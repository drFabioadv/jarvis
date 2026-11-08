#!/usr/bin/env bash
# Atualização segura: backup → build da versão nova → migração → health check.
# Se a saúde falhar, volta para a imagem anterior (rollback) sozinho.
# Uso: ./scripts/implantar.sh [git-ref]   (só código verificado: tag ou commit que você escolheu)
set -euo pipefail
cd "$(dirname "$0")/.."
ref="${1:-}"
if [ -n "$ref" ]; then
  git fetch --tags origin
  git -c advice.detachedHead=false checkout "$ref"
  git verify-tag "$ref" 2>/dev/null || git verify-commit "$ref" 2>/dev/null || echo "aviso: $ref não está assinado — confira antes de seguir"
fi
./scripts/backup.sh
anterior=$(docker image inspect jarvis:3 --format '{{.Id}}' 2>/dev/null || true)
[ -n "$anterior" ] && docker tag jarvis:3 jarvis:anterior
docker compose build api
docker compose up -d api worker
echo "aguardando a saúde da API..."
for i in $(seq 1 30); do
  if docker compose exec -T api node -e "fetch('http://127.0.0.1:8080/api/saude').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"; then
    echo "ok: versão nova no ar"; exit 0
  fi
  sleep 4
done
echo "FALHOU: voltando para a versão anterior"
if [ -n "$anterior" ]; then
  docker tag jarvis:anterior jarvis:3
  docker compose up -d --no-build api worker
  echo "rollback feito. Se a migração do banco mudou algo, restaure o último backup com ./scripts/restaurar.sh"
fi
exit 1
