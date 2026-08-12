# Roadmap: E2E Testing — Worker Functions

> Data: 2026-03-25
> Escopo: Testar **do comando CLI / entrada do endpoint HTTP até o salvamento no banco**, com banco local Docker e autenticação simulada via MockAuth (sem Firebase real).

---

## Log de implementação

| Fase | Status | Data | Observações |
|---|---|---|---|
| **Fase 0** — Fixes obrigatórios | ✅ Concluída | 2026-03-25 | Todos os 8 bugs do bloqueio resolvidos |
| **Fase 1** — Migrations estáveis | ✅ Concluída | 2026-03-25 | Abordagem diferiu do plano original (ver nota abaixo) |
| **Fase 2** — Setup robusto | ✅ Concluída | 2026-03-25 | setup.ts + helpers.ts compartilhado |
| **Fase 3** — Testes passando | ✅ Concluída | 2026-03-25 | 57 passando, 4 skipped (features removidas migration 028) |
| **Fase 4** — Import pipeline | ✅ Concluída | 2026-03-25 | 17/17 passando; fixtures (4 fontes) + cenários de erro; bug real corrigido (migration 055) |
| **Fase 5** — Scripts de execução | ✅ Concluída | 2026-03-25 | .env.test, wait-for-health.js, test:e2e:docker, test:e2e:reset, test:e2e:fixtures |
| **Fase 6** — CI/CD | ✅ Concluída | 2026-03-25 | `.github/workflows/e2e.yml` criado; usa compose test override + port 5433 |
| **Fase 7** — Firebase Emulator + Ambiente Prod-like | ✅ Concluída | 2026-03-25 | 3 containers isolados; zero mudança em src/ |

> **Total consolidado (2026-03-25):** `npm run test:e2e` → **74 passando · 4 skipped · 0 falhas** (6 suítes)
> **CI/CD (2026-03-25):** `.github/workflows/e2e.yml` — roda em todo PR e push para `main`; sobe stack via compose test override; teardown sempre com `-v`

### Nota sobre Fase 1 — isolamento prod/test

O plano original previa adicionar `command: sh -c "npm run migrate && npm start"` diretamente no `docker-compose.yml`. Isso foi **descartado** porque o mesmo arquivo é usado em produção.

**Solução adotada**: criado `docker-compose.test.yml` (override) que só é carregado em contexto de teste:

```bash
# Ambiente de testes (aplica migrations automaticamente antes de subir a API)
docker compose -f docker-compose.yml -f docker-compose.test.yml up -d postgres api

# Produção (comportamento inalterado)
docker compose up -d
```

O override injeta `command`, volumes e variáveis de ambiente específicas para testes sem tocar no compose de produção.

---

## Visão geral da arquitetura alvo

```
┌─────────────────────────────────────────────────────────────────┐
│                   Docker Network: enlite-network                 │
│                                                                  │
│  ┌─────────────────────┐   ┌─────────────────────────────────┐  │
│  │  postgres:16-alpine │   │  api (worker-functions)          │  │
│  │  porta: 5432        │◄──│  porta: 8080                     │  │
│  │  BD: enlite_e2e     │   │  USE_MOCK_AUTH=true              │  │
│  │  healthcheck: ok    │   │  NODE_ENV=test                   │  │
│  │  migrações: via API │   │  inicia → roda migrations → up   │  │
│  └─────────────────────┘   └──────────────┬──────────────────┘  │
│                                            │ API_URL=            │
│                                            │ http://api:8080     │
│                             ┌──────────────▼──────────────────┐  │
│                             │  test-runner                     │  │
│                             │  DATABASE_URL=postgres://...     │  │
│                             │  npm run test:e2e                │  │
│                             └──────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

### Fluxo de autenticação simulada

```
Teste → POST /api/test/auth/token  { uid, email, role }
      ← { token: "mock_<base64(JSON)>" }

Teste → ENDPOINT  Authorization: Bearer mock_<base64>
      → MockAuthMiddleware decodifica base64 → seta req.user
      → Controller executa com req.user.uid
      ← Resposta HTTP

Teste → SELECT direto no pg.Pool
      ← Verifica dado persistido no banco
```

O token é um base64 do JSON `{ uid, email, role, iat, exp }`, prefixado com `mock_`.
Gerado por `/api/test/auth/token` (registrado por `createMockAuthEndpoints()` quando `USE_MOCK_AUTH=true`).

---

## Auditoria do estado atual

### O que já existe e funciona

| Artefato | Caminho | Status |
|---|---|---|
| Docker Compose (base) | `docker-compose.yml` | ✅ Corrigido (BUG-03, BUG-08) |
| Docker Compose (test override) | `docker-compose.test.yml` | ✅ Criado — migrations + mock auth |
| Mock Auth Middleware | `src/infrastructure/middleware/MockAuthMiddleware.ts` | ✅ Correto |
| Jest config E2E | `jest.config.e2e.js` | ✅ Corrigido (BUG-06) |
| Worker onboarding flow | `tests/e2e/worker-flow.test.ts` | ✅ Corrigido (BUG-04/05) |
| Auth Firebase flow | `tests/e2e/auth-firebase.test.ts` | ✅ Corrigido (BUG-01/02/04/05) |
| Admin access control | `tests/e2e/admin-access-control.test.ts` | ✅ Corrigido (BUG-01/02/04/05) |
| Profile tabs | `tests/e2e/profile-tabs.test.ts` | ✅ Corrigido (BUG-04/05) |
| Recruitment API | `tests/e2e/recruitment-api.test.ts` | ⚠️ URL corrigida (BUG-07); isolado do Jest (BUG-06); migração p/ Jest pendente (Fase 3.5) |
| Dockerfile test-runner | `Dockerfile.test-runner` | ✅ OK |
| Migration runner (Docker) | `scripts/run-migrations-docker.js` | ✅ Criado — idempotente com `schema_migrations` |
| Script de reset | `scripts/reset-test-db.sh` | ✅ Criado |
| Setup E2E | `tests/e2e/setup.ts` | ⚠️ DATABASE_URL corrigida; truncate robusto pendente (Fase 2.1) |

### Bugs críticos catalogados

#### BUG-01 — Endpoints de mock auth divergentes entre arquivos

| Arquivo | Endpoint chamado | Endpoint real |
|---|---|---|
| `auth-firebase.test.ts:59` | `/test/mock-auth/token` | `/api/test/auth/token` |
| `admin-access-control.test.ts:68` | `/test/auth/mock-token` | `/api/test/auth/token` |

**Resultado**: 404 imediato. Nenhum token é gerado. Todos os testes subsequentes falham.

#### BUG-02 — Payload incompleto em `generateWorkerToken()` / `generateAdminToken()`

`admin-access-control.test.ts` envia `{ uid, role }` mas o endpoint exige `{ uid, email, role }`.
**Resultado**: 400 Bad Request. Sem token, sem testes.

#### BUG-03 — `docker-compose.yml` aponta para diretório inexistente

```yaml
test-runner:
  build:
    context: ./test-e2e   # ← não existe; os testes estão em ./tests/e2e
```

**Resultado**: `docker compose --profile testing up` falha no build.

#### BUG-04 — Credenciais/porta erradas nos defaults de DATABASE_URL

```ts
// setup.ts e todos os test files:
process.env.DATABASE_URL || 'postgresql://enlite_test:test_password@localhost:5433/enlite_test'
//                                         ^^^^^^^^^^^^  ^^^^^^^^^^^^^              ^^^^
// Docker tem:   enlite_admin  enlite_password  5432
```

**Resultado**: Falha ao conectar no banco em run local (sem variável de ambiente explícita).

#### BUG-05 — API_URL com porta errada

```ts
process.env.API_URL || 'http://localhost:8081'
//                                       ^^^^  ← docker expõe 8080
```

**Resultado**: `waitForBackend()` falha; todos os testes do suite ficam pendentes por 30s e então quebram.

#### BUG-06 — `recruitment-api.test.ts` usa Playwright em vez de Jest

O arquivo usa `import { test, expect } from '@playwright/test'` com o fixture `{ request }`.
`jest.config.e2e.js` inclui `tests/e2e/**/*.test.ts`, portanto o Jest vai tentar executar este arquivo e falhar na injeção do fixture.

#### BUG-07 — `recruitment-api.test.ts` aponta para URL de PRODUÇÃO

```ts
const BASE_URL = 'https://worker-functions-121472682203.southamerica-west1.run.app';
```

**Resultado crítico**: Se esse teste rodar (via Playwright, em outro contexto), ele bate em produção. Dados de produção podem ser afetados se qualquer escrita for feita.

#### BUG-08 — Migrations com prefixo duplicado quebram `initdb.d`

`docker-compose.yml` monta `./migrations:/docker-entrypoint-initdb.d`.
O PostgreSQL executa scripts em ordem alfabética, mas existem arquivos com mesmo prefixo numérico:

```
002_add_fullmap_fields.sql
002_add_kms_encrypted_columns.sql   ← conflito de ordem
003_add_timezone_support.sql
003_create_users_base_table.sql     ← conflito de ordem
005_add_soft_delete.sql
005_create_future_role_tables.sql   ← conflito de ordem
040_consolidate_clickup_columns.sql
040_consolidate_clickup_columns_safe.sql ← conflito de ordem
```

Além disso, `initdb.d` só executa na primeira criação do volume — migrações novas não são aplicadas se o volume já existir.

---

## Roadmap por fase

### Fase 0 — Fixes obrigatórios (sem isso zero teste roda) ✅

**Esforço estimado**: 1-2h
**Pré-requisito para**: Todas as fases seguintes
**Executada em**: 2026-03-25

---

#### 0.1 — Isolar recruitment-api.test.ts ✅

Este arquivo **não pode ficar em `tests/e2e/`** enquanto usa Playwright e a URL de produção.

**Fazer primeiro**: evita que o Jest trave ao tentar importar `@playwright/test`, o que impediria de verificar se os demais fixes funcionaram.

**Opção A (recomendada)**: Migrar para Jest/axios, apontando para `process.env.API_URL`.
**Opção B**: Mover para `tests/playwright/` com um `playwright.config.ts` separado, excluído do `jest.config.e2e.js`.

O `jest.config.e2e.js` precisa excluir explicitamente até a migração ser feita:
```js
// jest.config.e2e.js
testPathIgnorePatterns: ['recruitment-api.test.ts'],
```

**Implementado**: `jest.config.e2e.js` usa `testPathIgnorePatterns` (mais confiável que negação em `testMatch`).
`recruitment-api.test.ts` teve sua `BASE_URL` corrigida para `process.env.API_URL ?? 'http://localhost:8080'`.

---

#### 0.2 — Corrigir docker-compose.yml (test-runner context) ✅

```yaml
# DE:
test-runner:
  build:
    context: ./test-e2e
    dockerfile: Dockerfile.test

# PARA:
test-runner:
  build:
    context: .
    dockerfile: Dockerfile.test-runner
```

**Implementado**: `docker-compose.yml` corrigido.

---

#### 0.3 — Corrigir defaults de API_URL e DATABASE_URL ✅

Em todos os arquivos de teste (`worker-flow.test.ts`, `auth-firebase.test.ts`, `admin-access-control.test.ts`, `profile-tabs.test.ts`):

```ts
// DE:
const API_URL = process.env.API_URL || 'http://localhost:8081';
const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://enlite_test:test_password@localhost:5433/enlite_test';

// PARA:
const API_URL = process.env.API_URL || 'http://localhost:8080';
const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';
```

Também em `tests/e2e/setup.ts`:
```ts
// DE:
const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://enlite_test:test_password@localhost:5433/enlite_test';

// PARA:
const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';
```

**Implementado**: corrigido em `worker-flow.test.ts`, `auth-firebase.test.ts`, `admin-access-control.test.ts`, `profile-tabs.test.ts` e `setup.ts`.

---

#### 0.4 — Corrigir endpoints de mock auth ✅

**Arquivo**: `tests/e2e/auth-firebase.test.ts`

Substituir (linha 59):
```ts
// DE:
const response = await api.post('/test/mock-auth/token', {
  uid: 'test-user-123',
  email: 'test@example.com',
  name: 'Test User',
});
// PARA:
const response = await api.post('/api/test/auth/token', {
  uid: 'test-user-123',
  email: 'test@example.com',
  role: 'worker',
});
return response.data.data.token;
```

**Arquivo**: `tests/e2e/admin-access-control.test.ts`

Substituir `generateWorkerToken()` (linha 65-71):
```ts
// DE:
const response = await api.post('/test/auth/mock-token', {
  uid: 'test-worker-uid',
  role: 'worker',
});
return response.data.token;

// PARA:
const response = await api.post('/api/test/auth/token', {
  uid: 'test-worker-uid',
  email: 'test-worker@e2e.local',
  role: 'worker',
});
return response.data.data.token;
```

Substituir `generateAdminToken()` (linha 73-80) com o mesmo padrão:
```ts
const response = await api.post('/api/test/auth/token', {
  uid: 'test-admin-uid',
  email: 'test-admin@e2e.local',
  role: 'admin',
});
return response.data.data.token;
```

**Implementado**: corrigido em `auth-firebase.test.ts` (1 call-site) e `admin-access-control.test.ts` (5 call-sites: `generateWorkerToken`, `generateAdminToken` e 3 inline no describe de validação de role).

---

### Fase 1 — Migrations estáveis no Docker ✅

**Esforço estimado**: 2-3h
**Objetivo**: Banco sempre consistente, mesmo com volume pré-existente e migrações com prefixos duplicados.
**Executada em**: 2026-03-25

---

#### 1.1 — Remover montagem de migrations no initdb.d ✅

O `docker-compose.yml` atual faz:
```yaml
volumes:
  - ./migrations:/docker-entrypoint-initdb.d
```

Isso tem dois problemas:
1. Só executa na primeira criação do volume
2. Prefixos duplicados causam ordem ambígua

**Solução**: Remover esse volume do postgres. As migrations passam a ser executadas pela **API na inicialização**, usando o `run_migrations.sh` já existente.

```yaml
# docker-compose.yml — service api
command: >
  sh -c "npm run migrate && npm start"
```

O postgres só precisa do healthcheck. Sem volume de migrations.

**Implementado** (com desvio do plano): volume `./migrations:/docker-entrypoint-initdb.d` removido do postgres em `docker-compose.yml`. O `command` da API **não foi adicionado ao compose base** (risco prod); em vez disso, foi adicionado ao `docker-compose.test.yml` (override exclusivo para testes). Adicionado `npm run migrate:docker` ao `package.json`.

---

#### 1.2 — Garantir idempotência do run_migrations.sh ✅

Verificar se `run_migrations.sh` usa uma tabela de controle (ex: `schema_migrations`) para rastrear quais scripts já foram executados. Se não usar:

```sql
-- Criar tabela de controle (executar uma vez no schema base)
CREATE TABLE IF NOT EXISTS schema_migrations (
  filename TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ DEFAULT NOW()
);
```

O script deve pular migrations já registradas na tabela. Isso resolve tanto o problema de volume pré-existente quanto os prefixos duplicados (cada filename é único).

**Implementado**: criado `scripts/run-migrations-docker.js` — runner Node.js puro (usa `pg`, dependência de produção, sem necessidade de `psql` ou `ts-node`). Cria a tabela `schema_migrations` se não existir, lê todos os `.sql` de `migrations/` em ordem alfabética, pula os já aplicados, executa cada novo dentro de uma transação.

---

#### 1.3 — Criar script de reset para CI ✅

Para ambientes de CI onde o banco deve começar do zero a cada run:

```bash
# scripts/reset-test-db.sh
docker compose down -v          # remove volume postgres_data
docker compose up -d postgres   # recria banco limpo
# migrations rodam via API no próximo `docker compose up api`
```

**Implementado**: criado `scripts/reset-test-db.sh`. Usa `-f docker-compose.yml -f docker-compose.test.yml` para garantir o contexto correto de testes.

---

### Fase 2 — Setup global de testes robusto

**Esforço estimado**: 1h
**Objetivo**: `setup.ts` confiável; isolamento de dados entre suítes.

---

#### 2.1 — Atualizar `tests/e2e/setup.ts`

Problemas atuais:
- Trunca tabelas hard-coded que podem não existir
- Sem tratamento de tabelas ausentes
- Não espera o backend estar pronto antes do truncate

```ts
// tests/e2e/setup.ts — versão robusta
import { Pool } from 'pg';
import axios from 'axios';

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';
const API_URL = process.env.API_URL || 'http://localhost:8080';

// Tabelas a truncar em ordem (respeitando foreign keys)
const TABLES_TO_TRUNCATE = [
  'worker_availability',
  'worker_service_areas',
  'worker_quiz_responses',
  'worker_documents',
  'worker_payment_info',
  'worker_employment_history',
  'worker_job_applications',
  'import_job_errors',
  'import_jobs',
  'workers',
];

async function waitForApi(retries = 30): Promise<void> {
  for (let i = 0; i < retries; i++) {
    try {
      await axios.get(`${API_URL}/health`);
      return;
    } catch {
      await new Promise(r => setTimeout(r, 1000));
    }
  }
  throw new Error('API not ready after 30s');
}

async function truncateTestData(pool: Pool): Promise<void> {
  // Truncate em ordem para respeitar FK constraints
  for (const table of TABLES_TO_TRUNCATE) {
    await pool.query(`TRUNCATE ${table} CASCADE`).catch(() => {
      // Tabela pode não existir em schema antigo — ignorar
    });
  }
}

let pool: Pool;

beforeAll(async () => {
  await waitForApi();
  pool = new Pool({ connectionString: DATABASE_URL });
  await truncateTestData(pool);
});

afterAll(async () => {
  if (pool) await pool.end();
});
```

---

#### 2.2 — Helpers compartilhados

Criar `tests/e2e/helpers.ts` com funções reutilizadas em todas as suítes:

```ts
// tests/e2e/helpers.ts
import axios, { AxiosInstance } from 'axios';

const API_URL = process.env.API_URL || 'http://localhost:8080';

export function createApiClient(): AxiosInstance {
  return axios.create({
    baseURL: API_URL,
    headers: { 'Content-Type': 'application/json' },
    validateStatus: () => true,
  });
}

export async function getMockToken(
  api: AxiosInstance,
  opts: { uid: string; email: string; role?: string }
): Promise<string> {
  const res = await api.post('/api/test/auth/token', {
    uid: opts.uid,
    email: opts.email,
    role: opts.role || 'worker',
  });
  if (res.status !== 200) throw new Error(`Mock token failed: ${JSON.stringify(res.data)}`);
  return res.data.data.token;
}

export async function waitForBackend(api: AxiosInstance, maxRetries = 30): Promise<void> {
  for (let i = 0; i < maxRetries; i++) {
    const res = await api.get('/health').catch(() => null);
    if (res?.status === 200) return;
    await new Promise(r => setTimeout(r, 1000));
  }
  throw new Error('Backend not ready');
}
```

---

### Fase 3 — Cobertura dos testes existentes

**Esforço estimado**: 2-3h
**Objetivo**: Fazer os 4 arquivos existentes passarem 100% no stack local Docker.

---

#### 3.1 — `worker-flow.test.ts`

Aplicar fixes de BUG-04 e BUG-05 (defaults).
O fluxo usa `x-auth-uid` header diretamente — verificar se o `AuthMiddleware` aceita esse header além do Bearer token (se não aceitar, migrar para Bearer mock_token).

---

#### 3.2 — `auth-firebase.test.ts`

Aplicar BUG-01 e defaults.
Verificar que `generateMockAuthToken()` agora usa o endpoint correto com email no payload.

---

#### 3.3 — `admin-access-control.test.ts`

Aplicar BUG-01, BUG-02 e defaults.
Verificar que `generateWorkerToken()` e `generateAdminToken()` retornam tokens válidos antes de rodar os asserts de RBAC.

---

#### 3.4 — `profile-tabs.test.ts`

Aplicar BUG-04 e BUG-05.
O teste usa `x-auth-uid` header — mesma verificação do 3.1.

---

#### 3.5 — `recruitment-api.test.ts` (migrar para Jest)

Criar `tests/e2e/recruitment-api.test.ts` do zero usando Jest/axios, apontando para `process.env.API_URL`:

```ts
import axios from 'axios';
import { createApiClient, getMockToken, waitForBackend } from './helpers';

describe('Recruitment API', () => {
  let authToken: string;
  const api = createApiClient();

  beforeAll(async () => {
    await waitForBackend(api);
    authToken = await getMockToken(api, {
      uid: 'test-admin-e2e',
      email: 'admin@e2e.local',
      role: 'admin',
    });
  });

  it('GET /api/admin/recruitment/clickup-cases retorna paginação', async () => {
    const res = await api.get('/api/admin/recruitment/clickup-cases?page=1&limit=50', {
      headers: { Authorization: `Bearer ${authToken}` },
    });
    expect(res.status).toBe(200);
    expect(res.data.pagination).toHaveProperty('total');
    expect(Array.isArray(res.data.data)).toBe(true);
  });

  // ... demais endpoints
});
```

---

### Fase 4 — Import Pipeline (nova suíte) ✅

**Esforço estimado**: 3-4h
**Objetivo**: Cobrir o fluxo mais crítico do sistema — da entrada do arquivo até as linhas no banco.
**Executada em**: 2026-03-25

**Implementado**:
- `scripts/generate-test-fixtures.js` — gera os 6 arquivos de fixture com `npm run test:e2e:fixtures`
- `tests/e2e/fixtures/` — talentum_sample.csv, planilha_operativa.xlsx, clickup_sample.xlsx, ana_care_sample.xlsx, invalid_text.txt, empty.csv
- `tests/e2e/import-pipeline.test.ts` — 4 describes (uma por fonte) + describe de inválidos; usa multipart/form-data manual (Buffer) + polling
- `tests/e2e/setup.ts` — adicionadas `encuadres`, `blacklist`, `publications`, `job_postings` ao truncate
- `migrations/055_add_dependency_level_to_job_postings.sql` — corrige bug real: coluna faltante em `job_postings` causava falha silenciosa no import da Planilha Operativa

**Resultado dos testes (2026-03-25)**: **17/17 passando** — 4 fontes + 3 cenários de erro

---

#### 4.1 — Fixtures de teste

Criar `tests/e2e/fixtures/` com arquivos mínimos para cada fonte:

```
tests/e2e/fixtures/
  talentum_sample.csv         # 3 linhas, headers reais do Talentum
  planilha_operativa.xlsx     # 2 linhas, headers reais da Planilha
  clickup_sample.xlsx         # 2 linhas, headers reais do ClickUp
  ana_care_sample.xlsx        # 2 linhas, headers reais do Ana Care
```

Os arquivos devem usar dados fictícios mas com a estrutura exata que cada Converter espera.

---

#### 4.2 — Suíte `import-pipeline.test.ts`

```ts
// tests/e2e/import-pipeline.test.ts
describe('Import Pipeline E2E', () => {
  describe('Talentum CSV', () => {
    it('POST /api/import/upload → cria import_job com status PROCESSING', async () => {
      // Arrange: multipart/form-data com talentum_sample.csv
      // Act: POST /api/import/upload
      // Assert:
      //   - status 202 Accepted
      //   - body.importJobId existe
      //   - SELECT FROM import_jobs WHERE id = importJobId → status = 'PROCESSING'
    });

    it('polling GET /api/import/status/:id → chega em DONE', async () => {
      // Arrange: usar importJobId do teste anterior (ou novo upload)
      // Act: polling por até 30s
      // Assert: status = 'DONE', error_count = 0
    });

    it('após DONE → linhas salvas em operational_workers', async () => {
      // Assert:
      //   - SELECT COUNT(*) FROM operational_workers WHERE import_job_id = ...
      //   - Verificar normalização: telefone no formato correto, nome sem espaços extras
    });

    it('erro de linha não para o import — acumula em import_job_errors', async () => {
      // Arrange: arquivo com 1 linha válida + 1 linha com dado inválido
      // Assert: status = 'DONE', error_count = 1, row_count = 1
    });
  });

  // > **2026-05-23:** importador de planilha operativa descontinuado. Cenários abaixo são históricos.
  describe('Planilha Operativa XLSX', () => {
    it('detecta tipo correto via canHandle() e salva encuadres', async () => {
      // Assert:
      //   - SELECT FROM encuadres WHERE origin = 'planilha_operativa'
      //   - Sequência pós-import: linkWorkersByPhone() executado
    });
  });

  describe('Arquivo inválido', () => {
    it('retorna 400 para MIME type inválido (texto puro)', async () => { });
    it('retorna 400 para Excel vazio', async () => { });
    it('retorna 400 para Excel sem headers reconhecidos', async () => { });
  });
});
```

---

#### 4.3 — Verificar sequência pós-import

Após import de Planilha Operativa, verificar execução de:
1. `linkWorkersByPhone()` — `encuadres.worker_id` preenchido quando phone bate
2. `blacklistRepo.linkWorkersByPhone()` — `blacklist.worker_id` preenchido
3. `syncToWorkerJobApplications()` — tabela `worker_job_applications` sincronizada

---

### Fase 5 — Scripts de execução ✅

**Esforço estimado**: 1h
**Objetivo**: Um comando único para subir tudo, testar e derrubar.
**Executada em**: 2026-03-25

**Implementado**:
- `.env.test` — variáveis para execução local sem Docker Compose completo
- `scripts/wait-for-health.js` — poll em `/health` com timeout de 60s; usado pelo `test:e2e:docker`
- `package.json` — novos scripts:
  - `test:e2e:docker` — sobe stack (postgres + api), aguarda health, roda testes, derruba
  - `test:e2e:reset` — derruba volume, sobe stack limpo, aguarda health
  - `test:e2e:fixtures` — atalho para `node scripts/generate-test-fixtures.js`

---

#### 5.1 — `.env.test` (rodar localmente sem Docker Compose)

```bash
# .env.test — usado quando rodando API local + postgres local
NODE_ENV=test
PORT=8080
DATABASE_URL=postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e
USE_MOCK_AUTH=true
USE_CERBOS=false
INTERNAL_TOKEN_SECRET=test-secret-e2e-only
API_URL=http://localhost:8080
```

---

#### 5.2 — Script `test:e2e:docker` no package.json

```json
"test:e2e:docker": "docker compose up -d postgres api && node scripts/wait-for-health.js && npm run test:e2e; docker compose down"
```

`scripts/wait-for-health.js` — script simples que faz poll em `/health` com timeout de 60s.

---

#### 5.3 — Script de reset rápido

```json
"test:e2e:reset": "docker compose down -v && docker compose up -d postgres api && node scripts/wait-for-health.js"
```

Útil quando schema mudou e o volume do postgres precisa ser recriado do zero.

---

### Fase 6 — CI/CD (GitHub Actions)

**Esforço estimado**: 1-2h
**Objetivo**: E2E automático em todo PR.

---

#### 6.1 — Workflow `.github/workflows/e2e.yml`

```yaml
name: E2E Tests

on:
  pull_request:
    branches: [main]
  push:
    branches: [main]

jobs:
  e2e:
    runs-on: ubuntu-latest
    timeout-minutes: 15

    steps:
      - uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'

      - name: Install dependencies
        run: npm ci

      - name: Start Docker stack
        run: docker compose up -d postgres api

      - name: Wait for API health
        run: node scripts/wait-for-health.js
        env:
          API_URL: http://localhost:8080

      - name: Run E2E tests
        run: npm run test:e2e
        env:
          API_URL: http://localhost:8080
          DATABASE_URL: postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e

      - name: Collect logs on failure
        if: failure()
        run: docker compose logs api

      - name: Teardown
        if: always()
        run: docker compose down -v
```

---

### Fase 7 — Firebase Emulator + Ambiente Prod-like Completo

**Esforço estimado**: 3-4h
**Objetivo**: Substituir `MockAuthMiddleware` por tokens JWT reais emitidos pelo Firebase Auth Emulator, e montar um stack Docker com **três containers totalmente isolados** (banco, API, Firebase) — pronto para ser consumido por testes E2E do frontend.

**Por que isso importa**: Com o emulador, cada chamada autenticada passa pelo mesmo caminho de código que produção (`MultiAuthService.parseCredentials` → `authenticateGoogleIdToken`). O `MockAuthMiddleware` continua existindo como fallback para desenvolvimento rápido, mas os testes E2E rodam sem ele.

---

#### 7.1 — Princípio: zero mudança em código de produção

O Firebase Admin SDK detecta automaticamente o emulador via variável de ambiente:

```
FIREBASE_AUTH_EMULATOR_HOST=firebase-emulator:9099
```

Quando essa variável está presente, o SDK roteia chamadas de verificação de token para o emulador em vez do Firebase de produção. **Nenhuma linha em `src/` precisa mudar.**

| O que muda | O que NÃO muda |
|---|---|
| `docker-compose.test.yml` | `src/index.ts` |
| `tests/e2e/helpers.ts` | `src/infrastructure/middleware/MockAuthMiddleware.ts` |
| `tests/e2e/setup.ts` | `src/infrastructure/services/MultiAuthService.ts` |
| `firebase.json` (novo) | Qualquer arquivo em `src/` |
| `.firebaserc` (novo) | — |

---

#### 7.2 — Arquitetura do stack de teste prod-like

```
┌────────────────────────────────────────────────────────────────┐
│                  Docker Network: enlite-test-network            │
│                                                                 │
│  ┌──────────────────┐   ┌──────────────────────────────────┐   │
│  │  postgres:16     │   │  api (worker-functions)           │   │
│  │  porta: 5432     │◄──│  porta: 8080                      │   │
│  │  BD: enlite_e2e  │   │  USE_MOCK_AUTH: false             │   │
│  │  healthcheck: ✅ │   │  FIREBASE_AUTH_EMULATOR_HOST:     │   │
│  └──────────────────┘   │    firebase-emulator:9099         │   │
│                          └──────────────┬─────────────────┘   │
│  ┌──────────────────┐                   │ valida tokens        │
│  │  firebase-emul.  │◄──────────────────┘                     │
│  │  Auth: 9099      │                                          │
│  │  UI:   4000      │                                          │
│  │  projeto: demo-  │                                          │
│  │  enlite-test     │                                          │
│  └──────────────────┘                                          │
│                                                                 │
│  ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ host machine ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─  │
│                                                                 │
│  Jest (backend E2E)  Playwright (frontend E2E)                  │
│  DATABASE_URL=5432   API_URL=http://localhost:8080              │
│  FIREBASE_AUTH_      FIREBASE_AUTH_                            │
│    EMULATOR_HOST=      EMULATOR_HOST=                          │
│    localhost:9099      localhost:9099                           │
└────────────────────────────────────────────────────────────────┘
```

Cada serviço é **totalmente isolado**: banco não conhece a API, Firebase não conhece o banco. Exatamente como em produção (Cloud SQL, Cloud Run, Firebase Auth são serviços independentes).

---

#### 7.3 — `firebase.json` e `.firebaserc` (novos, raiz do projeto)

```json
// firebase.json
{
  "emulators": {
    "auth": {
      "port": 9099
    },
    "ui": {
      "enabled": true,
      "port": 4000
    }
  }
}
```

```json
// .firebaserc
{
  "projects": {
    "default": "demo-enlite-test"
  }
}
```

O prefixo `demo-` é obrigatório para projetos locais do emulador — dispensa credenciais GCP.

---

#### 7.4 — `docker-compose.test.yml` atualizado

```yaml
# Adicionar ao docker-compose.test.yml

services:
  postgres:
    image: postgis/postgis:16-3.4
    # porta 5433 no host para não colidir com postgres local em dev
    ports:
      - "5433:5432"

  firebase-emulator:
    image: node:20-alpine
    working_dir: /app
    volumes:
      - ./firebase.json:/app/firebase.json
      - ./.firebaserc:/app/.firebaserc
      - firebase_emulator_data:/root/.cache/firebase
    command: >
      sh -c "npm install -g firebase-tools@latest --quiet &&
             firebase emulators:start --only auth
             --project demo-enlite-test
             --export-on-exit /root/.cache/firebase"
    ports:
      - "9099:9099"   # Auth emulator (consumido por testes e frontend)
      - "4000:4000"   # Emulator UI (inspecionar usuários criados)
    healthcheck:
      test: ["CMD-SHELL", "wget -q --spider http://localhost:9099 2>/dev/null || exit 1"]
      interval: 5s
      timeout: 5s
      retries: 20
    networks:
      - enlite-network

  api:
    depends_on:
      firebase-emulator:
        condition: service_healthy
    environment:
      USE_MOCK_AUTH: "false"                          # desabilita MockAuth
      FIREBASE_AUTH_EMULATOR_HOST: "firebase-emulator:9099"
      GCLOUD_PROJECT: "demo-enlite-test"

volumes:
  firebase_emulator_data:
```

**Nota**: `USE_MOCK_AUTH: "false"` desativa o `MockAuthMiddleware` para que o `MultiAuthService` assuma o controle — igual a produção.

---

#### 7.5 — `tests/e2e/helpers.ts` atualizado

```typescript
// tests/e2e/helpers.ts
import axios, { AxiosInstance } from 'axios';

const API_URL = process.env.API_URL || 'http://localhost:8080';
const FIREBASE_EMULATOR_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST || 'localhost:9099';
const FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID || 'demo-enlite-test';

export function createApiClient(): AxiosInstance {
  return axios.create({
    baseURL: API_URL,
    headers: { 'Content-Type': 'application/json' },
    validateStatus: () => true,
  });
}

/**
 * Obtém token JWT real via Firebase Auth Emulator.
 *
 * Fluxo:
 *   1. Cria o usuário no emulador (idempotente — ignora "email já existe")
 *   2. Faz signIn com email/password → recebe idToken JWT real
 *   3. Retorna o idToken para uso em Authorization: Bearer <token>
 *
 * Quando USE_FIREBASE_EMULATOR não está setado, cai no MockAuth como fallback
 * para compatibilidade com runs locais sem Docker.
 */
export async function getMockToken(
  api: AxiosInstance,
  opts: { uid: string; email: string; role?: string },
): Promise<string> {
  if (process.env.USE_FIREBASE_EMULATOR === 'true') {
    return getFirebaseEmulatorToken(opts);
  }
  // Fallback: MockAuth (USE_MOCK_AUTH=true)
  const res = await api.post('/api/test/auth/token', {
    uid: opts.uid,
    email: opts.email,
    role: opts.role || 'worker',
  });
  if (res.status !== 200) throw new Error(`Mock token failed: ${JSON.stringify(res.data)}`);
  return res.data.data.token;
}

async function getFirebaseEmulatorToken(
  opts: { uid: string; email: string; role?: string },
): Promise<string> {
  const base = `http://${FIREBASE_EMULATOR_HOST}`;
  const signUpUrl = `${base}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=fake-api-key`;
  const signInUrl = `${base}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=fake-api-key`;

  // Criar usuário (ignora erro se já existir)
  await axios.post(signUpUrl, {
    email: opts.email,
    password: 'enlite-e2e-password',
    returnSecureToken: false,
  }).catch(() => {});

  // Login para obter idToken JWT real
  const res = await axios.post(signInUrl, {
    email: opts.email,
    password: 'enlite-e2e-password',
    returnSecureToken: true,
  });

  if (!res.data?.idToken) {
    throw new Error(`Firebase emulator signIn failed: ${JSON.stringify(res.data)}`);
  }

  return res.data.idToken;
}

export async function waitForBackend(api: AxiosInstance, maxRetries = 30): Promise<void> {
  for (let i = 0; i < maxRetries; i++) {
    const res = await api.get('/health').catch(() => null);
    if (res?.status === 200) return;
    await new Promise(r => setTimeout(r, 1000));
  }
  throw new Error('Backend not ready');
}
```

---

#### 7.6 — `tests/e2e/setup.ts` — aguardar emulador Firebase

```typescript
// Adicionar ao beforeAll de setup.ts quando USE_FIREBASE_EMULATOR=true
async function waitForFirebaseEmulator(retries = 30): Promise<void> {
  const host = process.env.FIREBASE_AUTH_EMULATOR_HOST || 'localhost:9099';
  for (let i = 0; i < retries; i++) {
    try {
      await axios.get(`http://${host}`);
      return;
    } catch {
      await new Promise(r => setTimeout(r, 1000));
    }
  }
  throw new Error('Firebase Auth Emulator not ready after 30s');
}
```

---

#### 7.7 — Como subir o stack completo

```bash
# Subir os 3 serviços isolados (banco, API, Firebase)
docker compose -f docker-compose.yml -f docker-compose.test.yml up -d postgres firebase-emulator api

# Verificar que os 3 estão healthy
docker compose ps

# Rodar testes E2E do backend com Firebase real
USE_FIREBASE_EMULATOR=true \
API_URL=http://localhost:8080 \
DATABASE_URL=postgresql://enlite_admin:enlite_password@localhost:5433/enlite_e2e \
FIREBASE_AUTH_EMULATOR_HOST=localhost:9099 \
npm run test:e2e

# Inspecionar usuários criados pelo emulador
open http://localhost:4000
```

---

#### 7.8 — Variáveis de ambiente para frontend E2E (Playwright)

O frontend pode usar as mesmas instâncias. No `playwright.config.ts` ou `.env.test` do frontend:

```bash
# .env.test (frontend)
NEXT_PUBLIC_API_URL=http://localhost:8080
NEXT_PUBLIC_FIREBASE_AUTH_EMULATOR_HOST=localhost:9099
NEXT_PUBLIC_FIREBASE_PROJECT_ID=demo-enlite-test
```

O frontend configura o Firebase SDK para usar o emulador com:
```typescript
// Em app/lib/firebase.ts (frontend)
if (process.env.NEXT_PUBLIC_FIREBASE_AUTH_EMULATOR_HOST) {
  connectAuthEmulator(
    auth,
    `http://${process.env.NEXT_PUBLIC_FIREBASE_AUTH_EMULATOR_HOST}`
  );
}
```

Com isso, um teste Playwright pode:
1. Criar um usuário via Firebase SDK do frontend (vai para o emulador)
2. Fazer login normalmente via UI
3. O token JWT emitido é validado pelo backend via `MultiAuthService` (que aponta para o emulador)
4. Verificar no banco se os dados foram salvos corretamente

---

#### 7.9 — Script `package.json` para o stack completo

```json
"test:e2e:full": "docker compose -f docker-compose.yml -f docker-compose.test.yml up -d postgres firebase-emulator api && node scripts/wait-for-health.js && USE_FIREBASE_EMULATOR=true FIREBASE_AUTH_EMULATOR_HOST=localhost:9099 npm run test:e2e; docker compose down",
"test:e2e:stack:up": "docker compose -f docker-compose.yml -f docker-compose.test.yml up -d postgres firebase-emulator api",
"test:e2e:stack:down": "docker compose -f docker-compose.yml -f docker-compose.test.yml down"
```

---

## Matriz de cobertura alvo (pós-roadmap)

| Camada | O que é testado | Onde | DB check? |
|---|---|---|---|
| **Auth** | Bearer mock token aceito | `auth-firebase.test.ts` | ❌ |
| **Auth** | 401 sem token / token inválido | `auth-firebase.test.ts` | ❌ |
| **Auth** | 403 worker em rota admin | `admin-access-control.test.ts` | ❌ |
| **Auth** | 200 admin em rota admin | `admin-access-control.test.ts` | ❌ |
| **Worker** | Onboarding completo steps 0→5 | `worker-flow.test.ts` | ✅ |
| **Worker** | step avança currentStep no DB | `worker-flow.test.ts` | ✅ |
| **Worker** | Tabs: general-info, service-area, availability | `profile-tabs.test.ts` | ✅ |
| **Worker** | upsert idempotente (salva 2x = 1 registro) | `profile-tabs.test.ts` | ✅ |
| **Recruitment** | clickup-cases, talentum-workers, encuadres | `recruitment-api.test.ts` | ❌ |
| **Import** | Upload → import_job PROCESSING → DONE | `import-pipeline.test.ts` | ✅ |
| **Import** | Linhas salvas no banco após DONE | `import-pipeline.test.ts` | ✅ |
| **Import** | Erro de linha não para import | `import-pipeline.test.ts` | ✅ |
| **Import** | MIME inválido → 400 | `import-pipeline.test.ts` | ❌ |
| **Import** | Sequência pós-import (linkByPhone, sync) | `import-pipeline.test.ts` | ✅ |

---

## Prioridade de execução

```
Fase 0  ←── BLOCKER: zero teste roda sem esses fixes
  └── 0.1  Isolar recruitment-api.test.ts do Jest   ← primeiro: evita travamento na importação do Playwright
  └── 0.2  Fix docker-compose test-runner context
  └── 0.3  Fix API_URL e DATABASE_URL defaults (todos os arquivos)
  └── 0.4  Fix endpoints mock auth (auth-firebase + admin-access-control)

Fase 2  ←── Base confiável antes de tentar fazer os testes passarem
  └── 2.1  Atualizar setup.ts
  └── 2.2  Criar helpers.ts compartilhado

Fase 3  ←── Fazer os testes existentes passarem de verdade
  └── 3.1–3.5  Ajustes nas 5 suítes

Fase 5  ←── DX: cimentar o hábito de rodar testes localmente
  └── 5.1  .env.test
  └── 5.2  test:e2e:docker script
  └── 5.3  test:e2e:reset script

Fase 1  ←── Migrations estáveis (adiar é seguro se volume não for pré-existente)
  └── 1.1  Remover initdb.d mounting, passar migrations para API startup
  └── 1.2  Garantir idempotência do run_migrations.sh
  └── 1.3  Script de reset para CI

Fase 4  ←── Nova cobertura: import pipeline (fluxo mais crítico do sistema)
  └── 4.1  Fixtures de teste
  └── 4.2  import-pipeline.test.ts
  └── 4.3  Verificar sequência pós-import

Fase 6  ←── CI/CD (somente após Fase 3 verde)
  └── 6.1  GitHub Actions workflow
```

---

## Arquivos que serão criados ou modificados

### Modificados

| Arquivo | Por quê |
|---|---|
| `tests/e2e/setup.ts` | Fix DATABASE_URL default + truncate robusto |
| `tests/e2e/worker-flow.test.ts` | Fix API_URL e DATABASE_URL defaults |
| `tests/e2e/auth-firebase.test.ts` | Fix endpoint mock auth + defaults |
| `tests/e2e/admin-access-control.test.ts` | Fix endpoint + payload mock auth + defaults |
| `tests/e2e/profile-tabs.test.ts` | Fix API_URL e DATABASE_URL defaults |
| `docker-compose.yml` | Fix test-runner context + migrations via API |
| `jest.config.e2e.js` | Excluir recruitment-api.test.ts até migração |
| `package.json` | Adicionar scripts test:e2e:docker e test:e2e:reset |

### Criados

| Arquivo | Por quê |
|---|---|
| `tests/e2e/helpers.ts` | Funções compartilhadas (createApiClient, getMockToken, waitForBackend) |
| `tests/e2e/recruitment-api.test.ts` | Reescrever em Jest/axios com URL de ambiente |
| `tests/e2e/import-pipeline.test.ts` | Nova suíte — cobre o pipeline de import E2E |
| `tests/e2e/fixtures/talentum_sample.csv` | Fixture mínima para testes de import |
| `tests/e2e/fixtures/planilha_operativa.xlsx` | Fixture mínima para testes de import |
| `tests/e2e/fixtures/ana_care_sample.xlsx` | Fixture mínima para testes de import |
| `scripts/wait-for-health.js` | Script de espera do backend para npm script |
| `.env.test` | Variáveis para run local sem Docker Compose |
| `.github/workflows/e2e.yml` | Pipeline de CI para E2E em PRs |
