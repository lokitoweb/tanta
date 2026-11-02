# syntax=docker/dockerfile:1
# Imagen del API de Tanta. Multi-etapa: compila con devDependencies y corre solo con lo necesario.

FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /app

# Se copian primero los manifiestos: la capa de dependencias se cachea mientras no cambien.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY apps/api/package.json ./apps/api/
RUN pnpm install --filter @tanta/api --frozen-lockfile

COPY apps/api ./apps/api
RUN pnpm --filter @tanta/api build


FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3001 \
    HOST=0.0.0.0

# Usuario sin privilegios: si alguien entra al contenedor, no es root.
RUN addgroup -S tanta && adduser -S tanta -G tanta

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/apps/api/dist ./dist
COPY --from=build /app/apps/api/db ./db

USER tanta
EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=4s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3001/api/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/src/server.js"]
