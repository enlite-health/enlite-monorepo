#!/usr/bin/env bash
# stack-e2e-local.sh — sobe a stack e2e local IGUAL à do CI (`.github/workflows/_frontend-integration.yml`,
# job `integration-e2e`): postgres + fake-gcs (bucket por POST) -> api -> firebase-emulator (--no-deps)
# -> Vite com as VITE_* do CI. Item 19 da spec 038.
#
# Uso:  bash scripts/stack-e2e-local.sh up | down | status | --autoteste
#
# As 7 armadilhas medidas (memória stack-e2e-real-local e vizinhas) e como o script as neutraliza:
#  1. `.env`: o compose e o Vite leem `.env` sozinhos (credencial real vazaria p/ a stack)
#       -> compose roda sob `env -i` + `--env-file` vazio; Vite sob `env -i`; `.env*` com chave real = RECUSA.
#  2. imagem da API é da worktree que a buildou -> `docker compose build api` SEMPRE, tag `e2e-<worktree>-api:local`.
#  3. emulador sobe como `demo-no-project`, não `enlite-e2e-test` -> como no CI, a API fica em USE_MOCK_AUTH=true
#       e SEM o override do firebase (o override é que dependeria desse project id); o emulador sobe só p/ os helpers.
#  4. claim de papel no token -> no modo mock da API o papel vem do token `mock_*` que os specs cunham; o script
#       não aplica o override que o exigiria (modo Firebase real com claim = fora do escopo, ver LISTA do relatório).
#  5. stub 9911 do Periskope -> a API sobe com PERISKOPE_BASE_URL=host.docker.internal:9911 e chave falsa
#       (docker-compose.test.yml); `up` PROVA no fim os nomes de env de canal e que nenhuma é valor real.
#  6. dev server igual ao CI -> Vite sob `env -i` com as MESMAS VITE_* do CI e SEM VITE_FIREBASE_AUTH_EMULATOR
#       (com ele 74/161 specs dão vermelho falso); porta 5173 estrita, e prova de que o dono da porta é esta worktree.
#  7. `node_modules` compartilhado por symlink entre worktrees -> recusa symlink (ou alvo fora da worktree) e
#       instala `pnpm install --frozen-lockfile` na própria worktree.
#
# Portas: as do CI (5433/5432 postgres, 8080 api, 54443 fake-gcs, 9099/9199/4000 emulador, 5173 vite). Ocupada =
# ABORTA dizendo quem a segura; nada é morto. Override de porta NÃO é barato (CORS da API fixa 5173; a chave do
# Maps é presa a 5173; compose concatena `ports:`) — não implementado.
# Nunca derruba container de outro projeto: só `-p e2e-<worktree>`.
set -u

SCRIPT_PATH="${BASH_SOURCE[0]}"
RAIZ="$(cd "$(dirname "$SCRIPT_PATH")/.." && pwd -P)"
PORTAS_CI="5432 5433 8080 54443 9099 9199 4000 5173"
# Nomes de env que, com valor não-vazio e não-falso, indicam credencial real.
RE_SENSIVEL='(TWILIO|TALENTUM|VERTEX|AIPLATFORM|PERISKOPE|WHATSAPP|WABA|CLICKUP|ANACARE|ANA_CARE|AXONICO|AXIONICO|SENDGRID|API_KEY|SECRET|TOKEN|PASSWORD|PRIVATE_KEY|SERVICE_ACCOUNT|CREDENTIAL|GOOGLE|FIREBASE)'
RE_FALSO='^(stub|fake|demo|your-|change|test|e2e|0+$|1:0+:web:0+$|placeholder|xxx)'

die() { echo "ERRO: $*" >&2; exit 1; }
info() { echo "[stack-e2e] $*"; }

# ── nome do projeto: e2e-<basename da worktree>, saneado p/ o compose ──
nome_projeto() {
  local base
  base="$(basename "$1" | tr 'A-Z' 'a-z' | sed 's/[^a-z0-9_-]/-/g')"
  echo "e2e-${base}"
}

# ── porta ocupada: devolve 0 e imprime o dono; 1 se livre ──
dono_da_porta() {
  local porta="$1" pid cmd c
  pid="$(lsof -nP -iTCP:"$porta" -sTCP:LISTEN -t 2>/dev/null | head -1)"
  [ -z "$pid" ] && return 1
  cmd="$(ps -o comm= -p "$pid" 2>/dev/null | head -1)"
  c=""
  if docker info >/dev/null 2>&1; then
    c="$(docker ps --format '{{.Names}} {{.Ports}}' 2>/dev/null | grep -E "(:|->)${porta}(->|/)|:${porta}->" | awk '{print $1}' | head -1)"
  fi
  if [ -n "$c" ]; then echo "container $c (pid $pid, $cmd)"; else echo "processo $cmd (pid $pid)"; fi
  return 0
}

checa_portas() {
  local p dono ruim=0
  for p in $PORTAS_CI; do
    if dono="$(dono_da_porta "$p")"; then
      echo "ERRO: porta $p ocupada por $dono" >&2
      ruim=1
    fi
  done
  return $ruim
}

# ── .env com chave real: 0 = tem chave real (RECUSAR), 1 = limpo ──
# Lê só NOME e classifica o valor; nunca imprime valor.
env_tem_chave_real() {
  local f="$1" linha nome valor ruim=1
  [ -f "$f" ] || return 1
  while IFS= read -r linha || [ -n "$linha" ]; do
    case "$linha" in ''|\#*) continue;; esac
    nome="${linha%%=*}"; nome="${nome#export }"
    valor="${linha#*=}"; valor="${valor%\"}"; valor="${valor#\"}"; valor="${valor%\'}"; valor="${valor#\'}"
    echo "$nome" | grep -Eq "$RE_SENSIVEL" || continue
    [ -z "$valor" ] && continue
    echo "$valor" | grep -Eiq "$RE_FALSO" && continue
    echo "  $f: variável $nome tem valor não-falso" >&2
    ruim=0
  done < "$f"
  return $ruim
}

checa_envs() {
  local f achou=0
  for f in "$RAIZ"/worker-functions/.env "$RAIZ"/worker-functions/.env.* "$RAIZ"/enlite-frontend/.env "$RAIZ"/enlite-frontend/.env.*; do
    [ -f "$f" ] || continue
    case "$f" in *.example|*.sample) continue;; esac
    if env_tem_chave_real "$f"; then
      achou=1
    else
      case "$f" in
        */enlite-frontend/.env*|*/worker-functions/.env) echo "AVISO: $f existe (sem chave real); o Vite/compose o leria e o CI não tem .env — mova para o lado." >&2;;
      esac
    fi
  done
  if [ "$achou" = 1 ]; then
    echo "ERRO: .env com credencial real na worktree. Este script não o lê e a stack não pode tocar canal real; mova-o (mv .env .env.bak) e rode de novo." >&2
    return 1
  fi
  return 0
}

# ── node_modules: recusa symlink / alvo fora da worktree ──
checa_node_modules() {
  local d ruim=0 alvo
  for d in "$1"/enlite-frontend/node_modules "$1"/worker-functions/node_modules; do
    [ -e "$d" ] || [ -L "$d" ] || continue
    if [ -L "$d" ]; then
      echo "ERRO: $d é symlink (-> $(readlink "$d")): node_modules compartilhado é disputado entre worktrees. Remova (rm \"$d\") e deixe o script instalar." >&2
      ruim=1; continue
    fi
    alvo="$(cd "$d" && pwd -P)"
    case "$alvo" in "$1"/*) ;; *) echo "ERRO: $d resolve fora da worktree ($alvo)" >&2; ruim=1;; esac
  done
  return $ruim
}

# ── estado em arquivo (pid, log, env vazio do compose) ──
estado_dir() { echo "${TMPDIR:-/tmp}/stack-e2e-local/$1"; }

dc() {
  # `env -i`: nada do shell do usuário (CLICKUP_*, PERISKOPE_*...) interpola no compose;
  # `--env-file` vazio: o `.env` de worker-functions NÃO é lido.
  ( cd "$RAIZ/worker-functions" && env -i PATH="$PATH" HOME="$HOME" E2E_PROJECT="$PROJ" \
      docker compose --env-file "$ESTADO/vazio.env" -p "$PROJ" \
      -f docker-compose.yml -f docker-compose.test.yml -f docker-compose.e2e-local.yml "$@" )
}
dc_fb() { # com o override do emulador (só p/ o serviço firebase-emulator, --no-deps, como o CI)
  ( cd "$RAIZ/worker-functions" && env -i PATH="$PATH" HOME="$HOME" E2E_PROJECT="$PROJ" \
      docker compose --env-file "$ESTADO/vazio.env" -p "$PROJ" \
      -f docker-compose.yml -f docker-compose.test.yml -f docker-compose.e2e-local.yml -f docker-compose.firebase.yml "$@" )
}

espera() { # nome url [regex-no-corpo]
  local i corpo
  for i in $(seq 1 60); do
    corpo="$(curl -sf "$2" 2>/dev/null)" && { [ -z "${3:-}" ] || echo "$corpo" | grep -Eq "$3"; } && { info "$1 pronto"; return 0; }
    sleep 2
  done
  echo "ERRO: $1 não respondeu em 120s ($2)" >&2
  return 1
}

memoria_ok() {
  command -v memory_pressure >/dev/null 2>&1 || return 0
  local livre
  livre="$(memory_pressure 2>/dev/null | tail -1 | grep -Eo '[0-9]+%' | tr -d %)"
  [ -z "$livre" ] && return 0
  info "memória livre: ${livre}%"
  [ "$livre" -ge 25 ] || { echo "ERRO: menos de 25% de memória livre (${livre}%); aborte outras coisas antes." >&2; return 1; }
}

# ── prova de canal: NOMES de env do container da API + classe do valor (nunca o valor) ──
prova_canal() {
  local nome valor classe real=0
  info "env de canal no container ${PROJ}-api (nome = classe):"
  while IFS= read -r linha; do
    nome="${linha%%=*}"; valor="${linha#*=}"
    echo "$nome" | grep -Eq "$RE_SENSIVEL|ORIGIN|BASE_URL|BUCKET|EMULATOR" || continue
    if [ -z "$valor" ]; then classe=vazio
    elif echo "$valor" | grep -Eq 'host\.docker\.internal|fake-gcs|firebase-emulator|localhost|127\.0\.0\.1|@postgres:'; then classe=stub
    elif echo "$valor" | grep -Eiq "stub|fake|demo|e2e|test|-ci$|^[0-9]*00000$|^(true|false|0)$"; then classe=falso
    else classe="REAL?"; real=1; fi
    echo "  $nome = $classe"
  done < <(docker inspect "${PROJ}-api" --format '{{range .Config.Env}}{{println .}}{{end}}')
  [ "$real" = 0 ] || { echo "ERRO: variável de canal com valor que não é vazio/stub/falso" >&2; return 1; }
}

cmd_up() {
  local t0=$SECONDS
  [ -d "$RAIZ/worker-functions" ] && [ -d "$RAIZ/enlite-frontend" ] || die "rode a partir de uma worktree do monorepo"
  for b in docker pnpm curl lsof nc node; do command -v $b >/dev/null || die "falta $b no PATH"; done
  docker info >/dev/null 2>&1 || die "Docker não está respondendo (open -a Docker e espere \`docker info\`)"
  checa_envs || exit 1
  checa_node_modules "$RAIZ" || exit 1
  memoria_ok || exit 1
  mkdir -p "$ESTADO"; : > "$ESTADO/vazio.env"
  info "projeto: $PROJ  worktree: $RAIZ"

  info "do zero: derrubando SÓ o projeto $PROJ (se houver)"
  cmd_down_quiet
  checa_portas || exit 1

  info "pnpm install --frozen-lockfile (enlite-frontend, node_modules próprio)"
  ( cd "$RAIZ/enlite-frontend" && pnpm install --frozen-lockfile >"$ESTADO/pnpm.log" 2>&1 ) || { tail -20 "$ESTADO/pnpm.log"; die "pnpm install falhou"; }
  checa_node_modules "$RAIZ" || exit 1
  ( cd "$RAIZ/enlite-frontend" && npx playwright install chromium >"$ESTADO/playwright.log" 2>&1 ) || { tail -20 "$ESTADO/playwright.log"; die "playwright install falhou"; }

  memoria_ok || exit 1
  info "build da imagem da API DESTA worktree"
  dc build api >"$ESTADO/build.log" 2>&1 || { tail -30 "$ESTADO/build.log"; die "build da API falhou"; }
  info "imagem: $(docker image inspect "${PROJ}-api:local" --format '{{.Id}} criada {{.Created}}')"

  memoria_ok || exit 1
  dc up -d postgres fake-gcs || die "up postgres/fake-gcs falhou"
  espera "fake-gcs" http://localhost:54443/storage/v1/b || { dc logs fake-gcs | tail -50; exit 1; }
  curl -sf -X POST http://localhost:54443/storage/v1/b -H 'Content-Type: application/json' \
    -d '{"name":"enlite-patient-photos-ci"}' >/dev/null || die "criar bucket enlite-patient-photos-ci falhou"
  dc up -d api || die "up api falhou"
  dc_fb up -d --no-deps firebase-emulator || die "up firebase-emulator falhou"
  espera "api" http://localhost:8080/health '"status" *: *"healthy"' || { dc logs api | tail -50; exit 1; }
  espera "emulador Firebase" http://localhost:9099/ || { dc_fb logs firebase-emulator | tail -50; exit 1; }

  info "subindo o Vite (env -i, VITE_* do CI, sem VITE_FIREBASE_AUTH_EMULATOR)"
  ( cd "$RAIZ/enlite-frontend" || exit 1
    # `cd` fora do `&`: o pid gravado tem de ser o do node do Vite, não de um subshell.
    env -i PATH="$PATH" HOME="$HOME" \
      VITE_API_WORKER_FUNCTIONS_URL=http://localhost:8080 \
      VITE_USE_PUBLIC_JOBS_API=true \
      VITE_GOOGLE_MAPS_API_KEY="${VITE_GOOGLE_MAPS_API_KEY:-}" \
      VITE_FIREBASE_API_KEY=fake-api-key-for-e2e \
      VITE_FIREBASE_AUTH_DOMAIN=demo-e2e.firebaseapp.com \
      VITE_FIREBASE_PROJECT_ID=demo-e2e \
      VITE_FIREBASE_STORAGE_BUCKET=demo-e2e.appspot.com \
      VITE_FIREBASE_MESSAGING_SENDER_ID=000000000000 \
      VITE_FIREBASE_APP_ID=1:000000000000:web:0000000000000000000000 \
      VITE_PATIENT_PHOTO_ENABLED=true \
      nohup node node_modules/vite/bin/vite.js --port 5173 --strictPort >"$ESTADO/vite.log" 2>&1 &
    echo $! >"$ESTADO/vite.pid" )
  espera "vite" http://localhost:5173/ || { tail -50 "$ESTADO/vite.log"; exit 1; }
  local dono
  dono="$(lsof -p "$(lsof -nP -iTCP:5173 -sTCP:LISTEN -t | head -1)" 2>/dev/null | awk '$4=="cwd"{print $NF}')"
  case "$dono" in "$RAIZ"/*) info "5173 é desta worktree ($dono)";; *) die "5173 respondeu mas o dono tem cwd=$dono (não é esta worktree)";; esac

  prova_canal || exit 1
  info "TEMPO TOTAL: $((SECONDS - t0))s"
  imprime_variaveis
}

imprime_variaveis() {
  cat <<EOF

# ── variáveis dos specs (copie/exporte) ──
export E2E_BACKEND_URL=http://localhost:8080
export E2E_PG_CONTAINER=${PROJ}-postgres
export E2E_FIREBASE_EMULATOR=http://127.0.0.1:9099
export PW_BASE_URL=http://localhost:5173
# DATABASE_URL local (postgres publicado em 5433): postgresql://enlite_admin:enlite_password@localhost:5433/enlite_e2e
# exemplo (como o CI, que usa --ignore-snapshots):
#   cd enlite-frontend && npx playwright test --project=integration --ignore-snapshots --grep <spec>
# log do Vite: $ESTADO/vite.log   pid: $(cat "$ESTADO/vite.pid" 2>/dev/null)
EOF
}

mata_vite() {
  local pid cwd
  pid="$(cat "$ESTADO/vite.pid" 2>/dev/null || true)"
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    cwd="$(lsof -p "$pid" 2>/dev/null | awk '$4=="cwd"{print $NF}')"
    case "$cwd" in
      "$RAIZ"/*) kill "$pid" 2>/dev/null; info "Vite (pid $pid) encerrado";;
      *) echo "AVISO: pid $pid não é o Vite desta worktree (cwd=$cwd); não mato." >&2;;
    esac
  fi
  rm -f "$ESTADO/vite.pid"
  # órfão (pid antigo/subshell): o dono da 5173 só morre se o cwd for DESTA worktree
  pid="$(lsof -nP -iTCP:5173 -sTCP:LISTEN -t 2>/dev/null | head -1)"
  if [ -n "$pid" ]; then
    cwd="$(lsof -p "$pid" 2>/dev/null | awk '$4=="cwd"{print $NF}')"
    case "$cwd" in "$RAIZ"/*) kill "$pid" 2>/dev/null; info "Vite órfão da 5173 (pid $pid) encerrado";; esac
  fi
}

cmd_down_quiet() {
  mata_vite
  if docker info >/dev/null 2>&1; then
    case "$PROJ" in e2e-*) ;; *) die "nome de projeto inesperado: $PROJ";; esac
    mkdir -p "$ESTADO"; [ -f "$ESTADO/vazio.env" ] || : > "$ESTADO/vazio.env"
    dc down -v --remove-orphans >/dev/null 2>&1
  fi
}

cmd_down() {
  info "down do projeto $PROJ (nada de outros projetos é tocado)"
  mata_vite
  if docker info >/dev/null 2>&1; then
    mkdir -p "$ESTADO"; [ -f "$ESTADO/vazio.env" ] || : > "$ESTADO/vazio.env"
    dc down -v --remove-orphans
    info "restam do projeto: $(docker ps -a --filter "label=com.docker.compose.project=$PROJ" --format '{{.Names}}' | wc -l | tr -d ' ') container(s)"
  else
    info "Docker não responde; só o Vite foi tratado"
  fi
}

cmd_status() {
  info "projeto: $PROJ"
  if docker info >/dev/null 2>&1; then
    docker ps -a --filter "label=com.docker.compose.project=$PROJ" --format '  {{.Names}}  {{.Status}}'
  else
    echo "  Docker não responde"
  fi
  if [ -f "$ESTADO/vite.pid" ] && kill -0 "$(cat "$ESTADO/vite.pid")" 2>/dev/null; then echo "  vite: vivo (pid $(cat "$ESTADO/vite.pid"))"; else echo "  vite: parado"; fi
  echo "  /health: $(curl -s -o /dev/null -w '%{http_code}' http://localhost:8080/health 2>/dev/null)  5173: $(curl -s -o /dev/null -w '%{http_code}' http://localhost:5173/ 2>/dev/null)  9099: $(curl -s -o /dev/null -w '%{http_code}' http://localhost:9099/ 2>/dev/null)"
}

# ── autoteste: o que dá para provar sem docker; dois lados em cada caso ──
cmd_autoteste() {
  local ok=0 falha=0 t
  check() { if eval "$2"; then ok=$((ok+1)); echo "ok   - $1"; else falha=$((falha+1)); echo "FALHA - $1"; fi; }
  t="$(mktemp -d)"

  # 1. nome de projeto derivado (2 lados: worktrees diferentes -> nomes diferentes; saneamento)
  check "nome: 038-f3-i19 -> e2e-038-f3-i19" '[ "$(nome_projeto /x/_worktrees/038-f3-i19)" = "e2e-038-f3-i19" ]'
  check "nome: outra worktree -> nome diferente" '[ "$(nome_projeto /x/_worktrees/abac-retomada)" != "$(nome_projeto /x/_worktrees/038-f3-i19)" ]'
  check "nome: saneia maiúscula/ponto/espaço" '[ "$(nome_projeto "/x/Feat.Um B")" = "e2e-feat-um-b" ]'

  # 2. porta ocupada (nc -l de mentira) vs livre
  local pl=47911
  nc -l "$pl" >/dev/null 2>&1 & local ncpid=$!
  sleep 1
  check "porta ocupada é detectada e o dono é nomeado" 'dono_da_porta '"$pl"' | grep -q "pid"'
  kill "$ncpid" 2>/dev/null; wait "$ncpid" 2>/dev/null; sleep 1
  check "porta livre não acusa" '! dono_da_porta '"$pl"' >/dev/null'

  # 3. .env com chave real vs falso
  printf 'TWILIO_AUTH_TOKEN=abc123realtoken\nFOO=bar\n' >"$t/real.env"
  printf 'PERISKOPE_API_KEY=stub-key-e2e-only\nVITE_FIREBASE_API_KEY=fake-api-key-for-e2e\nCLICKUP_API_TOKEN=\nVITE_API_WORKER_FUNCTIONS_URL=http://localhost:8080\n' >"$t/falso.env"
  check ".env com chave real é RECUSADO" 'env_tem_chave_real "$t/real.env" 2>/dev/null'
  check ".env só com stub/falso/vazio é ACEITO" '! env_tem_chave_real "$t/falso.env" 2>/dev/null'
  check "checa_envs recusa worktree com .env real" \
    'mkdir -p "$t/w1/worker-functions" "$t/w1/enlite-frontend" && cp "$t/real.env" "$t/w1/enlite-frontend/.env" && ! ( RAIZ="$t/w1"; checa_envs ) 2>/dev/null'
  check "checa_envs aceita worktree sem .env" \
    'mkdir -p "$t/w2/worker-functions" "$t/w2/enlite-frontend" && ( RAIZ="$t/w2"; checa_envs ) 2>/dev/null'

  # 4. node_modules symlink vs diretório real
  mkdir -p "$t/alvo-fora/node_modules" "$t/w3/enlite-frontend" "$t/w3/worker-functions" "$t/w4/enlite-frontend/node_modules" "$t/w4/worker-functions"
  ln -s "$t/alvo-fora/node_modules" "$t/w3/enlite-frontend/node_modules"
  check "node_modules symlink é RECUSADO" '! checa_node_modules "$t/w3" 2>/dev/null'
  check "node_modules diretório real é ACEITO" 'checa_node_modules "$(cd "$t/w4" && pwd -P)" 2>/dev/null'

  rm -rf "$t"
  echo "autoteste: $ok ok, $falha falha"
  [ "$falha" = 0 ]
}

main() {
  case "${1:-}" in
    --autoteste) cmd_autoteste; exit $?;;
    up|down|status) ;;
    *) echo "uso: $0 up|down|status|--autoteste" >&2; exit 2;;
  esac
  PROJ="$(nome_projeto "$RAIZ")"
  ESTADO="$(estado_dir "$PROJ")"
  case "$1" in up) cmd_up;; down) cmd_down;; status) cmd_status;; esac
}

[ "${STACK_E2E_SOURCE_ONLY:-}" = 1 ] || main "$@"
