#!/usr/bin/env bash
# Backup do JARVIS: banco (pg_dump) + fila (Redis AOF), cifrado com a sua senha.
# Uso: ./scripts/backup.sh   → backups/jarvis-AAAAMMDD-HHMM.tar.gz.enc
# Guarde a senha do backup (JARVIS_BACKUP_SENHA no .env) FORA do servidor.
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; source .env; set +a
: "${JARVIS_BACKUP_SENHA:?defina JARVIS_BACKUP_SENHA no .env}"
mkdir -p backups
carimbo=$(date +%Y%m%d-%H%M%S)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
docker compose exec -T postgres pg_dump -U jarvis -d jarvis --format=custom > "$tmp/banco.dump"
docker compose exec -T redis redis-cli BGREWRITEAOF >/dev/null; sleep 2
docker compose cp redis:/data "$tmp/redis" >/dev/null
cp modelos.json "$tmp/" 2>/dev/null || true
tar -C "$tmp" -czf - . | openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt -pass env:JARVIS_BACKUP_SENHA > "backups/jarvis-$carimbo.tar.gz.enc"
# Mantém os 14 mais recentes.
ls -1t backups/jarvis-*.tar.gz.enc | tail -n +15 | xargs -r rm --
echo "backup: backups/jarvis-$carimbo.tar.gz.enc"
