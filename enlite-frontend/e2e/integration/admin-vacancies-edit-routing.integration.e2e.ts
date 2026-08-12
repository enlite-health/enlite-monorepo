/**
 * admin-vacancies-edit-routing.integration.e2e.ts @integration
 *
 * Full-stack E2E — valida o roteamento do botão de editar (ícone lápis) na
 * listagem de vagas (AdminVacanciesPage) em função de `is_draft` da vaga.
 *
 * Regra (autoritativa no backend `vacancyCrudHelpers.ts`):
 *   - Vagas com `is_draft = true`  → operador ainda pode editar todos os campos
 *     (modal grande VacancyModal continua válido).
 *   - Vagas com `is_draft = false` → backend bloqueia com 403 qualquer campo
 *     fora de { schedule, status }. O fluxo correto é editar no detalhe via
 *     VacancyScheduleEditModal + VacancyStatusEditor.
 *
 * Antes deste teste, clicar no lápis em uma vaga SEARCHING_REPLACEMENT
 * (is_draft=false) abria o modal grande, que enviava o payload completo no
 * PUT — backend respondia 403 e a UI mostrava a mensagem "Forbidden fields
 * for vacancy in status SEARCHING_REPLACEMENT…".
 *
 * Esses cenários blindam:
 *   1. Lápis em vaga non-draft (status SEARCHING_REPLACEMENT) → NAVEGA pra
 *      /admin/vacancies/{id}, NÃO abre o modal grande.
 *   2. Lápis em vaga draft (status PENDING_ACTIVATION) → abre o modal grande
 *      (VacancyModal).
 *   3. No detalhe, abrir VacancyScheduleEditModal + salvar uma alteração de
 *      schedule numa vaga non-draft NÃO retorna 403 — o endpoint aceita o
 *      payload restrito { schedule }.
 */

import { test, expect, type Page, type Route } from '@playwright/test';
import {
  insertTestPatient,
  cleanupTestPatient,
  insertBaseVacancy,
  cleanupVacancies,
} from '../helpers/db-test-helper';
import { execSync } from 'child_process';

// ── Constants ──────────────────────────────────────────────────────────────────

const MOCK_ADMIN_USER = {
  uid: 'e2e-int-edit-routing',
  email: 'admin.edit-routing@e2e.test',
  role: 'admin',
};

const MOCK_TOKEN =
  'mock_' + Buffer.from(JSON.stringify(MOCK_ADMIN_USER), 'utf-8').toString('base64');

const FAKE_ID_TOKEN =
  'eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.' +
  Buffer.from(
    JSON.stringify({
      sub: MOCK_ADMIN_USER.uid,
      uid: MOCK_ADMIN_USER.uid,
      email: MOCK_ADMIN_USER.email,
      iss: 'https://securetoken.google.com/enlite-prd',
      aud: 'enlite-prd',
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600,
    }),
  ).toString('base64url') +
  '.';

// ── DB helpers ────────────────────────────────────────────────────────────────

const CONTAINER = 'enlite-postgres';
const DB_USER = 'enlite_admin';
const DB_NAME = 'enlite_e2e';

function runSQL(sql: string): string {
  const escaped = sql.replace(/'/g, "'\\''");
  try {
    return execSync(
      `docker exec ${CONTAINER} psql -U ${DB_USER} -d ${DB_NAME} -c '${escaped}'`,
      { stdio: 'pipe' },
    ).toString();
  } catch (err: unknown) {
    const error = err as { stderr?: Buffer; message?: string };
    throw new Error(`DB error: ${error.stderr?.toString() ?? error.message}`);
  }
}

function setPatientCaseNumber(patientId: string, caseNumber: number): void {
  runSQL(`UPDATE patients SET case_number = ${caseNumber} WHERE id = '${patientId}'`);
}

// ── Mock interceptors ─────────────────────────────────────────────────────────

async function installInterceptors(page: Page): Promise<void> {
  await page.route('**/identitytoolkit.googleapis.com/**', async (route: Route) => {
    const url = route.request().url();
    if (url.includes('signInWithPassword') || url.includes('signUp')) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          kind: 'identitytoolkit#VerifyPasswordResponse',
          localId: MOCK_ADMIN_USER.uid,
          email: MOCK_ADMIN_USER.email,
          idToken: FAKE_ID_TOKEN,
          refreshToken: 'fake-refresh-token',
          expiresIn: '3600',
          registered: true,
        }),
      });
      return;
    }
    if (url.includes('token') || url.includes('securetoken')) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          access_token: FAKE_ID_TOKEN,
          expires_in: '3600',
          token_type: 'Bearer',
          refresh_token: 'fake-refresh-token',
          id_token: FAKE_ID_TOKEN,
          user_id: MOCK_ADMIN_USER.uid,
        }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        users: [
          {
            localId: MOCK_ADMIN_USER.uid,
            email: MOCK_ADMIN_USER.email,
            emailVerified: true,
          },
        ],
      }),
    });
  });

  await page.route('**/securetoken.googleapis.com/**', async (route: Route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        access_token: FAKE_ID_TOKEN,
        expires_in: '3600',
        token_type: 'Bearer',
        refresh_token: 'fake-refresh-token',
        id_token: FAKE_ID_TOKEN,
      }),
    });
  });

  await page.route('**/api/**', async (route: Route) => {
    const url = route.request().url();

    if (url.includes('/api/admin/auth/profile')) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          data: {
            id: MOCK_ADMIN_USER.uid,
            email: MOCK_ADMIN_USER.email,
            role: 'superadmin',
            firstName: 'EditRouting',
            lastName: 'Admin',
            isActive: true,
            mustChangePassword: false,
          },
        }),
      });
      return;
    }

    if (url.includes('/publish-talentum')) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: {} }),
      });
      return;
    }

    const headers = {
      ...route.request().headers(),
      authorization: `Bearer ${MOCK_TOKEN}`,
    };
    await route.continue({ headers });
  });
}

async function loginAsAdmin(page: Page): Promise<void> {
  await installInterceptors(page);
  await page.goto('/admin/login');
  await page.locator('input[type="email"]').fill(MOCK_ADMIN_USER.email);
  await page.locator('input[type="password"]').fill('TestAdmin123!');
  await page.getByRole('button', { name: /Iniciar sesión/i }).click();
  await expect(page).not.toHaveURL(/.*login.*/, { timeout: 20_000 });
}

// ── Test Suite ────────────────────────────────────────────────────────────────

test.describe('AdminVacanciesPage — edit routing por is_draft @integration', () => {
  test.setTimeout(120_000);

  let patientId = '';
  let addressId = '';
  let draftVacancyId = '';
  let nonDraftVacancyId = '';
  let caseNumber = 0;

  test.beforeAll(() => {
    caseNumber = 980_000 + Math.floor(Math.random() * 9999);
    const patient = insertTestPatient({
      status: 'ACTIVE',
      firstName: 'EditRouting',
      lastName: `Patient${Date.now()}`,
      diagnosis: 'TEA leve',
      dependencyLevel: 'SEVERE',
      withAddress: true,
      addressLat: -34.6037,
      addressLng: -58.3816,
    });
    patientId = patient.patientId;
    addressId = patient.addressId ?? '';
    setPatientCaseNumber(patientId, caseNumber);

    // Vaga rascunho (is_draft = true) — modal grande deve abrir
    draftVacancyId = insertBaseVacancy({
      patientId,
      patientAddressId: addressId,
      caseNumber,
      status: 'PENDING_ACTIVATION',
      isDraft: true,
    });

    // Vaga publicada non-draft em SEARCHING_REPLACEMENT — deve redirecionar para o detalhe
    nonDraftVacancyId = insertBaseVacancy({
      patientId,
      patientAddressId: addressId,
      caseNumber,
      status: 'SEARCHING_REPLACEMENT',
      isDraft: false,
    });

    // Garante meet_link e schedule pra o detalhe não estourar
    runSQL(`
      UPDATE job_postings
      SET meet_link_1 = 'https://meet.google.com/abc-defg-hij',
          schedule = '[{"dayOfWeek": 5, "startTime": "16:30", "endTime": "18:30"}]'::jsonb
      WHERE id = '${nonDraftVacancyId}'
    `);

    // Mesma hidratação para a draft — o cenário 4 abre o modal grande e submete,
    // e o schema Zod exige schedule + meet_link válidos. Sem isso, o submit nem
    // chega ao PUT (validation barra antes) e a defesa do 403 não é exercitada.
    runSQL(`
      UPDATE job_postings
      SET meet_link_1 = 'https://meet.google.com/abc-defg-hij',
          schedule = '[{"dayOfWeek": 1, "startTime": "09:00", "endTime": "17:00"}]'::jsonb,
          providers_needed = 1
      WHERE id = '${draftVacancyId}'
    `);
  });

  test.afterAll(() => {
    cleanupVacancies([draftVacancyId, nonDraftVacancyId]);
    cleanupTestPatient(patientId);
  });

  // ── Cenário 1: non-draft → lápis navega pro detalhe, NÃO abre modal grande ───

  test('1. lápis em vaga non-draft (SEARCHING_REPLACEMENT) → navega pro detalhe, NÃO abre modal grande', async ({ page }) => {
    test.skip(!nonDraftVacancyId, 'Could not seed non-draft vacancy');

    await loginAsAdmin(page);
    await page.goto('/admin/vacancies');

    // Aguarda a tabela carregar
    const editBtn = page.getByTestId(`edit-vacancy-${nonDraftVacancyId}`);
    await expect(editBtn).toBeVisible({ timeout: 20_000 });

    // Clica no lápis
    await editBtn.click();

    // ── Deve navegar pra /admin/vacancies/{id} ───────────────────────────────
    await expect(page).toHaveURL(
      new RegExp(`/admin/vacancies/${nonDraftVacancyId}(?!/edit)`),
      { timeout: 10_000 },
    );

    // ── Modal grande NÃO deve estar visível ─────────────────────────────────
    const bigModal = page.getByTestId('vacancy-modal');
    await expect(bigModal).not.toBeVisible();

    // ── Screenshot do detalhe (regressão visual) ────────────────────────────
    await expect(page).toHaveScreenshot('non-draft-redirected-to-detail.png', {
      fullPage: false,
      maxDiffPixels: 10_000,
    });
  });

  // ── Cenário 2: draft → lápis abre modal grande ───────────────────────────

  test('2. lápis em vaga draft (PENDING_ACTIVATION, is_draft=true) → abre modal grande', async ({ page }) => {
    test.skip(!draftVacancyId, 'Could not seed draft vacancy');

    await loginAsAdmin(page);
    await page.goto('/admin/vacancies');

    const editBtn = page.getByTestId(`edit-vacancy-${draftVacancyId}`);
    await expect(editBtn).toBeVisible({ timeout: 20_000 });

    await editBtn.click();

    // ── Modal grande DEVE abrir ──────────────────────────────────────────────
    const bigModal = page.getByTestId('vacancy-modal');
    await expect(bigModal).toBeVisible({ timeout: 10_000 });

    // ── NÃO deve ter navegado pra fora da listagem ──────────────────────────
    await expect(page).toHaveURL(/\/admin\/vacancies(?:\?|$)/);
  });

  // ── Cenário 3: salvar schedule em non-draft via detalhe NÃO retorna 403 ──

  test('3. salvar schedule no detalhe de vaga non-draft NÃO retorna 403 — endpoint aceita { schedule }', async ({ page }) => {
    test.skip(!nonDraftVacancyId, 'Could not seed non-draft vacancy');

    await loginAsAdmin(page);
    await page.goto(`/admin/vacancies/${nonDraftVacancyId}`);

    // Aguarda a página de detalhe carregar
    await expect(page.getByText(/Días y Horarios|Días y horarios|Horarios/i).first())
      .toBeVisible({ timeout: 20_000 });

    // Procura o lápis ao lado de "Días y Horarios" e abre o VacancyScheduleEditModal
    const scheduleEditTrigger = page.getByTestId('vacancy-edit-schedule-trigger');
    await expect(scheduleEditTrigger).toBeVisible({ timeout: 10_000 });
    await scheduleEditTrigger.click();

    const scheduleModal = page.getByTestId('vacancy-schedule-modal');
    await expect(scheduleModal).toBeVisible({ timeout: 10_000 });

    // Clica em "Guardar" — escuta a resposta do PUT pra confirmar status 200
    const putResponse = page.waitForResponse(
      (res) =>
        res.url().includes(`/api/admin/vacancies/${nonDraftVacancyId}`) &&
        res.request().method() === 'PUT',
      { timeout: 15_000 },
    );

    await page.getByTestId('vacancy-schedule-save').click();
    const res = await putResponse;

    // ── Status DEVE ser 200, NÃO 403 ─────────────────────────────────────────
    expect(res.status()).toBe(200);
  });

  // Nota: a defesa do 403 no submit (VacancyFormSection.onSubmit interceptando
  // "Forbidden fields" e redirecionando para o detalhe) é coberta por unit test
  // em VacancyFormSection.defense.test.tsx — mockar updateVacancy pra retornar
  // 403 sem precisar passar pelo schema Zod do form completo é mais reliable.
});

// ── Backend connectivity ─────────────────────────────────────────────────────

test.describe('Backend health (edit-routing) @integration', () => {
  test.setTimeout(10_000);

  test('backend health endpoint returns OK', async ({ request }) => {
    const res = await request.get('http://localhost:8080/health');
    expect(res.ok()).toBe(true);
    const body = await res.json();
    expect(body.status).toBe('healthy');
  });
});
