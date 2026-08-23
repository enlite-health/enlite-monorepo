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
grep -E "^\+" "$TMP/diff" > "$TMP/add" 2>/dev/null || : > "$TMP/add"
# V5/V6/V10 olham CÓDIGO — e só código:
#  - doc/markdown fora (a própria doc deste gate cita "diagnóstico" e se auto-bloqueava)
#  - comentário fora (comentário que EXPLICA um conserto não é o defeito)
git diff "$MERGE_BASE"..HEAD -- '*.ts' '*.tsx' '*.js' '*.jsx' '*.sql' 2>/dev/null \
  | grep -E "^\+" \
  | grep -vE "^\+[[:space:]]*(//|\*|/\*|#|--)" > "$TMP/add_code" 2>/dev/null || : > "$TMP/add_code"

N_TODOS=$(grep -c . "$TMP/todos" 2>/dev/null || echo 0)
N_VIVOS=$(grep -c . "$TMP/vivos" 2>/dev/null || echo 0)
N_APAG=$(grep -c . "$TMP/apagados" 2>/dev/null || echo 0)

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
  ok "$N_TODOS arquivo(s), $(grep -c . "$TMP/diff") linha(s) de diff, $(grep -c . "$TMP/add") adicionada(s) ($(grep -c . "$TMP/add_code") de código)"
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
python3 - "$TMP/vivos" > "$TMP/orfaos" <<'PYEOF'
import re, sys, io, os
alvo = io.open(sys.argv[1], encoding='utf-8').read().split('\n')
IMPORT = re.compile(r"import\s+(?:type\s+)?([^;'\"]*?)\s+from\s+['\"][^'\"]+['\"]", re.S)
for f in alvo:
    if not f.endswith(('.ts', '.tsx')) or not os.path.isfile(f):
        continue
    src = io.open(f, encoding='utf-8').read()
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
            if not it or it.startswith('*'):
                continue
            it = re.sub(r'^type\s+', '', it)
            it = it.split(' as ')[-1].strip()   # o nome LOCAL é o depois do `as`
            if re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]*', it):
                nomes.add(it)
    for n in sorted(nomes):
        if not re.search(r'\b' + re.escape(n) + r'\b', corpo):
            print(f"{f}|{n}")
PYEOF
if [ -s "$TMP/orfaos" ]; then
  while IFS='|' read -r f id; do falha "$f: '$id' importado e nunca usado fora do próprio import"; done < "$TMP/orfaos"
else
  ok "nenhum import órfão em $(grep -cE '\.tsx?$' "$TMP/vivos" || echo 0) arquivo(s) TS"
fi
echo

# ─── V3 — referência a arquivo apagado ────────────────────────────────────────
echo "## V3 — import apontando para arquivo APAGADO neste diff"
: > "$TMP/pend"
while IFS= read -r f; do
  case "$f" in *.ts|*.tsx) ;; *) continue ;; esac
  mod="$(basename "$f")"; mod="${mod%.*}"
  if git grep -qE "from '[^']*/${mod}'" -- '*.ts' '*.tsx' 2>/dev/null; then
    echo "$mod" >> "$TMP/pend"
  fi
done < "$TMP/apagados"
if [ -s "$TMP/pend" ]; then
  while IFS= read -r mod; do
    falha "'$mod' foi apagado mas ainda é importado:"
    git grep -nE "from '[^']*/${mod}'" -- '*.ts' '*.tsx' | head -3 | sed 's/^/        /'
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
PII=$(grep -E "(console\.(log|error|warn)|logger?\.(info|warn|error|debug))" "$TMP/add_code" \
      | grep -iE "phone|telefone|email|first_?name|last_?name|\bdni\b|document_number|diagnos|patholog|birth" || true)
if [ -n "$PII" ]; then
  falha "log novo citando campo pessoal/clínico — conferir um a um:"
  echo "$PII" | head -8 | sed 's/^/        /'
else
  ok "nenhum log novo com campo pessoal/clínico"
fi
echo

# ─── V6 — dado clínico saindo do perímetro ────────────────────────────────────
# Regra mais dura da casa: texto clínico NUNCA sai, nem entra em prompt/log.
# `patients.diagnosis` é TEXT LIVRE. Achado real: ia para a Groq e para o
# utm_content de URL pública (#249).
echo "## V6 — dado clínico rumo a terceiro/URL/prompt"
CLIN=$(grep -iE "diagnos|patholog|patolog" "$TMP/add_code" \
       | grep -iE "fetch\(|axios|prompt|utm_|searchparams|http|body:|content:" || true)
if [ -n "$CLIN" ]; then
  falha "linha nova junta dado clínico com saída externa — JUSTIFICAR ou remover:"
  echo "$CLIN" | head -8 | sed 's/^/        /'
else
  ok "nenhum dado clínico em linha de saída externa"
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
echo "## V9 — arquivo de src tocado sem teste no mesmo diff"
SRC=$(grep -E "^worker-functions/src/.*\.ts$" "$TMP/vivos" | grep -vcE "__tests__|\.test\.|\.d\.ts$" || echo 0)
TST=$(grep -cE "__tests__|\.test\.|tests/" "$TMP/todos" || echo 0)
if [ "$SRC" -gt 0 ] && [ "$TST" -eq 0 ]; then
  falha "$SRC arquivo(s) de src sem nenhum teste tocado"
else
  ok "$SRC arquivo(s) de src, $TST arquivo(s) de teste"
fi
echo

# ─── V10 — segredo aparente ───────────────────────────────────────────────────
echo "## V10 — segredo aparente em linha adicionada"
SEG=$(grep -EI "(api[_-]?key|secret|password|token)[\"' ]*[:=][\"' ]*[A-Za-z0-9_-]{16,}" "$TMP/add_code" \
      | grep -viE "process\.env|test|mock|fake|example|latest|\\\$\{" || true)
if [ -n "$SEG" ]; then
  falha "possível segredo literal:"; echo "$SEG" | head -4 | sed 's/^/        /'
else
  ok "nenhum segredo literal aparente"
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
