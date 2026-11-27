#!/usr/bin/env bash
# e2e/presenca-sem-furo.sh — T-806-61, F9 da emenda 077 "presença sem furo": a jornada ponta a ponta no STACK LOCAL.
#
#   bash e2e/presenca-sem-furo.sh up      sobe o stack (idempotente): docker compose -p presenca806 (WF + 2 Postgres) + attendance em processo
#   bash e2e/presenca-sem-furo.sh run     (padrão) roda a jornada; imprime o controle (8 contagens = 0) e as 8 contagens depois; sai ≠ 0 se divergir
#   bash e2e/presenca-sem-furo.sh down    derruba TUDO do projeto: docker compose -p presenca806 down -v  +  mata o processo do attendance
#
# COMO DERRUBAR À MÃO: (cd worker-functions && docker compose -p presenca806 -f docker-compose.yml -f docker-compose.test.yml \
#                         -f ../e2e/presenca-sem-furo/override.yml down -v) ; kill $(cat /tmp/pr806-attendance.pid)
# NUNCA derruba container de outro projeto: só o projeto `presenca806` (containers pr806-*). Portas (todas em 127.0.0.1):
#   WF 8671 · Postgres do WF 5671 · Postgres do attendance 5672 · attendance 8672 (relógio da app 8673, só harness).
# Idempotência: a jornada semeia massa NOVA (sufixo RUN) e conta SÓ o que é dessa massa — rodar de novo dá as mesmas 8 contagens, no banco vazio ou não.
# Canal: nada real. NODE_ENV=test no WF (e-mail → SKIPPED_TEST), SENDGRID_API_KEY vazia, Twilio/Google/SendGrid resolvendo para 127.0.0.1, OTP em bypass;
# o attendance só fala com o WF local (127.0.0.1). Nenhuma ação da jornada enfileira o espelhamento do Ana Care (a jornada imprime os domain_events).
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
WFDIR="$REPO/worker-functions"
ATT_REPO="${ATT_REPO:-/Users/gabrielstein-dev/projects/enlite/ebrain/repos/_worktrees/077-att-806}"
PIDF=/tmp/pr806-attendance.pid
LOGF=/tmp/pr806-attendance.log
DC() { (cd "$WFDIR" && docker compose -p presenca806 -f docker-compose.yml -f docker-compose.test.yml -f ../e2e/presenca-sem-furo/override.yml "$@"); }
PSQL_WF() { docker exec pr806-postgres psql -U enlite_admin -d enlite_e2e "$@"; }

wait_health() { local n=0; until [ "$(docker inspect -f '{{.State.Health.Status}}' "$1" 2>/dev/null)" = healthy ]; do n=$((n+1)); [ $n -gt 60 ] && { echo "timeout esperando $1" >&2; return 1; }; sleep 3; done; }

up() {
  DC up -d --build postgres att-postgres api >/dev/null 2>&1 || true   # 1º boot do api pode cair no gate do engine ABAC (marcador abaixo)
  wait_health pr806-postgres; wait_health pr806-att-postgres
  docker exec -i pr806-att-postgres psql -U postgres -v ON_ERROR_STOP=0 -q < "$HERE/presenca-sem-furo/att-pg-init.sql" >/dev/null 2>&1 || true   # roles/DB do attendance (idempotente)
  for _ in $(seq 1 30); do PSQL_WF -Atc "select 1 from iam.rollout_state limit 1" >/dev/null 2>&1 && break; sleep 3; done
  PSQL_WF -qc "INSERT INTO iam.rollout_state (key,value,note,updated_by) VALUES ('permission_groups_migrated','done','stack e2e local presenca806','e2e:local') ON CONFLICT (key) DO UPDATE SET value='done'"
  DC up -d api >/dev/null 2>&1; DC restart api >/dev/null 2>&1; wait_health pr806-api
  if ! { [ -f "$PIDF" ] && kill -0 "$(cat "$PIDF")" 2>/dev/null; }; then
    ATT_REPO="$ATT_REPO" nohup node "$HERE/presenca-sem-furo/attendance-server.js" > "$LOGF" 2>&1 & echo $! > "$PIDF"
    for _ in $(seq 1 40); do grep -q READY "$LOGF" 2>/dev/null && break; sleep 2; done
    grep -q READY "$LOGF" || { echo "attendance não subiu:"; tail -5 "$LOGF"; exit 1; }
  fi
  echo "stack no ar: WF 127.0.0.1:8671 · attendance 127.0.0.1:8672"
}

down() {
  DC down -v
  [ -f "$PIDF" ] && kill "$(cat "$PIDF")" 2>/dev/null || true
  rm -f "$PIDF"; echo "derrubado: projeto presenca806 + processo do attendance"
}

run() {
  for u in "http://127.0.0.1:8671/health" "http://127.0.0.1:8672/internal/v1/me"; do curl -s -o /dev/null --max-time 5 "$u" || { echo "stack fora do ar ($u): rode 'bash e2e/presenca-sem-furo.sh up'" >&2; exit 2; }; done
  cd "$WFDIR"
  NODE_PATH="$WFDIR/node_modules" node "$HERE/presenca-sem-furo/journey.js"
}

case "${1:-run}" in up) up;; down) down;; run) run;; *) echo "uso: $0 up|run|down" >&2; exit 2;; esac
