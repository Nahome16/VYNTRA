FROM node:22-alpine AS deps

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

FROM node:22-alpine AS builder

WORKDIR /app

# next.config.ts evalua rewrites() durante `next build` y, con output standalone,
# el destino de /api/* queda fijado en la imagen. Por eso la URL del backend es
# un argumento de BUILD (no solo de runtime). Por defecto apunta al servicio
# `api` de docker-compose.prod.yml.
#   docker build --build-arg VYNTRA_API_URL=http://api:8000 .
ARG VYNTRA_API_URL=http://api:8000
ENV VYNTRA_API_URL=${VYNTRA_API_URL}
ENV NEXT_TELEMETRY_DISABLED=1

COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:22-alpine AS runner

WORKDIR /app

ARG VYNTRA_API_URL=http://api:8000
ENV HOSTNAME=0.0.0.0
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
# Informativo: el valor efectivo del proxy /api/* es el usado en el build.
ENV VYNTRA_API_URL=${VYNTRA_API_URL}

RUN addgroup --system --gid 1001 nodejs \
  && adduser --system --uid 1001 nextjs

COPY --from=builder --chown=nextjs:nodejs /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

USER nextjs

EXPOSE 3000

CMD ["node", "server.js"]
