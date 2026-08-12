# Gate de cobertura — a garantia de "todos os fluxos testados"

Este diretório materializa a garantia central da suíte: **prova determinística e
versionada de que toda rota user-facing do app tem teste** — não uma alegação, um gate.

## Como funciona

- **`user-facing-routes.ts` é o DENOMINADOR** (o flow-map). Cada rota user-facing do app
  (front + API pública/de-usuário) é um item tipado, commitado. Rotas com `excluded`
  (redirects, só-DEV, catch-all) ficam FORA do denominador, mas listadas pra auditoria.
- **Cada spec declara cobertura via tag `@route:` no título do `test(...)`.** Ex.:
  `test('[@route:/vacantes/:id] renderiza vaga pública', ...)`. O numerador é o conjunto
  de rotas do flow-map cuja `route` aparece como tag em algum spec sob `smoke/` ou `regression/`.
- **`coverage.spec.ts` (projeto Playwright `coverage-gate`) cruza os dois.** É um teste
  Node puro (sem browser): varre os specs, extrai as tags, monta a tabela de cobertura
  por surface e aplica os asserts.

## Regras operacionais

- **Rota nova no app → adicione ao flow-map** (senão fica invisível ao gate, nunca cobrada)
  **e escreva o spec** com a tag `@route:` batendo byte-a-byte com a string do flow-map.
- **A string tem que ser idêntica.** `@route:/vacantes/:id` no spec exige `/vacantes/:id`
  no flow-map. Tags de API incluem o método: `@route:GET /health`.

## Os dentes do gate

1. **Tag órfã → SEMPRE falha** (independe de enforcement). Uma tag `@route:` que não casa
   com nenhuma rota do flow-map = typo ou rota removida do app ainda sendo "testada".
2. **Ratchet via `ENFORCE_COVERAGE`** (default OFF = só reporta, build não fica vermelho
   enquanto construímos):
   - `ENFORCE_COVERAGE=smoke` → falha listando rotas **tier smoke** sem cobertura.
   - `ENFORCE_COVERAGE=all` → falha listando **qualquer** rota não-excluída sem cobertura.

**Plano de aperto:** ligar `ENFORCE_COVERAGE=smoke` no CI quando o smoke fechar; depois
`ENFORCE_COVERAGE=all` quando a regressão fechar. A partir daí, **o gate quebra se um spec
coberto sumir** (regressão silenciosa) **ou se aparecer tag órfã**. Essa é a garantia.

## Rodar

```bash
npx playwright test --project=coverage-gate --reporter=list   # report-only (imprime a tabela)
ENFORCE_COVERAGE=smoke npx playwright test --project=coverage-gate   # exige smoke completo
ENFORCE_COVERAGE=all   npx playwright test --project=coverage-gate   # exige tudo
```
