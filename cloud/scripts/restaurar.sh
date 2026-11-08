#!/usr/bin/env bash
# Restaura um backup (substitui o banco atual!). Uso: ./scripts/restaurar.sh backups/arquivo.tar.gz.enc
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; source .env; set +a
arq="${1:?informe o arquivo de backup}"
: "${JARVIS_BACKUP_SENHA:?defina JARVIS_BACKUP_SENHA no .env}"
read -r -p "Isto SUBSTITUI os dados atuais do JARVIS por $arq. Digite RESTAURAR para continuar: " ok
[ "$ok" = "RESTAURAR" ] || { echo "cancelado"; exit 1; }
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass env:JARVIS_BACKUP_SENHA -in "$arq" | tar -C "$tmp" -xzf -
docker compose stop api worker
docker compose exec -T postgres pg_restore -U jarvis -d jarvis --clean --if-exists < "$tmp/banco.dump"
docker compose stop redis
docker compose cp "$tmp/redis/." redis:/data
docker compose up -d redis api worker
echo "restaurado de $arq"
