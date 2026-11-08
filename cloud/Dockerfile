# syntax=docker/dockerfile:1.7
# J.A.R.V.I.S. 3.0 — uma imagem para a API e o worker.
# Contexto de build: a RAIZ do repositório (precisa do frontend em ../src).
#   docker build -f cloud/Dockerfile -t jarvis:3 .
# ARG STT=1 inclui a audição Whisper no servidor (imagem ~400 MB maior).

# ---------- 1) interface (PWA) compilada no modo nuvem
FROM node:22-bookworm-slim AS web
WORKDIR /src
COPY package.json package-lock.json ./
# O certificado extra (secret "ca") só existe em redes com proxy corporativo.
RUN --mount=type=secret,id=ca,required=false \
    if [ -f /run/secrets/ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/ca; fi; \
    npm ci --ignore-scripts --no-audit --no-fund
COPY index.html vite.config.ts tsconfig*.json ./
COPY public ./public
COPY src ./src
RUN npx vite build --mode cloud

# ---------- 2) servidor
FROM node:22-bookworm-slim
ARG STT=0
ENV NODE_ENV=production JARVIS_STATIC_DIR=/app/web JARVIS_MODELOS_DIR=/data/modelos PORT=8080
WORKDIR /app
COPY cloud/package.json cloud/package-lock.json ./
RUN --mount=type=secret,id=ca,required=false \
    if [ -f /run/secrets/ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/ca; fi; \
    if [ "$STT" = "1" ]; then npm ci --omit=dev --no-audit --no-fund; else npm ci --omit=dev --omit=optional --no-audit --no-fund; fi \
    && npm cache clean --force
COPY cloud/src ./src
COPY cloud/migrations ./migrations
COPY --from=web /src/dist-cloud ./web
RUN mkdir -p /data/modelos && chown -R node:node /data
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/saude').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "src/server.mjs"]
