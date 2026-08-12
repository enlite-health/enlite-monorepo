#!/bin/bash
# PreToolUse hook: roda tsc --noEmit no projeto afetado antes de permitir git commit.
# Só dispara para comandos "git commit". Outros comandos git passam direto.

# Hook não herda PATH do shell interativo (NVM/pnpm não estão disponíveis).
# Adicionamos a versão node mais recente do NVM e o pnpm via corepack.
if [ -d "$HOME/.nvm/versions/node" ]; then
  NODE_BIN=$(ls -d "$HOME/.nvm/versions/node"/v*/bin 2>/dev/null | tail -1)
  if [ -n "$NODE_BIN" ]; then
    export PATH="$NODE_BIN:$PATH"
  fi
fi

INPUT=$(cat)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty')

# Só validar commits
if ! echo "$COMMAND" | grep -q "git commit"; then
  exit 0
fi

PROJECT_DIR=$(git rev-parse --show-toplevel 2>/dev/null || pwd)

# Detecta quais projetos têm mudanças staged
BACKEND_CHANGED=$(git diff --cached --name-only 2>/dev/null | grep "^worker-functions/" | head -1)
FRONTEND_CHANGED=$(git diff --cached --name-only 2>/dev/null | grep "^enlite-frontend/" | head -1)

ERRORS=""

if [ -n "$BACKEND_CHANGED" ]; then
  TSC_OUTPUT=$(cd "$PROJECT_DIR/worker-functions" && npx tsc --noEmit 2>&1)
  if [ $? -ne 0 ]; then
    ERRORS="Backend TypeScript errors:\n$TSC_OUTPUT"
  fi
fi

if [ -n "$FRONTEND_CHANGED" ]; then
  TSC_OUTPUT=$(cd "$PROJECT_DIR/enlite-frontend" && pnpm tsc --noEmit 2>&1)
  if [ $? -ne 0 ]; then
    ERRORS="${ERRORS}\nFrontend TypeScript errors:\n$TSC_OUTPUT"
  fi
fi

if [ -n "$ERRORS" ]; then
  echo "Commit bloqueado: TypeScript não compila. Corrija os erros antes de commitar." >&2
  echo -e "$ERRORS" >&2
  exit 2
fi

exit 0
