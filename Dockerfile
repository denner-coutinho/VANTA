# syntax=docker/dockerfile:1.7
# Imagens de produção do VANTA: FRONTLINE (um Dockerfile, quatro alvos):
#   server  → API HTTP (Fastify) ou servidor de jogo (mesmo código; o comando escolhe)
#   migrate → aplica as migrações do banco e o seed de conteúdo (roda uma vez por deploy)
#   web     → cliente compilado servido pelo nginx, com proxy para /api e /game
# Nenhum segredo entra na imagem: tudo vem de variáveis de ambiente no momento de rodar.

ARG NODE_IMAGE=node:22-bookworm-slim

# ───────── Dependências e build ─────────
FROM ${NODE_IMAGE} AS build
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true COREPACK_ENABLE_DOWNLOAD_PROMPT=0
# Atrás de proxy corporativo com CA própria: docker build --secret id=ca,src=ca.crt (opcional).
ENV NODE_EXTRA_CA_CERTS=/run/secrets/ca
WORKDIR /app
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY apps/server/package.json apps/server/
COPY apps/client/package.json apps/client/
COPY packages/shared/package.json packages/shared/
COPY packages/db/package.json packages/db/
COPY packages/db/prisma packages/db/prisma
RUN --mount=type=secret,id=ca,required=false --mount=type=cache,id=pnpm,target=/pnpm/store \
  corepack enable && pnpm install --frozen-lockfile
COPY . .
# O cliente fala com a API pela mesma origem (/api e /game passam pelo nginx).
ENV VITE_API_URL=/api
RUN --mount=type=secret,id=ca,required=false pnpm build

# ───────── Migrações + seed (usa as ferramentas de desenvolvimento) ─────────
FROM build AS migrate
ENV NODE_EXTRA_CA_CERTS=
WORKDIR /app/packages/db
USER node
CMD ["sh", "-c", "npx prisma migrate deploy && npx tsx prisma/seed.ts"]

# ───────── Só dependências de produção do servidor ─────────
# Reinstala apenas o servidor e o que ele usa (sem o cliente nem ferramentas de dev) e
# devolve o cliente Prisma já gerado no estágio de build.
FROM build AS prod-deps
RUN --mount=type=secret,id=ca,required=false --mount=type=cache,id=pnpm,target=/pnpm/store \
  GEN="$(dirname "$(node -p "require.resolve('@prisma/client/package.json',{paths:['packages/db']})")")/../../.prisma" \
  && cp -r "$GEN" /tmp/prisma-gen \
  && rm -rf node_modules apps/*/node_modules packages/*/node_modules apps/client \
  && pnpm install --frozen-lockfile --prod --offline --filter "@vanta/server..." \
  && GEN="$(dirname "$(node -p "require.resolve('@prisma/client/package.json',{paths:['packages/db']})")")/../../.prisma" \
  && rm -rf "$GEN" && cp -r /tmp/prisma-gen "$GEN" \
  && rm -rf packages/*/src apps/server/src apps/server/test apps/server/scripts docs scripts \
  && cd apps/server && node -e "import('./dist/app.js').then(()=>console.log('servidor carrega com dependências de produção'))"

# ───────── API e servidor de jogo ─────────
FROM ${NODE_IMAGE} AS server
# A imagem slim já traz a libssl usada pelo Prisma. Use `init: true` (compose) para encaminhar sinais.
ENV NODE_ENV=production
WORKDIR /app
COPY --from=prod-deps --chown=node:node /app /app
USER node
WORKDIR /app/apps/server
EXPOSE 4000 4100
# Padrão: API. Para o servidor de jogo: command ["node", "dist/game-main.js"].
CMD ["node", "dist/main.js"]

# ───────── Cliente (arquivos estáticos + proxy reverso) ─────────
FROM nginx:1.27-alpine AS web
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/client/dist /usr/share/nginx/html
EXPOSE 8080
