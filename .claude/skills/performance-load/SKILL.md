---
name: performance-load
description: "Auditor de performance: smoke de carga HTTP com autocannon (p50/p95/p99/RPS/errors), análise de queries TypeORM via slow-query log para detectar N+1, full-scan e queries acima do orçamento (50ms). Bloqueia: p99 > 200ms em endpoint novo, error rate > 0% em smoke, qualquer N+1 detectado. Não roda load test 'serio' (cenário multi-step, multi-tenant) — isso fica pra K6 em pipeline separado. Setup idempotente."
---

# Performance Load — Smoke de carga + análise de queries

Performance é parte do contrato. Endpoint novo entra com **orçamento** (p99 < 200ms) e **prova** (smoke + análise de SQL). Sem isso, é dívida que não aparece em PR e quebra produção.

## Princípios

1. **p99 é a métrica, não p50.** Médias mentem. Cauda é o que mata.
2. **0% de erro em smoke é piso, não meta.** 1 erro em 1000 reqs = >1M erros/dia em produção.
3. **N+1 detectado é BLOCKER, sem exceção.** Use joins, dataloader ou query única.
4. **Smoke não é load test.** Smoke = 10 conn × 10s pra detectar regressão grosseira. Load test real fica em pipeline noturno separado (não esse skill).
5. **Sempre comparar com baseline.** Sem baseline = todo run é "WARN: sem baseline" mas não é BLOCKER ainda.

---

## Setup canônico (idempotente)

### S.1 — Instalar `autocannon`

```bash
ls node_modules/autocannon 2>/dev/null || \
  npm install --save-dev autocannon@7
```

### S.2 — Habilitar logging de SQL no TypeORM em modo "perf-test"

Criar `src/shared/infra/database/data-source-perf.ts` (cópia da config com logging exaustivo):

```ts
import { DataSource } from 'typeorm';
import dataSource from './data-source';
// reusa a config mas força logging de tudo + slow

export const perfDataSource = new DataSource({
  ...((dataSource as DataSource).options),
  logging: ['query', 'schema', 'error', 'warn', 'info', 'log'],
  maxQueryExecutionTime: 50, // ms — slow query > 50ms
} as never);
```

Em CI de perf, exponha env `DATA_SOURCE=perf` que o `database.module.ts` consome pra trocar pelo perf data source. (Se ainda não existe esse hook, é BLOCKER de setup — peça `backend-dev` pra adicionar.)

### S.3 — Script de smoke

Criar `scripts/perf-smoke.js`:

```js
// scripts/perf-smoke.js
const autocannon = require('autocannon');
const fs = require('fs');
const path = require('path');

const BUDGETS = {
  // path => { p99_ms, min_rps }
  '/health':                 { p99: 50,  rps: 500 },
  '/products':               { p99: 200, rps: 50 },
  '/categories':             { p99: 200, rps: 50 },
  // adicione novos endpoints aqui com pull request
};

async function run() {
  const baseUrl = process.env.PERF_BASE_URL || 'http://localhost:3000';
  const reports = [];
  let failed = false;

  for (const [route, budget] of Object.entries(BUDGETS)) {
    console.log(`\n→ ${route}  budget p99<${budget.p99}ms  rps>${budget.rps}`);
    const result = await autocannon({
      url: baseUrl + route,
      connections: 10,
      duration: 10,
      pipelining: 1,
      headers: { 'content-type': 'application/json' },
    });

    const p99 = result.latency.p99;
    const errors = result.errors;
    const rps = result.requests.average;

    const pass = p99 <= budget.p99 && errors === 0 && rps >= budget.rps;
    if (!pass) failed = true;

    reports.push({ route, budget, p99, p50: result.latency.p50, p95: result.latency.p95, rps, errors, pass });
    console.log(`   p50=${result.latency.p50}ms p95=${result.latency.p95}ms p99=${p99}ms rps=${rps.toFixed(0)} errors=${errors}  ${pass ? 'PASS' : 'FAIL'}`);
  }

  fs.mkdirSync('reports/perf', { recursive: true });
  fs.writeFileSync('reports/perf/smoke.json', JSON.stringify(reports, null, 2));
  console.log('\nreport: reports/perf/smoke.json');

  process.exit(failed ? 1 : 0);
}

run().catch((e) => { console.error(e); process.exit(2); });
```

### S.4 — Slow-query analyzer

Criar `scripts/perf-slow-queries.js`:

```js
// scripts/perf-slow-queries.js
// Roda os e2e em modo perf (TypeORM log + slow detector) e coleta queries lentas.
const { execSync } = require('child_process');
const fs = require('fs');

const LOG = 'reports/perf/queries.log';
fs.mkdirSync('reports/perf', { recursive: true });

try {
  execSync(`DATA_SOURCE=perf npm run test:e2e -- --silent 2>&1 | tee ${LOG}`, { stdio: 'inherit' });
} catch (e) {
  // continua mesmo com falha — queremos coletar logs
}

const lines = fs.readFileSync(LOG, 'utf8').split('\n');
const slow = lines.filter((l) => /query is slow/i.test(l));
const nplusone = findNPlusOne(lines);

console.log(`\nSlow queries (>50ms): ${slow.length}`);
slow.slice(0, 20).forEach((l) => console.log('  ' + l));

console.log(`\nN+1 candidates: ${nplusone.length}`);
nplusone.forEach((g) => console.log(`  pattern ${g.pattern} x${g.count}`));

fs.writeFileSync('reports/perf/slow-queries.json', JSON.stringify({ slow, nplusone }, null, 2));

function findNPlusOne(lines) {
  const groups = new Map();
  for (const l of lines) {
    const m = l.match(/query: (SELECT .*?WHERE .*?=)/);
    if (!m) continue;
    const key = m[1].replace(/=\s*\$\d+/, '= ?').slice(0, 80);
    groups.set(key, (groups.get(key) || 0) + 1);
  }
  return [...groups.entries()].filter(([, c]) => c >= 5).map(([pattern, count]) => ({ pattern, count }));
}
```

### S.5 — Scripts no `package.json`

```json
{
  "scripts": {
    "perf:smoke": "node scripts/perf-smoke.js",
    "perf:queries": "node scripts/perf-slow-queries.js",
    "perf:all": "npm run perf:smoke && npm run perf:queries"
  }
}
```

### S.6 — `.gitignore`

```
reports/perf/
```

---

## Protocolo de auditoria

### Passo 1 — Escopo

- `branch` → identifique controllers novos:
  ```bash
  git diff --name-only $(git merge-base HEAD main) HEAD | grep -E '/presentation/http/.*\.controller\.ts$' 
  ```
  Para cada controller novo, leia os métodos (`@Get`, `@Post`, etc.) e adicione ao `BUDGETS` do `perf-smoke.js` se ausente. Sem budget definido = BLOCKER (force o user a declarar).
- `full` → roda smoke completo + slow queries.

### Passo 2 — Subir app

```bash
# checar se já tá rodando
curl -s http://localhost:3000/health >/dev/null 2>&1 || {
  npm run start:dev &  # se já tem docker-compose, prefer-lo
  sleep 8
}
```

Se app não responde em 30s → ABORTA `[ABORTADO: app não está rodando em :3000]`.

### Passo 3 — Smoke

```bash
PERF_BASE_URL=http://localhost:3000 npm run perf:smoke 2>&1 | tee /tmp/perf-smoke.txt
```

Exit 0 → PASS em todos os endpoints.

Parse `reports/perf/smoke.json`:

| Endpoint | p50 | p95 | p99 | RPS | Errors | Budget p99 | Status |
|---|---|---|---|---|---|---|---|
| ... | | | | | | | OK/BLOCKER |

### Passo 4 — Slow queries + N+1

```bash
npm run perf:queries 2>&1 | tee /tmp/perf-queries.txt
```

Parse `reports/perf/slow-queries.json`:
- Slow query (>50ms): cada uma é WARN; se >100ms = BLOCKER
- N+1 candidates (mesma query padrão ≥5x): BLOCKER

### Passo 5 — Comparação com baseline

Se `reports/perf/baseline.json` existe:

```bash
node -e "
  const cur = require('./reports/perf/smoke.json');
  const base = require('./reports/perf/baseline.json');
  for (const c of cur) {
    const b = base.find((x) => x.route === c.route);
    if (!b) continue;
    const delta_p99 = ((c.p99 - b.p99) / b.p99) * 100;
    if (delta_p99 > 20) console.log('REGRESSION ' + c.route + ' p99 +' + delta_p99.toFixed(0) + '%');
  }
"
```

Regressão > 20% p99 → BLOCKER.
Atualização de baseline só por aprovação explícita do user (`npm run perf:smoke && cp reports/perf/smoke.json reports/perf/baseline.json`).

### Passo 6 — Saída

```
[OK|BLOCKER] smoke autocannon
  GET /health      p50=2ms   p95=4ms   p99=8ms   rps=820  errors=0  budget p99<50ms   PASS
  GET /products    p50=45ms  p95=120ms p99=180ms rps=65   errors=0  budget p99<200ms  PASS
  POST /products   p50=80ms  p95=180ms p99=320ms rps=22   errors=3  budget p99<200ms  FAIL

[OK|BLOCKER] slow queries
  Slow (>50ms): 7 (top 3)
    87ms  SELECT * FROM product LEFT JOIN ...
    120ms SELECT * FROM category WHERE parent_id = ?
    ...
  Slow (>100ms): 3 → BLOCKER

[OK|BLOCKER] N+1 detector
  Padrão: `SELECT * FROM category WHERE id = ?`  hits=47
    suspeito em: src/modules/catalog/category/infra/repositories/category.repository.typeorm.ts
    fix: relations: ['parent', 'children'] OU TreeRepository OR DataLoader

[OK|WARN]    baseline
  comparação vs reports/perf/baseline.json
  REGRESSION GET /products p99 +35% (180ms vs 133ms baseline)

Endpoints novos sem budget declarado:
  POST /categories/:id/children  → adicionar em scripts/perf-smoke.js BUDGETS

Comandos:
  $ npm run perf:smoke
  $ npm run perf:queries
```

---

## Anti-padrões

- ❌ Rodar smoke contra Postgres compartilhado (vizinhos barulhentos enviesam p99)
- ❌ Aumentar budget só pra passar — investigue a regressão
- ❌ Confiar em p50 (mediana esconde cauda)
- ❌ Esquecer de subir o app antes (autocannon mostra "ECONNREFUSED" 1000x e parece "rodou bem")
- ❌ Rodar autocannon em modo `pipelining > 1` em endpoints non-idempotent (escreve duplicado)
- ❌ N+1 "tolerado" porque "só em endpoint admin" — N+1 vira incidente quando admin chama com dataset crescido

---

## Quando ABORTAR

- App não sobe → ABORTA
- autocannon não instalado e `npm install` falhou → ABORTA
- TypeORM logging não está produzindo output (`maxQueryExecutionTime` não respeitado) → ABORTA, peça pra revisar `database.module.ts`

---

## Limites

- Não faz load test multi-step (jornada de usuário) — para isso, k6/Artillery em pipeline separado
- Não faz profiling de CPU/mem do node (use `clinic` separado)
- Não decide budget — vem do PO/architect; aqui só audita
- Não corrige queries — peça `backend-dev`
