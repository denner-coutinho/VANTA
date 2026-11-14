# Arquitetura técnica — VANTA: FRONTLINE

## Visão geral

```
                     ┌──────────────────────────── Navegador / PC ────────────────────────────┐
                     │  apps/client  (Vite + React + TypeScript + Three.js)                    │
                     │   • UI/menus (React)        • Gameplay 3D (Three.js puro, loop próprio) │
                     │   • Predição local + interpolação (Fase 3)                              │
                     └───────────────┬───────────────────────────────┬─────────────────────────┘
                          HTTPS/JSON │                               │ WebSocket (Fase 3)
                     ┌───────────────▼──────────────┐   ┌────────────▼────────────────────────┐
                     │ apps/server (API, Fastify)   │   │ apps/game-server (Colyseus, Fase 3) │
                     │ auth · perfil · conteúdo ·   │   │ servidor AUTORITATIVO a 30–60 Hz:   │
                     │ loja · economia · admin ·    │   │ movimento, tiros (raycast + lag     │
                     │ webhooks Stripe              │   │ compensation), dano, rounds         │
                     └───────┬───────────────┬──────┘   └──────┬──────────────────┬───────────┘
                             │               │                 │                  │
                     ┌───────▼──────┐ ┌──────▼──────┐   resultado assinado   matchmaking
                     │ PostgreSQL   │ │ Redis       │◄──────────┘            (filas no Redis)
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
| `apps/game-server` | *(Fase 3)* Servidor de partidas Colyseus, reutilizando `packages/shared` para física e armas. |

## Decisões e justificativas

- **Fastify em vez de NestJS.** Para uma API que precisa de baixa latência e que será dividida em módulos claros, o Fastify entrega ~2–3× mais requisições por segundo com muito menos cerimônia. A organização em módulos (rotas + serviço + testes) dá a mesma separação que o Nest sem o custo de decorators/DI. Se a equipe crescer muito, os serviços já são classes injetáveis e migram fácil.
- **Three.js puro no gameplay, React só na interface.** Um FPS precisa de controle total do loop (tick fixo, pointer lock, pooling de objetos). React Three Fiber é ótimo para cenas declarativas, mas adiciona reconciliação desnecessária no loop de jogo. Menus continuam em React.
- **Colyseus no servidor de partidas (Fase 3).** Salas com estado sincronizado por delta, reconexão nativa (`allowReconnection`), matchmaking embutido e escala horizontal com Redis presence. Evita reinventar a camada de rede, mas a lógica de simulação será nossa (tick autoritativo).
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

Não é possível gerar aqui personagens com qualidade comercial (escultura, retopologia, texturas, rig e animação de captura). Plano:
1. **Agora:** operador procedural em código (original, animado em idle, cabeça segue o cursor) atrás do contrato `OperatorRig`.
2. **Fase 4:** pipeline glTF + `AnimationMixer` com um rig humanoide único (`vanta_humanoid_v1`) compartilhado pelos 8 personagens. Fontes viáveis: modelos encomendados a um artista, bases CC0 (ex.: Quaternius, Kenney) personalizadas, e animações com licença que permite uso comercial em jogos. Cada personagem vira um `modelKey` no banco, sem mudar código.

## Gameplay (Fase 2)

A simulação fica em `packages/shared/src/game` e não depende de navegador nem de Three.js, para que o servidor autoritativo da Fase 3 rode exatamente as mesmas regras:

- `movement.ts`: `stepPlayer(state, input, world)` a 60 Hz fixos (andar, correr, agachar, pular, degraus, gravidade).
- `collision.ts` / `raycast.ts`: mundo de AABBs com grade espacial, raycast por *slab*, hitboxes humanoides (cabeça/corpo/pernas).
- `weapons.ts`: estado da arma (munição, recarga, troca, *bloom*, recuo) e disparo com RNG semeado (mulberry32), reproduzível no servidor.
- `weapon-catalog.ts`: as 10 armas; o seed do banco importa daqui, então banco e simulação nunca divergem.
- `maps/`: definição de mapa como dados (sólidos, neon, luzes, spawns, alvos). O cliente monta o visual a partir dela; o servidor usará só os sólidos.

No cliente (`apps/client/src/game`), `GameRuntime` acumula o tempo real, roda N ticks de simulação e renderiza interpolando entre os dois últimos estados. A mira é aplicada por quadro (sem atraso de tick). A arma em primeira pessoa é desenhada numa cena separada depois de limpar o depth buffer, para não atravessar paredes.
