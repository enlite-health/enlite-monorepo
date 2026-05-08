#!/bin/bash
# Script para rodar uma migration específica no banco de STAGING (Cloud SQL)
# Uso: ./scripts/run-migration-stg.sh worker-functions/migrations/104_recreate_worker_availability.sql
#
# Pré-requisitos:
#   - gcloud autenticado, com acesso ao projeto enlite-stg
#   - cloud-sql-proxy instalado
#   - psql instalado
#   - Acesso ao secret "enlite-ar-db-password" no Secret Manager de enlite-stg

set -e

if [ -z "$1" ]; then
  echo "Uso: $0 <caminho-da-migration>"
  echo "Exemplo: $0 worker-functions/migrations/104_recreate_worker_availability.sql"
  exit 1
fi

MIGRATION_FILE="$1"

if [ ! -f "$MIGRATION_FILE" ]; then
  echo "Arquivo não encontrado: $MIGRATION_FILE"
  exit 1
fi

PROJECT="enlite-stg"
DB_USER="enlite_app"
DB_NAME="enlite_ar"
INSTANCE="${PROJECT}:southamerica-west1:enlite-ar-db"
PROXY_PORT="5436" # diferente do prd (5435) pra poder rodar os 2 ao mesmo tempo

echo "Projeto:   $PROJECT (STAGING)"
echo "Database:  $DB_NAME"
echo "Migration: $MIGRATION_FILE"
echo ""

# Busca senha do Secret Manager (no projeto stg)
echo "Buscando senha no Secret Manager (enlite-stg)..."
DB_PASSWORD=$(gcloud secrets versions access latest --secret="enlite-ar-db-password" --project="$PROJECT" 2>/dev/null)
if [ -z "$DB_PASSWORD" ]; then
  echo "Erro: nao foi possivel obter senha do Secret Manager."
  echo "Verifique se o secret 'enlite-ar-db-password' existe em $PROJECT e tem uma versao com valor."
  exit 1
fi

# Inicia Cloud SQL Proxy em background
echo "Iniciando Cloud SQL Proxy na porta $PROXY_PORT..."
cloud-sql-proxy --port "$PROXY_PORT" "$INSTANCE" &
PROXY_PID=$!

trap 'kill $PROXY_PID 2>/dev/null; wait $PROXY_PID 2>/dev/null' EXIT

sleep 4

echo "Executando migration..."
echo ""
PGPASSWORD="$DB_PASSWORD" psql \
  --host="localhost" \
  --port="$PROXY_PORT" \
  --username="$DB_USER" \
  --dbname="$DB_NAME" \
  --file="$MIGRATION_FILE" \
  --set="ON_ERROR_STOP=1"

echo ""
echo "Migration aplicada com sucesso em STAGING!"
