/**
 * 027-public-jobs-search-en-code.integration.e2e.ts @integration
 *
 * Rodada de fecho do gate `revisao-pr` (spec 027, item 3.2 — BLOQUEIO por
 * ausência de e2e de TELA). Cobre a busca da lista PÚBLICA de vagas na home
 * do worker (`JobsEmbeddedSection.tsx:133`) — a comparação `job.code` era a
 * ÚNICA das 5 do filtro sem `.toLowerCase()`, então digitar "en1234"
 * minúsculo dava ZERO resultado enquanto "EN1234"/"1234" funcionavam
 * (conserto do item 2 desta mesma rodada).
 *
 * SEM MOCK de rede na parte que importa: frontend real (Vite dev server) +
 * backend real (worker-functions, USE_MOCK_AUTH=true) + Postgres real
 * (própria worktree — 027fase4-postgres/027fase4-api, docker-compose.027fase4-ports.yml).
 * `/api/public/v1/jobs` NUNCA é interceptado — a lista que o teste busca vem
 * do Postgres de verdade. O único mock é a IDENTIDADE do worker
 * (`e2e/helpers/worker-auth-helper.ts::loginAsWorker`, mesmo mecanismo já
 * usado por `home-vagas-api-publica.integration.e2e.ts`): ela estuba
 * `/api/workers/me` no NAVEGADOR (perfil mínimo, só para o `ProtectedRoute`
 * liberar a tela) — não tem relação com o que este teste prova.
 *
 * Interação humana: click no campo de busca + `type()` tecla a tecla, nunca
 * `fill()` direto — e a leitura da lista é por `getByText`/`queryByText` NA
 * TELA, nunca por estado interno.
 *
 * Pré-condições (ver "## Não consegui" se algo faltar):
 *   docker compose -p 027fase4 -f worker-functions/docker-compose.yml \
 *     -f worker-functions/docker-compose.027fase4-ports.yml up -d postgres api
 *   cd enlite-frontend && pnpm dev   (porta 5173, .env local aponta
 *     VITE_API_WORKER_FUNCTIONS_URL=http://localhost:8479, e precisa também
 *     das VITE_FIREBASE_* — sem elas o app monta BRANCO e o teste falha em
 *     `input[type=email]` como timeout opaco, não como o erro de fato)
 * Run:
 *   E2E_PG_CONTAINER=027fase4-postgres PW_BASE_URL=http://localhost:5173 \
 *     pnpm test:e2e:integration --grep "busca.*EN"
 */
import { test, expect, type Page } from '@playwright/test';
import { execSync } from 'child_process';
import { loginAsWorker } from '../helpers/worker-auth-helper';

const CONTAINER = process.env.E2E_PG_CONTAINER || 'enlite-postgres';
const DB_USER = 'enlite_admin';
const DB_NAME = 'enlite_e2e';

function runSQL(sql: string): string {
  const escaped = sql.replace(/'/g, "'\\''");
  return execSync(`docker exec ${CONTAINER} psql -U ${DB_USER} -d ${DB_NAME} -t -c '${escaped}'`, {
    stdio: 'pipe',
  }).toString();
}

function extractUUID(psqlOutput: string): string | null {
  const m = psqlOutput.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  return m ? m[0] : null;
}

// ── Seed: 1 vaga NATIVA (case_number >= 1000 → exibição "EN{n}"), visível na
//    listagem pública (social_short_links->'site', is_draft=false, SEARCHING). ──

const NATIVE_CASE = 420088; // exibição "EN420088"
const TASK_ID = 'E2E-027-PUB-SEARCH';
let vacancyId: string;
let patientId: string;

function seed(): void {
  runSQL(`
    INSERT INTO patients (clickup_task_id, first_name, last_name, status, diagnosis, dependency_level, country, case_number, created_at, updated_at)
    VALUES ('${TASK_ID}', 'PublicSearch', 'E2E027', 'ACTIVE', 'TEA', 'MODERATE', 'AR', ${NATIVE_CASE}, NOW(), NOW());
  `);
  patientId = extractUUID(runSQL(`SELECT id FROM patients WHERE clickup_task_id = '${TASK_ID}'`))!;
  if (!patientId) throw new Error('seed: paciente não foi inserido');

  runSQL(`
    INSERT INTO patient_addresses (patient_id, address_formatted, address_raw, lat, lng, display_order, source, created_at, updated_at)
    VALUES ('${patientId}', 'Av. Busca Pública 420088, CABA', 'Av. Busca Pública 420088', -34.6037, -58.3816, 1, 'manual', NOW(), NOW());
  `);
  const addressId = extractUUID(
    runSQL(`SELECT id FROM patient_addresses WHERE patient_id = '${patientId}' LIMIT 1`),
  )!;

  runSQL(`
    INSERT INTO job_postings (
      vacancy_number, case_number, title, description,
      patient_id, patient_address_id,
      required_professions, providers_needed,
      status, is_draft, country,
      talentum_whatsapp_url, social_short_links,
      created_at, updated_at
    ) VALUES (
      nextval('job_postings_vacancy_number_seq'), ${NATIVE_CASE},
      'CASO ${NATIVE_CASE} Test público', '',
      '${patientId}', '${addressId}',
      ARRAY['AT']::varchar[], 1,
      'SEARCHING', false, 'AR',
      'https://wa.me/5491100000420',
      '{"site": "https://jobs.enlite.health/es/vagas/${NATIVE_CASE}/"}'::jsonb,
      NOW(), NOW()
    );
  `);
  vacancyId = extractUUID(
    runSQL(`SELECT id FROM job_postings WHERE patient_id = '${patientId}' ORDER BY created_at DESC LIMIT 1`),
  )!;
  if (!vacancyId) throw new Error('seed: vaga não foi inserida');
}

function cleanup(): void {
  if (vacancyId) runSQL(`DELETE FROM job_postings WHERE id = '${vacancyId}';`);
  runSQL(`DELETE FROM patient_addresses WHERE patient_id IN (SELECT id FROM patients WHERE clickup_task_id = '${TASK_ID}');`);
  runSQL(`DELETE FROM patients WHERE clickup_task_id = '${TASK_ID}';`);
}

async function loginAndGoHome(page: Page): Promise<void> {
  await page.addInitScript(() => {
    (window as { __USE_PUBLIC_JOBS_API?: boolean }).__USE_PUBLIC_JOBS_API = true;
  });
  const authUid = `e2e-worker-027-pubsearch-${Date.now()}`;
  await loginAsWorker(page, authUid, `${authUid}@test.local`);
  await page.goto('/', { waitUntil: 'networkidle', timeout: 30_000 });
  await expect(page.locator('#jobs-section')).toBeVisible({ timeout: 20_000 });
}

async function typeInSearch(page: Page, term: string): Promise<void> {
  // Cada teste usa uma `page` NOVA (browser context próprio do Playwright) —
  // o campo já nasce vazio, sem precisar limpar.
  const input = page.getByPlaceholder('Buscar por nombre de vacante');
  await input.click();
  await input.type(term, { delay: 20 }); // tecla a tecla — o defeito só aparece via evento de digitação real, não fill()
}

test.describe('@integration Home — busca da lista pública de vagas por código EN', () => {
  // fullyParallel do projeto espalharia os 4 testes em workers diferentes,
  // cada um chamando beforeAll()/seed() em paralelo contra a MESMA vaga —
  // serial força 1 worker, 1 seed (mesmo motivo do spec de case-select).
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(60_000);

  test.beforeAll(() => {
    cleanup();
    seed();
  });
  test.afterAll(() => {
    cleanup();
  });

  test(`feliz — buscar "EN${NATIVE_CASE}" acha a vaga (dado real do Postgres)`, async ({ page }) => {
    await loginAndGoHome(page);

    await typeInSearch(page, `EN${NATIVE_CASE}`);
    await expect(page.getByText(`EN${NATIVE_CASE}`, { exact: false })).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText('jobs.noResults', { exact: false })).not.toBeVisible();
  });

  test(`alt — buscar em MINÚSCULO "en${NATIVE_CASE}" também acha a MESMA vaga (o defeito consertado: era case-sensitive só nesta comparação)`, async ({ page }) => {
    await loginAndGoHome(page);

    await typeInSearch(page, `en${NATIVE_CASE}`);
    await expect(page.getByText(`EN${NATIVE_CASE}`, { exact: false })).toBeVisible({ timeout: 10_000 });
  });

  test(`alt — buscar pelo número SECO "${NATIVE_CASE}" (sem prefixo EN) acha a MESMA vaga`, async ({ page }) => {
    await loginAndGoHome(page);

    await typeInSearch(page, String(NATIVE_CASE));
    await expect(page.getByText(`EN${NATIVE_CASE}`, { exact: false })).toBeVisible({ timeout: 10_000 });
  });

  test('alt — busca sem match mostra o estado vazio ("No se encontraron vacantes...")', async ({ page }) => {
    await loginAndGoHome(page);

    await typeInSearch(page, 'EN999999999-nao-existe');
    await expect(page.getByText('No se encontraron vacantes', { exact: false })).toBeVisible({ timeout: 10_000 });
  });

  // Gate `revisao-pr` MODO fecho, PR #512 — blocker 4/D354: `PublicVacancyPage`
  // (rota `/vacantes/:id`, PÚBLICA — PublicVacancyController não exige auth) é uma
  // das 7 superfícies sem e2e afirmando o `EN####` renderizado. `vacancyId` já vem
  // do `seed()` acima (mesma vaga NATIVA usada pela busca) — só falta um `goto`
  // direto e ler o texto da TELA, sem reconstruir jornada nenhuma.
  test('feliz — página pública da vaga (/vacantes/:id) mostra o código EN da mesma vaga', async ({ page }) => {
    await page.goto(`/vacantes/${vacancyId}`);
    await expect(page.getByText(`EN${NATIVE_CASE}`, { exact: false })).toBeVisible({ timeout: 15_000 });
  });
});
