---
name: revisao-pr
description: "Revisão OBRIGATÓRIA de PR antes de qualquer merge neste monorepo. Exige SEMPRE: padrões do projeto seguidos, ZERO código repetido (reaproveitar o que existe), cobertura 100% de unit nos arquivos tocados, e2e SEM MOCK provando o fluxo real de ponta a ponta. Veredito APROVADO/BLOQUEADO com evidência verificável — afirmação sem prova não vale. Use antes de todo `gh pr merge`, sem exceção; delegue a um Agent para não poluir o contexto principal."
---

# Revisão de PR — critérios permanentes (Gabriel, 14/08/2026)

Você é o revisor de gate. **Merge só com veredito APROVADO deste procedimento.**
Regra de evidência: toda alegação precisa do comando + saída no relatório. Sem
evidência, o critério conta como REPROVADO — proibido preencher com plausibilidade.

⚠️ **O check `gate` do CI NÃO substitui isto.** Ele é agregador de quality+e2e:
executa o **conjunto**. Este gate lê o **diff**. São perguntas diferentes — e nas
duas vezes em que rodou, achou coisa grave que suíte verde não apontava (D131).

## Passo 0 — o verificador determinístico (roda ANTES dos 4 critérios)

```bash
bash .claude/skills/revisao-pr/verificar.sh              # base: origin/main
bash .claude/skills/revisao-pr/verificar.sh origin/stage # PR para a stage
bash .claude/skills/revisao-pr/testar.sh                 # o teste DO verificador
```

⚠️ **`awk` é proibido neste script, e o `testar.sh` trava isso.** Ele já matou o
V10 duas vezes: `IGNORECASE` (só no gawk — o awk do macOS ignora em silêncio) e
`{16,}` (o **mawk**, awk padrão de Debian e Ubuntu, não honra intervalo). Nas
duas o check ficou **morto e verde**. A varredura pesada vive em `orfaos.py`,
`importadores.py` e `segredos.py`.

⚠️ **Rodar em Linux antes de mergear mudança no script.** A guarda de
portabilidade do `testar.sh` é estrutural (proíbe `awk`, `grep -P`, `sed -i`,
`mapfile`…) e vale em qualquer máquina, mas não substitui a execução:
```bash
docker run --rm -v "$(pwd)/.claude/skills/revisao-pr:/skill:ro" node:20 bash -c \
  'mkdir -p /tmp/w/.claude/skills/revisao-pr && cp /skill/* /tmp/w/.claude/skills/revisao-pr/ && cd /tmp/w \
   && git config --global user.email t@t && git config --global user.name t \
   && git config --global init.defaultBranch main \
   && bash .claude/skills/revisao-pr/testar.sh'
```
Medido em 23/08/2026: **41/41 no macOS (bash 3.2, BWK awk) e 41/41 no Linux
(bash 5.2, mawk 1.3.4)** — o mesmo ambiente onde a versão com `awk` dava 23/25.

⚠️ **Se você mexer no `verificar.sh`, rode o `testar.sh`.** São 25 fixtures, cada
uma um defeito real que já passou por aqui, com controle **positivo** (o defeito
presente → tem de reprovar) e **negativo** (o caso legítimo parecido → tem de
passar). Autoteste de um lado só aprova o defeito do próprio verificador.

12 checks sobre o DIFF, sem LLM. **Exit 1 se algum FALHAR → BLOQUEADO, e os 4
critérios nem começam.**

Três estados, e a diferença importa:
- **❌ falha** — reprova e derruba o exit code.
- **⚠️ aviso** — informa e NÃO reprova. São **V7** (rota sem célula: a definição
  pode ser multilinha, e um FAIL teria falso positivo demais), o **V2 inteiro** e
  o **V10**. Todos pela mesma razão: **gate que reprova código certo se aprende a
  ignorar**. O V2 e o V10 foram rebaixados em 24/08 com falso positivo MEDIDO — o
  `//` de uma URL trunca a linha e acusa import usado (`orfaos.py`), e 3 de 6
  merges reais do `main` dão hit de segredo sem nenhum segredo (`segredos.py`,
  basta `Content-Type` perto de `token`). Voltam a **falha** quando o tokenizador
  de string e a exigência de aspas + mistura de classes entrarem — o achado está
  escrito no cabeçalho do `verificar.sh`, não perdido.
  ⚠️ **Aviso não é ✅.** V2 e V10 em aviso passam a ser leitura obrigatória do
  revisor: o script deixou de decidir por eles.
- **⚪ N/A** — o check não tinha o que varrer. **Nunca ✅**: contagem zero é
  falha, não sucesso. V2, V3, V4, V5, V6, V9 e V10 usam isto. A saída **colada** é a evidência; descrever a saída em
vez de colar conta como REPROVADO.

| # | pega | por que é falha |
|---|---|---|
| V-1 | o verificador não enxerga o diff | contagem zero é falha, nunca sucesso |
| V-2 | arquivo do diff **ausente do disco** | o V-1 guarda o diff global e não vê o vácuo de um check: a 1ª versão pulava o arquivo em silêncio e imprimia a contagem CHEIA — "✅ em 14 arquivos" tendo lido 10, e os 4 pulados eram os defeituosos |
| V1 | `node_modules` no diff | `.gitignore` da raiz usa `node_modules/` **com barra**, e barra casa só diretório real → **symlink entra em `git add -A`**. Reincidente (#173, #231); checkout com ele quebra o build **mudo** |
| V2 | import órfão **introduzido pelo diff** | `noUnusedLocals: false` → **o tsc passa limpo com import morto**. É o rastro de PR que apaga código. Órfão que já existia na base vira AVISO: gate que culpa o autor por dívida alheia se aprende a ignorar |
| V3 | import de arquivo apagado | quebra em runtime, não no diff. **Resolve o caminho de verdade** (`importadores.py`): relativo pelo diretório do importador, alias pelo `paths` do tsconfig — 318 linhas do repo importam por `@shared/`/`@modules/`. Cobre `import()`, `jest.mock()` e sufixo `.js`. Sem isso, os **14 basenames repetidos** do repo geravam falso positivo duro |
| V4 | `.only`/`.skip`/`xit` | suíte verde que não roda nada |
| V5 | PII **interpolada** em log novo | "nunca logar PII" é regra dura — mas a mesma regra PERMITE contagem, então `sem_telefone=${n}` passa |
| V6 | dado clínico rumo a terceiro/URL/prompt | **texto clínico NUNCA sai do perímetro.** `patients.diagnosis` é TEXT livre. Casa **palavra**, não substring: `diagnosticsHttpTimeoutMs` não é dado clínico |
| V7 | rota nova sem célula (**aviso**) | deny-when-undeclared: no flip do ABAC a rota é negada e o painel não mostra |
| V8 | workflow de PRD tocado | overwrite PROIBIDO até reconciliar YAML × serviço vivo |
| V9 | arquivo de **feature** sem teste **do mesmo projeto** | cobre `interfaces/(controllers\|routes)`, `application`, `presentation/(pages\|components)` e `infrastructure/converters`, com ou sem `modules/` no meio — **574 arquivos**, contra **1** no layout legado. ⚠️ NÃO reusa `scripts/check-needs-tests.sh`: aquele roda de dentro de `worker-functions/` e mira o legado. ⚠️ **Mede EXISTÊNCIA de teste no projeto, não se o teste cobre o arquivo tocado** |
| V10 | segredo literal | corpus próprio e mais largo (`.tf`, workflow, `.sh`, `.env`), **case-insensitive** (`apiKey` e afins são **123 linhas** em `worker-functions/src`) e janela de **4 linhas** para o terraform idiomático, sem atravessar arquivo nem hunk. Vive em `segredos.py` — **sem `awk`**, que matou este check duas vezes |

**Exit codes:** `0` sem falha · `1` alguma falha → BLOQUEADO · `2` erro de uso
(base inexistente, fora de repo git). **Testar `-eq 1` lê o 2 como aprovado.**

**Passar no Passo 0 NÃO é aprovação:** o script mede forma, os 8 critérios medem
substância.

## Os 4 critérios obrigatórios (SEMPRE, todo PR)

### 1. Padrões do projeto
- Ler o código VIZINHO de cada arquivo tocado (mesmo diretório/módulo) e comparar:
  nomenclatura, idioma dos comentários, forma de teste, camadas (controller → use
  case → repository), zod na borda, erros visíveis (nunca default silencioso).
- Config de serviço muda em WORKFLOW (`.github/workflows/`), nunca instrução de
  `gcloud update` manual; migration nova é idempotente e re-rodável.
- Evidência: lista dos padrões conferidos, com 1 exemplo de arquivo vizinho por padrão.

### 2. Zero código repetido — reaproveitar antes de criar
- Para CADA função/helper/constante nova no diff: grep no repo por equivalente
  existente (nome, e também por FORMA — ex.: outro enum AR|BR, outro parser de env,
  outro filtro de status). Achou equivalente → o PR deve usá-lo ou a duplicação é
  BLOCKER com justificativa explícita no código.
- Dentro do próprio diff: dois trechos ≥5 linhas estruturalmente iguais = BLOCKER.
- Evidência: os greps rodados (comando + hits relevantes) e o veredito de cada
  símbolo novo.

### 3. Unit com cobertura 100% nos arquivos tocados
- Rodar `npx jest --coverage --collectCoverageFrom='<globs dos arquivos de PRODUÇÃO
  tocados>' <suites relacionadas> --silent` e ler o per-file (nunca só a média).
- Piso: **100% lines/branches/functions/statements em cada arquivo de produção
  tocado**. Abaixo disso: listar arquivo + linhas descobertas + o caso de teste que
  falta. Exceção só com justificativa técnica escrita (ex.: ramo de erro de driver
  irreproduzível em unit) E cobertura do ramo em e2e — anotada no relatório.
- Evidência: tabela per-file do coverage colada no relatório.

### 4. E2E sem mock provando o fluxo REAL
- Todo fluxo novo/alterado precisa de e2e que exercite banco real (Postgres do
  stack) e, quando houver rota, a API real — `grep -l "jest.mock" tests/e2e/` nos
  arquivos do PR tem que voltar VAZIO (mock em e2e = BLOCKER).
- O e2e afirma o EFEITO (linha no banco, resposta da API, RLS negando), não o mock
  do efeito. Side-effects outbound (WhatsApp, Periskope, e-mail) usam o padrão da
  casa de neutralização — nunca canal real (memória teste-nunca-toca-canal-real).
- Evidência: nomes das suítes rodadas + linha final X/X + o grep de mocks.

## Critérios 5-8 — acrescentados em 23/08/2026

### 5. Escopo: o diff bate com o que foi APROVADO?
A autorização vale para o achado **NOMEADO** — não para a classe de bug, não para
o arquivo. Achado novo vai para **LISTA**, não para o diff. Sinais de
racionalização: *"já estou com a mão nessas linhas"* · *"é a mesma classe de
defeito"* · *"são só 4 linhas"*. **BLOCKER** se o diff sair do arquivo/função
nomeados, ou mudar **semântica** e não só robustez.
- Evidência: o que foi pedido × o que o diff faz, lado a lado.

### 6. O que a rota DEVOLVE, não como ela se chama
Oráculo não é verdade: `by-phone` era `worker_pii` disfarçado de `worker:read` e
devolvia o dossiê inteiro (D127). Abrir o payload de cada rota tocada e conferir
campo a campo.
- Evidência: lista de campos que cada rota tocada devolve.

### 7. Falha silenciosa
`catch` que engole, fallback que mascara, `?? ''` que manda requisição vazia para
fora. Perguntar de cada um: **se isto falhar, alguém fica sabendo?** Caso real:
`fetch` para terceiro sem guarda de chave — com a chave morta o dado já tinha
saído, e o 401 caía num `console.error`.
- Evidência: cada `catch`/fallback do diff, com arquivo:linha e o veredito.

### 8. Sabotagem do teste novo
Guarda de regressão só vale **provada**: reintroduzir o defeito e mostrar o teste
**VERMELHO**, depois restaurar e mostrar verde. Autoteste de um lado só aprova
defeito do próprio verificador — quem acha monta alvo **próprio**.
- Evidência: as duas saídas, vermelha e verde.

## Medir sem se enganar
- **`$?` depois de pipeline é do `head`.** Redirecionar para arquivo e ler o exit
  code sozinho — nunca `tsc | head`.
- **`npx` inventa pacote** quando o real não está instalado. Usar `./node_modules/.bin/`.
- **Exit code é UM sinal** — dar um segundo, independente (contagem de suítes/testes).
- **Suíte da máquina local é instável** (SIGSEGV de worker, timeout de 10s). O que
  se afirma é *"nenhuma falha atribuível, com o teste de atribuição feito"*.
  **O CI é a autoridade.**

## Retorno parcial é permitido
Se algum critério não puder ser concluído (falta credencial, ambiente fora do ar,
decisão que só o Gabriel fecha), **devolver menos e dizer o que faltou**.
⛔ Proibido declarar APROVADO com verificação não feita.

## Procedimento
1. Rodar `verificar.sh` (Passo 0). Falhou → BLOQUEADO, para aqui.
2. `gh pr diff <n>` (ou range da branch) — mapear arquivos de produção × teste.
3. Rodar os 8 critérios acima, coletando evidência de cada um.
4. Rodar também a skill `code-review` (nível high) sobre o mesmo alvo para bugs de
   correção — os achados dela entram no mesmo relatório.
5. Relatório final no formato abaixo. SEM prosa fora dele.

**Delegar a um `Agent`** (`general-purpose`, **sem ferramenta de escrita**), que faz
1-4 e devolve só o relatório. O Claude principal recebe o veredito e aplica.

## Formato do relatório (obrigatório)
```
## Veredito: APROVADO | BLOQUEADO
## Passo 0 — verificador: <saída COLADA de verificar.sh, íntegra, com o exit code>
## Critério 1 — padrões: [PASS/FAIL] + evidência
## Critério 2 — duplicação: [PASS/FAIL] + greps + símbolos julgados
## Critério 3 — cobertura 100%: [PASS/FAIL] + tabela per-file
## Critério 4 — e2e real: [PASS/FAIL] + suítes + grep de mock
## Critério 5 — escopo: [PASS/FAIL] + pedido × diff
## Critério 6 — o que a rota devolve: [PASS/FAIL] + campos por rota
## Critério 7 — falha silenciosa: [PASS/FAIL] + cada catch/fallback
## Critério 8 — sabotagem: [PASS/FAIL] + saída vermelha e verde
## Achados do code-review: [lista com severidade, arquivo:linha]
## Achados FORA do escopo (LISTA, não diff): [severidade · custo · recomendação]
## BLOCKERs (se houver): [o que impede o merge + conserto proposto]
## Não verificado: [o que ficou de fora e por quê]  (vazio = tudo coberto)
```

**Rodar DUAS vezes:** antes de **abrir** o PR e antes de **mergear**. O diff muda
entre as duas — e merge é deploy.

## Exclusões duras
- Arquivo só-documentação/só-comentário: fora dos critérios 3 e 4 (dentro do 1 e 2).
- Migration SQL: critério 3 não se aplica; exige e2e de banco real que a rode.
- Terraform/workflow: critérios 1 e 2 + `terraform validate`/`fmt` como evidência.
