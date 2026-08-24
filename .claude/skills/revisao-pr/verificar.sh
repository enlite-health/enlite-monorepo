#!/usr/bin/env bash
# revisao-pr/verificar.sh — o que uma máquina decide sobre o DIFF, sem LLM.
#
# O check `gate` do CI executa o CONJUNTO. Este script lê o DIFF. São perguntas
# diferentes, e é por isso que suíte verde não substitui (D131).
#
# Uso:   bash .claude/skills/revisao-pr/verificar.sh [base]     # default: origin/main
# Teste: bash .claude/skills/revisao-pr/testar.sh               # 20 fixtures, controles + -
# Sai 1 se alguma verificação FALHAR. AVISO e N/A não derrubam o exit code.
#
# ⚠️ bash 3.2 (o do macOS) — SEM `mapfile`, SEM array associativo.
#
# QUATRO ERROS DESTE ARQUIVO, todos "verde mentindo", todos achados por revisão
# adversarial e todos com fixture em testar.sh para não voltarem:
#   1. `mapfile` inexistente        -> listas vazias, ✅ sobre nada       (daí o V-1)
#   2. `grep -c … || echo 0`        -> "0\n0", comparação numérica sempre falsa,
#                                      ramo de falha INALCANÇÁVEL         (V9 nasceu morto)
#   3. `grep | while`               -> subshell, FALHAS++ perdido, ❌ com exit 0
#   4. `[ -f "$f" ] || continue`    -> arquivo do diff ausente do disco pulado em
#                                      SILÊNCIO, com a contagem CHEIA     (daí o V-2)
# A lição é sempre a mesma: contagem zero é falha, nunca sucesso — e a contagem
# tem de ser do que foi REALMENTE lido, não do que se pretendia ler.

# ── PONTOS CEGOS CONHECIDOS ───────────────────────────────────────────────────
# Declarados de propósito: gate cujo alcance não está escrito vira licença. O
# que ele NÃO pega (e por isso os 8 critérios do SKILL.md não são opcionais):
#   · V2 — nome usado só dentro de STRING literal conta como uso (falso negativo)
#   · V2 — só olha arquivo do diff; órfão em arquivo não tocado passa
#   · V3 — import montado dinamicamente (`from \`./\${x}\``) é invisível
#   · V5/V6 — heurística de texto: PII repassada por variável de nome neutro passa
#   · V7 — só AVISA; rota sem célula não reprova (definição pode ser multilinha)
#   · V9 — mede EXISTÊNCIA de teste no diff, nunca se o teste testa algo
#   · V10 — segredo sem palavra-chave por perto (um UUID solto) passa
#   · V2 lê a WORKING TREE do lado "atual" (a base vem do commit): órfão que
#     está no commit mas foi removido do disco sem commitar não é visto
#   · V9 mede EXISTÊNCIA de teste no projeto, nunca se o teste cobre o arquivo
#   · V7 só olha `router.`/`app.` — rota montada por outra abstração escapa
#   · V8 casa `prd|prod` no nome do workflow; convenção nova de nome escapa
# Todos com fixture em testar.sh quando cobertos; os de cima estão sem cobertura
# porque são limitação, não bug.

AQUI="$(cd "$(dirname "$0")" && pwd)"
set -uo pipefail
BASE="${1:-origin/main}"
ROOT="$(git rev-parse --show-toplevel)" || exit 2
cd "$ROOT" || exit 2

git rev-parse --verify --quiet "$BASE" >/dev/null || { echo "base '$BASE' não existe"; exit 2; }
MERGE_BASE="$(git merge-base HEAD "$BASE")"
[ -n "$MERGE_BASE" ] || { echo "merge-base vazio contra '$BASE'"; exit 2; }

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
git diff --name-only                 "$MERGE_BASE"..HEAD > "$TMP/todos"
git diff --name-only --diff-filter=d "$MERGE_BASE"..HEAD > "$TMP/vivos"
git diff --name-only --diff-filter=D "$MERGE_BASE"..HEAD > "$TMP/apagados"
git diff                             "$MERGE_BASE"..HEAD > "$TMP/diff"
# RENOME: o destino aparece em "vivos" e a origem NÃO aparece em "apagados".
# Sem este mapa, `git show BASE:destino` falha, a base vira vazia, e toda a
# dívida antiga do arquivo é imputada a este PR (falso positivo que ensina a
# ignorar o gate).
# ⚠️ sem `awk`: ele já matou o V10 duas vezes por diferença de implementação
# (IGNORECASE do gawk, intervalo {n,} do mawk). Bash puro não tem dialeto.
: > "$TMP/renomes"
git diff --name-status -M "$MERGE_BASE"..HEAD > "$TMP/status" 2>/dev/null || : > "$TMP/status"
while IFS="$(printf '\t')" read -r st origem destino; do
  case "$st" in R*) [ -n "${destino:-}" ] && printf '%s\t%s\n' "$destino" "$origem" >> "$TMP/renomes" ;; esac
done < "$TMP/status"

# `+++ b/…` é cabeçalho do diff, não código: entrava no corpus e gerava falso
# positivo pelo NOME do arquivo (um `token-store.ts` casava o V10).
grep -E "^\+" "$TMP/diff" | grep -v "^+++" > "$TMP/add" 2>/dev/null || : > "$TMP/add"
# shellcheck disable=SC2086
git diff "$MERGE_BASE"..HEAD -- '*.ts' '*.tsx' '*.js' '*.jsx' '*.sql' 2>/dev/null \
  | grep -E "^\+" | grep -v "^+++" \
  | grep -vE "^\+[[:space:]]*(//|\*|/\*|#|--)" > "$TMP/add_code" 2>/dev/null || : > "$TMP/add_code"

N_TODOS=$(grep -c . "$TMP/todos" || true)
N_VIVOS=$(grep -c . "$TMP/vivos" || true)
N_APAG=$(grep -c . "$TMP/apagados" || true)
N_REN=$(grep -c . "$TMP/renomes" || true)
N_CODE=$(grep -c . "$TMP/add_code" || true)
N_TS=$(grep -cE '\.tsx?$' "$TMP/vivos" || true)

FALHAS=0
falha() { echo "   ❌ $*"; FALHAS=$((FALHAS+1)); }
ok()    { echo "   ✅ $*"; }
aviso() { echo "   ⚠️  $*"; }
na()    { echo "   ⚪ N/A — $* (contagem zero NÃO é aprovação)"; }

echo "# revisao-pr — diff contra $BASE ($MERGE_BASE)"
echo "# $N_TODOS arquivo(s): $N_VIVOS vivo(s), $N_APAG apagado(s), $N_REN renomeado(s)"
echo

# ─── V-1 — o verificador enxerga o diff? ──────────────────────────────────────
echo "## V-1 — autoproteção: o script está medindo?"
if [ "$N_TODOS" -eq 0 ]; then
  falha "diff VAZIO contra $BASE — nada a revisar, ou base errada"
elif [ ! -s "$TMP/diff" ]; then
  falha "lista com $N_TODOS entradas mas diff VAZIO — o script está cego"
else
  ok "$N_TODOS arquivo(s), $(grep -c . "$TMP/diff" || true) linha(s) de diff, $(grep -c . "$TMP/add" || true) adicionada(s) ($N_CODE de código)"
fi
[ "$FALHAS" -gt 0 ] && { echo; echo "VERIFICADOR CEGO — BLOQUEADO."; exit 1; }
echo

# ─── V-2 — o corpus de cada check existe no disco? ────────────────────────────
# O V-1 guarda o diff GLOBAL; não vê o vácuo de um check individual. A 1ª versão
# pulava arquivo ausente em silêncio e imprimia a contagem CHEIA: "✅ nenhum
# órfão em 14 arquivos" tendo lido 10 — e os 4 pulados eram os defeituosos.
# Acontece com checkout esparso no CI e com worktree suja.
echo "## V-2 — autoproteção: os arquivos do diff estão legíveis?"
: > "$TMP/ausentes"
while IFS= read -r f; do
  [ -n "$f" ] || continue
  [ -f "$f" ] || printf '%s\n' "$f" >> "$TMP/ausentes"
done < "$TMP/vivos"
N_AUSENTES=$(grep -c . "$TMP/ausentes" || true)
if [ "$N_AUSENTES" -gt 0 ]; then
  falha "$N_AUSENTES arquivo(s) do diff NÃO estão no disco — os checks abaixo os ignorariam:"
  head -5 "$TMP/ausentes" | sed 's/^/        /'
  echo; echo "VERIFICADOR PARCIALMENTE CEGO — BLOQUEADO."; exit 1
elif [ "$N_VIVOS" -eq 0 ]; then
  na "diff só de deleções — nenhum arquivo vivo para ler"
else
  ok "os $N_VIVOS arquivo(s) vivos do diff estão legíveis"
fi
echo

# ─── V1 — node_modules no diff ────────────────────────────────────────────────
# `.gitignore` da raiz usa 'node_modules/' COM barra, e barra casa só diretório
# real: um SYMLINK com esse nome entra em qualquer `git add -A`. Reincidente
# (#173 removeu, #231 trouxe de volta). Checkout com ele quebra o build MUDO.
# ⚠️ ancorado: `docs/node_modules-armadilha.md` (a doc SOBRE a armadilha) não
# pode ser bloqueada pelo próprio check.
echo "## V1 — node_modules no diff"
if grep -qE "(^|/)node_modules(/|$)" "$TMP/todos"; then
  falha "node_modules aparece no diff:"
  grep -E "(^|/)node_modules(/|$)" "$TMP/todos" | sed 's/^/        /'
else
  ok "nenhum node_modules no diff"
fi
echo

# ─── V2 — import órfão INTRODUZIDO por este diff ──────────────────────────────
# tsconfig tem noUnusedLocals:false → o tsc passa LIMPO com import morto.
echo "## V2 — import órfão introduzido (tsc não pega: noUnusedLocals=false)"
mkdir -p "$TMP/base"
: > "$TMP/pares"
i=0
while IFS= read -r f; do
  case "$f" in *.ts|*.tsx) ;; *) continue ;; esac
  i=$((i+1))
  b="$TMP/base/$i.ts"
  orig=$(grep -F "$(printf '%s\t' "$f")" "$TMP/renomes" | head -1 | cut -f2)
  [ -n "$orig" ] || orig="$f"
  git show "$MERGE_BASE:$orig" > "$b" 2>/dev/null || : > "$b"
  printf '%s\t%s\n' "$f" "$b" >> "$TMP/pares"
done < "$TMP/vivos"

if ! command -v python3 >/dev/null 2>&1; then
  falha "V2 NÃO RODOU: python3 ausente. Check que não roda não é check verde."
elif [ "$N_TS" -eq 0 ]; then
  na "nenhum arquivo TS/TSX vivo no diff"
else
python3 "$AQUI/orfaos.py" "$TMP/pares" > "$TMP/orfaos" 2>"$TMP/py_err"
  PY_RC=$?
  if [ "$PY_RC" -ne 0 ]; then
    falha "V2 NÃO RODOU: python3 saiu $PY_RC — $(head -1 "$TMP/py_err")"
  else
    LIDOS=$(grep "^LIDOS	" "$TMP/orfaos" | cut -f2)
    grep "^FALHA	" "$TMP/orfaos" > "$TMP/orf_falha" 2>/dev/null || : > "$TMP/orf_falha"
    grep "^AVISO	" "$TMP/orfaos" > "$TMP/orf_aviso" 2>/dev/null || : > "$TMP/orf_aviso"
    grep "^ERRO	"  "$TMP/orfaos" > "$TMP/orf_erro"  2>/dev/null || : > "$TMP/orf_erro"
    while IFS=$'\t' read -r _ f id; do aviso "$f: '$id' órfão PRÉ-EXISTENTE (não é deste PR — vai para LISTA)"; done < "$TMP/orf_aviso"
    while IFS=$'\t' read -r _ f m;  do falha "$f: $m"; done < "$TMP/orf_erro"
    if [ -s "$TMP/orf_falha" ]; then
      while IFS=$'\t' read -r _ f id; do falha "$f: '$id' importado e nunca usado — INTRODUZIDO por este diff"; done < "$TMP/orf_falha"
    elif [ ! -s "$TMP/orf_erro" ]; then
      # a contagem é do que foi LIDO, nunca do que se pretendia ler
      ok "nenhum órfão introduzido — $LIDOS de $N_TS arquivo(s) TS efetivamente lidos"
    fi
  fi
fi
echo

# ─── V3 — referência a arquivo apagado ────────────────────────────────────────
# ⚠️ TRÊS defeitos da 1ª versão, todos com fixture no testar.sh:
#   (a) casava por BASENAME — há dois TalentumWebhookController.ts no repo;
#   (b) `head -1` no importador: com dois imports de mesmo nome, achava o vivo
#       e dava o apagado por resolvido;
#   (c) via só `from '…'` com aspas simples e sem extensão — cego ao ALIAS do
#       tsconfig (497 `@shared/` + 125 `@modules/` = 622 sítios), ao
#       `import()` dinâmico, ao `jest.mock()` e ao sufixo `.js`.
echo "## V3 — import apontando para arquivo APAGADO neste diff"
# A resolução vive em `importadores.py`: casar por BASENAME dava falso positivo
# duro (14 basenames repetidos neste repo) e casar só `from '…'` era cego ao
# alias do tsconfig, ao import() dinâmico e ao jest.mock().
if [ "$N_APAG" -eq 0 ]; then
  na "nenhum arquivo apagado no diff"
elif ! command -v python3 >/dev/null 2>&1; then
  falha "V3 NÃO RODOU: python3 ausente. Check que não roda não é check verde."
else
  git ls-files '*.ts' '*.tsx' > "$TMP/todos_ts" 2>/dev/null || : > "$TMP/todos_ts"
  : > "$TMP/pend"
  V3_ERRO=0
  while IFS= read -r f; do
    case "$f" in *.ts|*.tsx) ;; *) continue ;; esac
    grep -qF "	$f" "$TMP/renomes" && continue      # renomeado não é apagado
    if ! python3 "$AQUI/importadores.py" "$f" "$ROOT" "$TMP/todos_ts" >> "$TMP/pend" 2>>"$TMP/v3_err"; then
      V3_ERRO=1
    fi
  done < "$TMP/apagados"
  if [ "$V3_ERRO" -ne 0 ]; then
    falha "V3 NÃO RODOU por completo: $(head -1 "$TMP/v3_err")"
  elif [ -s "$TMP/pend" ]; then
    falha "arquivo apagado ainda é importado ($(grep -c . "$TMP/pend" || true) sítio(s)):"
    head -8 "$TMP/pend" | sed 's/^/        /'
  else
    ok "nenhuma referência pendente ($N_APAG arquivo(s) apagado(s), $(grep -c . "$TMP/todos_ts" || true) arquivo(s) TS varridos)"
  fi
fi
echo

# ─── V4 — teste desligado ─────────────────────────────────────────────────────
# ⚠️ usa add_code, não add: `.skip(` citado numa doc, ou `q.skip(10).limit(20)`
# de paginação, NÃO é teste desligado. E exige o prefixo de teste.
echo "## V4 — teste desligado (.only / .skip / xit / fdescribe)"
if [ "$N_CODE" -eq 0 ]; then na "0 linha de código no diff"; else
LIG=$(grep -E "\b(describe|it|test|context)\.(only|skip)\(|\b(xit|xdescribe|fdescribe|fit)\(" "$TMP/add_code" || true)
if [ -n "$LIG" ]; then
  falha "teste desligado sendo introduzido:"; echo "$LIG" | head -6 | sed 's/^/        /'
else
  ok "nenhum teste desligado ($N_CODE linha(s) de código)"
fi
fi
echo

# ─── V5 — PII em log novo ─────────────────────────────────────────────────────
# ⚠️ A regra da casa PERMITE contagem ("status e contagem, sempre"). A 1ª versão
# reprovava `console.log(\`breakdown: sem_telefone=${n}\`)` — uma contagem — só
# porque a palavra "telefone" aparecia. Agora exige o campo sendo INTERPOLADO
# como valor, e exclui os sufixos de agregação.
echo "## V5 — PII em log adicionado"
if [ "$N_CODE" -eq 0 ]; then na "0 linha de código no diff"; else
PII=$(grep -E "(console\.(log|error|warn)|logger?\.(info|warn|error|debug))" "$TMP/add_code" \
      | grep -iE '\$\{[^}]*\b(phone|telefone|email|firstName|lastName|first_name|last_name|dni|documentNumber|document_number|birthDate|birth_date|diagnosis|diagnostico)\b[^}]*\}|\b(phone|email|firstName|lastName|dni|diagnosis)\b[[:space:]]*[,)]' \
      | grep -viE '\\b(count|total|qtd|quantidade|length|size|has|missing)\\b|\\bsem_|\\bcom_|\\.length' || true)
if [ -n "$PII" ]; then
  falha "log novo interpolando campo pessoal — conferir um a um:"
  echo "$PII" | head -8 | sed 's/^/        /'
else
  ok "nenhum log novo interpolando PII ($N_CODE linha(s))"
fi
fi
echo

# ─── V6 — dado clínico saindo do perímetro ────────────────────────────────────
# Regra mais dura da casa. ⚠️ A 1ª versão casava SUBSTRING: `diagnos` pegava
# `diagnosticsHttpTimeoutMs` e `http` pegava qualquer URL — reprovava
# `const DIAGNOSTIC_ENDPOINT = 'http://localhost:8080/healthz'`. Agora é PALAVRA.
echo "## V6 — dado clínico rumo a terceiro/URL/prompt"
if [ "$N_CODE" -eq 0 ]; then na "0 linha de código no diff"; else
CLIN=$(grep -iE '\b(diagnosis|diagnostico|diagnóstico|pathology|pathologies|patologia|patologias|patología|patologías)\b' "$TMP/add_code" \
       | grep -iE 'fetch\(|axios|\bprompt\b|utm_|searchParams|\bbody:|\bcontent:|\.post\(|\.put\(' \
       | grep -viE '\bdiagnostics?(Http|Timeout|Endpoint|Mode|Log|Url)' || true)
if [ -n "$CLIN" ]; then
  falha "linha nova junta dado clínico com saída externa — JUSTIFICAR ou remover:"
  echo "$CLIN" | head -8 | sed 's/^/        /'
else
  ok "nenhum dado clínico em linha de saída externa ($N_CODE linha(s))"
fi
fi
echo

# ─── V7 — rota nova sem célula declarada (AVISO, por desenho) ─────────────────
# A definição da rota pode ser multilinha; FAIL aqui teria falso positivo demais.
# Quem decide é o critério 6 do SKILL.md, com o payload na mão.
echo "## V7 — rota nova sem declaração de célula (aviso, nunca reprova sozinho)"
# ⚠️ rota nova não mora só em *Routes.ts: `app.post(...)` em `index.ts` ou
# `server.ts` passava batido. Corpus = todo TS do diff.
ROTAS=$(git diff "$MERGE_BASE"..HEAD -- '*.ts' 2>/dev/null \
        | grep -E "^\+" | grep -v "^+++" \
        | grep -E "\b(router|app)\.(get|post|put|patch|delete)\(" || true)
if [ -z "$ROTAS" ]; then
  ok "nenhuma rota nova"
else
  SEM=$(echo "$ROTAS" | grep -v "requirePermission\|perm\.require\|EXEMPT" || true)
  if [ -n "$SEM" ]; then
    aviso "rota(s) nova(s) sem célula na MESMA linha — conferir no arquivo:"
    echo "$SEM" | head -6 | sed 's/^/        /'
  else
    ok "toda rota nova declara célula"
  fi
fi
echo

# ─── V8 — workflow de PRD ─────────────────────────────────────────────────────
echo "## V8 — workflow de produção tocado"
# ⚠️ `deploy-PRD.yml`, `-prod` e `-production` passavam: era case-sensitive
# e só conhecia a string 'prd'.
if grep -qiE "\.github/workflows/.*(prd|prod)" "$TMP/todos"; then
  falha "workflow de PRODUÇÃO no diff — overwrite PROIBIDO até reconciliar YAML × vivo:"
  grep -iE "\.github/workflows/.*(prd|prod)" "$TMP/todos" | sed 's/^/        /'
else
  ok "nenhum workflow de PRD tocado"
fi
echo

# ─── V9 — arquivo de feature sem teste ────────────────────────────────────────
# ⚠️ A 1ª versão copiou a regex de `scripts/check-needs-tests.sh` SEM ver que
# aquele script roda de DENTRO de worker-functions/ e mira o layout LEGADO.
# Medido: 174 arquivos de feature sob `src/modules/**` contra 1 no legado — o
# check era vazio, e não acusou nem os 3 arquivos do PR que o estreou.
# E o teste tem de ser do MESMO projeto: mexer num teste do frontend não
# satisfaz uma feature do backend.
echo "## V9 — arquivo de feature tocado sem teste"
FEATURE_RE='^(worker-functions|enlite-frontend)/src/(modules/[^/]+/)?(interfaces/(controllers|routes)|application|presentation/(pages|components)|infrastructure/converters)/.*\.tsx?$'
grep -E "$FEATURE_RE" "$TMP/vivos" | grep -vE "__tests__|\.test\.|\.spec\." > "$TMP/feats" || true
SRC=$(grep -c . "$TMP/feats" || true)
if [ "$SRC" -eq 0 ]; then
  na "nenhum arquivo de feature no diff"
else
  : > "$TMP/v9_faltando"
  for proj in worker-functions enlite-frontend; do
    n=$(grep -cE "^$proj/" "$TMP/feats" || true)
    [ "$n" -eq 0 ] && continue
    t=$(grep -E "^$proj/" "$TMP/todos" | grep -cE "__tests__|\.test\.|\.spec\.|/tests/|/e2e/" || true)
    [ "$t" -eq 0 ] && printf '%s\t%s\n' "$proj" "$n" >> "$TMP/v9_faltando"
  done
  if [ -s "$TMP/v9_faltando" ]; then
    while IFS=$'\t' read -r proj n; do
      falha "$n arquivo(s) de feature em '$proj' sem NENHUM teste do mesmo projeto no diff"
    done < "$TMP/v9_faltando"
  else
    ok "$SRC arquivo(s) de feature, todos com teste do mesmo projeto no diff"
  fi
fi
echo

# ─── V10 — segredo aparente ───────────────────────────────────────────────────
# ⚠️ DOIS defeitos da 1ª versão:
#   (a) corpus só de .ts — segredo literal mora em .tf, workflow, .sh e .env
#       muito mais que em código;
#   (b) SEM `-i`: `apiKey` camelCase era invisível. Medido no repo: apiKey ×114,
#       accessToken ×30, authToken ×20, apiToken ×6 = 170 identificadores cegos.
#       E não há gitleaks/trufflehog no CI para compensar.
echo "## V10 — segredo aparente em linha adicionada"
# corpus próprio e mais largo: segredo mora em .tf, workflow, .sh e .env muito
# mais que em .ts. A varredura vive em `segredos.py` — ver lá os DOIS awks que
# mataram este check antes (IGNORECASE do gawk e {16,} do mawk).
# shellcheck disable=SC2086
git diff "$MERGE_BASE"..HEAD -- '*.ts' '*.tsx' '*.js' '*.sql' '*.tf' '*.tfvars' '*.yml' '*.yaml' '*.sh' '*.env*' '*.json' '*.py' 2>/dev/null > "$TMP/diff_seg" || : > "$TMP/diff_seg"
N_SEG=$(grep -cE "^\\+" "$TMP/diff_seg" || true)
if [ ! -s "$TMP/diff_seg" ]; then
  na "0 linha de código/config no diff"
elif ! python3 "$AQUI/segredos.py" "$TMP/diff_seg" > "$TMP/seg_hits" 2>"$TMP/seg_err"; then
  falha "V10 NÃO RODOU: $(head -1 "$TMP/seg_err")"
elif [ -s "$TMP/seg_hits" ]; then
  falha "possível segredo literal:"; head -5 "$TMP/seg_hits" | sed 's/^/        /'
else
  ok "nenhum segredo literal aparente ($N_SEG linha(s) adicionada(s) de código+config)"
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
