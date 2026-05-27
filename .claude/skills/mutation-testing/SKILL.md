---
name: mutation-testing
description: "Auditor de mutation testing com Stryker. Mede a qualidade EFETIVA dos testes (não só cobertura) introduzindo mutações no código (operadores, strings, branches) e verificando se algum teste falha. Garante mutation score ≥85% em domain, ≥80% em application, ≥70% em infra. Reporta mutantes vivos com file:line + operador + sugestão. Roda DEPOIS de coverage-enforcer (depende de testes verdes). Setup idempotente do Stryker se ausente."
---

# Mutation Testing — Stryker para detectar testes que passam mas não testam nada

Cobertura mede "linhas executadas pelo teste". Mutation testing mede "se eu sabotar a linha, algum teste falha?". A diferença pega `expect(true).toBeTruthy()` e variantes — testes vazios que dão coverage 100%.

## Princípios

1. **Mutation score é a métrica real.** Coverage 100% + mutation 30% = teste teatro.
2. **Mutantes vivos = bugs latentes.** Cada mutante vivo é uma instrução do seu código que pode ser qualquer coisa sem nenhum teste reclamar.
3. **Threshold por camada:** domain 85, application 80, infra 70. Domain é o mais crítico porque é o coração do negócio.
4. **Sem ignorar mutante por preguiça.** Se um mutante é genuinamente equivalente (impossível de detectar — ex: tempo de log), você usa `// Stryker disable next-line` com **comentário explicando**. Sem comentário = BLOCKER.

---

## Setup canônico (idempotente)

### S.1 — Instalar Stryker se ausente

```bash
ls node_modules/@stryker-mutator/core 2>/dev/null || \
  npm install --save-dev \
    @stryker-mutator/core@8 \
    @stryker-mutator/jest-runner@8 \
    @stryker-mutator/typescript-checker@8
```

### S.2 — Criar `stryker.config.json` (na raiz)

```json
{
  "$schema": "./node_modules/@stryker-mutator/core/schema/stryker-schema.json",
  "_comment": "Mutation testing config — geral threshold conservador, override por camada via thresholds.high",
  "packageManager": "npm",
  "testRunner": "jest",
  "jest": {
    "projectType": "custom",
    "configFile": "jest.config.stryker.js"
  },
  "checkers": ["typescript"],
  "tsconfigFile": "tsconfig.json",
  "coverageAnalysis": "perTest",
  "mutate": [
    "src/**/*.ts",
    "!src/**/*.spec.ts",
    "!src/**/*.e2e-spec.ts",
    "!src/**/__test-fixtures__/**",
    "!src/**/migrations/**",
    "!src/**/*.module.ts",
    "!src/main.ts",
    "!src/**/data-source.ts",
    "!src/**/*.dto.ts",
    "!src/**/index.ts"
  ],
  "incremental": true,
  "incrementalFile": ".stryker-tmp/incremental.json",
  "thresholds": {
    "high": 85,
    "low": 80,
    "break": 80
  },
  "reporters": ["html", "clear-text", "json", "progress"],
  "htmlReporter": { "fileName": "reports/mutation/mutation-report.html" },
  "jsonReporter": { "fileName": "reports/mutation/mutation.json" },
  "concurrency": 4,
  "timeoutMS": 60000,
  "disableTypeChecks": "{src,test}/**/*.{ts,tsx,js,jsx}",
  "ignorePatterns": ["dist", "coverage", "coverage-e2e", "node_modules", "reports"]
}
```

> O threshold `break: 80` é o piso GLOBAL. A auditoria por camada é feita no Passo 4 deste skill, parsing `reports/mutation/mutation.json`.

### S.3 — `jest.config.stryker.js`

Stryker usa esse arquivo Jest separado pra excluir e2e (caro demais pra rodar por mutante):

```js
// jest.config.stryker.js
module.exports = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: 'src',
  testRegex: '.*\\.spec\\.ts$',
  testPathIgnorePatterns: ['/node_modules/', '\\.e2e-spec\\.ts$'],
  transform: { '^.+\\.(t|j)s$': 'ts-jest' },
  moduleNameMapper: { '^src/(.*)$': '<rootDir>/$1' },
  testEnvironment: 'node',
};
```

### S.4 — Script no `package.json`

```json
{
  "scripts": {
    "test:mutation": "stryker run",
    "test:mutation:incremental": "stryker run --incremental",
    "test:mutation:since": "stryker run --since=main"
  }
}
```

### S.5 — `.gitignore`

```
reports/mutation/
.stryker-tmp/
```

---

## Protocolo de auditoria

### Passo 1 — Pré-requisito

Coverage tem que estar OK (chamada por `quality-master` só após `coverage-enforcer` PASS). Se invocado isoladamente, rode primeiro:

```bash
npm run test:cov -- --silent 2>&1 | tail -5
```

Se falhou → `[ABORTADO: testes unitários falhando; mutation não roda em red]`.

### Passo 2 — Determinar escopo

- `branch` → `stryker run --since=main` (só mutações em arquivos modificados desde main)
- `full` → `stryker run`
- lista de paths → não dá pra passar lista direto pro Stryker; rode `stryker run` e filtre a leitura do report aos paths informados

### Passo 3 — Executar

```bash
npm run test:mutation 2>&1 | tail -50
```

Tempo esperado: 5–30min full, <5min incremental. Se passa de 60min → `[ABORTADO: timeout, rode --since ou aumente concurrency]`.

### Passo 4 — Parse de `reports/mutation/mutation.json`

Estrutura relevante:

```ts
{
  files: {
    "src/modules/catalog/product/domain/product.ts": {
      mutants: [
        { id, mutatorName, status: "Killed"|"Survived"|"NoCoverage"|"Timeout"|"CompileError", location: { start: { line, column } }, replacement }
      ]
    }
  }
}
```

Para cada path em escopo:
- conta `killed`, `survived`, `noCoverage`, `timeout`
- mutation score = `killed / (killed + survived + noCoverage + timeout)` × 100

Agregue por camada usando o mesmo mapeamento do `coverage-enforcer`:

| Camada (regex path) | Threshold |
|---|---|
| `src/modules/**/domain/` | ≥85 |
| `src/shared/domain/` | ≥85 |
| `src/modules/**/application/` | ≥80 |
| `src/shared/application/` | ≥80 |
| `src/modules/**/presentation/` | ≥80 |
| `src/modules/**/infra/` | ≥70 |
| `src/shared/infra/` | ≥70 |
| `src/shared/config/` | ≥80 |

### Passo 5 — Mutantes vivos (top 10 priorizados)

Ordem de prioridade (descendente):
1. `survived` em arquivo de `domain/` (maior risco)
2. `survived` em arquivo de `application/`
3. `survived` em arquivo de `infra/`
4. `noCoverage` (linha sequer foi executada — coverage-enforcer deveria ter pego, é red flag dupla)
5. `timeout` (teste loop infinito ou recursão por causa da mutação — ainda assim survived na prática)

Para cada um, emita:
- file:line:col
- operador (`mutatorName`)
- snippet original + replacement
- sugestão de teste (curta, 1 linha)

Sugestão é por padrão genérica:

| Mutator | Sugestão |
|---|---|
| `StringLiteral` (`"foo"→""`) | Asserte o valor exato, não só "trutiness" |
| `ConditionalExpression` (`a && b → false`) | Cubra ambos os ramos (true E false do guard) |
| `EqualityOperator` (`==→!=`) | Asserte resultado quando a igualdade vale E quando não |
| `LogicalOperator` (`&&→\|\|`) | Teste o curto-circuito em ambos os lados |
| `ArithmeticOperator` (`+→-`) | Asserte com inputs cujo resultado discrimina os operadores |
| `BlockStatement` (apaga corpo) | Asserte um efeito observável do bloco (evento, mutação de estado, retorno) |
| `BooleanLiteral` (`true→false`) | Verifique o lado true E o lado false da bandeira |
| `OptionalChaining` (`a?.b → a.b`) | Cubra o caso null/undefined com expect específico |
| `MethodExpression` (`.filter→.map`) | Asserte tamanho E conteúdo do resultado |

### Passo 6 — Saída

```
[OK|BLOCKER] domain         — mutation score X% (alvo 85)  killed/total
[OK|BLOCKER] application    — X% (alvo 80)
[OK|BLOCKER] presentation   — X% (alvo 80)
[OK|BLOCKER] infra          — X% (alvo 70)

Mutantes vivos (top 10 por risco):
  1. src/modules/catalog/product/domain/product.ts:142  ConditionalExpression
       this._name.equals(name)  →  false
       sugestão: cubra o branch true (rename idempotente — name igual = no-op, sem evento)
  2. src/.../product.repository.typeorm.ts:88  StringLiteral
       "draft"  →  ""
       sugestão: asserte equality com a constante ProductStatus.DRAFT, não trutiness
  ...

Arquivos com mutation score abaixo do threshold:
  src/modules/catalog/product/domain/product.ts  → 78% (alvo 85; survived: 6)
  ...

Disable comments sem justificativa (// Stryker disable sem texto):
  src/.../foo.ts:42

Comando:
  $ npm run test:mutation
Report HTML:
  reports/mutation/mutation-report.html (abra pra navegar)
```

---

## Heurísticas

- **Mutation score > coverage** em qualquer camada é matematicamente impossível — se acontecer, há bug no parse; rode novamente.
- **`NoCoverage` count alto** = coverage-enforcer falhou em pegar exclusão indevida. Investigue antes de rodar mutation de novo.
- **`Timeout` count alto** = teste muito acoplado a tempo real (`setTimeout`/`setInterval` em produção). Mock o clock.
- **Mesmo file:line aparece em N mutantes vivos** = single point of failure no teste. Reescreva o spec daquele arquivo focando em comportamento, não na linha.

---

## Disable legítimo

Quando um mutante é **comprovadamente equivalente** (mata produzir o mesmo comportamento, ex: trocar ordem de map+filter equivalentes), use:

```ts
// Stryker disable next-line ArithmeticOperator: a + 0 é equivalente a a; mantemos pra clareza do encoding
const offset = base + 0;
```

**Sem texto após `:`** = BLOCKER. Você não está auto-cobrando da regra, mas se o user mandou commit assim, reporte como BLOCKER.

Detectar comentários sem justificativa:

```bash
grep -rnHE 'Stryker disable [a-z\-]+( [A-Za-z]+)?\s*$' src/
```

---

## Anti-padrões

- ❌ Aceitar `mutation score = 100%` em arquivo trivial (getter puro sem ramos) sem checar `total > 0` — pode ser zero mutantes gerados (arquivo sem código mutável)
- ❌ Rodar mutation com testes vermelhos (`coverage-enforcer FAIL`) → mutantes "killed" são falsos
- ❌ Aumentar `timeoutMS` pra mascarar teste lento — fix o teste
- ❌ Excluir arquivo do `mutate` "porque demora" — paciência, ou divide o run com `--since`

---

## Quando ABORTAR

- Stryker não instalado E `npm install` falhou → ABORTA com instrução manual
- Jest config Stryker quebrado (tests não rodam no contexto Stryker) → ABORTA
- Timeout total > 60min → ABORTA com sugestão de `--since` e maior `concurrency`

---

## Limites

- Não escreve testes pra matar mutantes (chama `backend-dev` ou orienta o user)
- Não altera threshold (vem do agent qa)
- Não suprime mutantes sem justificativa escrita
