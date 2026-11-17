# Teste de carga e métricas

Fase 8, parte 2. Como medir a capacidade do servidor de jogo e da API, o que foi medido e o que
mudou por causa disso.

## 1. Métricas (Prometheus)

A API (`:4000`) e o servidor de jogo (`:4100`) expõem `GET /metrics` no formato do Prometheus.

- **Desligado por padrão.** Só existe com `METRICS_TOKEN` definido e exige `Authorization: Bearer <token>`.
  Em produção, um token curto ou repetitivo impede o servidor de subir.
- **Nunca público.** O nginx responde 404 para `/api/metrics`, e o servidor de jogo só é alcançável em `/game`.
  O Prometheus deve falar direto com `api:4000` e `game:4100` pela rede interna do Docker.
- As rotas aparecem pelo nome declarado (`/players/:username`), nunca pela URL com o nome do jogador.

| Métrica | O que mostra |
|---|---|
| `vanta_game_tick_duration_seconds` | Tempo para avançar todas as partidas um tick. Orçamento: 16,7 ms (60 Hz) |
| `vanta_game_tick_catchup_total{kind}` | Ticks atrasados que o loop precisou recuperar (`catchup`) e travadas de mais de 250 ms (`stall`) |
| `vanta_game_connections`, `vanta_game_players_online` | Conexões abertas e jogadores identificados |
| `vanta_game_matches_active{mode}`, `vanta_game_queue_players{queue}` | Partidas em andamento e tamanho das filas |
| `vanta_game_messages_in_total{type}`, `vanta_game_messages_out_total`, `vanta_game_bytes_out_total` | Tráfego |
| `vanta_game_rejected_total{reason}` | Mensagens recusadas: limite de taxa, JSON inválido, comando fora de sequência, inundação |
| `vanta_game_matches_started_total`, `vanta_game_matches_ended_total` | Partidas por modo |
| `vanta_http_requests_total{method,route,status}`, `vanta_http_request_duration_seconds` | API por rota |
| `vanta_process_*`, `vanta_nodejs_*` | CPU, memória, heap, atraso do event loop e coleta de lixo de cada processo |

Exemplo de coleta (`prometheus.yml`), com o Prometheus na mesma rede do `docker-compose.prod.yml`:

```yaml
scrape_configs:
  - job_name: vanta
    authorization: { credentials_file: /etc/prometheus/vanta_metrics_token }
    static_configs:
      - targets: ["api:4000", "game:4100"]
```

Alertas sugeridos: p99 do tick acima de 12 ms por 5 minutos; qualquer `stall`; `vanta_nodejs_eventloop_lag_p99_seconds`
acima de 50 ms; respostas 5xx da API.

## 2. Como rodar o teste de carga

Os clientes de carga **não são jogadores**. São conexões de teste com contas `carga_NNNN` criadas só para isso,
que entram na fila casual e mandam comandos aleatórios no mesmo ritmo do cliente real (60 comandos/s em lotes, um
ping por segundo, no máximo 12 comandos sem confirmação). Por isso os scripts só aceitam um banco cujo nome contenha
`load` ou `carga`, e recusam `NODE_ENV=production`: as contas e as partidas ficam gravadas nesse banco.

```bash
# 1. Banco descartável com migrações e seed
psql postgresql://vanta:vanta@localhost:5432/vanta -c "CREATE DATABASE vanta_load"
export DATABASE_URL="postgresql://vanta:vanta@localhost:5432/vanta_load?schema=public"
pnpm --filter @vanta/db exec prisma migrate deploy && pnpm --filter @vanta/db exec tsx prisma/seed.ts

# 2. Servidor de jogo e API apontando para ele (build de produção; METRICS_TOKEN no .env)
pnpm build
cd apps/server
GAME_PORT=4200 REDIS_KEY_PREFIX=vanta-load: node --env-file=../../.env dist/game-main.js &
API_PORT=4300 REDIS_KEY_PREFIX=vanta-load: RATE_LIMIT_PER_MIN=1000000 node --env-file=../../.env dist/main.js &

# 3. Carga no jogo (cria as contas) e na API
pnpm load-test --players 300 --duration 60 --ramp 15 --game ws://127.0.0.1:4200/game --out carga.json
pnpm load-api --workers 50 --duration 30 --api http://127.0.0.1:4300
```

`RATE_LIMIT_PER_MIN` alto só no teste: todas as requisições saem do mesmo IP. Em produção fica o padrão (300 por IP
por minuto, com limites menores nas rotas de login e cadastro).

## 3. Resultados (17/11/2026)

Máquina de teste: contêiner com 4 núcleos e 16 GB. **O gerador de carga, o Postgres e o Redis rodam na mesma máquina
que o servidor**, disputando CPU com ele, e a rede é local (sem latência de internet). Os números do servidor são,
portanto, pessimistas para CPU e otimistas para rede.

### Servidor de jogo (um processo, partidas 3v3 casuais)

| Jogadores | Partidas | Tick médio | Tick p99 | Ticks atrasados | CPU (1 núcleo = 100%) | Memória (RSS / heap) | Ping p99 no cliente | Saída |
|---|---|---|---|---|---|---|---|---|
| 12 | 2 | 0,33 ms | ≤ 1 ms | 0 | 5% | 141 / 25 MB | 0,6 ms | 3,8 Mbit/s |
| 120 | 20 | 2,2 ms | ≤ 8 ms | 0 | 23% | 193 / 78 MB | 11 ms | 37 Mbit/s |
| 300 | 49 | 4,9 ms | ≤ 16,7 ms | 0 | 49% | 406 / 255 MB | 13 ms | 92 Mbit/s |
| 600 (antes das correções) | 100 | 11,6 ms | ≤ 33 ms | 1.337 + 1 travada | 105% | 1.348 / 598 MB | 100 ms | 189 Mbit/s |
| **600 (depois)** | 100 | **8,9 ms** | ≤ 33 ms | **124**, nenhuma travada | **88%** | **390 / 82 MB** | **42 ms** | 187 Mbit/s |

Os percentis do tick vêm dos baldes do histograma (limite superior do balde). Cada jogador recebe ~38 KB/s
(snapshots a 30 Hz numa partida 3v3).

**Capacidade recomendada por processo de jogo: até ~400 jogadores simultâneos (~65 partidas 3v3).** Até aí o tick
fica com folga e nenhum atraso; com 600 o processo encosta em um núcleo inteiro. Para mais jogadores, mais
processos de jogo: é o trabalho da próxima parte (estado compartilhado no Redis).

### O que o perfil de CPU mostrou e o que mudou

1. **Replays guardados como objetos na memória** até o fim da partida: ~40 MB de heap por partida 3v3 de 20 minutos
   (medido: 18.000 quadros = 38,8 MB). Com 100 partidas longas, o processo passaria de 4 GB. No fim da partida, o
   JSON e o gzip de tudo eram feitos de uma vez na thread principal, travando o loop de 60 Hz de todas as partidas.
   **Agora** cada quadro vira JSON na hora e vai para um gzip em streaming, fora da thread principal
   (`ReplayRecorder`). O conteúdo do arquivo final é o mesmo de antes (teste compara). Heap com 600 jogadores:
   598 → 82 MB.
2. **Colisão alocando a cada consulta** (texto para cada célula da grade e um `Set` novo por consulta, milhares de vezes
   por tick). **Agora** a chave da célula é um número e a marcação de "já visto" usa um vetor reaproveitado. Mesmo
   resultado, na mesma ordem (teste compara com força bruta em todos os mapas).
3. **O que sobra é envio pela rede**: com 600 jogadores, quase metade do tempo de CPU ocupado do processo vai para escrever os snapshots
   nos sockets (uma escrita por jogador a 30 Hz). Isso não some otimizando o código; escala com mais processos.

### Teste longo (estabilidade)

TESTE_LONGO

### API (um processo)

| Concorrência | Vazão | p50 | p99 | Erros |
|---|---|---|---|---|
| 8 | 586 req/s | 12,9 ms | 30,3 ms | 0 |
| 50 | 715 req/s | 59,7 ms | 159,8 ms | 0 |

Mistura de 11 rotas de leitura autenticadas (perfil, carteira, inventário, loja, ranqueado, social, rankings...).
Cada requisição confere a conta no banco (banimento vale na hora). A API já é sem estado: para mais vazão, mais
processos atrás do nginx (limites de taxa e sessões ficam no Redis e no Postgres).

**Login e cadastro** são limitados pelo Argon2id (19 MB de memória por hash): 24 ms por hash, ~42 por segundo por
núcleo. É proposital (dificulta quebrar senhas vazadas) e protegido por limite de taxa por IP.

## 4. Limites deste teste

- **Mesma máquina e rede local.** Não mede latência de internet nem perda de pacotes; isso depende da hospedagem.
- **Clientes de carga não miram**: andam e atiram ao acaso. Uma partida real tem mais abates e eventos, mas o custo
  dominante (simular e enviar snapshots) é o mesmo.
- **Um processo de jogo.** O teste mostra o limite de um processo; vários processos dependem da próxima parte.
