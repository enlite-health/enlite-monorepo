#!/usr/bin/env bash
# Smoke test do MCP server (worker-functions-mcp).
#
# Como usar:
#   MCP_URL=https://worker-functions-mcp-xxxx-tl.a.run.app/mcp/v1 \
#   MCP_TOKEN=<bearer-token> \
#   ./scripts/mcp-smoke-test.sh
#
# Ou passando a URL como argumento posicional:
#   MCP_URL=... MCP_TOKEN=... ./scripts/mcp-smoke-test.sh
#
# Testes executados:
#   1. POST sem Authorization → 401 (camada de app-level auth)
#   2. POST com token inválido → 401
#   3. POST com token válido + body vazio → 4xx do SDK MCP (body malformado esperado)
#   4. (Opcional) MCP initialize handshake → 200 com capabilities
#
# Notas:
#   - O service tem --ingress=internal. Rodar este script de dentro de uma
#     VM/Cloud Run no mesmo projeto GCP. Fora da VPC o teste vai time-out ou
#     receber connection refused (esperado — significa que o ingress funciona).
#   - MCP_TOKEN é opcional. Sem ele, o teste 3 e 4 são pulados.

set -euo pipefail

MCP_URL="${MCP_URL:-${1:-}}"
MCP_TOKEN="${MCP_TOKEN:-}"

PASS=0
FAIL=0

_pass() {
  echo "  PASS: $1"
  PASS=$((PASS + 1))
}

_fail() {
  echo "  FAIL: $1"
  FAIL=$((FAIL + 1))
}

_assert_status() {
  local label="$1"
  local expected="$2"
  local actual="$3"
  if [[ "${actual}" == "${expected}" ]]; then
    _pass "${label} — HTTP ${actual}"
  else
    _fail "${label} — esperava ${expected}, recebeu ${actual}"
  fi
}

if [[ -z "${MCP_URL}" ]]; then
  echo "Uso: MCP_URL=https://... [MCP_TOKEN=...] $0"
  exit 1
fi

echo "==> Alvo: ${MCP_URL}"
echo ""

# ---------------------------------------------------------------------------
# Teste 1: POST sem Authorization deve retornar 401
# ---------------------------------------------------------------------------
echo "--- Teste 1: POST sem auth → 401"
STATUS=$(curl -s -o /dev/null -w '%{http_code}' \
  -X POST "${MCP_URL}" \
  -H 'Content-Type: application/json' \
  -d '{}' \
  --max-time 10 \
  || echo "000")
_assert_status "Sem Authorization → 401" "401" "${STATUS}"

# ---------------------------------------------------------------------------
# Teste 2: POST com token inválido deve retornar 401
# ---------------------------------------------------------------------------
echo "--- Teste 2: POST com token inválido → 401"
STATUS=$(curl -s -o /dev/null -w '%{http_code}' \
  -X POST "${MCP_URL}" \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer token-invalido-smoke-test' \
  -d '{}' \
  --max-time 10 \
  || echo "000")
_assert_status "Token inválido → 401" "401" "${STATUS}"

# ---------------------------------------------------------------------------
# Teste 3: POST com token válido + body malformado → 4xx (SDK MCP rejeita)
# Só roda se MCP_TOKEN estiver setado
# ---------------------------------------------------------------------------
if [[ -n "${MCP_TOKEN}" ]]; then
  echo "--- Teste 3: POST com token válido + body vazio → 4xx"
  STATUS=$(curl -s -o /dev/null -w '%{http_code}' \
    -X POST "${MCP_URL}" \
    -H 'Content-Type: application/json' \
    -H "Authorization: Bearer ${MCP_TOKEN}" \
    -d '{}' \
    --max-time 10 \
    || echo "000")
  if [[ "${STATUS}" =~ ^4[0-9][0-9]$ ]]; then
    _pass "Token válido + body inválido → 4xx (${STATUS})"
  else
    _fail "Token válido + body inválido — esperava 4xx, recebeu ${STATUS}"
  fi

  # -------------------------------------------------------------------------
  # Teste 4: MCP initialize handshake → 200 com result
  # -------------------------------------------------------------------------
  echo "--- Teste 4: MCP initialize handshake → 200"
  INIT_BODY='{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "initialize",
    "params": {
      "protocolVersion": "2024-11-05",
      "capabilities": {},
      "clientInfo": { "name": "smoke-test", "version": "0.0.1" }
    }
  }'
  RESPONSE=$(curl -s -w '\n%{http_code}' \
    -X POST "${MCP_URL}" \
    -H 'Content-Type: application/json' \
    -H "Authorization: Bearer ${MCP_TOKEN}" \
    -d "${INIT_BODY}" \
    --max-time 15 \
    || echo -e "\n000")

  STATUS=$(echo "${RESPONSE}" | tail -1)
  BODY=$(echo "${RESPONSE}" | head -n -1)

  if [[ "${STATUS}" == "200" ]]; then
    _pass "Initialize handshake → 200"
    # Verificar que resultado tem "result" com "capabilities"
    if echo "${BODY}" | grep -q '"result"'; then
      _pass "Resposta contém campo 'result'"
    else
      _fail "Resposta não contém campo 'result': ${BODY:0:200}"
    fi
  else
    _fail "Initialize handshake — esperava 200, recebeu ${STATUS}"
  fi
else
  echo "--- Teste 3 e 4: pulados (MCP_TOKEN não setado)"
fi

# ---------------------------------------------------------------------------
# Sumário
# ---------------------------------------------------------------------------
echo ""
echo "==> Resultado: ${PASS} passed, ${FAIL} failed"
if [[ "${FAIL}" -gt 0 ]]; then
  exit 1
fi
