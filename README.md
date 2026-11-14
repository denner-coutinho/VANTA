# VANTA: FRONTLINE

FPS multiplayer competitivo, futurista e tático, para PC (navegador e, futuramente, app desktop).
Monetização 100% cosmética: nada que dê vantagem em combate é vendido.

> **Status:** Fase 1 (fundação) concluída. Veja [`PROGRESS.md`](PROGRESS.md) para o que está pronto, testado e o que vem a seguir.
> Arquitetura e decisões técnicas: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Estrutura

```
apps/
  client/        Cliente web (Vite + React + Three.js)
  server/        API HTTP (Fastify) — auth, perfil, conteúdo; depois loja, pagamentos, admin
packages/
  shared/        Tipos, validação (zod), patentes, progressão, i18n — usado por cliente e servidor
  db/            Prisma: schema, migrations e seed
scripts/         Teste ponta a ponta (Playwright)
docs/            Arquitetura e capturas de tela
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

## Testes

```bash
createdb vanta_test                   # uma vez (ou: docker compose exec postgres createdb -U vanta vanta_test)
pnpm test                             # unitários + integração (API contra PostgreSQL/Redis reais)
node scripts/e2e-smoke.mjs            # ponta a ponta no navegador (com `pnpm dev` rodando)
node scripts/e2e-training.mjs         # Fase 2: joga o treinamento (tiro, recarga, troca, pausa, arsenal)
node scripts/e2e-multiplayer.mjs      # Fase 3: dois navegadores jogam 1v1 (fila, tiro, reconexão, W.O.)
```

O teste E2E precisa do Playwright: `npm i -g playwright && npx playwright install chromium`.
Os testes de integração usam `TEST_DATABASE_URL` (banco com `_test` no nome); o setup recusa outro banco.

## Variáveis de ambiente

Todas documentadas em [`.env.example`](.env.example). Regras:
- Segredos (`JWT_ACCESS_SECRET`, `STRIPE_*`, `SMTP_PASS`) **só no servidor**.
- No cliente, apenas variáveis `VITE_*` chegam ao navegador — nunca coloque segredos nelas.
- Em produção o servidor recusa iniciar com o segredo JWT padrão ou sem SMTP.

## Deploy (preparação)

- API: `pnpm build && pnpm --filter @vanta/server start` atrás de um proxy reverso com HTTPS (defina `TRUST_PROXY=true`).
- Cliente: `pnpm --filter @vanta/client build` gera `apps/client/dist` (estático; sirva com o proxy encaminhando `/api` para a API, mantendo a mesma origem).
- Banco: `pnpm db:deploy` a cada release (nunca `migrate dev`/`reset` em produção).
- Dockerfiles e pipeline de CI entram na Fase 8.

## Licença dos assets

Todo o conteúdo visual e sonoro atual é original e gerado em código (logo SVG, emblemas das 15 patentes, operador 3D procedural, sons de interface sintetizados via Web Audio). Fontes: Chakra Petch e Barlow (SIL Open Font License), empacotadas localmente.
