#!/usr/bin/env bash
# revisao-pr/testar.sh — o teste do verificador.
#
# `verificar.sh` é CÓDIGO: 380 linhas, 12 ramos, um interpretador embutido e um
# `exit 1` que fecha merge. Código que decide deploy sem teste próprio é o
# artefato mais perigoso do repo — se degradar, nada acusa, e o erro se propaga
# a todos os PRs seguintes.
#
# Cada caso abaixo é um defeito REAL que passou por aqui, com controle POSITIVO
# (o defeito presente → tem de reprovar) e NEGATIVO (o caso legítimo parecido →
# tem de passar). Autoteste de um lado só aprova o defeito do próprio
# verificador: por isso todo caso tem o par.
#
# Uso: bash .claude/skills/revisao-pr/testar.sh
# Sai 1 se qualquer caso divergir do esperado.

set -uo pipefail
VERIF="$(cd "$(dirname "$0")" && pwd)/verificar.sh"
[ -f "$VERIF" ] || { echo "verificar.sh não encontrado"; exit 2; }

PASS=0; FAIL=0
LAB=""; ESPERADO=""; SAIDA=""; RC=0

# ── monta um repo git descartável, fora do repo real ──────────────────────────
novo_repo() {
  REPO="$(mktemp -d)"
  cd "$REPO" || exit 2
  git init -q . && git config user.email t@t && git config user.name t
  mkdir -p src
  echo "base" > README.md
  git add -A && git commit -qm base
  git branch -q -M main
  git checkout -q -b feature
}

# roda o verificador contra main e guarda saída + exit code
rodar() { SAIDA="$(bash "$VERIF" main 2>&1)"; RC=$?; }

# checa(rótulo, esperado_rc, [regex_que_a_saída_deve_conter])
checa() {
  LAB="$1"; ESPERADO="$2"; local re="${3:-}"
  local erro=""
  [ "$RC" -ne "$ESPERADO" ] && erro="exit $RC, esperado $ESPERADO"
  if [ -n "$re" ] && ! echo "$SAIDA" | grep -qE "$re"; then
    erro="${erro:+$erro; }saída não casa /$re/"
  fi
  if [ -z "$erro" ]; then
    PASS=$((PASS+1)); printf '  ✅ %s\n' "$LAB"
  else
    FAIL=$((FAIL+1)); printf '  ❌ %s — %s\n' "$LAB" "$erro"
    echo "$SAIDA" | grep -E "❌|⚠️|⚪|✅" | sed 's/^/        /'
  fi
  cd / && rm -rf "$REPO"
}

commit() { git add -A && git commit -qm "$1"; }

echo "# testar.sh — controles do verificar.sh"
echo

# ══ V-1 — autoproteção global ════════════════════════════════════════════════
echo "## V-1 — o script percebe que está cego?"
novo_repo; rodar; checa "diff vazio REPROVA (contagem zero não é sucesso)" 1 "VERIFICADOR CEGO"

# ══ V-2 — autoproteção por corpus ════════════════════════════════════════════
echo "## V-2 — arquivo do diff ausente do disco"
novo_repo
printf 'import { X } from "./x";\nexport const a = X;\n' > src/a.ts; commit c1
rm src/a.ts                                   # some do disco, segue no diff
rodar; checa "arquivo sumido REPROVA em vez de ser pulado em silêncio" 1 "PARCIALMENTE CEGO"

# ══ V1 — node_modules ════════════════════════════════════════════════════════
echo "## V1 — node_modules"
novo_repo; mkdir -p node_modules && echo x > node_modules/pacote.js; commit c1
rodar; checa "[+] caminho real em node_modules REPROVA" 1 "node_modules aparece"
novo_repo; echo "sobre a armadilha" > docs-node_modules-armadilha.md; commit c1
rodar; checa "[-] doc SOBRE a armadilha passa (nome não é caminho)" 0

# ══ V2 — import órfão ════════════════════════════════════════════════════════
echo "## V2 — import órfão"
novo_repo
printf 'import { Usado, Orfao } from "./m";\nexport const z = Usado;\n' > src/a.ts; commit c1
rodar; checa "[+] órfão introduzido REPROVA" 1 "'Orfao' importado e nunca usado"

novo_repo
printf 'import * as Ns from "./m";\nexport const z = 1;\n' > src/a.ts; commit c1
rodar; checa "[+] 'import * as X' órfão REPROVA (era ponto cego)" 1 "'Ns' importado"

novo_repo
printf 'import { A as B } from "./m";\nexport const z = B;\n' > src/a.ts; commit c1
rodar; checa "[-] alias usado passa (o nome local é o do 'as')" 0

novo_repo
printf 'const z = 1;\n/*\nimport { Fantasma } from "./g";\n*/\nexport { z };\n' > src/a.ts; commit c1
rodar; checa "[-] import dentro de bloco /* */ NÃO é órfão" 0

novo_repo
printf 'import { Mult } from "./m";\nexport const p = 2\n  * Mult;\n' > src/a.ts; commit c1
rodar; checa "[-] continuação de linha com '*' não vira comentário" 0

novo_repo
printf 'import { T } from "./t";\nexport const x: Array<T> = [];\n' > src/a.ts; commit c1
rodar; checa "[-] uso só em tipo genérico conta como uso" 0

novo_repo
printf 'import { Div } from "./m";\nexport const z = 1;\n' > src/velho.ts; commit c0
git checkout -q main && git merge -q feature && git checkout -q -b f2
git mv src/velho.ts src/novo.ts && commit c1
git checkout -q feature 2>/dev/null || true; git branch -q -f feature f2 2>/dev/null || true
git checkout -q f2
SAIDA="$(bash "$VERIF" main 2>&1)"; RC=$?
checa "[-] RENOME não imputa dívida antiga ao PR" 0 "PRÉ-EXISTENTE|SEM FALHA"

# ══ V3 — import de arquivo apagado ═══════════════════════════════════════════
echo "## V3 — referência a arquivo apagado"
novo_repo
mkdir -p src/a src/b
printf 'export const x = 1;\n' > src/a/Comum.ts
printf 'export const x = 2;\n' > src/b/Comum.ts
printf 'import { x } from "../b/Comum";\nimport { x as y } from "../a/Comum";\nexport const z = x + y;\n' > src/importa.ts
commit c0; git checkout -q main && git merge -q feature && git checkout -q -b f2
git rm -q src/a/Comum.ts; commit c1
rodar 2>/dev/null; SAIDA="$(bash "$VERIF" main 2>&1)"; RC=$?
checa "[+] basename repetido: acha o apagado apesar do vivo (era 'head -1')" 1 "ainda é importado"

novo_repo
mkdir -p src/mod src/outro
printf 'export const x = 1;\n' > src/mod/Alvo.ts
printf 'import { x } from "@shared/mod/Alvo";\nexport const z = x;\n' > src/outro/alias.ts
commit c0; git checkout -q main && git merge -q feature && git checkout -q -b f2
git rm -q src/mod/Alvo.ts; commit c1
SAIDA="$(bash "$VERIF" main 2>&1)"; RC=$?
checa "[+] import por ALIAS do tsconfig é visto (622 sítios no repo real)" 1 "ainda é importado"

# ══ V4 — teste desligado ═════════════════════════════════════════════════════
echo "## V4 — teste desligado"
novo_repo
printf 'describe.skip("x", () => {});\n' > src/a.test.ts; commit c1
rodar; checa "[+] describe.skip REPROVA" 1 "teste desligado"
novo_repo
printf 'export const q = db.skip(10).limit(20);\n' > src/a.ts; commit c1
rodar; checa "[-] .skip() de paginação NÃO é teste desligado" 0

# ══ V5 — PII em log ══════════════════════════════════════════════════════════
echo "## V5 — PII em log"
novo_repo
printf 'console.log(`worker ${w.phone} convidado`);\n' > src/a.ts; commit c1
rodar; checa "[+] telefone INTERPOLADO no log REPROVA" 1 "interpolando campo pessoal"
novo_repo
printf 'console.log(`breakdown: sem_telefone=${semTelefone}`);\n' > src/a.ts; commit c1
rodar; checa "[-] CONTAGEM passa (a regra permite status e contagem)" 0

# ══ V6 — dado clínico ════════════════════════════════════════════════════════
echo "## V6 — dado clínico rumo a terceiro"
novo_repo
printf 'const url = `${base}?utm_content=${p.diagnosis}`;\n' > src/a.ts; commit c1
rodar; checa "[+] diagnosis em URL REPROVA" 1 "dado clínico com saída externa"
novo_repo
printf "const DIAGNOSTIC_ENDPOINT = 'http://localhost:8080/healthz';\n" > src/a.ts; commit c1
rodar; checa "[-] diagnosticsHttp/Endpoint NÃO é dado clínico" 0

# ══ V9 — feature sem teste ═══════════════════════════════════════════════════
echo "## V9 — feature sem teste"
novo_repo
mkdir -p worker-functions/src/modules/matching/interfaces/controllers
printf 'export class C {}\n' > worker-functions/src/modules/matching/interfaces/controllers/Novo.ts
commit c1
rodar; checa "[+] controller sob modules/** sem teste REPROVA (era cego a 174 arquivos)" 1 "sem NENHUM teste"

novo_repo
mkdir -p worker-functions/src/modules/matching/interfaces/controllers enlite-frontend/src
printf 'export class C {}\n' > worker-functions/src/modules/matching/interfaces/controllers/Novo.ts
printf 'it("x", () => {});\n' > enlite-frontend/src/algo.test.ts
commit c1
rodar; checa "[+] teste do OUTRO projeto não satisfaz a feature do backend" 1 "sem NENHUM teste"

novo_repo
mkdir -p worker-functions/src/modules/matching/interfaces/controllers/__tests__
printf 'export class C {}\n' > worker-functions/src/modules/matching/interfaces/controllers/Novo.ts
printf 'it("x", () => {});\n' > worker-functions/src/modules/matching/interfaces/controllers/__tests__/Novo.test.ts
commit c1
rodar; checa "[-] controller COM teste do mesmo projeto passa" 0

# ══ V10 — segredo ════════════════════════════════════════════════════════════
echo "## V10 — segredo literal"
novo_repo
printf 'const apiKey = "sk_live_9aBcDeFgHiJkLmNoPqRs";\n' > src/a.ts; commit c1
rodar; checa "[+] apiKey camelCase REPROVA (eram 170 identificadores cegos)" 1 "segredo literal"
novo_repo
mkdir -p terraform
printf 'variable "db_password" {\n  default = "SuperSecret1234567890abc"\n}\n' > terraform/x.tf; commit c1
rodar; checa "[+] segredo em .tf REPROVA (corpus era só .ts)" 1 "segredo literal"
novo_repo
printf 'const apiKey = process.env.API_KEY;\n' > src/a.ts; commit c1
rodar; checa "[-] leitura de env passa" 0

echo
echo "================================================================"
echo "PASSOU: $PASS · FALHOU: $FAIL"
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
