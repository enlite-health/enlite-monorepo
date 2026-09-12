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

# ⚠️ ISCAS do V10, montadas por CONCATENAÇÃO de propósito.
# O V10 varre `.sh`. Se o segredo-isca estivesse literal aqui, o gate reprovaria
# o PR que traz o teste do gate — e foi exatamente o que aconteceu na 1ª versão.
# Um detector de segredo não pode carregar segredo literal no próprio teste.
P1="sk_live_"; P2="9aBcDeFgHiJkLmNoPqRs"
P3="SuperS";   P4="ecret1234567890abc"

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
rodar; checa "[+] órfão introduzido AVISA (rebaixado: falso positivo em URL e string)" 0 "'Orfao' parece importado e nunca usado"

novo_repo
printf 'import * as Ns from "./m";\nexport const z = 1;\n' > src/a.ts; commit c1
rodar; checa "[+] 'import * as X' órfão AVISA (era ponto cego)" 0 "'Ns' parece importado"

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

# [+] basename REPETIDO: o apagado tem de ser achado apesar do homônimo vivo.
#     ⚠️ a fixture da 1ª versão punha o importador em `src/` e importava
#     `../a/Comum`, que resolve para FORA de `src/` — ela passava por ACIDENTE,
#     porque o V3 antigo casava por basename e não resolvia caminho nenhum.
novo_repo
mkdir -p src/a src/b src/c
printf 'export const x = 1;\n' > src/a/Comum.ts
printf 'export const x = 2;\n' > src/b/Comum.ts
printf 'import { x } from "../b/Comum";\nimport { x as y } from "../a/Comum";\nexport const z = x + y;\n' > src/c/importa.ts
commit c0; git checkout -q main && git merge -q feature && git checkout -q -b f2
git rm -q src/a/Comum.ts; commit c1
SAIDA="$(bash "$VERIF" main 2>&1)"; RC=$?
checa "[+] basename repetido: acha o apagado apesar do homônimo VIVO" 1 "src/c/importa.ts:2"

# [-] CONTROLE NEGATIVO que faltava: apagar um homônimo que NINGUÉM importa,
#     enquanto o outro é usado, tem de PASSAR. Sem este caso, o V3 podia
#     reprovar todo PR que apagasse arquivo com nome repetido — e o repo real
#     tem 14 basenames repetidos.
novo_repo
mkdir -p src/legacy src/new src/app
printf 'export const b = 1;\n' > src/legacy/Utils.ts
printf 'export const b = 2;\n' > src/new/Utils.ts
printf 'import { b } from "../new/Utils";\nexport const z = b;\n' > src/app/main.ts
commit c0; git checkout -q main && git merge -q feature && git checkout -q -b f2
git rm -q src/legacy/Utils.ts; commit c1
SAIDA="$(bash "$VERIF" main 2>&1)"; RC=$?
checa "[-] apagar homônimo NÃO importado passa (14 basenames repetidos no repo)" 0

# [+] ALIAS do tsconfig — a forma dominante de import do repo.
novo_repo
mkdir -p src/mod src/outro
printf '{ "compilerOptions": { "baseUrl": ".", "paths": { "@shared/*": ["src/*"] } } }\n' > tsconfig.json
printf 'export const x = 1;\n' > src/mod/Alvo.ts
printf 'import { x } from "@shared/mod/Alvo";\nexport const z = x;\n' > src/outro/alias.ts
commit c0; git checkout -q main && git merge -q feature && git checkout -q -b f2
git rm -q src/mod/Alvo.ts; commit c1
SAIDA="$(bash "$VERIF" main 2>&1)"; RC=$?
checa "[+] import por ALIAS do tsconfig é visto" 1 "src/outro/alias.ts"

# [+] jest.mock() e import() dinâmico contam como referência.
novo_repo
mkdir -p src/mod src/outro
printf 'export const x = 1;\n' > src/mod/Alvo.ts
printf 'jest.mock("../mod/Alvo");\nexport const z = 1;\n' > src/outro/mock.ts
commit c0; git checkout -q main && git merge -q feature && git checkout -q -b f2
git rm -q src/mod/Alvo.ts; commit c1
SAIDA="$(bash "$VERIF" main 2>&1)"; RC=$?
checa "[+] jest.mock() de arquivo apagado é referência pendente" 1 "src/outro/mock.ts"

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

# ── D-11/09 (atualizado, item 1 do gate): redactContact foi APAGADO; os donos
#    únicos da máscara agora são maskPhoneForLog/maskEmailForLog/safeErrorFields
#    — e SOMENTE eles são SAÍDA SEGURA ──────────────────────────────────────
novo_repo
printf "console.log(\`worker \${maskPhoneForLog(phone)} convidado\`);\n" > src/a.ts; commit c1
rodar; checa "[-] telefone mascarado via maskPhoneForLog(...) NÃO reprova" 0
novo_repo
printf 'console.log(`worker ${phone} convidado`);\n' > src/a.ts; commit c1
rodar; checa "[+] CONTROLE: o mesmo telefone SEM maskPhoneForLog continua reprovando" 1 "interpolando campo pessoal"
novo_repo
printf "console.log(\`user \${maskEmailForLog(email)} registered\`);\n" > src/a.ts; commit c1
rodar; checa "[-] e-mail mascarado via maskEmailForLog(...) NÃO reprova" 0
novo_repo
printf "console.log(\`worker \${safeErrorFields(phone)} convidado\`);\n" > src/a.ts; commit c1
rodar; checa "[-] campo pessoal mascarado via safeErrorFields(...) NÃO reprova" 0
novo_repo
printf 'console.log(`user ${email} registered`);\n' > src/a.ts; commit c1
rodar; checa "[+] CONTROLE: e-mail cru (sem nenhum helper) continua reprovando" 1 "interpolando campo pessoal"
novo_repo
printf "logger.warn({ phone: maskPhoneForLog(phone) }, phone);\n" > src/a.ts; commit c1
rodar; checa "[+] linha com UM campo mascarado e outro campo pessoal cru na MESMA linha continua reprovando" 1 "interpolando campo pessoal"
novo_repo
printf "console.log(\`worker \${redactContact(phone, 'phone')} convidado\`);\n" > src/a.ts; commit c1
rodar; checa "[+] CONTROLE: helper EXTINTO (redactContact) não é mais saída segura — reprova como qualquer nome desconhecido" 1 "interpolando campo pessoal"

# ── C2 (parecer do lex): campos novos no detector, e CUIL/CUIT NUNCA tem saída
#    segura — "documento não se mascara, se remove", mesmo dentro de maskPhoneForLog ──
novo_repo
printf 'console.log(`worker ${cuil} cadastrado`);\n' > src/a.ts; commit c1
rodar; checa "[+] CUIL cru REPROVA (campo novo, C2)" 1 "interpolando campo pessoal"
novo_repo
printf "console.log(\`worker \${maskPhoneForLog(cuil)} cadastrado\`);\n" > src/a.ts; commit c1
rodar; checa "[+] CONTROLE: CUIL dentro de maskPhoneForLog(...) TAMBÉM reprova — não existe saída segura pra documento" 1 "interpolando campo pessoal"
novo_repo
printf 'console.log(`endereco ${address} confirmado`);\n' > src/a.ts; commit c1
rodar; checa "[+] endereço (address) INTERPOLADO REPROVA (campo novo, C2)" 1 "interpolando campo pessoal"
novo_repo
printf 'console.log(`paciente ${nombre} confirmado`);\n' > src/a.ts; commit c1
rodar; checa "[+] nome (nombre) INTERPOLADO REPROVA (campo novo, C2)" 1 "interpolando campo pessoal"

# ── item 5 (2ª rodada do gate): chamada de log MULTILINHA — sabotagem que o
#    gate reproduziu (EXIT=0 com telefone cru numa linha de continuação) ─────
novo_repo
printf 'console.warn(\n  `worker ${phone} nao encontrado`,\n);\n' > src/a.ts; commit c1
rodar; checa "[+] MULTILINHA: telefone cru na linha SEGUINTE ao abridor REPROVA (sabotagem do gate)" 1 "interpolando campo pessoal"
novo_repo
printf "console.warn(\n  \`worker \${maskPhoneForLog(phone)} nao encontrado\`,\n);\n" > src/a.ts; commit c1
rodar; checa "[-] MULTILINHA: telefone mascarado na linha seguinte NÃO reprova" 0
novo_repo
printf "logger.warn({\n  phone: maskPhoneForLog(phone),\n}, phone);\n" > src/a.ts; commit c1
rodar; checa "[+] MULTILINHA: um campo mascarado e outro campo cru em linhas DIFERENTES continua reprovando" 1 "interpolando campo pessoal"

# ══ V6 — dado clínico ════════════════════════════════════════════════════════
echo "## V6 — dado clínico rumo a terceiro"
novo_repo
printf 'const url = `${base}?utm_content=${p.diagnosis}`;\n' > src/a.ts; commit c1
rodar; checa "[+] diagnosis em URL REPROVA" 1 "dado clínico com saída externa"
novo_repo
printf "const DIAGNOSTIC_ENDPOINT = 'http://localhost:8080/healthz';\n" > src/a.ts; commit c1
rodar; checa "[-] diagnosticsHttp/Endpoint NÃO é dado clínico" 0

# ══ V7 — rota nova sem célula ════════════════════════════════════════════════
# Sem fixture até a 3ª revisão: check anunciado na tabela e nunca exercitado.
echo "## V7 — rota nova sem célula (aviso)"
novo_repo
mkdir -p src
printf 'router.post("/admin/purge", purgeTudo);\n' > src/adminRoutes.ts; commit c1
rodar; checa "[+] rota nova sem célula AVISA (não reprova, por desenho)" 0 "sem célula na MESMA linha"
novo_repo
mkdir -p src
printf 'router.post("/admin/purge", requirePermission("admin","purge"), purgeTudo);\n' > src/adminRoutes.ts; commit c1
rodar; checa "[-] rota nova COM célula não avisa" 0 "toda rota nova declara célula"
novo_repo
mkdir -p src
printf 'app.post("/admin/purge", purgeTudo);\n' > src/server.ts; commit c1
rodar; checa "[+] rota fora de *Routes.ts também é vista (app.post em server.ts)" 0 "sem célula na MESMA linha"

# ══ V8 — workflow de produção ════════════════════════════════════════════════
# Idem: é FAIL DURO que fecha merge, e não tinha fixture nenhuma.
echo "## V8 — workflow de produção"
novo_repo
mkdir -p .github/workflows
printf 'name: deploy\n' > .github/workflows/backend-prd.yml; commit c1
rodar; checa "[+] workflow -prd REPROVA" 1 "workflow de PRODUÇÃO"
novo_repo
mkdir -p .github/workflows
printf 'name: deploy\n' > .github/workflows/deploy-PRODUCTION.yml; commit c1
rodar; checa "[+] -PRODUCTION maiúsculo REPROVA (era case-sensitive e só 'prd')" 1 "workflow de PRODUÇÃO"
novo_repo
mkdir -p .github/workflows
printf 'name: deploy\n' > .github/workflows/backend-stg.yml; commit c1
rodar; checa "[-] workflow de staging passa" 0 "nenhum workflow de PRD"

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
printf 'const apiKey = "%s%s";\n' "$P1" "$P2" > src/a.ts; commit c1
rodar; checa "[+] apiKey camelCase AVISA (rebaixado: 3 de 6 PRs reais dão falso positivo)" 0 "segredo literal"
novo_repo
mkdir -p terraform
printf 'variable "db_password" {\n  default = "%s%s"\n}\n' "$P3" "$P4" > terraform/x.tf; commit c1
rodar; checa "[+] segredo em .tf AVISA (corpus era só .ts)" 0 "segredo literal"
novo_repo
printf 'const apiKey = process.env.API_KEY;\n' > src/a.ts; commit c1
rodar; checa "[-] leitura de env passa" 0

# ══ PORTABILIDADE — a armadilha que já voltou DUAS vezes ═════════════════════
# 1ª: `IGNORECASE` no awk (extensão do gawk) — o awk do macOS ignora em silêncio
#     e o V10 voltava a ser cego a `apiKey`.
# 2ª: `{16,}` no awk — o **mawk**, awk padrão de Debian E Ubuntu (portanto do
#     CI), não honra intervalo: o V10 ficava MORTO e VERDE em Linux. Medido pelo
#     revisor em `node:20` e `ubuntu:22.04`: 23/25 nos dois.
#
# Rodar o testar.sh em Linux pegaria — mas só se alguém rodar. Estas asserções
# são ESTRUTURAIS: valem em qualquer máquina, inclusive nesta, e travam a CLASSE
# em vez de esperar a terceira encarnação.
echo "## Portabilidade — construções que se comportam diferente por plataforma"
porta() {
  local lab="$1" re="$2"
  local hits
  hits=$(grep -nE "$re" "$VERIF" | grep -v "^[0-9]*:#" || true)
  if [ -n "$hits" ]; then
    FAIL=$((FAIL+1)); printf '  ❌ %s\n' "$lab"; echo "$hits" | head -3 | sed 's/^/        /'
  else
    PASS=$((PASS+1)); printf '  ✅ %s\n' "$lab"
  fi
}
porta "sem \`awk\` — a fonte das duas armadilhas (use python3, já é dependência)" '(^|[^_[:alnum:]])awk[[:space:]]'
porta "sem \`grep -P\` (PCRE é GNU-only, não existe no BSD)"                     'grep[^|]*-[a-zA-Z]*P'
porta "sem \`sed -i\` sem sufixo (BSD exige argumento, GNU não)"                 'sed -i[[:space:]]'
porta "sem \`readlink -f\` (não existe no BSD antigo)"                           'readlink -f'
porta "sem \`mapfile\`/\`readarray\` (não existem no bash 3.2 do macOS)"        '(mapfile|readarray)[[:space:]]'
porta "sem \`declare -A\` (array associativo não existe no bash 3.2)"            'declare -A'
porta "sem \`date -d\` / \`stat -c\` (sintaxe GNU)"                             '(date -d|stat -c)'

# O verificador tem de rodar num shell POSIX-ish sem estourar sintaxe
if bash -n "$VERIF" 2>/dev/null; then
  PASS=$((PASS+1)); printf '  ✅ %s\n' "verificar.sh passa no \`bash -n\`"
else
  FAIL=$((FAIL+1)); printf '  ❌ %s\n' "verificar.sh NÃO passa no \`bash -n\`"
fi

echo
echo "⚠️  Isto NÃO substitui rodar em Linux. Antes de mergear mudança neste"
echo "    script:  docker run --rm -v \$(pwd):/w:ro node:20 bash -c 'cp -r /w/.claude /tmp/ && cd /tmp && bash .claude/skills/revisao-pr/testar.sh'"

echo
echo "================================================================"
echo "PASSOU: $PASS · FALHOU: $FAIL"
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
