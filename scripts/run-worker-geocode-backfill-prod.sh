#!/bin/bash
# Backfill de geocoding de worker_service_areas em PRODUÇÃO (Cloud SQL).
# Preenche provincia (state) / localidad (city) / coords faltantes a partir de
# address_line OU da zona de texto livre (work_zone/interest_zone). Idempotente.
#
# Uso:
#   ./scripts/run-worker-geocode-backfill-prod.sh --dry-run           # preview (não escreve)
#   ./scripts/run-worker-geocode-backfill-prod.sh --dry-run --limit 40
#   ./scripts/run-worker-geocode-backfill-prod.sh                     # EXECUÇÃO REAL
#
# Pré-requisitos:
#   - gcloud autenticado no projeto enlite-prd
#   - cloud-sql-proxy instalado
#   - Acesso ao secret "enlite-ar-db-password"
#   - A GOOGLE_MAPS_API_KEY vem do env do Cloud Run worker-functions (não precisa expor).
set -e

PROJECT=$(gcloud config get-value project 2>/dev/null)
INSTANCE="${PROJECT}:southamerica-west1:enlite-ar-db"
PROXY_PORT="5440"
DB_USER="enlite_app"
DB_NAME="enlite_ar"

echo "Projeto: $PROJECT | Args: ${*:-<EXECUÇÃO REAL>}"

echo "Buscando senha do banco no Secret Manager..."
DB_PASSWORD=$(gcloud secrets versions access latest --secret="enlite-ar-db-password" 2>/dev/null)
[ -z "$DB_PASSWORD" ] && { echo "Erro: sem senha do Secret Manager"; exit 1; }

echo "Buscando GOOGLE_MAPS_API_KEY do Cloud Run..."
MAPS_KEY=$(gcloud run services describe worker-functions --region=southamerica-west1 --format=json 2>/dev/null \
  | python3 -c 'import sys,json;c=json.load(sys.stdin)["spec"]["template"]["spec"]["containers"][0];print(next((e.get("value","") for e in c.get("env",[]) if e["name"]=="GOOGLE_MAPS_API_KEY"),""))')
[ -z "$MAPS_KEY" ] && { echo "Erro: sem GOOGLE_MAPS_API_KEY no Cloud Run"; exit 1; }

# URL-encode a senha (pode ter caracteres especiais) para a DATABASE_URL.
DB_PASS_ENC=$(python3 -c 'import sys,urllib.parse;print(urllib.parse.quote(sys.argv[1],safe=""))' "$DB_PASSWORD")

echo "Iniciando Cloud SQL Proxy na porta $PROXY_PORT..."
cloud-sql-proxy --port "$PROXY_PORT" "$INSTANCE" &
PROXY_PID=$!
trap 'kill $PROXY_PID 2>/dev/null; wait $PROXY_PID 2>/dev/null' EXIT
sleep 4
# Aborta se o proxy não subiu (ex.: porta ocupada) — evita conectar no lugar errado.
if ! kill -0 "$PROXY_PID" 2>/dev/null; then
  echo "Erro: cloud-sql-proxy não subiu na porta $PROXY_PORT (ocupada?)"; exit 1
fi

cd "$(dirname "$0")/../worker-functions"
DATABASE_URL="postgresql://${DB_USER}:${DB_PASS_ENC}@localhost:${PROXY_PORT}/${DB_NAME}" \
GOOGLE_MAPS_API_KEY="$MAPS_KEY" \
  npx ts-node -r dotenv/config scripts/backfill-worker-service-areas-geocoding.ts "$@"
