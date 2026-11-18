# VANTA: FRONTLINE

FPS multiplayer competitivo, futurista e tático, para PC (navegador e, futuramente, app desktop).
Monetização 100% cosmética: nada que dê vantagem em combate é vendido.

> **Status:** as 8 fases do plano estão concluídas e testadas; o jogo ainda **não foi lançado** (pagamentos reais e deploy
> num provedor dependem de decisões suas). Veja [`PROGRESS.md`](PROGRESS.md) para o que está pronto, como foi testado e os limites conhecidos.
> Arquitetura e decisões técnicas: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Estrutura

```
apps/
  client/        Cliente web (Vite + React + Three.js)
  server/        API HTTP (Fastify, :4000) e servidor de jogo autoritativo (WebSocket, :4100)
packages/
  shared/        Tipos, validação (zod), patentes, progressão, i18n — usado por cliente e servidor
  db/            Prisma: schema, migrations e seed
scripts/         Testes ponta a ponta (Playwright) e de vários nós
deploy/          nginx e exemplo de configuração de produção
docs/            Arquitetura, deploy, teste de carga e capturas de tela
```

## Requisitos

- Node.js 22+ e pnpm 10 (`corepack enable`)
- PostgreSQL 16 e Redis 7 — o jeito mais simples é Docker (`docker compose up -d`)

## Rodando localmente

```bash
pnpm install
cp .env.example .env                  # e troque JWT_ACCESS_SECRET (comando no próprio arquivo)
docker compose up -d                  # PostgreSQL, Redis e Mailpit (caixa de e-mail local)
pnpm build                            # compila shared e db (gera o Prisma Client)
pnpm db:deploy                        # aplica as migrations
pnpm db:seed                          # patentes, personagens, armas, mapas, pacotes de VC, missões
pnpm dev                              # API em :4000, servidor de jogo em :4100 (ws /game) e cliente em http://localhost:5173
```

Sem `SMTP_HOST`, os e-mails (verificação, recuperação de senha) aparecem no log do servidor.
Com o Mailpit do docker-compose, use `SMTP_HOST=localhost` e `SMTP_PORT=1025` e abra http://localhost:8025.

### Criar um administrador

Não existe rota HTTP para isso, de propósito. Crie a conta pelo jogo e, no servidor:

```bash
pnpm --filter @vanta/server create-admin seu@email.com ADMIN   # ou SUPERADMIN / MODERATOR
```

A equipe só usa o painel (`/admin`) com a verificação em duas etapas ligada: depois do comando, a pessoa liga em
Perfil › Verificação em duas etapas (app autenticador) e entra de novo com o código.

## Testes

```bash
createdb vanta_test                   # uma vez (ou: docker compose exec postgres createdb -U vanta vanta_test)
pnpm test                             # unitários + integração (API contra PostgreSQL/Redis reais)
node scripts/e2e-smoke.mjs            # ponta a ponta no navegador (com `pnpm dev` rodando)
node scripts/e2e-training.mjs         # Fase 2: joga o treinamento (tiro, recarga, troca, pausa, arsenal)
node scripts/e2e-multiplayer.mjs      # Fase 3: dois navegadores jogam 1v1 (fila, tiro, reconexão, W.O.)
node scripts/e2e-maps.mjs             # Fase 4: 5 partidas seguidas, uma em cada mapa, com os 8 operadores e suas animações
node scripts/e2e-ranked.mjs           # Fase 5: quatro navegadores em duas ranqueadas 1v1 (classificação, PP, bloqueio por abandono, ranking)
node scripts/e2e-economy.mjs          # Fase 6: loja, compras, inventário, skins no menu e na partida
node scripts/e2e-social.mjs           # Fase 7: três navegadores (amigos, presença, grupo, chat, denúncia, bloqueio)
node scripts/e2e-rooms.mjs            # Fase 7: três navegadores (sala com senha, convite, regras, partida, espectador, remover, encerrar)
node scripts/e2e-progression.mjs      # Fase 7: partida real → XP no resultado → missão resgatada → conquista → histórico → título
node scripts/e2e-clans.mjs            # Fase 7: clã (criar, convidar, cargos, desfazer), perfil público, cartão e rankings
node scripts/e2e-replay.mjs           # Fase 7: kill cam com abate real, MVP, replay (pausa, linha do tempo, velocidade) e download
node scripts/e2e-admin.mjs            # Fase 7: painel administrativo (moderador, superadmin, auditoria) e teclas remapeáveis
node scripts/e2e-mfa.mjs              # Fase 8: verificação em duas etapas (QR code, código, recuperação, exigência para a equipe)
node scripts/e2e-cluster.mjs          # Fase 8: dois servidores de jogo pela pilha de produção (veja docs/DEPLOY.md)
pnpm --filter @vanta/server load-test # Fase 8: carga no servidor de jogo (só em banco de carga; veja docs/LOAD_TEST.md)
```

O teste E2E precisa do Playwright: `npm i -g playwright && npx playwright install chromium`.
Os testes de integração usam `TEST_DATABASE_URL` (banco com `_test` no nome); o setup recusa outro banco.

## Variáveis de ambiente

Todas documentadas em [`.env.example`](.env.example). Regras:
- Segredos (`JWT_ACCESS_SECRET`, `MFA_ENCRYPTION_KEY`, `METRICS_TOKEN`, `STRIPE_*`, `SMTP_PASS`) **só no servidor**.
- No cliente, apenas variáveis `VITE_*` chegam ao navegador — nunca coloque segredos nelas.
- Em produção o servidor recusa iniciar com segredos de exemplo ou fracos, sem `MFA_ENCRYPTION_KEY`, sem https ou sem SMTP.

## Pagamentos (Stripe)

Sem `STRIPE_SECRET_KEY` e `STRIPE_WEBHOOK_SECRET`, a compra de VANTA COINS fica desativada (a tela avisa; nada é simulado). Para ativar:

1. Na Stripe, copie a chave secreta (`sk_test_…` para testes) e crie um endpoint de webhook para `https://SEU_DOMINIO/api/payments/stripe/webhook` com os eventos `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, `checkout.session.expired`, `charge.refunded`, `charge.dispute.created` e `charge.dispute.closed`. Copie o segredo de assinatura (`whsec_…`).
2. Coloque as duas no `.env` do servidor (nunca no cliente) e reinicie a API.
3. Em desenvolvimento: `stripe listen --forward-to localhost:4000/payments/stripe/webhook` e use o `whsec_` que ele mostrar.

Só o webhook credita moedas. O cartão é digitado na página da Stripe; o jogo não recebe nem guarda dados de cartão.

## Deploy

Produção em um servidor com Docker (cliente + API + jogo + Postgres + Redis, só o nginx exposto):

```bash
cp deploy/.env.production.example deploy/.env.production   # preencha os segredos
docker compose -f docker-compose.prod.yml --env-file deploy/.env.production up -d --build --wait
```

Passo a passo, backup, segurança e limites em [docs/DEPLOY.md](docs/DEPLOY.md). A CI (`.github/workflows/ci.yml`)
roda typecheck, testes, build, auditoria e a pilha de produção em todo PR.

Métricas (Prometheus), teste de carga e capacidade medida em [docs/LOAD_TEST.md](docs/LOAD_TEST.md).

## Licença dos assets

Todo o conteúdo visual e sonoro atual é original e gerado em código (logo SVG, emblemas das 15 patentes, operador 3D procedural, sons de interface sintetizados via Web Audio). Fontes: Chakra Petch e Barlow (SIL Open Font License), empacotadas localmente.
