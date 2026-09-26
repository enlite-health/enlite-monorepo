/**
 * 028-caso-en.integration.e2e.ts @integration
 *
 * Fecho da spec 028 (`CASO EN{n}` em todo lugar) — passo 3.3. Prova, SEM MOCK
 * de dado (só a IDENTIDADE, via `mock_<base64>`, mesmo mecanismo de
 * `027-vacancy-case-select.integration.e2e.ts`), que:
 *
 *   1. Abrir a vacante de um paciente NATIVO (case_number >= 1000) → o cartão
 *      (`VacancyCaseCard`, `data-testid="vacancy-case-card"`) mostra
 *      "CASO EN{n}" e o título da página mostra "EN{n}-{m}" — os dois
 *      concordam (era exatamente o que o Gabriel reportou discordando:
 *      "Caso EN1041-5597" no título × "CASO 1041 - HURLINGHAM" no cartão).
 *      O `job_posting` é semeado com o `title` RAW no formato ANTIGO
 *      ("CASO {n} …", sem EN) de propósito — prova que o cartão nunca lê a
 *      coluna `title`, só formata `case_number` (`formatCaseNumber`), então
 *      continua certo mesmo sobre uma linha ainda não migrada.
 *   2. Criar uma vacante pela UI (`/admin/vacancies/new`, mesmo fluxo do
 *      `full-create-vacancy.integration.e2e.ts`) para um paciente nativo →
 *      o BACKEND real escreve `job_postings.title = 'CASO EN{n}-{m}'`
 *      (conferido direto no Postgres) e o cartão da vaga recém-criada, tanto
 *      no detalhe quanto na lista de vacantes do paciente
 *      (`PatientVacanciesCard`), mostra o mesmo texto — prova ponta a ponta:
 *      backend (write path, commit 9f195c70) + frontend (este passo, 3.2).
 *   3. Paciente LEGADO (case_number < 1000) → cartão mostra "CASO {n}", sem
 *      prefixo `EN` (D412 ponto 1-2, não reaberta por esta task).
 *   4. Baseline visual do cartão nativo (`toHaveScreenshot`) — gerada nesta
 *      rodada, primeira vez que este arquivo roda.
 *
 * Única coisa mockada: `/generate-ai-content` (Gemini — regra dura do
 * CLAUDE.md, "Custo de API = zero"; `CreateVacancyPage` chama esse endpoint
 * AUTOMATICAMENTE ao terminar o passo 1, antes de qualquer navegação
 * seguinte — sem mock, todo submit custaria uma chamada real). Mesmo padrão
 * já estabelecido em `full-create-vacancy.integration.e2e.ts`.
 *
 * `video: 'on'` só para este arquivo (abaixo, `test.use`) — os outros specs
 * de integração continuam sem vídeo (custo de disco/CI).
 *
 * Pré-condições — stack `wf028` (portas e nomes próprios, não colide com o
 * `wf027b` do outro agente que edita `worker-functions/` ao mesmo tempo):
 *   cd worker-functions
 *   docker compose -p wf028 -f docker-compose.yml -f docker-compose.test.yml \
 *     -f docker-compose.wf028-ports.yml up -d postgres api
 *   docker compose -p wf028 -f docker-compose.yml -f docker-compose.test.yml \
 *     run --rm --no-deps api node scripts/run-migrations-docker.js
 *
 *   cd ../enlite-frontend
 *   VITE_API_WORKER_FUNCTIONS_URL=http://localhost:8228 VITE_USE_PUBLIC_JOBS_API=true \
 *   VITE_FIREBASE_API_KEY=fake-api-key-for-e2e VITE_FIREBASE_AUTH_DOMAIN=demo-e2e.firebaseapp.com \
 *   VITE_FIREBASE_PROJECT_ID=demo-e2e VITE_FIREBASE_STORAGE_BUCKET=demo-e2e.appspot.com \
 *   VITE_FIREBASE_MESSAGING_SENDER_ID=000000000000 VITE_FIREBASE_APP_ID=1:000000000000:web:0 \
 *   pnpm dev
 *
 * Run:
 *   E2E_PG_CONTAINER=wf028-postgres PW_BASE_URL=http://localhost:5173 \
 *     pnpm exec playwright test --project=integration --workers=1 --grep 028
 */
import { test, expect, type Page, type Route } from '@playwright/test';
import { execSync } from 'child_process';

test.use({ video: 'on' });

const CONTAINER = process.env.E2E_PG_CONTAINER || 'wf028-postgres';
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

// ── Seed ──────────────────────────────────────────────────────────────────

const ADMIN_UID = 'e2e-admin-028-caso-en';
const ADMIN_EMAIL = 'e2e.admin.028.caso-en@enlite.health';

const NATIVE_CASE = 931041;      // >= 1000 → "EN931041" (teste 1 e 4, cartão pré-existente)
const NATIVE_CASE_CREATE = 931077; // >= 1000 → paciente separado, SEM vaga (teste 2, criação via UI)
const LEGACY_CASE = 893;         // < 1000 → "893", sem EN (teste 3)

const NATIVE_TASK = 'E2E-028-CASO-EN-NATIVO';
const NATIVE_CREATE_TASK = 'E2E-028-CASO-EN-NATIVO-CREATE';
const LEGACY_TASK = 'E2E-028-CASO-EN-LEGADO';

let nativePatientId = '';
let nativeVacancyId = '';
let nativeCreatePatientId = '';
let legacyVacancyId = '';

function seed(): void {
  runSQL(`
    INSERT INTO users (firebase_uid, email, display_name, role, is_active, account_type, status)
    VALUES ('${ADMIN_UID}', '${ADMIN_EMAIL}', 'E2E Admin CasoEN', 'admin', true, 'staff', 'ACTIVE')
    ON CONFLICT (firebase_uid) DO NOTHING;
  `);

  runSQL(`
    INSERT INTO patients (clickup_task_id, first_name, last_name, status, diagnosis, dependency_level, country, case_number, created_at, updated_at)
    VALUES ('${NATIVE_TASK}', 'Nativo', 'CasoEnE2E', 'ACTIVE', 'TEA', 'MODERATE', 'AR', ${NATIVE_CASE}, NOW(), NOW());
  `);
  runSQL(`
    INSERT INTO patients (clickup_task_id, first_name, last_name, status, diagnosis, dependency_level, country, case_number, created_at, updated_at)
    VALUES ('${NATIVE_CREATE_TASK}', 'NativoCriar', 'CasoEnE2E', 'ACTIVE', 'TEA', 'MODERATE', 'AR', ${NATIVE_CASE_CREATE}, NOW(), NOW());
  `);
  runSQL(`
    INSERT INTO patients (clickup_task_id, first_name, last_name, status, diagnosis, dependency_level, country, case_number, created_at, updated_at)
    VALUES ('${LEGACY_TASK}', 'Legado', 'CasoEnE2E', 'ACTIVE', 'Down', 'MILD', 'AR', ${LEGACY_CASE}, NOW(), NOW());
  `);

  runSQL(`
    INSERT INTO patient_addresses (patient_id, address_formatted, address_raw, lat, lng, display_order, source, created_at, updated_at)
    SELECT id, 'Av. Nativo ${NATIVE_CASE}, CABA', 'Av. Nativo ${NATIVE_CASE}', -34.6037, -58.3816, 1, 'manual', NOW(), NOW()
    FROM patients WHERE clickup_task_id = '${NATIVE_TASK}';
  `);
  runSQL(`
    INSERT INTO patient_addresses (patient_id, address_formatted, address_raw, lat, lng, display_order, source, created_at, updated_at)
    SELECT id, 'Av. NativoCriar ${NATIVE_CASE_CREATE}, CABA', 'Av. NativoCriar ${NATIVE_CASE_CREATE}', -34.61, -58.39, 1, 'manual', NOW(), NOW()
    FROM patients WHERE clickup_task_id = '${NATIVE_CREATE_TASK}';
  `);
  runSQL(`
    INSERT INTO patient_addresses (patient_id, address_formatted, address_raw, lat, lng, display_order, source, created_at, updated_at)
    SELECT id, 'Calle Legado ${LEGACY_CASE}, CABA', 'Calle Legado ${LEGACY_CASE}', -34.6, -58.4, 1, 'manual', NOW(), NOW()
    FROM patients WHERE clickup_task_id = '${LEGACY_TASK}';
  `);

  nativePatientId = extractUUID(runSQL(`SELECT id FROM patients WHERE clickup_task_id = '${NATIVE_TASK}'`))!;
  if (!nativePatientId) throw new Error('seed: paciente nativo (teste 1) não foi inserido');
  nativeCreatePatientId = extractUUID(runSQL(`SELECT id FROM patients WHERE clickup_task_id = '${NATIVE_CREATE_TASK}'`))!;
  if (!nativeCreatePatientId) throw new Error('seed: paciente nativo (teste 2, criação) não foi inserido');
  const legacyPatientId = extractUUID(runSQL(`SELECT id FROM patients WHERE clickup_task_id = '${LEGACY_TASK}'`))!;
  if (!legacyPatientId) throw new Error('seed: paciente legado não foi inserido');

  const nativeAddressId = extractUUID(
    runSQL(`SELECT id FROM patient_addresses WHERE patient_id = '${nativePatientId}' LIMIT 1`),
  )!;
  const legacyAddressId = extractUUID(
    runSQL(`SELECT id FROM patient_addresses WHERE patient_id = '${legacyPatientId}' LIMIT 1`),
  )!;
  if (!nativeAddressId) throw new Error('seed: endereço do paciente nativo não foi inserido');
  if (!legacyAddressId) throw new Error('seed: endereço do paciente legado não foi inserido');

  // Vaga do paciente NATIVO (teste 1 e 4) — `title` RAW no formato ANTIGO
  // (sem EN), de propósito: prova que o cartão não lê essa coluna.
  runSQL(`
    INSERT INTO job_postings (
      vacancy_number, case_number, title, description, talentum_description,
      patient_id, patient_address_id,
      required_professions, providers_needed,
      status, is_draft, country,
      created_at, updated_at
    ) VALUES (
      nextval('job_postings_vacancy_number_seq'), ${NATIVE_CASE},
      'CASO ${NATIVE_CASE} Test caso-en (linha não migrada)', '', 'Descrição semeada — evita geração via Gemini.',
      '${nativePatientId}', '${nativeAddressId}',
      ARRAY['AT']::varchar[], 1,
      'PENDING_ACTIVATION', false, 'AR',
      NOW(), NOW()
    );
  `);
  nativeVacancyId = extractUUID(
    runSQL(`SELECT id FROM job_postings WHERE patient_id = '${nativePatientId}' ORDER BY created_at DESC LIMIT 1`),
  )!;
  if (!nativeVacancyId) throw new Error('seed: vaga do paciente nativo não foi inserida');

  // Vaga do paciente LEGADO (teste 3).
  runSQL(`
    INSERT INTO job_postings (
      vacancy_number, case_number, title, description, talentum_description,
      patient_id, patient_address_id,
      required_professions, providers_needed,
      status, is_draft, country,
      created_at, updated_at
    ) VALUES (
      nextval('job_postings_vacancy_number_seq'), ${LEGACY_CASE},
      'CASO ${LEGACY_CASE} Test caso-en', '', 'Descrição semeada — evita geração via Gemini.',
      '${legacyPatientId}', '${legacyAddressId}',
      ARRAY['AT']::varchar[], 1,
      'PENDING_ACTIVATION', false, 'AR',
      NOW(), NOW()
    );
  `);
  legacyVacancyId = extractUUID(
    runSQL(`SELECT id FROM job_postings WHERE patient_id = '${legacyPatientId}' ORDER BY created_at DESC LIMIT 1`),
  )!;
  if (!legacyVacancyId) throw new Error('seed: vaga do paciente legado não foi inserida');
}

function cleanup(): void {
  const tasks = `'${NATIVE_TASK}', '${NATIVE_CREATE_TASK}', '${LEGACY_TASK}'`;
  runSQL(`DELETE FROM job_postings WHERE patient_id IN (SELECT id FROM patients WHERE clickup_task_id IN (${tasks}));`);
  runSQL(`DELETE FROM patient_addresses WHERE patient_id IN (SELECT id FROM patients WHERE clickup_task_id IN (${tasks}));`);
  runSQL(`DELETE FROM patients WHERE clickup_task_id IN (${tasks});`);
  runSQL(`DELETE FROM users WHERE firebase_uid = '${ADMIN_UID}';`);
}

// ── Admin mock auth — mesmo mecanismo de 027-vacancy-case-select ───────────

function buildMockToken(uid: string, email: string, role: string): string {
  return 'mock_' + Buffer.from(JSON.stringify({ uid, email, role }), 'utf-8').toString('base64');
}

function buildFakeIdToken(uid: string, email: string): string {
  return (
    'eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.' +
    Buffer.from(
      JSON.stringify({
        sub: uid, uid, email,
        iss: 'https://securetoken.google.com/demo-no-project',
        aud: 'demo-no-project',
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 3600,
      }),
    ).toString('base64url') +
    '.'
  );
}

async function loginAsAdminMock(page: Page, landingPath: string): Promise<void> {
  const fakeIdToken = buildFakeIdToken(ADMIN_UID, ADMIN_EMAIL);
  const mockToken = buildMockToken(ADMIN_UID, ADMIN_EMAIL, 'admin');

  const mockAuthPayload = JSON.stringify({
    uid: ADMIN_UID, email: ADMIN_EMAIL,
    stsTokenManager: { accessToken: fakeIdToken, expirationTime: Date.now() + 3600_000 },
  });
  await page.addInitScript((payload: string) => {
    localStorage.setItem('enlite_e2e_mock_auth', payload);
  }, mockAuthPayload);

  await page.route('**/identitytoolkit.googleapis.com/**', async (route: Route) => {
    await route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({
        localId: ADMIN_UID, email: ADMIN_EMAIL, idToken: fakeIdToken,
        refreshToken: 'fake-refresh', expiresIn: '3600', registered: true,
      }),
    });
  });
  await page.route('**/securetoken.googleapis.com/**', async (route: Route) => {
    await route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ id_token: fakeIdToken, expires_in: '3600', token_type: 'Bearer', refresh_token: 'fake-refresh' }),
    });
  });

  // Único endpoint de DADO mockado — custo de Gemini (regra dura do CLAUDE.md).
  // `CreateVacancyPage` chama isso automaticamente ao terminar o passo 1.
  await page.route('**/generate-ai-content', async (route: Route) => {
    await route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        data: {
          description: 'Descrição fixture — e2e 028, sem custo de Gemini.',
          prescreening: { questions: [], faq: [] },
        },
      }),
    });
  });

  await page.route('**/api/**', async (route: Route) => {
    const headers = { ...route.request().headers(), authorization: `Bearer ${mockToken}` };
    await route.continue({ headers });
  });
  await page.route('**/v1/**', async (route: Route) => {
    const headers = { ...route.request().headers(), authorization: `Bearer ${mockToken}` };
    await route.continue({ headers });
  });

  await page.goto(landingPath);
  await expect(page).not.toHaveURL(/.*\/(admin\/)?login/, { timeout: 20_000 });
}

// ── SearchableSelect helpers (case-select) ─────────────────────────────────

function caseSelectButton(page: Page) {
  return page.locator('[data-testid="case-select"] button');
}

async function openCaseSelectAndSearch(page: Page, term: string): Promise<void> {
  await caseSelectButton(page).click();
  const searchInput = page.locator('[data-testid="case-select"] input[type="text"]');
  await searchInput.click();
  await searchInput.type(term, { delay: 20 });
}

// ── Preenchimento mínimo pra passar a validação Zod (profissão + 1 slot de
//    horário + 1 link de Meet válido) — interação humana: click + keyboard,
//    nunca fill()/selectOption() forçado num widget que não é <select>. ────

async function fillMinimumAndSave(page: Page, saveTestId: string): Promise<void> {
  // O `<input>` do Checkbox é `sr-only` (visualmente escondido) — a caixa
  // decorativa que o usuário de fato vê e clica é o `<label>` que os envolve
  // (mesmo padrão HTML nativo label+input); clicar direto no input escondido
  // é interceptado pela `<div>` decorativa por cima (medido na 1ª rodada).
  await page.locator('label:has([data-testid="profession-checkbox-AT"])').click();

  const addSlotBtn = page.getByRole('button', { name: /Horarios|Horários/i }).first();
  await addSlotBtn.scrollIntoViewIfNeeded();
  await addSlotBtn.click();

  const meetInput = page.locator('[data-testid="meet-link-0"]');
  await meetInput.scrollIntoViewIfNeeded();
  await meetInput.click();
  await meetInput.type('meet.google.com/abc-defg-hij', { delay: 15 });
  await meetInput.blur();

  const saveBtn = page.getByTestId(saveTestId);
  await expect(saveBtn).toBeEnabled({ timeout: 10_000 });
  await saveBtn.click();
}

// ── Testes ──────────────────────────────────────────────────────────────────

test.describe('@integration Spec 028 — "CASO EN{n}" no cartão, no prefill e na criação via UI', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(90_000);

  test.beforeAll(() => {
    cleanup();
    seed();
  });
  test.afterAll(() => {
    cleanup();
  });

  test('feliz — vaga NATIVA: cartão mostra "CASO EN{n}", título da página mostra "EN{n}-{m}" (concordam)', async ({ page }) => {
    await loginAsAdminMock(page, `/admin/vacancies/${nativeVacancyId}`);

    const card = page.locator('[data-testid="vacancy-case-card"]');
    await expect(card).toBeVisible({ timeout: 15_000 });
    await expect(card).toContainText(`CASO EN${NATIVE_CASE}`);
    // Nunca o número cru sem o prefixo, mesmo a linha tendo sido semeada com
    // `title = 'CASO ${NATIVE_CASE} …'` (sem EN) — o cartão ignora essa coluna.
    await expect(card).not.toContainText(`CASO ${NATIVE_CASE} `);

    // Título da página (h1, calculado independentemente por VacancyDetailPage
    // com o mesmo `formatCaseNumber`, spec 027) — os dois concordam.
    await expect(page.getByText(new RegExp(`EN${NATIVE_CASE}-\\d+`)).first()).toBeVisible({ timeout: 10_000 });
  });

  test('alt — vaga LEGADA: cartão mostra "CASO {n}", sem prefixo EN', async ({ page }) => {
    await loginAsAdminMock(page, `/admin/vacancies/${legacyVacancyId}`);

    const card = page.locator('[data-testid="vacancy-case-card"]');
    await expect(card).toBeVisible({ timeout: 15_000 });
    await expect(card).toContainText(`CASO ${LEGACY_CASE}`);
    await expect(card).not.toContainText(`EN${LEGACY_CASE}`);
  });

  test('visual — cartão da vaga nativa (baseline nova, 1ª rodada deste arquivo)', async ({ page }) => {
    await loginAsAdminMock(page, `/admin/vacancies/${nativeVacancyId}`);
    const card = page.locator('[data-testid="vacancy-case-card"]');
    await expect(card).toBeVisible({ timeout: 15_000 });
    await expect(card).toContainText(`CASO EN${NATIVE_CASE}`);

    await page.screenshot({ path: 'evidencias-tmp/028-cartao-caso-en-print.png' });
    await expect(card).toHaveScreenshot('028-caso-en-card.png', { maxDiffPixelRatio: 0.02 });
  });

  test('feliz — criar vaga pela UI (paciente nativo) → backend escreve "CASO EN{n}-{m}", cartão e lista concordam', async ({ page }) => {
    // D425 item 4 (24/09/2026, docs/decisoes.md, Fase 3 de completar-vacante-em-rascunho) —
    // "Nueva" sai temporariamente: este teste cria a vaga pela UI via /admin/vacancies/new,
    // rota que agora redireciona pra /admin/vacancies. Achado FORA da lista medida na Fase 0
    // (`evidencias/medicao-fase-0.md` §Fase 3 só listava 9 arquivos) — este é o 10º, achado
    // pelo grep de "Nueva Vacante" no Passo 6 da Fase 3. Skip, não apagado; os testes 1-3
    // deste arquivo (que navegam direto por ID) não são afetados.
    test.skip(true, 'D425 item 4 — "Nueva" fora temporariamente; vacante nasce só do serviço contratado');
    await loginAsAdminMock(page, '/admin/vacancies/new');
    await expect(page.getByText('Nueva Vacante')).toBeVisible({ timeout: 15_000 });

    await openCaseSelectAndSearch(page, String(NATIVE_CASE_CREATE));
    const option = page.getByRole('option', { name: new RegExp(`EN${NATIVE_CASE_CREATE}`) });
    await expect(option).toBeVisible({ timeout: 5_000 });
    await option.click();
    await expect(caseSelectButton(page)).toContainText(`EN${NATIVE_CASE_CREATE}`);

    // Endereço único do paciente auto-seleciona.
    const addressBtn = page.locator('[data-testid^="address-option-"]').first();
    await expect(addressBtn).toBeVisible({ timeout: 10_000 });
    await expect(addressBtn).toContainText(`Av. NativoCriar ${NATIVE_CASE_CREATE}`);

    await fillMinimumAndSave(page, 'create-vacancy-save-btn');

    // Sucesso → navega pro passo 2 (Talentum). Não precisamos dele — a prova
    // é o TÍTULO gravado, não a config do Talentum.
    await expect(page).toHaveURL(/\/admin\/vacancies\/.+\/talentum/, { timeout: 30_000 });
    const urlParts = page.url().split('/');
    const talentumIdx = urlParts.indexOf('talentum');
    const newVacancyId = talentumIdx > 0 ? urlParts[talentumIdx - 1] : '';
    expect(newVacancyId).toBeTruthy();

    // ── Prova 1 (backend): título RAW no Postgres já sai "CASO EN{n}-{m}" ──
    const titleRaw = runSQL(`SELECT title FROM job_postings WHERE id = '${newVacancyId}'`).trim();
    expect(titleRaw).toMatch(new RegExp(`^CASO EN${NATIVE_CASE_CREATE}-\\d+$`));

    // ── Prova 2 (frontend, detalhe): o cartão da vaga recém-criada concorda ──
    await page.goto(`/admin/vacancies/${newVacancyId}`);
    const card = page.locator('[data-testid="vacancy-case-card"]');
    await expect(card).toBeVisible({ timeout: 15_000 });
    await expect(card).toContainText(`CASO EN${NATIVE_CASE_CREATE}`);

    // ── Prova 3 (frontend, lista): PatientVacanciesCard, na ficha do paciente ──
    await page.goto(`/admin/patients/${nativeCreatePatientId}`);
    await page.getByRole('button', { name: /^Vacantes$/i }).click();
    const vacanciesCard = page.getByTestId('patient-vacancies-card');
    await expect(vacanciesCard).toBeVisible({ timeout: 15_000 });
    await expect(vacanciesCard.getByText(new RegExp(`CASO EN${NATIVE_CASE_CREATE}-\\d+`)).first()).toBeVisible({
      timeout: 10_000,
    });

    cleanupCreatedVacancy(newVacancyId);
  });
});

function cleanupCreatedVacancy(vacancyId: string): void {
  runSQL(`DELETE FROM job_postings WHERE id = '${vacancyId}';`);
}
