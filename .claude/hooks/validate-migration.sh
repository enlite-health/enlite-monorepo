#!/bin/bash
# PreToolUse hook: bloqueia escrita de migrations com DROP/DELETE destrutivo sem padrão de deprecação.
# Regra: nunca dropar coluna/tabela sem renomear para _deprecated_YYYYMMDD primeiro.

INPUT=$(cat)
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')

# Só valida arquivos de migration
if ! echo "$FILE_PATH" | grep -q "migrations/.*\.sql"; then
  exit 0
fi

CONTENT=$(echo "$INPUT" | jq -r '.tool_input.content // .tool_input.new_string // empty')

# Ignora se não tem conteúdo (ex: Read)
if [ -z "$CONTENT" ]; then
  exit 0
fi

# Detecta operações destrutivas
HAS_DROP=$(echo "$CONTENT" | grep -iE "DROP\s+(TABLE|COLUMN|INDEX|CONSTRAINT)" | grep -iv "_deprecated_" | head -1)
HAS_DELETE=$(echo "$CONTENT" | grep -iE "DELETE\s+FROM" | grep -iv "schema_migrations" | head -1)
HAS_TRUNCATE=$(echo "$CONTENT" | grep -iE "TRUNCATE" | head -1)

if [ -n "$HAS_DROP" ] || [ -n "$HAS_DELETE" ] || [ -n "$HAS_TRUNCATE" ]; then
  echo "Migration bloqueada: operação destrutiva detectada sem padrão de deprecação." >&2
  echo "Regra: renomear para _deprecated_YYYYMMDD antes de dropar. DELETE/TRUNCATE requer justificativa." >&2
  echo "Operação encontrada: ${HAS_DROP}${HAS_DELETE}${HAS_TRUNCATE}" >&2
  exit 2
fi

# Defesa contra "código continua referenciando coluna dropada":
# Quando a migration faz DROP COLUMN (mesmo de _deprecated_), faz grep no
# código de produção (src/ + scripts/) pra ver se algum SQL/string crua ainda
# referencia o nome ORIGINAL da coluna. tsc é cego pra SQL — esta é a defesa.
DROP_COLS=$(echo "$CONTENT" \
  | grep -iE "DROP\s+COLUMN" \
  | sed -E 's/.*DROP[[:space:]]+COLUMN[[:space:]]+(IF[[:space:]]+EXISTS[[:space:]]+)?([a-z_][a-z0-9_]*).*/\2/i' \
  | sed -E 's/_deprecated_[0-9]+$//' \
  | sort -u)

if [ -n "$DROP_COLS" ]; then
  REPO_ROOT=$(dirname "$(dirname "$(dirname "$0")")")
  HITS_TOTAL=""
  for col in $DROP_COLS; do
    # Ignora colunas com nomes muito genéricos (id, created_at, etc.) — alta chance de falso positivo
    case "$col" in
      id|created_at|updated_at|deleted_at|name|status|type|value|data) continue ;;
    esac
    HITS=$(grep -rn --include="*.ts" --include="*.js" --include="*.sql" "\b${col}\b" \
      "$REPO_ROOT/worker-functions/src/" \
      "$REPO_ROOT/worker-functions/scripts/" 2>/dev/null \
      | grep -v "_deprecated_" \
      | grep -v "// .*${col}" \
      | head -3)
    if [ -n "$HITS" ]; then
      HITS_TOTAL+="\n  Coluna '${col}' ainda referenciada em:\n${HITS}\n"
    fi
  done
  if [ -n "$HITS_TOTAL" ]; then
    echo "Migration bloqueada: colunas sendo dropadas ainda têm referências no código de produção." >&2
    printf "%b\n" "$HITS_TOTAL" >&2
    echo "Atualize o código (ou apague o trecho órfão) ANTES de aplicar o DROP." >&2
    echo "tsc não pega SQL string crua — esta é a defesa que pega." >&2
    exit 2
  fi
fi

exit 0
