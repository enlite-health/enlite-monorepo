#!/bin/bash
# ⛔ PROIBIDO RODAR — ver D218 (ebrain, 29/08/2026). Este arquivo é a receita exata do vazamento fechado pelo
# scripts/create-mcp-ro-role.sql: SELECT ON ALL TABLES + ALTER DEFAULT PRIVILEGES contra a instância de prd.
# A role `enlite_readonly` NÃO existe em prod (medido) e o secret não existe. Mantido só como histórico.
echo "PROIBIDO — ver D218"; exit 1
# Wrapper para iniciar o MCP de PostgreSQL com credencial READ-ONLY em producao.
# Usa o role enlite_readonly (apenas SELECT) e busca a senha no GCP Secret Manager.
# Se o Cloud SQL Proxy nao estiver rodando, inicia automaticamente.
#
# Pre-requisitos:
#   - gcloud autenticado no projeto enlite-prd
#   - cloud-sql-proxy instalado (https://cloud.google.com/sql/docs/postgres/sql-proxy)
#   - pg_isready disponivel (pacote postgresql-client)
#   - Role enlite_readonly criado (ver scripts/create-readonly-role.sql)
#   - Acesso ao secret "enlite-ar-db-password-readonly" no Secret Manager

set -euo pipefail

DB_USER="enlite_readonly"
DB_NAME="enlite_ar"
DB_HOST="127.0.0.1"
DB_PORT="${POSTGRES_MCP_PORT:-5436}"
SECRET_NAME="enlite-ar-db-password-readonly"
INSTANCE="enlite-prd:southamerica-west1:enlite-ar-db"
PROXY_PID=""

if ! pg_isready -h "$DB_HOST" -p "$DB_PORT" -q 2>/dev/null; then
  echo "Cloud SQL Proxy nao esta rodando na porta $DB_PORT. Iniciando..." >&2

  if ! command -v cloud-sql-proxy &>/dev/null; then
    echo "ERRO: cloud-sql-proxy nao encontrado no PATH." >&2
    echo "Instale em: https://cloud.google.com/sql/docs/postgres/sql-proxy#install" >&2
    exit 1
  fi

  cloud-sql-proxy --port "$DB_PORT" "$INSTANCE" &
  PROXY_PID=$!

  RETRIES=15
  until pg_isready -h "$DB_HOST" -p "$DB_PORT" -q 2>/dev/null; do
    RETRIES=$((RETRIES - 1))
    if [ "$RETRIES" -eq 0 ]; then
      echo "ERRO: Cloud SQL Proxy nao ficou pronto apos 15 segundos." >&2
      kill "$PROXY_PID" 2>/dev/null
      exit 1
    fi
    sleep 1
  done

  echo "Cloud SQL Proxy pronto na porta $DB_PORT." >&2
fi

DB_PASSWORD=$(gcloud secrets versions access latest --secret="$SECRET_NAME" 2>/dev/null)
if [ -z "$DB_PASSWORD" ]; then
  echo "ERRO: nao foi possivel obter a senha do Secret Manager ($SECRET_NAME)" >&2
  exit 1
fi

DATABASE_URL="postgresql://${DB_USER}:${DB_PASSWORD}@${DB_HOST}:${DB_PORT}/${DB_NAME}"

# Sem --allow-write: defesa em profundidade (alem das grants SELECT-only no banco)
if [ -n "$PROXY_PID" ]; then
  trap 'kill "$PROXY_PID" 2>/dev/null; wait "$PROXY_PID" 2>/dev/null' EXIT
  npx -y @modelcontextprotocol/server-postgres "$DATABASE_URL"
else
  exec npx -y @modelcontextprotocol/server-postgres "$DATABASE_URL"
fi
