#!/usr/bin/env bash
# revisao-pr/verificar.sh — o que uma máquina decide sobre o DIFF, sem LLM.
#
# O check `gate` do CI executa o CONJUNTO. Este script lê o DIFF. São perguntas
# diferentes, e é por isso que suíte verde não substitui (D131).
#
# Uso:  bash .claude/skills/revisao-pr/verificar.sh [base]     # base default: origin/main
# Sai 1 se alguma verificação FALHAR. AVISO não derruba o exit code.
#
# ⚠️ bash 3.2 (o do macOS) — SEM `mapfile`, SEM array associativo. A 1ª versão
# usou `mapfile` e ficou muda: imprimia "✅ nenhum node_modules" com as listas
# vazias, aprovando no vácuo. Por isso o V-1 abaixo existe.

set -uo pipefail
BASE="${1:-origin/main}"
ROOT="$(git rev-parse --show-toplevel)" || exit 2
cd "$ROOT" || exit 2

git rev-parse --verify --quiet "$BASE" >/dev/null || { echo "base '$BASE' não existe"; exit 2; }
MERGE_BASE="$(git merge-base HEAD "$BASE")"

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
git diff --name-only                    "$MERGE_BASE"..HEAD > "$TMP/todos"
git diff --name-only --diff-filter=d    "$MERGE_BASE"..HEAD > "$TMP/vivos"
git diff --name-only --diff-filter=D    "$MERGE_BASE"..HEAD > "$TMP/apagados"
git diff                                "$MERGE_BASE"..HEAD > "$TMP/diff"
grep -E "^\+" "$TMP/diff" | grep -v "^+++" > "$TMP/add" 2>/dev/null || : > "$TMP/add"
# V5/V6/V10 olham CÓDIGO — e só código:
#  - doc/markdown fora (a própria doc deste gate cita "diagnóstico" e se auto-bloqueava)
#  - comentário fora (comentário que EXPLICA um conserto não é o defeito)
git diff "$MERGE_BASE"..HEAD -- '*.ts' '*.tsx' '*.js' '*.jsx' '*.sql' 2>/dev/null \
  | grep -E "^\+" | grep -v "^+++" \
  | grep -vE "^\+[[:space:]]*(//|\*|/\*|#|--)" > "$TMP/add_code" 2>/dev/null || : > "$TMP/add_code"

# ⚠️ `grep -c` sem match imprime 0 E SAI 1. Um `|| echo 0` acrescenta um SEGUNDO
# zero, a variável vira "0\n0", e todo `[ "$X" -eq 0 ]` passa a dar erro e ser
# FALSO. Foi assim que o V9 nasceu morto: o ramo de falha era inalcançável.
N_TODOS=$(grep -c . "$TMP/todos" || true)
N_VIVOS=$(grep -c . "$TMP/vivos" || true)
N_APAG=$(grep -c . "$TMP/apagados" || true)

N_CODE=$(grep -c . "$TMP/add_code" || true)
N_TS=$(grep -cE '\.tsx?$' "$TMP/vivos" || true)

FALHAS=0
falha() { echo "   ❌ $*"; FALHAS=$((FALHAS+1)); }
ok()    { echo "   ✅ $*"; }
aviso() { echo "   ⚠️  $*"; }

echo "# revisao-pr — diff contra $BASE ($MERGE_BASE)"
echo "# $N_TODOS arquivo(s): $N_VIVOS vivo(s), $N_APAG apagado(s)"
echo

# ─── V-1 — o verificador está medindo mesmo? ──────────────────────────────────
# Contagem zero é falha, nunca sucesso: verificador que não acha nada aprova
# no vácuo. Este check existe porque a 1ª versão deste script fez exatamente isso.
echo "## V-1 — autoproteção do verificador"
if [ "$N_TODOS" -eq 0 ]; then
  falha "diff VAZIO contra $BASE — nada a revisar, ou base errada"
elif [ ! -s "$TMP/diff" ]; then
  falha "lista de arquivos com $N_TODOS entradas mas diff VAZIO — o script está cego"
else
  ok "$N_TODOS arquivo(s), $(grep -c . "$TMP/diff" || true) linha(s) de diff, $(grep -c . "$TMP/add" || true) adicionada(s) ($N_CODE de código)"
fi
[ "$FALHAS" -gt 0 ] && { echo; echo "VERIFICADOR CEGO — BLOQUEADO."; exit 1; }
echo

# ─── V1 — node_modules no diff ────────────────────────────────────────────────
# O .gitignore da raiz usa 'node_modules/' COM barra, e barra casa só diretório
# real: um SYMLINK com esse nome entra em qualquer `git add -A`. Reincidente
# (#173 removeu, #231 trouxe de volta). Checkout com ele destrói o node_modules
# local e o build falha MUDO (tsc 127, build 194).
echo "## V1 — node_modules no diff"
if grep -q "node_modules" "$TMP/todos"; then
  falha "node_modules aparece no diff:"; grep "node_modules" "$TMP/todos" | sed 's/^/        /'
else
  ok "nenhum node_modules no diff"
fi
echo

# ─── V2 — import órfão ────────────────────────────────────────────────────────
# tsconfig.json tem noUnusedLocals:false → o tsc passa LIMPO com import morto.
# Um identificador importado que aparece 1x no arquivo é a própria linha do
# import. Pega o rastro típico de PR que APAGA código (achado real no #249).
echo "## V2 — import órfão nos arquivos tocados (tsc não pega: noUnusedLocals=false)"
# sed não serve aqui: o bloco de import é MULTILINHA e existe `import { X, type Y }`.
# A 1ª versão usava sed, inventou 'typeSocialChannel' e PERDEU os 3 órfãos reais.
# ⚠️ Órfão PRÉ-EXISTENTE não é culpa deste PR. Extraímos a versão da BASE de
# cada arquivo tocado; o que já era órfão lá vira AVISO, não falha. Gate que
# culpa o autor por dívida alheia é gate que se aprende a ignorar.
mkdir -p "$TMP/base"
: > "$TMP/pares"
i=0
while IFS= read -r f; do
  case "$f" in *.ts|*.tsx) ;; *) continue ;; esac
  [ -f "$f" ] || continue
  i=$((i+1))
  b="$TMP/base/$i.ts"
  git show "$MERGE_BASE:$f" > "$b" 2>/dev/null || : > "$b"
  printf '%s\t%s\n' "$f" "$b" >> "$TMP/pares"
done < "$TMP/vivos"

if ! command -v python3 >/dev/null 2>&1; then
  falha "V2 NÃO RODOU: python3 ausente. Um check que não roda não é um check verde."
else
python3 - "$TMP/pares" > "$TMP/orfaos" 2>"$TMP/py_err" <<'PYEOF'
import re, sys, io, os
pares = [l.split('\t') for l in io.open(sys.argv[1], encoding='utf-8', errors='replace').read().split('\n') if '\t' in l]
IMPORT = re.compile(r"import\s+(?:type\s+)?([^;'\"]*?)\s+from\s+['\"][^'\"]+['\"]", re.S)
def orfaos_de(caminho):
    """Nomes importados que não aparecem em lugar nenhum fora do próprio import."""
    if not os.path.isfile(caminho):
        return set()
    src = io.open(caminho, encoding='utf-8', errors='replace').read()
    # import COMENTADO não é import: a 1ª versão acusava `// import { X } …`
    # como órfão e bloqueava PR limpo que deixou a linha como nota.
    src = re.sub(r'(?m)^[ \t]*(//|\*|/\*).*$', '', src)
    corpo = IMPORT.sub('', src)          # o corpo é o arquivo SEM os imports
    nomes = set()
    for m in IMPORT.finditer(src):
        clausula = m.group(1)
        chaves = re.search(r'\{(.*)\}', clausula, re.S)
        itens = chaves.group(1).split(',') if chaves else []
        fora = re.sub(r'\{.*\}', '', clausula, flags=re.S)   # default / namespace
        itens += [x for x in fora.split(',')]
        for it in itens:
            it = it.strip()
            if not it:
                continue
            # `import * as X` — o nome local é o depois do `as`, não descartar
            it = re.sub(r'^\*\s*', '', it)
            it = re.sub(r'^type\s+', '', it)
            # o nome LOCAL é o depois do `as` — por FRONTEIRA de palavra, não por
            # ' as ': em `* as X` o alias não tem espaço antes, e o split falhava.
            it = re.split(r'\bas\b', it)[-1].strip()
            if re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]*', it):
                nomes.add(it)
    return {n for n in nomes if not re.search(r'\b' + re.escape(n) + r'\b', corpo)}

for f, b in pares:
    novos = orfaos_de(f) - orfaos_de(b)      # o que ESTE diff introduziu
    herdados = orfaos_de(f) & orfaos_de(b)   # dívida que já estava lá
    for n in sorted(novos):
        print(f"FALHA|{f}|{n}")
    for n in sorted(herdados):
        print(f"AVISO|{f}|{n}")
PYEOF
  PY_RC=$?
  [ "$PY_RC" -ne 0 ] && falha "V2 NÃO RODOU: python3 saiu $PY_RC — $(head -1 "$TMP/py_err")"
fi
if [ "$N_TS" -eq 0 ]; then
  aviso "V2 N/A — nenhum arquivo TS/TSX vivo no diff (contagem zero não é aprovação)"
else
  # ⚠️ `grep | while` roda em SUBSHELL: o incremento de FALHAS se perde e o
  # script imprime ❌ saindo 0. Ler de ARQUIVO mantém o loop no shell atual.
  grep "^FALHA|" "$TMP/orfaos" > "$TMP/orf_falha" 2>/dev/null || : > "$TMP/orf_falha"
  grep "^AVISO|" "$TMP/orfaos" > "$TMP/orf_aviso" 2>/dev/null || : > "$TMP/orf_aviso"
  while IFS='|' read -r _ f id; do
    aviso "$f: '$id' órfão PRÉ-EXISTENTE (não é deste PR — vai para LISTA)"
  done < "$TMP/orf_aviso"
  if [ -s "$TMP/orf_falha" ]; then
    while IFS='|' read -r _ f id; do
      falha "$f: '$id' importado e nunca usado — INTRODUZIDO por este diff"
    done < "$TMP/orf_falha"
  else
    ok "nenhum órfão INTRODUZIDO por este diff (em $N_TS arquivo(s) TS)"
  fi
fi
echo

# ─── V3 — referência a arquivo apagado ────────────────────────────────────────
echo "## V3 — import apontando para arquivo APAGADO neste diff"
: > "$TMP/pend"
while IFS= read -r f; do
  case "$f" in *.ts|*.tsx) ;; *) continue ;; esac
  # ⚠️ basename COLIDE: há dois TalentumWebhookController.ts em módulos
  # diferentes. Casar o caminho resolvido, não só o nome do arquivo.
  mod="$(basename "$f")"; mod="${mod%.*}"
  dir="$(dirname "$f")"
  # quem importa este módulo tem de estar numa pasta cujo caminho resolvido caia aqui
  hits=$(git grep -lE "from ['\"][^'\"]*/${mod}['\"]|from ['\"]\\./${mod}['\"]" -- '*.ts' '*.tsx' 2>/dev/null || true)
  for h in $hits; do
    hdir="$(dirname "$h")"
    # resolve o import relativo do importador e compara com a pasta do apagado
    rel=$(git grep -hoE "from ['\"][^'\"]*${mod}['\"]" -- "$h" | head -1 | sed "s/.*['\"]\\(.*\\)['\"].*/\\1/")
    alvo="$(cd "$hdir" 2>/dev/null && cd "$(dirname "$rel")" 2>/dev/null && pwd)"
    esperado="$(cd "$dir" 2>/dev/null && pwd)"
    [ -n "$alvo" ] && [ "$alvo" = "$esperado" ] && echo "$mod|$h" >> "$TMP/pend"
  done
done < "$TMP/apagados"
if [ -s "$TMP/pend" ]; then
  while IFS='|' read -r mod imp; do
    falha "'$mod' foi apagado mas '$imp' ainda o importa"
  done < "$TMP/pend"
else
  ok "nenhuma referência pendente ($N_APAG arquivo(s) apagado(s))"
fi
echo

# ─── V4 — teste desligado ─────────────────────────────────────────────────────
echo "## V4 — teste desligado no diff (.only / .skip / xit / fdescribe)"
LIG=$(grep -E "\.(only|skip)\(|\b(xit|xdescribe|fdescribe|fit)\(" "$TMP/add" || true)
if [ -n "$LIG" ]; then
  falha "teste desligado sendo introduzido:"; echo "$LIG" | head -6 | sed 's/^/        /'
else
  ok "nenhum teste desligado"
fi
echo

# ─── V5 — PII em log novo ─────────────────────────────────────────────────────
echo "## V5 — PII/dado clínico em log adicionado"
if [ "$N_CODE" -eq 0 ]; then aviso "N/A — 0 linha de CÓDIGO no diff"; else
PII=$(grep -E "(console\.(log|error|warn)|logger?\.(info|warn|error|debug))" "$TMP/add_code" \
      | grep -iE "phone|telefone|email|first_?name|last_?name|\bdni\b|document_number|diagnos|patholog|birth" || true)
if [ -n "$PII" ]; then
  falha "log novo citando campo pessoal/clínico — conferir um a um:"
  echo "$PII" | head -8 | sed 's/^/        /'
else
  ok "nenhum log novo com campo pessoal/clínico ($N_CODE linha(s) de código varrida(s))"
fi
fi
echo

# ─── V6 — dado clínico saindo do perímetro ────────────────────────────────────
# Regra mais dura da casa: texto clínico NUNCA sai, nem entra em prompt/log.
# `patients.diagnosis` é TEXT LIVRE. Achado real: ia para a Groq e para o
# utm_content de URL pública (#249).
echo "## V6 — dado clínico rumo a terceiro/URL/prompt"
if [ "$N_CODE" -eq 0 ]; then aviso "N/A — 0 linha de CÓDIGO no diff"; else
CLIN=$(grep -iE "diagnos|patholog|patolog" "$TMP/add_code" \
       | grep -iE "fetch\(|axios|prompt|utm_|searchparams|http|body:|content:" || true)
if [ -n "$CLIN" ]; then
  falha "linha nova junta dado clínico com saída externa — JUSTIFICAR ou remover:"
  echo "$CLIN" | head -8 | sed 's/^/        /'
else
  ok "nenhum dado clínico em linha de saída externa ($N_CODE linha(s) varrida(s))"
fi
fi
echo

# ─── V7 — rota nova sem célula declarada ──────────────────────────────────────
echo "## V7 — rota nova sem declaração de célula"
ROTAS=$(git diff "$MERGE_BASE"..HEAD -- '*Routes.ts' '*routes.ts' 2>/dev/null \
        | grep -E "^\+" | grep -E "\.(get|post|put|patch|delete)\(" || true)
if [ -n "$ROTAS" ]; then
  SEM=$(echo "$ROTAS" | grep -v "requirePermission\|perm\.require\|EXEMPT" || true)
  if [ -n "$SEM" ]; then
    aviso "rota(s) nova(s) sem célula na MESMA linha — conferir no arquivo:"
    echo "$SEM" | head -6 | sed 's/^/        /'
  else
    ok "toda rota nova declara célula"
  fi
else
  ok "nenhuma rota nova"
fi
echo

# ─── V8 — workflow de PRD ─────────────────────────────────────────────────────
echo "## V8 — workflow de produção tocado"
if grep -qE "\.github/workflows/.*prd" "$TMP/todos"; then
  falha "workflow de PRD no diff — overwrite PROIBIDO até reconciliar YAML × vivo:"
  grep -E "\.github/workflows/.*prd" "$TMP/todos" | sed 's/^/        /'
else
  ok "nenhum workflow de PRD tocado"
fi
echo

# ─── V9 — src sem teste ───────────────────────────────────────────────────────
# ⚠️ A 1ª versão reimplementava, PIOR, o que já existe em
# `worker-functions/scripts/check-needs-tests.sh` (regex de camada real, não
# `src/**/*.ts` genérico). E nasceu MORTO: o `|| echo 0` fazia o ramo de falha
# ser inalcançável. Agora delega ao script da casa quando ele existe.
echo "## V9 — arquivo de feature tocado sem teste"
CNT="worker-functions/scripts/check-needs-tests.sh"
SRC=$(grep -E "^worker-functions/src/(interfaces/(controllers|routes)|application|infrastructure/converters)/.*\.ts$" "$TMP/vivos" \
      | grep -vcE "__tests__|\.test\." || true)
TST=$(grep -cE "__tests__|\.test\.|tests/" "$TMP/todos" || true)
if [ ! -f "$CNT" ]; then
  aviso "N/A — $CNT não existe nesta branch (era a fonte da regra de camada)"
elif [ "$SRC" -gt 0 ] && [ "$TST" -eq 0 ]; then
  falha "$SRC arquivo(s) de feature (controller/route/application/converter) sem NENHUM teste no diff"
else
  ok "$SRC arquivo(s) de feature, $TST arquivo(s) de teste"
fi
echo

# ─── V10 — segredo aparente ───────────────────────────────────────────────────
echo "## V10 — segredo aparente em linha adicionada"
# ⚠️ V10 NÃO usa add_code: segredo literal mora em .tf, workflow, .sh e .env
# muito mais do que em .ts. Corpus próprio, mais largo.
git diff "$MERGE_BASE"..HEAD -- '*.ts' '*.tsx' '*.js' '*.sql' '*.tf' '*.yml' '*.yaml' '*.sh' '*.env*' '*.json' 2>/dev/null \
  | grep -E "^\+" | grep -v "^+++" \
  | grep -vE "^\+[[:space:]]*(//|\*|/\*|#|--)" > "$TMP/add_seg" 2>/dev/null || : > "$TMP/add_seg"
N_SEG=$(grep -c . "$TMP/add_seg" || true)
if [ "$N_SEG" -eq 0 ]; then aviso "N/A — 0 linha de config/código no diff"; else
SEG=$(grep -EI "(api[_-]?key|secret|password|token)[\"' ]*[:=][\"' ]*[A-Za-z0-9_-]{16,}" "$TMP/add_seg" \
      | grep -viE "process\.env|test|mock|fake|example|latest|\\\$\{" || true)
if [ -n "$SEG" ]; then
  falha "possível segredo literal:"; echo "$SEG" | head -4 | sed 's/^/        /'
else
  ok "nenhum segredo literal aparente ($N_SEG linha(s) de código+config varrida(s))"
fi
fi

echo
echo "================================================================"
if [ "$FALHAS" -eq 0 ]; then
  echo "VERIFICADOR: SEM FALHA — segue para os 8 critérios do SKILL.md."
  echo "⚠️  Isto NÃO é aprovação: o script mede forma, não substância."
  exit 0
else
  echo "VERIFICADOR: $FALHAS FALHA(S) — BLOQUEADO."
  exit 1
fi
