# Arquitetura técnica — VANTA: FRONTLINE

## Visão geral

```
                     ┌──────────────────────────── Navegador / PC ────────────────────────────┐
                     │  apps/client  (Vite + React + TypeScript + Three.js)                    │
                     │   • UI/menus (React)        • Gameplay 3D (Three.js puro, loop próprio) │
                     │   • Predição local + interpolação                                       │
                     └───────────────┬───────────────────────────────┬─────────────────────────┘
                          HTTPS/JSON │                               │ WebSocket /game
                     ┌───────────────▼──────────────┐   ┌────────────▼────────────────────────┐
                     │ apps/server (API, Fastify)   │   │ apps/server/src/game (ws, :4100)    │
                     │ auth · perfil · conteúdo ·   │   │ servidor AUTORITATIVO a 60 Hz:      │
                     │ loja · economia · admin ·    │   │ movimento, tiros (raycast + lag     │
                     │ webhooks Stripe              │   │ compensation), dano, rounds         │
                     └───────┬───────────────┬──────┘   └──────┬──────────────────┬───────────┘
                             │               │                 │                  │
                     ┌───────▼──────┐ ┌──────▼──────┐   resultado da partida  matchmaking
                     │ PostgreSQL   │ │ Redis       │◄──────────┘            (fila em memória)
                     │ (Prisma)     │ │ rate limit, │
                     │ fonte da     │ │ throttle,   │
                     │ verdade      │ │ filas, pres.│
                     └──────────────┘ └─────────────┘
```

## Pacotes do monorepo (pnpm workspaces)

| Pacote | Responsabilidade |
|---|---|
| `packages/shared` | Tipos da API, validação (zod), 15 patentes, curva de XP, i18n. Usado por cliente **e** servidor: uma regra, um lugar. |
| `packages/db` | Esquema Prisma, migrations, seed de conteúdo, `createPrismaClient`. |
| `apps/server` | API HTTP (Fastify). Módulos: `auth`, `users`, `content`, `health`, `mail` (próximos: `store`, `economy`, `payments`, `admin`, `social`, `ranked`). |
| `apps/client` | Cliente web. `screens/` (telas), `three/` (cenas 3D), `api/` (cliente HTTP), `auth/`, `audio/`. |
| `apps/server/src/game` | Servidor de partidas (processo separado `dev:game`, WebSocket `ws`), reutilizando `packages/shared` para física, armas e mapas. |

## Decisões e justificativas

- **Fastify em vez de NestJS.** Para uma API que precisa de baixa latência e que será dividida em módulos claros, o Fastify entrega ~2–3× mais requisições por segundo com muito menos cerimônia. A organização em módulos (rotas + serviço + testes) dá a mesma separação que o Nest sem o custo de decorators/DI. Se a equipe crescer muito, os serviços já são classes injetáveis e migram fácil.
- **Three.js puro no gameplay, React só na interface.** Um FPS precisa de controle total do loop (tick fixo, pointer lock, pooling de objetos). React Three Fiber é ótimo para cenas declarativas, mas adiciona reconciliação desnecessária no loop de jogo. Menus continuam em React.
- **Servidor de partidas próprio sobre `ws` (Fase 3), não Colyseus.** O plano inicial era Colyseus, mas a sincronização de estado por delta dele não ajuda num FPS com predição e reconciliação por comando: o que importa é o tick autoritativo e o protocolo de comandos, que são nossos de qualquer forma. Com `ws` + zod o protocolo fica explícito e testável, e a escala horizontal (fila no Redis) entra na Fase 8.
- **Prisma 6 (não 7).** A versão 7 mudou a forma de conectar (driver adapters obrigatórios) e ainda é recente; a 6.19 é estável e madura. A migração é planejada depois.
- **Autenticação própria** (sem provedor externo): o jogo precisa controlar banimentos com efeito imediato, papéis administrativos e auditoria. Ver “Segurança”.
- **Moeda virtual com razão contábil.** `Wallet.balance` é um cache; a verdade é `WalletTransaction` (somente-inserção, protegida por trigger no banco), com chave de idempotência única.

## Segurança implementada na Fase 1

| Ameaça | Mitigação |
|---|---|
| Vazamento de senhas | Argon2id (m=19 MiB, t=2, p=1 — recomendação OWASP). Nunca logadas (pino `redact`). |
| Força bruta | `@fastify/rate-limit` com Redis (10 logins/min por IP) + `LoginThrottle` por conta+IP (5 falhas/15 min) e por conta (20 falhas/1 h). Contadores por ID da conta: trocar e-mail por username não burla. |
| Enumeração de contas | Mesma mensagem e mesmo tempo (hash fictício) para usuário inexistente e senha errada; recuperação de senha sempre responde igual. |
| Roubo de token (XSS) | Access token só em memória, 15 min. Refresh token em cookie `httpOnly`, `SameSite=Strict`, `Secure` em produção, restrito ao caminho das rotas de auth (`REFRESH_COOKIE_PATH`, padrão `/api/auth`). |
| Reuso de refresh roubado | Rotação a cada uso; token antigo reapresentado revoga toda a família de sessões e gera `SecurityEvent`. |
| CSRF | SameSite=Strict + header obrigatório `X-Vanta-Client` nas rotas que usam cookie. |
| Banimento / troca de senha | `tokenVersion` e status conferidos no banco a cada requisição autenticada: efeito imediato. |
| Falsificação de JWT | Algoritmo fixo HS256 (rejeita `alg: none` e troca de algoritmo); segredo ≥ 32 caracteres; o servidor recusa subir em produção com o segredo padrão. |
| Abuso de API | Rate limit global (300/min por IP), `bodyLimit` 64 KB, validação zod em toda entrada, CORS com lista explícita, Helmet. |
| SQL injection | Prisma (consultas parametrizadas); o único SQL cru é estático. |
| Manipulação de saldo | Sem rota que altere saldo na Fase 1. CHECK `balance >= 0`, razão somente-inserção (trigger), chave de idempotência única. |
| Escalada de privilégio | Papéis `PLAYER < MODERATOR < ADMIN < SUPERADMIN`; `requireRole` conferindo o papel atual no banco. Promoção só via CLI no servidor, registrada em `AdminAuditLog`. |

## Banco de dados

40 modelos em `packages/db/prisma/schema.prisma`, cobrindo todas as tabelas pedidas e mais:
`AuthSession`, `EmailVerificationToken`, `PasswordResetToken`, `SecurityEvent`, `GameMap`, `StoreItem`, `CoinPackage`, `RankHistory`, `UserBlock`, `GameEvent`, `AdminAuditLog`.

Restrições extras em SQL (`20261114160800_integrity_constraints`): saldo não negativo, preços positivos, pares de amizade ordenados, um pedido de amizade pendente por direção, uma temporada ativa por vez, e triggers que impedem `UPDATE/DELETE` no razão financeiro e no log de auditoria.

## Multiplayer (planejado para a Fase 3)

- Tick do servidor fixo (30 Hz no início, meta 60 Hz); cliente envia **inputs** (não posições).
- Servidor valida velocidade máxima por tick (anti speed hack), cadência pela arma (anti rapid-fire), e faz o raycast dos tiros com **lag compensation** (histórico de ~250 ms de hitboxes).
- Cliente: predição do próprio movimento + reconciliação; interpolação dos outros jogadores com buffer de ~100 ms.
- Resultado da partida gravado pelo servidor de jogo direto no banco (o cliente nunca informa resultado). `MatchEvent` guarda o fluxo para replay e kill cam; `replayHash` detecta adulteração.

## Assets 3D (limitação honesta e plano)

Não é possível gerar aqui personagens com qualidade comercial (escultura, retopologia, texturas, rig e animação de captura). O que existe hoje:

- **Fase 4 (atual):** os 8 operadores são modelos **procedurais** (`apps/client/src/three/characters.ts`), originais, gerados em código. Cada um tem silhueta própria (capacete, ombreiras, capa, mochila, drone, antena), mas todos compartilham o mesmo esqueleto hierárquico e a mesma altura (~1,80 m, igual à hitbox do servidor): a aparência não dá vantagem. As animações são procedurais e misturadas por peso a cada quadro: idle, walk, run, crouch (pernas com IK analítica para os pés ficarem no chão), jump, die, e as sobreposições shoot e reload. O mesmo `CharacterRig` é usado no menu (com demonstração de recarga e disparo) e na partida, alimentado pelos bits de animação do snapshot (`WireOther[10]`: no chão, correndo, recarregando).
- **Depois:** pipeline glTF + `AnimationMixer` com um rig humanoide único compartilhado pelos 8 personagens, sem mudar o contrato do `CharacterRig` (`updateAt`, `shoot`, `state`). Fontes viáveis: modelos encomendados a um artista, bases CC0 personalizadas e animações com licença comercial.

## Mapas (Fase 4)

Os 5 mapas são dados (`packages/shared/src/game/maps/*.ts`), montados com `SymmetricMapBuilder`: descreve-se metade do mapa e ela é espelhada por rotação de 180°, o que garante simetria exata entre os times. Cada mapa tem tema visual (`neon`, `desert`, `frost`, `lab`, `orbital`), sol opcional e zonas especiais (Orbital Zero tem um setor com 40% da gravidade, aplicado pela mesma simulação no cliente e no servidor).

`MapAnalyzer` (`maps/analysis.ts`) valida os mapas com a física real do jogo: explora a grade a partir do spawn caminhando de verdade entre células, confere que não há linha de visão entre os spawns e procura um ponto de contato (linha de visão a 8–30 m pelo caminho mais curto). Os testes rodam isso em todos os mapas, e o E2E da Fase 4 usa os mesmos caminhos para jogar uma partida em cada mapa. O servidor de jogo alterna os mapas em rodízio (`MAP_ROTATION`, configurável com `GAME_MAPS`).

## Gameplay (Fase 2)

A simulação fica em `packages/shared/src/game` e não depende de navegador nem de Three.js, para que o servidor autoritativo da Fase 3 rode exatamente as mesmas regras:

- `movement.ts`: `stepPlayer(state, input, world)` a 60 Hz fixos (andar, correr, agachar, pular, degraus, gravidade).
- `collision.ts` / `raycast.ts`: mundo de AABBs com grade espacial, raycast por *slab*, hitboxes humanoides (cabeça/corpo/pernas).
- `weapons.ts`: estado da arma (munição, recarga, troca, *bloom*, recuo) e disparo com RNG semeado (mulberry32), reproduzível no servidor.
- `weapon-catalog.ts`: as 10 armas; o seed do banco importa daqui, então banco e simulação nunca divergem.
- `maps/`: definição de mapa como dados (sólidos, neon, luzes, spawns, alvos). O cliente monta o visual a partir dela; o servidor usará só os sólidos.

No cliente (`apps/client/src/game`), `GameRuntime` acumula o tempo real, roda N ticks de simulação e renderiza interpolando entre os dois últimos estados. A mira é aplicada por quadro (sem atraso de tick). A arma em primeira pessoa é desenhada numa cena separada depois de limpar o depth buffer, para não atravessar paredes.

## Multiplayer (Fase 3)

```
navegador ──HTTP /api──▶ API Fastify (:4000) ──▶ PostgreSQL / Redis
    │
    └──WebSocket /game──▶ servidor de jogo (:4100, processo separado) ──▶ PostgreSQL (resultado das partidas)
```

- **Protocolo** (`packages/shared/src/net/protocol.ts`): JSON validado com zod. O cliente envia só `hello` (JWT), `queue`, `ready`, `cmd` (comandos compactos `[seq, botões, yaw, pitch, viewTick, slot]`), `ping` e `leave_match`.
- **Comandos** (`packages/shared/src/game/sim.ts`): `applyCommand` aplica um comando de um tick a um combatente (movimento, troca, recarga, disparo). Roda igual no servidor (autoritativo) e no cliente (predição). O tempo de um comando é `seq × 16,67 ms`, então a reaplicação é determinística.
- **Servidor** (`apps/server/src/game/match.ts`): por tick, consome no máximo 1 comando por jogador (2 se houver fila acumulada) e só se houver crédito (1 por tick, teto de 10): não dá para andar mais rápido mandando mais comandos. Disparos são resolvidos com raycast contra as hitboxes **na posição em que o atirador via os alvos** (histórico de 64 ticks, rebobinamento máximo de 250 ms). Snapshots a 30 Hz: estado completo do próprio jogador (para reconciliar), posição/mira dos outros, placar e eventos.
- **Cliente** (`apps/client/src/game/OnlineRuntime.ts`): prevê o próprio jogador, guarda os comandos não confirmados, e a cada snapshot volta ao estado do servidor e reaplica o resto. Pequenas diferenças são suavizadas na câmera. Os outros jogadores são desenhados 100 ms no passado, interpolando entre snapshots.
- **Reconexão**: o servidor mantém a vaga por 60 s; ao voltar, envia a partida e o último `seq` aceito, e o cliente continua dele.

## Competitivo (Fase 5)

- **Regras puras em `packages/shared/src/ranked.ts`**: Glicko-2, conversão de MMR em Pontos de Patente, classificação, bônus, penalidade de abandono, janela de matchmaking, balanceamento de equipes e reinício de temporada. Não tocam em banco nem em rede, então são testadas isoladamente e o cliente pode usar as mesmas tabelas só para exibir.
- **MMR oculto, PP visíveis.** O MMR (rating, desvio, volatilidade) decide o pareamento e nunca sai do servidor. Os PP são o que o jogador vê; o ganho base é ajustado pela distância entre os PP atuais e os PP que o MMR "merece", então as duas medidas convergem.
- **Fila**: uma fila por modo e tipo (casual ou ranqueada) na memória do servidor de jogo. A casual é por ordem de chegada. A ranqueada procura, a cada segundo, um grupo em que todos caibam na janela de MMR uns dos outros (a janela cresce com a espera) e divide as equipes pela menor diferença de média.
- **Gravação**: ao fim da partida, `GameServer.persist` aplica `applyRankedMatch` dentro da mesma transação que grava `Match` e `MatchPlayer` (PP, MMR antes e depois, histórico de patente). Só depois envia `ranked_result` a cada jogador. Sem temporada ativa no instante do fim, a partida é gravada sem pontos.
- **Bloqueio por abandono** é derivado do banco (abandonos em ranqueadas nas últimas 24 h), não de estado em memória: reiniciar o servidor não limpa a punição.
- **Temporadas** (`modules/ranked/season.service.ts`): encerrar grava o top 100 por modo em `leaderboardSnapshot`; iniciar a próxima cria as avaliações de quem já tinha patente com MMR puxado para a média e desvio maior.
- **Para escalar**: a fila em memória vale para um processo. Com vários servidores de jogo, mover a fila para o Redis (lista ordenada por MMR) e manter um único casador.

## Economia (Fase 6)

- **Razão contábil** (`modules/economy/wallet.ts`, `postLedger`): único ponto que altera saldo. Cada lançamento tem chave de idempotência única (`store:<user>:<item>`, `stripe:order:<id>`, `stripe:refund:<id>:<valor>`, `season:<id>:<user>`, `admin:<requestId>`), grava `balanceAfter` e atualiza `Wallet.balance` com bloqueio otimista (`version`). Débitos da loja nunca deixam o saldo negativo; débitos externos (estorno, chargeback) zeram e registram o que faltou.
- **Loja** (`store.service.ts`): o preço vem do banco; débito e `Inventory` são gravados na mesma transação. Duas compras simultâneas do mesmo item: uma vence, a outra recebe 409 (`ALREADY_OWNED`).
- **Pagamentos** (`payments.ts`): `PaymentGateway` com a implementação `StripeGateway` (Checkout hospedado). O webhook roda num plugin com parser de corpo cru para conferir a assinatura; todo evento é gravado em `PaymentWebhookEvent` (id único) antes de ser aplicado, e o crédito do pedido usa chave própria, então reentregas não duplicam. O valor pago é conferido com o pedido.
- **Cosméticos** (`packages/shared/src/cosmetics.ts`): definição das skins (cores e padrão), preços e recompensas. O cliente aplica as cores no `CharacterRig` e no `ViewModel`; os padrões são desenhados em canvas. O servidor de jogo carrega as skins equipadas ao entrar na fila e as envia em `MatchInfo.players[].cosmetics`.
- **Recompensas de temporada**: aplicadas dentro da transação de `closeSeason`, com chave por jogador.

## Social (Fase 7, parte 1)

- **Onde mora cada coisa.** Amizades, pedidos, bloqueios, silenciados, denúncias e notificações ficam no PostgreSQL e passam pela API (`modules/social`). Presença, grupo, convites de grupo e chat ficam no servidor de jogo, porque dependem de quem está conectado agora.
- **API → servidor de jogo.** Quando uma amizade ou um bloqueio muda, a API publica um evento no Redis (canal `<prefixo>social`, `RedisSocialBus`). O servidor de jogo assina o canal, atualiza a lista de amigos/bloqueios da conexão e repassa o evento ao cliente (`{t:"social"}`). A entrega é "no máximo uma vez": o cliente sempre relê `/social/overview` ao abrir o painel, o evento só adianta a atualização. Nos testes, API e servidor de jogo compartilham um `MemorySocialBus`.
- **Presença** é calculada no servidor (`online`, `queue`, `match`; `room` entra com as salas) e enviada só para amigos confirmados nos dois sentidos. Ao desconectar, grava `lastSeenAt`.
- **Grupo** (até 3): convite só para amigo online e não bloqueado, expira em 60 s. Quem cai tem 60 s para voltar sem sair do grupo. Na fila, o grupo vira um "bilhete" único: `packParties` monta os dois times com grupos inteiros, respeitando a ordem de chegada (busca com memoização, testada com 400 bilhetes). O ranqueado continua individual.
- **Chat**: canais grupo, equipe e todos; texto limpo no servidor (`sanitizeChat`: sem caracteres de controle/invisíveis, até 200), anti-flood de 5 mensagens a cada 5 s, banimento de chat (`Ban` tipo `CHAT_MUTE`). Bloqueio e silêncio são aplicados no servidor (a mensagem nem é enviada). O chat de partida é gravado como `MatchEvent` tipo `chat` para servir de prova em denúncias.
- **Voz (futuro).** A arquitetura prevista: WebRTC com sinalização (oferta/resposta/ICE) trafegando pelo mesmo WebSocket autenticado, em canais equivalentes aos do chat (grupo/equipe), com um SFU (ex.: mediasoup/LiveKit) para 3v3 e as mesmas regras de bloqueio/silêncio aplicadas no servidor antes de encaminhar. Nada disso está implementado ainda.
