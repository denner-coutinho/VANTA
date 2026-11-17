# Deploy do VANTA: FRONTLINE

Este guia sobe o jogo inteiro (cliente, API, servidor de jogo, PostgreSQL e Redis) num servidor Linux com Docker.
Foi testado de ponta a ponta no ambiente de desenvolvimento (veja "O que foi verificado").

## 1. O que você precisa

- Um servidor Linux com Docker 24+ e o plugin `docker compose` (2 vCPU e 4 GB de RAM bastam para começar).
- Um domínio apontando para o servidor e **TLS** na frente (Caddy, Cloudflare, ou o balanceador do seu provedor). O jogo exige `https://` em produção.
- Um serviço de **SMTP** (e-mails de verificação e recuperação de senha). Sem SMTP o servidor se recusa a subir, para os links não irem parar no log.
- (Opcional, ainda adiado) chaves da Stripe. Sem elas, a compra de VANTA COINS fica desativada (nunca simulada).

## 2. Configurar

```bash
cp deploy/.env.production.example deploy/.env.production
# gere cada segredo com:
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

Preencha `PUBLIC_APP_URL` (https), `POSTGRES_PASSWORD`, `REDIS_PASSWORD`, `JWT_ACCESS_SECRET`, `MFA_ENCRYPTION_KEY` (outro segredo aleatório, diferente do JWT) e o SMTP.
O arquivo preenchido **nunca** vai para o Git (`.gitignore` já ignora `.env.*`).

A API e o servidor de jogo recusam subir em produção se encontrarem: segredo de exemplo ou com pouca variedade,
senha de banco de desenvolvimento, `PUBLIC_APP_URL` sem https, `CORS_ORIGINS=*` ou SMTP ausente.

## 3. Subir

```bash
docker compose -f docker-compose.prod.yml --env-file deploy/.env.production up -d --build --wait
```

Ordem: Postgres e Redis ficam saudáveis → `migrate` aplica as migrações e o seed de conteúdo (idempotente) e termina →
API → servidor de jogo → nginx. Só o nginx expõe porta (`WEB_PORT`, padrão 8080); coloque o TLS na frente dela.

Primeiro superadmin (só pelo terminal, de propósito):

```bash
# A imagem de migração tem as ferramentas (tsx); a imagem da API não.
docker compose -f docker-compose.prod.yml --env-file deploy/.env.production run --rm --workdir /app/apps/server migrate npx tsx scripts/create-admin.ts email@da.conta SUPERADMIN
```

Em produção a Temporada 1 nasce **inativa**: um admin a inicia no lançamento (`POST /admin/ranked/seasons/start`).

## 4. Atualizar

```bash
git pull
docker compose -f docker-compose.prod.yml --env-file deploy/.env.production up -d --build --wait
```

O `migrate` roda de novo a cada atualização (só aplica migrações novas). As migrações são aditivas; antes de uma que
remova coluna, faça backup.

**Atenção:** reiniciar o servidor de jogo encerra as partidas e salas em andamento (o estado vivo fica em memória).
Atualize fora do horário de pico.

## 5. Backup

```bash
docker compose -f docker-compose.prod.yml --env-file deploy/.env.production exec -T postgres pg_dump -U vanta -Fc vanta > backup-$(date +%F).dump
# restaurar num banco vazio:
docker compose ... exec -T postgres pg_restore -U vanta -d vanta --clean < backup-AAAA-MM-DD.dump
```

Agende o `pg_dump` diário (cron) e guarde fora do servidor. O Redis guarda só dados temporários (limites de taxa,
sessões de fila) e pode ser perdido sem prejuízo.

## 5b. Equipe e verificação em duas etapas

Moderadores, admins e superadmins só usam o painel com a verificação em duas etapas ligada (app autenticador).
Depois de `create-admin`, a pessoa entra no jogo, vai em Perfil › Verificação em duas etapas, liga, guarda os códigos
de recuperação e entra de novo com o código. Quem perder o celular e os códigos: o superadmin desliga pela ficha
(`Desligar verificação`), com motivo registrado na auditoria. A `MFA_ENCRYPTION_KEY` cifra os segredos no banco:
guarde-a com os outros segredos; trocá-la ou perdê-la obriga todos a cadastrar o app de novo.

## 6. Segurança da imagem

- API e jogo rodam como usuário `node` (sem root), com sistema de arquivos **somente leitura**, `no-new-privileges` e
  sem capabilities. Banco e Redis não têm porta exposta; o Redis exige senha.
- `TRUST_PROXY=1`: só o nginx é confiável, então o IP usado nos limites de taxa não pode ser falsificado com
  `X-Forwarded-For`. Se houver outro balanceador antes do nginx, use `TRUST_PROXY=2`.
- Cabeçalhos: o cliente sai com CSP restrita, `frame-ancestors 'none'`, `nosniff` e política de permissões; a API usa
  os do helmet (inclui HSTS).
- Nenhum segredo entra na imagem nem no JavaScript do cliente (verificado varrendo o build).

## 7. CI

`.github/workflows/ci.yml` roda em todo PR: typecheck, testes (com Postgres e Redis reais), build de produção,
auditoria de dependências (falha em crítica), build das três imagens e a pilha de produção completa com `--wait`.

## 8. O que foi verificado

- Build das imagens `server` (API e jogo, ~170 MB compactada), `migrate` e `web` (nginx, ~22 MB).
- Pilha de produção local com segredos gerados: migração + seed, healthchecks, E2E de cadastro, login, recuperação
  de senha e troca de operador **pelo nginx**, e-mails entregues por SMTP (mailpit), partida 1v1 criada pelo servidor
  de jogo através do proxy WebSocket.
- Os E2Es de jogabilidade (tiro, kill cam, replay) usam ganchos de depuração que só existem no build de
  desenvolvimento; por isso rodam contra `pnpm dev`, não contra a imagem de produção.

## 9. Métricas e capacidade

Com `METRICS_TOKEN` definido, a API e o servidor de jogo expõem `GET /metrics` (Prometheus) só na rede interna.
Um processo de jogo aguenta ~400 jogadores simultâneos. Detalhes, alertas sugeridos e como medir de novo:
[`docs/LOAD_TEST.md`](LOAD_TEST.md).

## 10. Vários servidores de jogo

Cada processo de jogo é um nó com nome (`GAME_NODE_ID`, letras minúsculas, números e hífen). Partidas, grupos e salas
vivem num nó; o Redis guarda o resto (nós vivos, onde cada conta está, fila, salas) e um nó líder forma as partidas.
Quando a partida, o grupo ou a sala de alguém está em outro nó, o servidor manda `{t:"redirect", node}` e o cliente
reconecta em `/game?node=<nó>`; o nginx encaminha esse pedido direto ao nó (só aceita nomes `gameN`).

```bash
# dois nós (game1 + game2):
docker compose -f docker-compose.prod.yml --env-file deploy/.env.production --profile scale up -d
node scripts/e2e-cluster.mjs https://seu-dominio   # confere fila, redirecionamento e rota por nó
```

Para um terceiro nó, copie o serviço `game2` como `game3` com `GAME_NODE_ID: game3` e os aliases `[game, game3]`.
O `game1` precisa estar sempre no ar. Se os nós ficarem atrás de outro balanceador (sem o nginx), defina
`GAME_PUBLIC_URL` (`wss://...`) em cada nó para o cliente saber onde reconectar.

## 11. Limites conhecidos

- **Nó de jogo que cai perde suas partidas, grupos e salas** (ficam na memória do nó); os jogadores voltam ao menu.
- **Grupo e partida em nós diferentes** podem desfazer o grupo depois dos 60 s de tolerância.
- **Replays ficam no Postgres** (gzip, até 8 MB cada, 30 dias). Com muitas partidas, mover para armazenamento de
  objetos (S3 ou compatível).
- **O Prisma avisa que não detectou a versão do OpenSSL** na imagem slim e usa o motor `openssl-1.1.x`; as consultas
  funcionam (testado), mas o aviso aparece no log ao subir.
- **Sem deploy feito daqui.** Este ambiente não tem conta de nuvem nem domínio; subir num provedor real é um passo
  seu (ou meu, com acesso e sua autorização), porque gera custo e expõe o jogo publicamente.
