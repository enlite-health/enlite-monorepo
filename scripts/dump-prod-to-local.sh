#!/bin/bash
# Faz pg_dump completo do banco de produção e restaura no container Postgres
# local (enlite-postgres). Sem anonimização, sem limite de linhas — schema +
# dados 1:1 com prod, FKs preservadas.
#
# Uso:
#   ./scripts/dump-prod-to-local.sh
#
# Pré-requisitos:
#   - cloud-sql-proxy instalado e gcloud autenticado em enlite-prd
#   - Container enlite-postgres rodando (subir com: make dev — uma vez)
#   - pg_dump instalado localmente

set -euo pipefail

DB_PORT_PROD=5435
PROD_DB_USER=enlite_app
PROD_DB_NAME=enlite_ar
PROD_DB_SECRET=enlite-ar-db-password

LOCAL_CONTAINER=enlite-postgres
LOCAL_DB_USER=enlite_admin
LOCAL_DB_NAME=enlite_e2e

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

"$REPO_ROOT/scripts/ensure-cloud-sql-proxy.sh"

echo "🔑  Buscando senha de prod no Secret Manager..."
PROD_PASS=$(gcloud secrets versions access latest --secret="$PROD_DB_SECRET" --project=enlite-prd 2>/dev/null || true)
if [ -z "$PROD_PASS" ]; then
  echo "❌  Falha ao obter senha do Secret Manager ($PROD_DB_SECRET)."
  echo "    Execute: gcloud auth login && gcloud config set project enlite-prd"
  exit 1
fi

if ! docker ps --format '{{.Names}}' | grep -q "^${LOCAL_CONTAINER}$"; then
  echo "❌  Container '$LOCAL_CONTAINER' não está rodando."
  echo "    Suba o postgres antes: make dev (Ctrl+C depois que ele estiver up)."
  exit 1
fi

DUMP_FILE="$(mktemp /tmp/enlite-prod-dump-XXXXXX.sql)"
trap 'rm -f "$DUMP_FILE"' EXIT

echo "📥  pg_dump de prod ($PROD_DB_NAME) → $DUMP_FILE..."
PGPASSWORD="$PROD_PASS" pg_dump \
  -h 127.0.0.1 -p "$DB_PORT_PROD" \
  -U "$PROD_DB_USER" -d "$PROD_DB_NAME" \
  --no-owner --no-acl --no-privileges \
  --clean --if-exists \
  > "$DUMP_FILE"

SIZE=$(du -h "$DUMP_FILE" | cut -f1)
echo "✅  Dump completo ($SIZE)."

echo "📤  Restaurando em '$LOCAL_CONTAINER' ($LOCAL_DB_NAME)..."
docker exec -i "$LOCAL_CONTAINER" psql \
  -U "$LOCAL_DB_USER" -d "$LOCAL_DB_NAME" \
  -v ON_ERROR_STOP=0 \
  < "$DUMP_FILE" > /tmp/enlite-restore.log 2>&1 || true

ERRORS=$(grep -cE '^(ERROR|FATAL):' /tmp/enlite-restore.log || true)
if [ "$ERRORS" -gt 0 ]; then
  echo "⚠️   Restore concluído com $ERRORS aviso(s) (geralmente extensões/owners — esperado)."
  echo "    Log completo: /tmp/enlite-restore.log"
else
  echo "✅  Restore limpo."
fi

echo ""
echo "🌱  Banco local agora é réplica de prod. Rode 'make dev' para subir tudo."
