#!/usr/bin/env bash
# check-rapido.sh — check local pré-push, só nos arquivos TOCADOS (spec 038, item 10).
#
# D459: "local só o teste tocado (a suíte é do CI)". Roda:
#   enlite-frontend   : eslint nos tocados (.ts/.tsx, como o `pnpm lint`) + `vitest related`
#   worker-functions  : `jest --findRelatedTests` + cobertura com o threshold por arquivo valendo SÓ para os tocados
#                       (worker-functions não tem eslint: nem dependência nem script no package.json)
# Para na PRIMEIRA falha, na ordem eslint -> vitest related -> jest (o erro de lint sai em ~1 s, sem esperar o jest);
# rc final != 0 se qualquer etapa falhar.
#
# Uso:  scripts/check-rapido.sh [--autoteste]
# Env:  CHECK_BASE=<ref>  sobrescreve a base (default: origin/stage ou origin/main, a com MENOS commits à frente)
set -uo pipefail

if [ "${1:-}" = "--autoteste" ]; then
  # Prova os DOIS lados num repo temporário com `pnpm`/`npx` falsos no PATH (sem node_modules).
  # Por que stubs e não a árvore real: instalar node_modules num mktemp custa minutos e muita RAM, e a prova de
  # que as ferramentas REAIS barram é feita à parte (sabotagem restaurada de cp). Aqui se prova a LÓGICA do
  # script: base, conjunto, roteamento por pasta, "roda tudo", filtro de threshold e propagação do rc.
  SELF="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"
  REAL_WF="$(cd "$(dirname "$SELF")/../worker-functions" && pwd)"
  T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
  FAILS=0
  ok()  { echo "  ok   $1"; }
  bad() { echo "  FAIL $1"; FAILS=$((FAILS+1)); }
  mkdir -p "$T/bin" "$T/origin.git" "$T/w"
  cat > "$T/bin/stub" <<'STUB'
#!/usr/bin/env bash
echo "$(basename "$0") $*" >> "$STUB_LOG"
case "$*" in *"${STUB_FAIL:-__nada__}"*) exit 1;; esac
exit 0
STUB
  chmod +x "$T/bin/stub"; ln -s stub "$T/bin/pnpm"; ln -s stub "$T/bin/npx"
  export STUB_LOG="$T/stub.log" CHECK_MM_PATH="$REAL_WF"
  git init -q --bare "$T/origin.git"
  cd "$T/w" && git init -q -b main && git config user.email t@t && git config user.name t
  mkdir -p scripts enlite-frontend/node_modules enlite-frontend/src worker-functions/node_modules worker-functions/src
  cp "$SELF" scripts/check-rapido.sh
  echo 'module.exports={coverageThreshold:{"src/a.ts":{lines:100},"src/outro.ts":{lines:100},"src/{g,h}.ts":{lines:100}}}' > worker-functions/jest.config.js
  echo x > enlite-frontend/src/base.tsx; echo x > worker-functions/src/a.ts; echo x > worker-functions/src/outro.ts
  git add -A && git commit -qm base && git remote add origin "$T/origin.git"
  git push -q origin main:main
  git checkout -q -b stagebr && echo y >> worker-functions/src/outro.ts && git commit -qam s1 && echo y >> worker-functions/src/outro.ts && git commit -qam s2
  git push -q origin stagebr:stage && git fetch -q origin
  git checkout -q -b feat origin/stage && echo y >> enlite-frontend/src/base.tsx && echo y >> worker-functions/src/a.ts && git commit -qam feat
  run() { : > "$STUB_LOG"; PATH="$T/bin:$PATH" bash scripts/check-rapido.sh >"$T/out" 2>&1; echo $?; }

  echo "[1] LADO BOM: branch da stage (1 commit da stage, 3 da main) escolhe origin/stage"
  rc=$(run); grep -q 'BASE: origin/stage' "$T/out" && ok "base=origin/stage" || bad "base errada: $(grep BASE "$T/out")"
  [ "$rc" = 0 ] && ok "rc 0 com ferramentas verdes" || bad "rc=$rc esperado 0"
  grep -q 'eslint --max-warnings 0 src/base.tsx' "$STUB_LOG" && ok "eslint recebeu o .tsx tocado" || bad "eslint sem o arquivo"
  grep -q 'vitest related --run' "$STUB_LOG" && ok "vitest related rodou" || bad "vitest related ausente"
  grep -q 'findRelatedTests src/a.ts' "$STUB_LOG" && ok "jest recebeu o .ts tocado" || bad "jest sem o arquivo"
  grep -q -- '--collectCoverageFrom=src/a.ts' "$STUB_LOG" && ok "cobertura restrita ao tocado" || bad "collectCoverageFrom errado"
  grep -q 'threshold ativo em 1 de 3 chaves' "$T/out" && ok "threshold filtrado: 1 de 3 (outro.ts e o glob {g,h} fora)" || bad "filtro de threshold: $(grep threshold "$T/out")"

  echo "[1b] nome com acento e espaço (quotepath) chega ao eslint"
  git checkout -q -b acento origin/stage; echo x > "enlite-frontend/src/ação x.ts"; git add -A; git commit -qm acento
  : > "$STUB_LOG"; PATH="$T/bin:$PATH" bash scripts/check-rapido.sh >"$T/out" 2>&1
  grep -q 'eslint --max-warnings 0 src/ação x.ts' "$STUB_LOG" && ok "eslint recebeu 'ação x.ts' cru" || bad "arquivo com acento PULADO: $(cat "$STUB_LOG")"
  git checkout -q feat

  echo "[2] CHECK_BASE sobrescreve"
  : > "$STUB_LOG"; CHECK_BASE=origin/main PATH="$T/bin:$PATH" bash scripts/check-rapido.sh >"$T/out" 2>&1
  grep -q 'BASE: origin/main (CHECK_BASE)' "$T/out" && ok "override respeitado" || bad "override ignorado"
  grep -q 'src/outro.ts' "$STUB_LOG" && ok "conjunto maior contra a main (inclui commits da stage)" || bad "conjunto não cresceu"
  grep -q 'threshold ativo em 2 de 3 chaves' "$T/out" && ok "threshold 2 de 3 (a.ts + outro.ts)" || bad "filtro: $(grep threshold "$T/out")"

  echo "[3] conjunto vazio -> rc 0 + 'nada tocado'"
  git checkout -q -b vazio origin/stage; rc=$(run)
  [ "$rc" = 0 ] && grep -q 'nada tocado' "$T/out" && ok "rc 0, nada tocado" || bad "vazio: rc=$rc"
  git checkout -q feat

  echo "[4] eslint falha -> rc 1 e vitest/jest NÃO rodam (para na primeira falha)"
  : > "$STUB_LOG"; STUB_FAIL=eslint PATH="$T/bin:$PATH" bash scripts/check-rapido.sh >"$T/out" 2>&1; rc=$?
  [ "$rc" != 0 ] && ok "rc=$rc" || bad "eslint falhou e rc=0"
  grep -q 'eslint' "$STUB_LOG" && ok "eslint rodou" || bad "eslint nem rodou"
  grep -q 'vitest' "$STUB_LOG" && bad "vitest rodou depois do eslint vermelho" || ok "vitest NÃO rodou"
  grep -q 'jest' "$STUB_LOG" && bad "jest rodou depois do eslint vermelho" || ok "jest NÃO rodou"
  grep -q 'FALHOU' "$T/out" && ok "resumo marca a etapa falha" || bad "sem resumo de falha"
  echo "[4b] outro lado: eslint verde -> vitest e jest rodam; vitest vermelho -> jest NÃO roda"
  : > "$STUB_LOG"; PATH="$T/bin:$PATH" bash scripts/check-rapido.sh >"$T/out" 2>&1
  grep -q 'vitest' "$STUB_LOG" && grep -q 'jest' "$STUB_LOG" && ok "eslint verde: vitest e jest rodaram" || bad "etapas seguintes não rodaram com eslint verde"
  : > "$STUB_LOG"; STUB_FAIL=vitest PATH="$T/bin:$PATH" bash scripts/check-rapido.sh >"$T/out" 2>&1; rc=$?
  [ "$rc" != 0 ] && ok "rc=$rc" || bad "vitest falhou e rc=0"
  grep -q 'jest' "$STUB_LOG" && bad "jest rodou depois do vitest vermelho" || ok "jest NÃO rodou"

  echo "[5] LADO RUIM: jest falha -> rc != 0"
  STUB_FAIL=findRelatedTests PATH="$T/bin:$PATH" bash scripts/check-rapido.sh >"$T/out" 2>&1; rc=$?
  [ "$rc" != 0 ] && ok "rc=$rc" || bad "jest falhou e rc=0"

  echo "[6] LADO RUIM: sem node_modules -> rc != 0 (não passa em silêncio)"
  mv enlite-frontend/node_modules enlite-frontend/nm_off
  rc=$(run); [ "$rc" != 0 ] && ok "rc=$rc" || bad "sem node_modules e rc=0"
  mv enlite-frontend/nm_off enlite-frontend/node_modules

  echo "[7] LADO RUIM: sem origin/stage nem origin/main -> rc != 0"
  git update-ref -d refs/remotes/origin/stage; git update-ref -d refs/remotes/origin/main
  rc=$(run); [ "$rc" != 0 ] && ok "rc=$rc" || bad "sem base e rc=0"

  if [ "$FAILS" = 0 ]; then echo "AUTOTESTE: PASSOU"; exit 0; fi
  echo "AUTOTESTE: $FAILS falha(s)"; exit 1
fi

ROOT="$(git rev-parse --show-toplevel)" || exit 2
cd "$ROOT" || exit 2

# ---- base: a com MENOS commits à frente (branch da stage diffada contra a main traria centenas de arquivos)
if [ -n "${CHECK_BASE:-}" ]; then
  BASE="$CHECK_BASE"; WHY="CHECK_BASE"
else
  BASE=""; BEST=""
  for cand in origin/stage origin/main; do
    n=$(git rev-list --count "$cand..HEAD" 2>/dev/null) || continue
    if [ -z "$BEST" ] || [ "$n" -lt "$BEST" ]; then BEST="$n"; BASE="$cand"; fi
  done
  WHY="${BEST:-?} commit(s) à frente"
fi
if [ -z "$BASE" ] || ! MB=$(git merge-base "$BASE" HEAD 2>/dev/null); then
  echo "check-rapido: base inexistente (rode 'git fetch origin main stage' ou defina CHECK_BASE)." >&2
  exit 2
fi
echo "BASE: $BASE ($WHY)  merge-base=${MB:0:8}"

# ---- conjunto tocado (A/C/M/R; inclui alterações ainda não commitadas em arquivos rastreados)
# -z + quotepath=off: nome com acento/espaço/quebra de linha vem cru (sem aspas nem \303\243) e não é pulado em silêncio.
TOUCHED_LIST=()
while IFS= read -r -d '' f; do TOUCHED_LIST+=("$f"); done < <(git -c core.quotepath=off diff -z --name-only --diff-filter=ACMR "$MB")
if [ ${#TOUCHED_LIST[@]} -eq 0 ]; then echo "nada tocado — nada a checar."; exit 0; fi

FE_LINT=(); FE_ALL=(); WF_ALL=(); WF_SRC=()
for f in "${TOUCHED_LIST[@]}"; do
  case "$f" in
    enlite-frontend/*.ts|enlite-frontend/*.tsx) FE_LINT+=("${f#enlite-frontend/}"); FE_ALL+=("${f#enlite-frontend/}");;
    enlite-frontend/*.js|enlite-frontend/*.jsx) FE_ALL+=("${f#enlite-frontend/}");;
    worker-functions/*.d.ts) ;;
    worker-functions/*.ts)
      WF_ALL+=("${f#worker-functions/}")
      case "$f" in
        */__tests__/*|*.test.ts|*.spec.ts) ;;
        worker-functions/src/*|worker-functions/scripts/*) WF_SRC+=("${f#worker-functions/}");;
      esac;;
  esac
done
echo "tocados: frontend=${#FE_ALL[@]} worker-functions=${#WF_ALL[@]} (de ${#TOUCHED_LIST[@]} no diff)"

RESULTS=(); RC=0
step() { # step "nome" cmd...
  local name="$1"; shift; local t0=$SECONDS
  echo; echo "=== $name"; echo "\$ $*"
  "$@"; local rc=$?
  local dt=$((SECONDS - t0))
  if [ $rc -eq 0 ]; then RESULTS+=("ok     ${dt}s  $name"); else RESULTS+=("FALHOU ${dt}s  $name (rc=$rc)"); RC=1; finish; fi
}
finish() {
  echo; echo "=== RESUMO (base $BASE)"
  [ ${#RESULTS[@]} -gt 0 ] && printf '%s\n' "${RESULTS[@]}" || echo "(nenhum arquivo checável: só docs/config fora de frontend e worker-functions)"
  if [ $RC -eq 0 ]; then echo "check-rapido: OK"; else echo "check-rapido: FALHOU (parou na primeira falha)"; fi
  exit $RC
}

# ---- frontend
if [ ${#FE_ALL[@]} -gt 0 ]; then
  if [ ! -d enlite-frontend/node_modules ]; then
    RESULTS+=("FALHOU 0s  frontend: node_modules ausente (cd enlite-frontend && pnpm install --frozen-lockfile)"); RC=1; finish
  else
    cd enlite-frontend
    [ ${#FE_LINT[@]} -gt 0 ] && step "frontend: eslint (${#FE_LINT[@]} arquivo(s))" pnpm exec eslint --max-warnings 0 "${FE_LINT[@]}"
    step "frontend: vitest related (${#FE_ALL[@]} arquivo(s))" pnpm exec vitest related --run --passWithNoTests "${FE_ALL[@]}"
    cd "$ROOT"
  fi
fi

# ---- worker-functions
if [ ${#WF_ALL[@]} -gt 0 ]; then
  if [ ! -d worker-functions/node_modules ]; then
    RESULTS+=("FALHOU 0s  worker-functions: node_modules ausente (cd worker-functions && npm ci)"); RC=1; finish
  else
    cd worker-functions
    COV=()
    if [ ${#WF_SRC[@]} -gt 0 ]; then
      # `jest --coverage --collectCoverageFrom=<tocados>` reprova as ~114 chaves de threshold de arquivos fora do
      # relatório ("Coverage data for ... was not found": rc=1 com testes verdes — medido). Por isso o threshold
      # vai num config temporário (mktemp), filtrado aos tocados.
      TMPD="$(mktemp -d)"; trap 'rm -rf "$TMPD"' EXIT
      WF_DIR="$PWD" TOUCHED_SRC="$(printf '%s\n' "${WF_SRC[@]}")" node -e '
        const path = require("path");
        const wf = process.env.WF_DIR;
        const mm = require(require.resolve("micromatch", { paths: [wf, process.env.CHECK_MM_PATH || wf] }));
        const base = require(path.join(wf, "jest.config.js"));
        const touched = process.env.TOUCHED_SRC.split("\n").filter(Boolean);
        const th = {};
        for (const [k, v] of Object.entries(base.coverageThreshold || {})) {
          if (k === "global" || touched.some((f) => f === k || mm.isMatch(f, k))) th[k] = v;
        }
        const cfg = { ...base, rootDir: wf, coverageThreshold: th };
        if (!Object.keys(th).length) delete cfg.coverageThreshold;
        require("fs").writeFileSync(process.argv[1], "module.exports = " + JSON.stringify(cfg, null, 2));
        console.log("threshold ativo em " + Object.keys(th).length + " de " + Object.keys(base.coverageThreshold || {}).length + " chaves");
      ' "$TMPD/jest.check.config.js" || { RESULTS+=("FALHOU 0s  worker-functions: geração do config temporário"); RC=1; finish; }
      if [ -f "$TMPD/jest.check.config.js" ]; then
        COV=(--config "$TMPD/jest.check.config.js" --coverage --coverageReporters=text-summary --silent)
        for f in "${WF_SRC[@]}"; do COV+=("--collectCoverageFrom=$f"); done
      fi
    fi
    step "worker-functions: jest relacionados + cobertura dos tocados (${#WF_ALL[@]} arquivo(s))" \
      npx jest --passWithNoTests --findRelatedTests "${WF_ALL[@]}" ${COV[@]+"${COV[@]}"}
    cd "$ROOT"
  fi
fi

finish
