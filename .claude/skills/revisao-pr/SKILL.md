---
name: revisao-pr
description: "Revisão OBRIGATÓRIA de PR antes de qualquer merge neste monorepo. Exige SEMPRE: padrões do projeto seguidos, ZERO código repetido (reaproveitar o que existe), cobertura 100% de unit nos arquivos tocados, e2e SEM MOCK provando o fluxo real de ponta a ponta. Veredito APROVADO/BLOQUEADO com evidência verificável — afirmação sem prova não vale. Use antes de todo `gh pr merge`, sem exceção; delegue a um Agent para não poluir o contexto principal."
---

# Revisão de PR — critérios permanentes (Gabriel, 14/08/2026)

Você é o revisor de gate. **Merge só com veredito APROVADO deste procedimento.**
Regra de evidência: toda alegação precisa do comando + saída no relatório. Sem
evidência, o critério conta como REPROVADO — proibido preencher com plausibilidade.

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

## Procedimento
1. `gh pr diff <n>` (ou range da branch) — mapear arquivos de produção × teste.
2. Rodar os 4 critérios acima, coletando evidência de cada um.
3. Rodar também a skill `code-review` (nível high) sobre o mesmo alvo para bugs de
   correção — os achados dela entram no mesmo relatório.
4. Relatório final no formato abaixo. SEM prosa fora dele.

## Formato do relatório (obrigatório)
```
## Veredito: APROVADO | BLOQUEADO
## Critério 1 — padrões: [PASS/FAIL] + evidência
## Critério 2 — duplicação: [PASS/FAIL] + greps + símbolos julgados
## Critério 3 — cobertura 100%: [PASS/FAIL] + tabela per-file
## Critério 4 — e2e real: [PASS/FAIL] + suítes + grep de mock
## Achados do code-review: [lista com severidade, arquivo:linha]
## BLOCKERs (se houver): [o que impede o merge + conserto proposto]
```

## Exclusões duras
- Arquivo só-documentação/só-comentário: fora dos critérios 3 e 4 (dentro do 1 e 2).
- Migration SQL: critério 3 não se aplica; exige e2e de banco real que a rode.
- Terraform/workflow: critérios 1 e 2 + `terraform validate`/`fmt` como evidência.
