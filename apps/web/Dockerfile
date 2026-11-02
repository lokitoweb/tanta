# syntax=docker/dockerfile:1
# Web de Tanta: se compila dentro de Docker y la sirve Caddy (TLS automático + proxy al API).
# Así una instalación nueva no necesita Node ni pnpm en el servidor.

FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /app

COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY apps/web/package.json ./apps/web/
COPY packages/tokens/package.json ./packages/tokens/
RUN pnpm install --filter @tanta/web --filter @tanta/tokens --frozen-lockfile

COPY packages/tokens ./packages/tokens
COPY apps/web ./apps/web
RUN pnpm --filter @tanta/tokens build && pnpm --filter @tanta/web build


FROM caddy:2-alpine
COPY infra/caddy/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /app/apps/web/dist /srv/web
