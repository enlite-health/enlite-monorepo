# Runbook — Suite de Testes do Funil Kanban (Talentum)

> ⚠️ **Runbook histórico.** Modelo canônico do funil em **[../features/worker-job-applications/](../features/worker-job-applications/README.md)**.
> Suite cobre o fluxo WJA atual; cenários que assumiam encuadre como entidade separada foram ajustados.

> Como rodar a rede de segurança criada para o funil/Kanban da vaga.
> Contexto e motivação: [`../POSTMORTEM_KANBAN_FUNNEL_BUGS.md`](../POSTMORTEM_KANBAN_FUNNEL_BUGS.md).

---

## 1. O que essa suite cobre

| Camada | Arquivo | Testes | Cobertura |
|---|---|---|---|
| Backend | [`worker-functions/tests/e2e/talentum-prescreening-funnel-transition.test.ts`](../../worker-functions/tests/e2e/talentum-prescreening-funnel-transition.test.ts) | 8 | Happy paths: nada→INITIATED, INITIATED→IN_PROGRESS→COMPLETED→ANALYZED com cada `statusLabel` |
| Backend | [`worker-functions/tests/e2e/talentum-prescreening-funnel-regression.test.ts`](../../worker-functions/tests/e2e/talentum-prescreening-funnel-regression.test.ts) | 4 | Out-of-order delivery — bug #4 (regressão de stage) |
| Backend | [`worker-functions/tests/e2e/talentum-prescreening-funnel-edge-cases.test.ts`](../../worker-functions/tests/e2e/talentum-prescreening-funnel-edge-cases.test.ts) | 5 | Side effects (encuadre RECHAZADO — bug #8), idempotência, email órfão, ANALYZED sem statusLabel, domain events |
| Frontend | [`enlite-frontend/e2e/integration/vacancy-kanban-talentum-webhook.integration.e2e.ts`](../../enlite-frontend/e2e/integration/vacancy-kanban-talentum-webhook.integration.e2e.ts) | 7 + health | Ciclo webhook → Kanban com snapshots PNG (visual regression) |

**Total:** 17 testes backend + 7 cenários visuais frontend.

---

## 2. Backend — rodar localmente

### 2.1 Pré-condições

- Node 20, npm
- Docker rodando
- `worker-functions` instalado: `npm ci`

### 2.2 Comando recomendado (Docker completo)

```bash
cd worker-functions
npm run test:e2e:docker
```

Esse script:
1. Sobe `docker-compose.yml` + `docker-compose.test.yml` (postgres + api com `USE_MOCK_AUTH=true`).
2. Espera healthcheck via [`scripts/wait-for-health.js`](../../worker-functions/scripts/wait-for-health.js).
3. Roda Jest E2E.
4. Derruba containers (`down -v`).

### 2.3 Variantes úteis

```bash
# Stack já rodando (mais rápido em ciclo de desenvolvimento)
npm run test:e2e

# Watch mode
npm run test:e2e:watch

# Apenas a suite do funil
npm run test:e2e -- --testPathPattern="talentum-prescreening-funnel"

# Apenas o teste de regressão (bug #4)
npm run test:e2e -- --testPathPattern="talentum-prescreening-funnel-regression"
```

### 2.4 Resultado esperado

```
PASS tests/e2e/talentum-prescreening-funnel-transition.test.ts
PASS tests/e2e/talentum-prescreening-funnel-regression.test.ts
PASS tests/e2e/talentum-prescreening-funnel-edge-cases.test.ts

Tests:  17 passed, 17 total
```

### 2.5 Como adicionar um teste novo

Os testes usam o fixture builder typed [`tests/fixtures/talentumPayload.ts`](../../worker-functions/tests/fixtures/talentumPayload.ts) (`envelope()`). Padrão:

```typescript
import { envelope } from '../fixtures/talentumPayload';

it('meu cenário', async () => {
  // Setup: criar worker + job_posting no DB de teste (helpers existentes)
  const payload = envelope({
    subtype: 'IN_PROGRESS',
    prescreening: { id: 'psc-xxx', name: jobPostingTitle },
    profile: { email: workerEmail },
  });
  const res = await request(app).post('/api/webhooks/talentum/prescreening').send(payload);
  expect(res.status).toBe(200);

  // Assertion no DB
  const wja = await db.query('SELECT application_funnel_stage FROM worker_job_applications WHERE worker_id=$1 AND job_posting_id=$2', [...]);
  expect(wja.rows[0].application_funnel_stage).toBe('IN_PROGRESS');
});
```

**Regras:**
- Cada teste cria seus próprios `workers`/`job_postings` com IDs únicos (timestamp + random) — sem dependência entre testes.
- Truncate em `beforeEach` cobre `talentum_prescreenings`, `worker_job_applications`, `encuadres`.
- Webhook não precisa de header `Authorization` em modo teste (`USE_MOCK_AUTH=true` bypassa Google OAuth — ver [`TalentumWebhookController.verifyGoogleToken`](../../worker-functions/src/modules/matching/interfaces/controllers/TalentumWebhookController.ts)).
- Limite 400 linhas por arquivo — se exceder, dividir por tema.

---

## 3. Frontend — testes E2E integration com snapshots visuais

### 3.1 Pré-condições

- Node 20, **pnpm 8+**
- Docker stack do backend rodando (veja seção 2):
  ```bash
  cd worker-functions
  docker compose -f docker-compose.yml -f docker-compose.test.yml up -d postgres api
  ```
- Frontend dev server rodando do **diretório correto**:
  ```bash
  cd enlite-frontend
  pnpm dev
  # confirma:
  curl -s -o /dev/null -w "%{http_code}\n" http://localhost:5173  # → 200
  ```
- **Atenção:** se o dev server já estiver rodando, confira o diretório de origem com:
  ```bash
  ps aux | grep vite | grep -v grep
  ```
  Se vier de outro path, mate o processo e suba do `enlite-frontend` correto. Vite servindo de pasta errada foi um dos bugs descobertos na investigação inicial.

### 3.2 Comando padrão

```bash
cd enlite-frontend
pnpm test:e2e:integration --grep "Vacancy Kanban.*Talentum"
```

Roda os 7 cenários + 1 health check, compara os 7 snapshots PNG contra os baselines commitados.

### 3.3 Quando atualizar snapshots

Se você fez mudança intencional no Kanban (CSS, layout, novo badge etc.), os snapshots vão divergir. Atualizar com:

```bash
pnpm test:e2e:integration --grep "Vacancy Kanban.*Talentum" --update-snapshots
```

Em seguida, **inspecionar visualmente** cada PNG modificado em [`e2e/integration/vacancy-kanban-talentum-webhook.integration.e2e.ts-snapshots/`](../../enlite-frontend/e2e/integration/vacancy-kanban-talentum-webhook.integration.e2e.ts-snapshots/) antes de commitar.

### 3.4 Os 7 cenários

| # | Snapshot | O que valida |
|---|---|---|
| C1 | `vacancy-kanban-empty.png` | Estado vazio — 7 colunas com count=0 |
| C2 | `vacancy-kanban-initiated.png` | Card em "Iniciado" após webhook `INITIATED` |
| C3 | `vacancy-kanban-in-progress.png` | Card migrou pra "En Progreso" |
| C4 | `vacancy-kanban-completed.png` | Card migrou pra "Completado" |
| C5 | `vacancy-kanban-qualified.png` | Card em "Completado" + badge verde `Talentum: Calificado` |
| C6 | `vacancy-kanban-not-qualified.png` | 2 cards em "Completado" (QUALIFIED + NOT_QUALIFIED) |
| C7 | `vacancy-kanban-counters.png` | Estado final com 4 cards em 3 colunas diferentes — flagship visual |

### 3.5 Resultado esperado

```
Running 8 tests using 1 worker

  ✓  1  C1 — kanban vazio: 7 colunas com 0 cards (~2s)
  ✓  2  C2 — webhook INITIATED: card aparece na coluna INITIATED (~2s)
  ✓  3  C3 — webhook IN_PROGRESS: card migra para coluna IN_PROGRESS (~2s)
  ✓  4  C4 — webhook COMPLETED: card migra para coluna COMPLETED (~2s)
  ✓  5  C5 — webhook ANALYZED+QUALIFIED: card em COMPLETED com badge QUALIFIED (~2s)
  ✓  6  C6 — segundo worker NOT_QUALIFIED: 2 cards em COMPLETED (~2s)
  ✓  7  C7 — contadores corretos com workers em stages diferentes (~2s)
  ✓  8  health — backend acessível antes da suite (<10ms)

  8 passed (~25s)
```

### 3.6 Helpers

| Arquivo | O que oferece |
|---|---|
| [`e2e/helpers/talentumWebhookHelper.ts`](../../enlite-frontend/e2e/helpers/talentumWebhookHelper.ts) | `loginAsKanbanAdmin`, `installKanbanInterceptors`, `sendTalentumWebhook`, `waitForCardInStage`, `openKanban`, `getEncuadreId`, `MOCK_ADMIN`, `MOCK_TOKEN` |
| [`e2e/helpers/db-test-helper.ts`](../../enlite-frontend/e2e/helpers/db-test-helper.ts) | `insertTestWorker`, `insertTestPatient`, `insertBaseVacancy`, `cleanupTestWorker`, `cleanupTestPatient` |

**Atenção aos cuidados de teste:**
- `MOCK_ADMIN.role = 'admin'` — a backend `requireStaff` middleware só aceita `admin | recruiter | community_manager`. Usar `superadmin` resulta em 403.
- Profile não pode mandar `cuil: null` — o schema Zod é `.strict()` e `cuil?: string` espera string ou ausência. Use `cuil: 'algum-valor'` ou omita o campo.
- View Kanban depende de `localStorage["vacancy-funnel-view-{vacancyId}"] === 'kanban'` — `forceKanbanView` faz isso via `page.addInitScript`.
- `DraggableCard` e `KanbanCard` compartilham `data-testid="kanban-card-{id}"`. Para discriminar, use `[data-testid="..."][data-stage]` (só o inner tem `data-stage`).

---

## 4. CI

A suite backend roda automaticamente em [`worker-functions/.github/workflows/e2e.yml`](../../worker-functions/.github/workflows/e2e.yml) em todo PR e push pra `main`. A suite frontend integration ainda não está em CI — adicionar é TD-NNN (ver `docs/FOLLOWUPS.md`).

---

## 5. Troubleshooting

### Backend

| Sintoma | Causa provável | Fix |
|---|---|---|
| `Cannot connect to Docker` | Docker daemon parado | `open -a Docker` (Mac) e aguarde |
| `ECONNREFUSED 5433` | Postgres do test ainda subindo | Esperar `wait-for-health.js` finalizar — ou rodar `npm run test:e2e:docker` em vez de `:e2e` |
| `401 Invalid credentials` no webhook | Falta `USE_MOCK_AUTH=true` no container | Confirma em `docker-compose.test.yml` |
| Schema check constraint fail | Migration nova não rodou | `cd worker-functions && node scripts/run-migrations-docker.js` |

### Frontend

| Sintoma | Causa provável | Fix |
|---|---|---|
| `404 Cannot GET /api/...` em todos os endpoints | Backend Docker não está rodando | Subir conforme seção 3.1 |
| Timeout `waiting for kanban-board` | Vite dev server de outro path servindo código antigo | `ps aux \| grep vite` → kill PID → subir do `enlite-frontend` |
| `Staff access required` | `MOCK_ADMIN.role` incorreta | Trocar pra `admin` |
| `400 Bad Request` no webhook em teste | Payload viola schema Zod | Remover campos extras / nulls — schema é `.strict()` |
| `duplicate key value violates unique constraint "idx_workers_phone_unique"` | Phones gerados por timestamp colidem | Usar `Math.random()` em vez de timestamp truncado |
| Snapshot diff inesperado | Mudança visual real ou flake | Inspecionar PNG; se intencional, `--update-snapshots`; se flake, aumentar `maxDiffPixelRatio` ou mascarar elementos voláteis |
| Localstorage `view` não persiste | `addInitScript` chamado depois de `goto` | Chamar `forceKanbanView()` SEMPRE antes de `page.goto` |

---

## 6. Convenções

- **Limite 400 linhas/arquivo** (regra Enlite — ver `worker-functions/CLAUDE.md`)
- **Sem `any`** — usar tipos explícitos / Zod / interfaces
- **Sem `page.waitForTimeout` arbitrário** — preferir `expect.poll` ou `waitForSelector`
- **Cleanup garantido** — `afterAll` deve rodar mesmo em falha; usar `try/finally` se necessário
- **Screenshots** — sempre commitar baselines em `*.e2e.ts-snapshots/` no mesmo PR que adiciona o teste
