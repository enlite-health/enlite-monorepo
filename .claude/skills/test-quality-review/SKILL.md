---
name: test-quality-review
description: "Meta-auditor da qualidade dos próprios testes. Detecta smells (test sem expect, .only, .skip, sleep arbitrário, ordem-dependente, mocks demais, magic numbers, sem AAA), flakiness (3 runs consecutivos comparando resultados), testes lentos (>1s unit / >10s integration), shared mutable state. NÃO valida o que o teste cobre — valida se o teste é confiável e legível. Bloqueia: .only/.skip em commit, teste sem expect, sleep arbitrário, flakiness comprovada, teste lento sem justificativa."
---

# Test Quality Review — meta-teste pra teste

Teste ruim é dívida pior que código ruim — ele dá falsa segurança E impede refactor. Esta skill garante que os testes do projeto são **confiáveis, determinísticos, rápidos e legíveis**.

## Princípios

1. **Teste é production code.** Aplica-se: AAA, sem mágica, sem comentário-narrativa, sem ifs.
2. **Determinismo é não-negociável.** Flaky test ou some, ou bloqueia.
3. **Sem `.only`/`.skip` em main.** Em PR também não. Eles existem pra debug local; não chegam a commit.
4. **Sleep arbitrário é cheiro fatal.** Use `waitFor` / polling com timeout finito; se a infra exige sleep, encapsule num helper com nome explícito.
5. **Mock só em fronteira externa.** Mock de service interno = teste de implementação.

---

## Catálogo de smells

| # | Smell | Detecção | Severidade |
|---|---|---|---|
| 1 | `it.only` / `describe.only` / `test.only` | grep | BLOCKER |
| 2 | `it.skip` / `describe.skip` / `xit` / `xdescribe` em código commitado | grep + `git log -p` | BLOCKER |
| 3 | Teste sem `expect()` (ou equivalente) | AST/grep | BLOCKER |
| 4 | `setTimeout(fn, N)` / `await new Promise(r => setTimeout(r, N))` em teste | grep | BLOCKER |
| 5 | Teste mutável shared state entre `it` (sem `beforeEach` resetar) | heurística | BLOCKER |
| 6 | Teste com `Math.random()` ou `Date.now()` sem fixar (não-determinismo) | grep | BLOCKER |
| 7 | Mock de classe sob teste (`jest.mock('../foo')` para testar `foo`) | grep | BLOCKER |
| 8 | `expect(true).toBe(true)` / `expect(1).toBe(1)` / `expect(undefined).toBeUndefined()` | grep | BLOCKER |
| 9 | Teste lento (unit > 1s, integration > 10s) | parse Jest output | BLOCKER (sem justificativa em `it`) |
| 10 | `it('...')` ou `it('test 1')` (nome inútil) | grep | WARN |
| 11 | Magic number sem nome (`expect(x).toBe(42)` sem const) | inspeção visual heurística | WARN |
| 12 | `try/catch` em vez de `expect(...).toThrow(...)` | grep | BLOCKER |
| 13 | `assert(...)` em vez de `expect(...)` | grep | BLOCKER |
| 14 | `console.log` em teste | grep | WARN |
| 15 | `// TODO` / `// FIXME` em teste | grep | WARN |
| 16 | Ordem-dependente (passa só com `--runInBand`, falha paralelo) | heurística + 2 runs | BLOCKER |
| 17 | Snapshot inline > 30 linhas | parse | WARN (usa `toMatchInlineSnapshot` com limite) |
| 18 | `expect(...).toBeTruthy()` em vez de `.toBe(<valor exato>)` | grep + caso a caso | WARN |
| 19 | Teste que polui filesystem/DB sem cleanup | grep `fs.write*`, `repo.save` sem cleanup | BLOCKER |
| 20 | `beforeAll` com setup pesado que deveria ser `beforeEach` | inspeção | WARN |

---

## Protocolo de auditoria

### Passo 1 — Escopo

- `branch` → só specs modificados:
  ```bash
  git diff --name-only $(git merge-base HEAD main) HEAD | grep -E '\.(spec|e2e-spec)\.ts$'
  ```
- `full` → todos: `find src test -name '*.spec.ts' -o -name '*.e2e-spec.ts'`
- lista → só os informados

### Passo 2 — Smells por grep (rodar em paralelo)

```bash
# 1, 2 — only/skip
grep -rnHE '\.(only|skip)\(|^\s*x(it|describe)\(' src test --include='*.spec.ts' --include='*.e2e-spec.ts' 2>/dev/null || true

# 3 — teste sem expect: heurística — listar describe/it sem expect no corpo direto
# (mais robusto: AST; aqui usa grep por bloco it->expect na mesma faixa de linhas)
for f in $(find src test -name '*.spec.ts' -o -name '*.e2e-spec.ts'); do
  awk '
    /^\s*(it|test)\s*\(/ { inblock=1; start=NR; hasexpect=0; name=$0 }
    inblock && /expect\s*\(|fc\.assert/ { hasexpect=1 }
    inblock && /^\s*\}\s*\)\s*;?\s*$/ {
      if (!hasexpect) print FILENAME ":" start ": " name
      inblock=0
    }
  ' "$f"
done

# 4 — setTimeout/sleep
grep -rnHE 'setTimeout\s*\(|new\s+Promise\s*\(\s*[a-z_]+\s*=>\s*setTimeout|await\s+sleep\(' src test --include='*.spec.ts' --include='*.e2e-spec.ts' 2>/dev/null \
  | grep -v jest.setTimeout \
  | grep -v 'jest.useFakeTimers\|jest.runAllTimers' || true

# 6 — Math.random / Date.now sem fixar (heurística)
grep -rnH 'Math\.random()\|new Date()\|Date\.now()' src test --include='*.spec.ts' --include='*.e2e-spec.ts' 2>/dev/null \
  | grep -v 'jest.useFakeTimers\|jest.setSystemTime\|jest.spyOn(Date' || true

# 7 — mock de classe sob teste (heurística: mesmo path do spec, removendo .spec)
for f in $(find src -name '*.spec.ts'); do
  source_under_test="${f%.spec.ts}.ts"
  if [ -f "$source_under_test" ]; then
    mock_target=$(grep -oE "jest\.mock\(['\"]\.\/[^'\"]+['\"]" "$f" | sed -E "s/jest\.mock\(['\"]\.\///;s/['\"]\s*$//")
    if [ -n "$mock_target" ]; then
      sut_basename=$(basename "$source_under_test" .ts)
      if echo "$mock_target" | grep -qE "(^|/)$sut_basename(\$|\.ts$)"; then
        echo "$f: mocks SUT (../$mock_target)"
      fi
    fi
  fi
done

# 8 — expect(true).toBe(true) e variantes
grep -rnHE 'expect\(\s*(true|false|0|1|null|undefined|""|\s*''\s*)\s*\)\.(toBe|toEqual)\(\s*(true|false|0|1|null|undefined|""|\s*''\s*)\s*\)' src test --include='*.spec.ts' --include='*.e2e-spec.ts' 2>/dev/null || true

# 10 — nomes inúteis
grep -rnHE "(it|test)\(\s*['\"](test|works|should work|it works|case \d+|exemplo|foo|bar)['\"]" src test --include='*.spec.ts' --include='*.e2e-spec.ts' 2>/dev/null || true

# 12 — try/catch em vez de toThrow
grep -rnH "try\s*{" src test --include='*.spec.ts' --include='*.e2e-spec.ts' 2>/dev/null | head -30

# 13 — assert() em vez de expect()
grep -rnH "^\s*assert(" src test --include='*.spec.ts' --include='*.e2e-spec.ts' 2>/dev/null || true

# 14 — console.log
grep -rnH "console\.\(log\|info\|debug\|warn\|error\)" src test --include='*.spec.ts' --include='*.e2e-spec.ts' 2>/dev/null || true

# 15 — TODO/FIXME em teste
grep -rnHE "// (TODO|FIXME|XXX)" src test --include='*.spec.ts' --include='*.e2e-spec.ts' 2>/dev/null || true

# 18 — toBeTruthy/Falsy (cheirou — investigar)
grep -rnH "\.toBeTruthy\(\)\|\.toBeFalsy\(\)" src test --include='*.spec.ts' --include='*.e2e-spec.ts' 2>/dev/null || true

# 19 — fs.write / save sem cleanup correspondente
grep -rln "fs\.\(write\|append\|mkdir\)" src test --include='*.spec.ts' --include='*.e2e-spec.ts' 2>/dev/null | while read f; do
  grep -q "afterAll\|afterEach" "$f" || echo "$f: escreve fs sem afterAll/afterEach"
done
```

### Passo 3 — Tempo de cada teste (Jest)

```bash
# Unit
npx jest --silent --json --outputFile=/tmp/jest-unit.json 2>&1 | tail -5

# Parse: testes >1000ms
node -e "
  const r = require('/tmp/jest-unit.json');
  const slow = [];
  for (const t of r.testResults) {
    for (const a of t.testResults) {
      if (a.duration && a.duration > 1000) {
        slow.push({ file: t.testFilePath, name: a.fullName, ms: a.duration });
      }
    }
  }
  slow.sort((x, y) => y.ms - x.ms);
  for (const s of slow.slice(0, 20)) console.log(s.ms + 'ms — ' + s.file.replace(process.cwd()+'/', '') + ' > ' + s.name);
"

# E2E
npx jest --config ./test/jest-e2e.json --silent --json --outputFile=/tmp/jest-e2e.json --runInBand 2>&1 | tail -5

# E2E: >10000ms = BLOCKER, 5000-10000ms = WARN
node -e "
  const r = require('/tmp/jest-e2e.json');
  const slow = [];
  for (const t of r.testResults) {
    for (const a of t.testResults) {
      if (a.duration && a.duration > 5000) {
        slow.push({ file: t.testFilePath, name: a.fullName, ms: a.duration, blocker: a.duration > 10000 });
      }
    }
  }
  slow.sort((x, y) => y.ms - x.ms);
  for (const s of slow.slice(0, 20)) console.log((s.blocker?'BLOCKER':'WARN') + ' ' + s.ms + 'ms — ' + s.file.replace(process.cwd()+'/', '') + ' > ' + s.name);
"
```

### Passo 4 — Flakiness (3 runs consecutivos)

Roda os testes 3 vezes seguidas no mesmo escopo e compara conjuntos de testes que passaram/falharam.

```bash
mkdir -p /tmp/flaky
for i in 1 2 3; do
  npx jest --silent --json --outputFile=/tmp/flaky/run-$i.json 2>&1 | tail -3
done

node -e "
  const runs = [1,2,3].map(i => require('/tmp/flaky/run-' + i + '.json'));
  const stat = {};
  for (let i = 0; i < 3; i++) {
    for (const t of runs[i].testResults) {
      for (const a of t.testResults) {
        const key = t.testFilePath + ' > ' + a.fullName;
        stat[key] = stat[key] || { pass: [false,false,false] };
        stat[key].pass[i] = a.status === 'passed';
      }
    }
  }
  const flaky = Object.entries(stat).filter(([, v]) => new Set(v.pass).size > 1);
  for (const [name, v] of flaky.slice(0, 20)) console.log('FLAKY ' + v.pass.map(p => p?'P':'F').join('') + ' — ' + name);
  console.log(flaky.length === 0 ? 'OK: nenhum flaky em 3 runs.' : 'FLAKY total: ' + flaky.length);
"
```

Se algum teste deu PASS-FAIL-PASS ou variações entre runs → BLOCKER.

### Passo 5 — Ordem-dependente

```bash
# Roda com seed default (paralelo) e com --runInBand. Compara.
npx jest --silent --json --outputFile=/tmp/order-parallel.json 2>&1 | tail -3
npx jest --silent --json --outputFile=/tmp/order-band.json --runInBand 2>&1 | tail -3

# Já capturada por flakiness se houver inconsistência; aqui especifica:
node -e "
  const a = require('/tmp/order-parallel.json');
  const b = require('/tmp/order-band.json');
  const fail = (r) => r.testResults.flatMap(t => t.testResults.filter(x => x.status !== 'passed').map(x => t.testFilePath + ' > ' + x.fullName));
  const aFail = new Set(fail(a));
  const bFail = new Set(fail(b));
  for (const x of aFail) if (!bFail.has(x)) console.log('ORDER ONLY-PARALLEL: ' + x);
  for (const x of bFail) if (!aFail.has(x)) console.log('ORDER ONLY-BAND: ' + x);
"
```

Teste que falha só em paralelo (e passa runInBand) → BLOCKER (shared state).

### Passo 6 — Saída

```
[OK|BLOCKER] sem .only/.skip — found <N>
[OK|BLOCKER] sem teste sem expect — found <N>
[OK|BLOCKER] sem setTimeout/sleep — found <N>
[OK|BLOCKER] sem Math.random/Date.now não-mockado — found <N>
[OK|BLOCKER] sem mock de SUT — found <N>
[OK|BLOCKER] sem assert vazio (expect(true).toBe(true)) — found <N>
[OK|BLOCKER] sem try/catch em vez de toThrow — found <N>
[OK|BLOCKER] sem fs.write sem cleanup — found <N>
[OK|WARN]    sem nome de teste inútil — found <N>
[OK|WARN]    sem toBeTruthy/Falsy em vez de toBe — found <N>
[OK|WARN]    sem console.log — found <N>
[OK|WARN]    sem TODO/FIXME — found <N>
[OK|BLOCKER] sem teste >1s unit ou >10s integration sem justificativa — found <N>
[OK|BLOCKER] sem flakiness em 3 runs — found <N>
[OK|BLOCKER] sem ordem-dependência (paralelo vs runInBand) — found <N>

Smells:
  src/modules/catalog/product/domain/product.spec.ts:42
    it.only('attaches category')
    → remova .only antes de commitar

  src/modules/.../foo.spec.ts:23
    it('does X') { logic(); /* sem expect */ }
    → adicionar assertion explícita; se é setup, mova pra beforeEach

  test/catalog.persistence.e2e-spec.ts:120
    await new Promise(r => setTimeout(r, 2000))
    → usar polling: await waitFor(() => repo.findById(id), { timeout: 5000 })

  src/.../bar.spec.ts:55
    jest.mock('../bar')   ← bar é o SUT
    → remova; teste a classe real, mocke só ports

Slow tests:
  BLOCKER 3200ms — src/.../slow.spec.ts > does heavy stuff
  WARN    1450ms — src/.../warm.spec.ts > maps things

Flaky (3 runs PPF/PFP/FPP):
  test/catalog.persistence.e2e-spec.ts > truncate + insert >> persists root
    → causa provável: shared dataSource sem truncate atômico

Order-dependent:
  src/.../uses-shared.spec.ts > reads previous state
    passa só com --runInBand; quebra em paralelo

Comandos:
  $ grep -rnHE '\.(only|skip)\(' src test
  $ npx jest --json --outputFile=/tmp/jest-unit.json
  $ (loop 3x) npx jest --silent --json
  $ npx jest --runInBand vs paralelo (comparação)
```

---

## Anti-padrões

- ❌ "Esse teste é só pra debug, deixa o `.only`" — debug local, commit nunca
- ❌ "Sleep 2s pra esperar o evento" — usa `waitFor`/polling; se a operação não termina em N tentativas com backoff, é teste de timeout legítimo (explicite no nome)
- ❌ Mockar repo `application/__test-fixtures__/in-memory-*` de novo no spec — já é fixture
- ❌ Setup global compartilhado mutável (ex: array de produtos no top-level do describe) — use `beforeEach`
- ❌ `expect(x).toBeDefined()` quando o ponto é o valor — fale o valor exato
- ❌ Spec gigante (1000+ linhas) com 80 `it`s — quebra em sub-describes; spec de >500 linhas é WARN
- ❌ Snapshot inline > 30 linhas — vai pra arquivo, ou é sinal de teste pretendendo "tudo de uma vez"
- ❌ `jest.spyOn` sem `mockRestore` em `afterEach`

---

## Quando ABORTAR

- 3 runs em sequência > 30min → ABORTA (sugira `--testPathPattern` pra rodar só o escopo)
- Testes falham no run 1 já por motivo NÃO-quality (ex: Docker down) → ABORTA, peça pra rodar `coverage-enforcer` antes
- Spec gera output binário que poluí stdout do parser → ABORTA

---

## Limites

- Não corrige smells (peça `backend-dev` ou orienta o user)
- Não decide se um teste lento é "legítimo lento" — exige comentário no `it('...' /* slow: <razão> */)`; ausência = BLOCKER
- Não substitui code review humano — pega o que máquina pega bem
