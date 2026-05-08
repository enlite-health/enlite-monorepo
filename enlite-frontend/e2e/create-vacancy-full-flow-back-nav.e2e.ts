/**
 * create-vacancy-full-flow-back-nav.e2e.ts — Playwright E2E
 *
 * Cobre o flow completo end-to-end exigido pelo regression:
 *   Step 1 (criar) → Step 2 (Talentum) → Volver → Step 1 (edit) hidratado
 *
 * Cenário:
 *   1. Login admin via Firebase Emulator
 *   2. Step 1 (/admin/vacancies/new): preenche caso, profissão, schedule
 *      e meet link → clica Continuar
 *   3. Backend mockado cria vaga + persiste meet links + AI content
 *   4. Lands on /admin/vacancies/:id/talentum (Step 2)
 *   5. Clica Volver no header → /admin/vacancies/:id/edit (Step 1 em edit)
 *   6. REGRESSION: confirma que o form hidrata com todos os dados da vaga
 *      criada e que o botão Continuar fica HABILITADO sem o usuário ter
 *      que mexer em nada.
 *   7. Screenshot anchor pós-back-nav.
 *
 * Mocks (sem rede externa — Gemini, Talentum, Google Calendar):
 *   - Tudo que /create-vacancy-step1-to-step2.e2e.ts mocka, mais:
 *   - GET /vacancies/:id retorna payload FULL pra hidratação do form (não
 *     só os campos que o Step 2 usa).
 *
 * Auth: Firebase Emulator (a setup local tá em
 * docker-compose.test.yml). Não usa Firebase de produção — é um teste de
 * regression visual, não de integração end-to-end com Talentum real.
 */
import { test, expect, type Page, type Route } from '@playwright/test';

const FIREBASE_EMULATOR = 'http://127.0.0.1:9099';
const FIREBASE_API_KEY = 'test-api-key';

// ── Fixtures (id distinto pra não colidir com create-vacancy-step1-to-step2) ──

const CASE_OPTION = {
  caseNumber: 88,
  patientId: 'pat-fullflow-1',
  dependencyLevel: 'SEVERE',
};

const PATIENT_DETAIL = {
  id: CASE_OPTION.patientId,
  firstName: 'Lucía',
  lastName: 'Pereyra',
  documentNumber: '30222111',
  status: 'ACTIVE',
  diagnosis: 'TEA moderado',
  dependencyLevel: 'SEVERE',
  serviceType: ['AT'],
  cityLocality: 'Vicente López',
  province: 'Buenos Aires',
  lastCaseNumber: CASE_OPTION.caseNumber,
  responsibles: [],
};

const PATIENT_ADDRESS = {
  id: 'addr-fullflow-1',
  patient_id: CASE_OPTION.patientId,
  address_formatted: 'Av. Maipú 2500, Olivos, Buenos Aires, Argentina',
  address_raw: 'Av. Maipú 2500',
  address_type: 'service',
  display_order: 1,
  source: 'manual',
  complement: null,
  lat: -34.5085,
  lng: -58.4801,
};

const CREATED_VACANCY_ID = 'vac-fullflow-new';
const MEET_LINK = 'https://meet.google.com/xyz-abcd-pqr';

// Payload FULL retornado pelo GET /vacancies/:id em Step 1 edit mode.
// Importante: contém todos os campos que o `reset(...)` do RHF lê em
// VacancyFormSection, pra simular fielmente o comportamento do backend
// após criar a vaga.
const FULL_VACANCY = {
  id: CREATED_VACANCY_ID,
  case_number: CASE_OPTION.caseNumber,
  vacancy_number: 1,
  patient_id: CASE_OPTION.patientId,
  patient_address_id: PATIENT_ADDRESS.id,
  title: `CASO ${CASE_OPTION.caseNumber}-1`,
  status: 'SEARCHING',
  required_professions: ['AT'],
  required_sex: '',
  age_range_min: null,
  age_range_max: null,
  required_experience: '',
  worker_attributes: '',
  providers_needed: 1,
  work_schedule: '',
  schedule: [{ dayOfWeek: 1, startTime: '09:00', endTime: '17:00' }],
  salary_text: '',
  payment_day: '',
  daily_obs: '',
  published_at: null,
  closes_at: null,
  meet_link_1: MEET_LINK,
  meet_link_2: null,
  meet_link_3: null,
  meet_datetime_1: '2026-05-12T15:00:00-03:00',
  meet_datetime_2: null,
  meet_datetime_3: null,
  patient_first_name: PATIENT_DETAIL.firstName,
  patient_last_name: PATIENT_DETAIL.lastName,
  caseNumber: CASE_OPTION.caseNumber,
  vacancyNumber: 1,
};

const AI_CONTENT_FIXTURE = {
  description:
    'Descripción de la Propuesta:\nAcompañamiento Terapéutico para paciente con TEA moderado en Vicente López.\n\nPerfil Profesional Sugerido:\nProfesional con experiencia en TEA.',
  prescreening: {
    questions: [
      {
        question: '¿Tenés experiencia con TEA?',
        responseType: ['YES_NO'],
        desiredResponse: 'YES',
        weight: 3,
        required: true,
        analyzed: true,
        earlyStoppage: false,
      },
    ],
    faq: [{ question: '¿Modalidad?', answer: 'MEI mensual' }],
  },
};

// ── Auth helper ─────────────────────────────────────────────────────────────────

async function loginAsAdmin(page: Page): Promise<void> {
  const email = `e2e.fullflow.${Date.now()}@test.com`;
  const password = 'TestAdmin123!';
  const signUpRes = await fetch(
    `${FIREBASE_EMULATOR}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=${FIREBASE_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, returnSecureToken: true }),
    },
  );
  const { localId: uid } = (await signUpRes.json()) as { localId: string };

  await page.route('**/api/admin/auth/profile', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        data: {
          id: uid,
          email,
          role: 'superadmin',
          firstName: 'Admin',
          lastName: 'E2E',
          isActive: true,
          mustChangePassword: false,
        },
      }),
    }),
  );

  await page.goto('/admin/login');
  await page.locator('input[type="email"]').fill(email);
  await page.locator('input[type="password"]').fill(password);
  await page.getByRole('button', { name: /Iniciar sesión/i }).click();
  await expect(page).not.toHaveURL(/.*login.*/, { timeout: 20_000 });
}

// ── Mocks ───────────────────────────────────────────────────────────────────────

function installMocks(page: Page): void {
  // GET /vacancies/cases-for-select
  page.route('**/api/admin/vacancies/cases-for-select', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, data: [CASE_OPTION] }),
    }),
  );

  // GET /vacancies/next-vacancy-number
  page.route('**/api/admin/vacancies/next-vacancy-number', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, data: { nextVacancyNumber: 1 } }),
    }),
  );

  // GET /patients/:id + addresses
  page.route(`**/api/admin/patients/${CASE_OPTION.patientId}`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, data: PATIENT_DETAIL }),
    }),
  );
  page.route(`**/api/admin/patients/${CASE_OPTION.patientId}/addresses`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, data: [PATIENT_ADDRESS] }),
    }),
  );

  // POST /vacancies/meet-links/lookup — onBlur normaliza
  page.route('**/api/admin/vacancies/meet-links/lookup', (route: Route) => {
    const body = route.request().postDataJSON() as { link: string };
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        data: {
          normalized: body.link.startsWith('http') ? body.link : `https://${body.link}`,
          datetime: '2026-05-12T15:00:00-03:00',
        },
      }),
    });
  });

  // POST /vacancies (create) — retorna a vaga criada
  page.route('**/api/admin/vacancies', (route: Route) => {
    if (route.request().method() === 'POST') {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          data: { id: CREATED_VACANCY_ID, title: FULL_VACANCY.title, status: 'PENDING_ACTIVATION' },
        }),
      });
    } else {
      route.continue();
    }
  });

  // PUT /vacancies/:id/meet-links
  page.route(`**/api/admin/vacancies/${CREATED_VACANCY_ID}/meet-links`, (route: Route) => {
    if (route.request().method() === 'PUT') {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          data: {
            meet_link_1: MEET_LINK,
            meet_datetime_1: '2026-05-12T15:00:00-03:00',
            meet_link_2: null,
            meet_datetime_2: null,
            meet_link_3: null,
            meet_datetime_3: null,
          },
        }),
      });
    } else {
      route.continue();
    }
  });

  // POST /vacancies/:id/generate-ai-content (mockado — sem Gemini)
  page.route(
    `**/api/admin/vacancies/${CREATED_VACANCY_ID}/generate-ai-content`,
    (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: AI_CONTENT_FIXTURE }),
      }),
  );

  // GET / POST /vacancies/:id/prescreening-config (Step 2)
  page.route(
    `**/api/admin/vacancies/${CREATED_VACANCY_ID}/prescreening-config`,
    (route: Route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          data:
            route.request().method() === 'GET'
              ? { questions: [], faq: [] }
              : route.request().postDataJSON(),
        }),
      }),
  );

  // GET /vacancies/:id — usado pelo Step 2 (summary) E pelo Step 1 edit mode
  // (hidratação do form). Por isso retorna o payload FULL.
  page.route(`**/api/admin/vacancies/${CREATED_VACANCY_ID}`, (route: Route) => {
    if (route.request().method() === 'GET') {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: FULL_VACANCY }),
      });
    } else {
      route.continue();
    }
  });

  // GET /vacancies/:id/social-links-stats
  page.route(
    `**/api/admin/vacancies/${CREATED_VACANCY_ID}/social-links-stats`,
    (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          data: { perChannel: [], totalClicks: 0 },
        }),
      }),
  );
}

// ── Test ───────────────────────────────────────────────────────────────────────

test.describe('CreateVacancy — flow completo Step 1 → Step 2 → Voltar → Step 1', () => {
  test('criar vaga, voltar do Step 2 e ver Step 1 hidratado com Continuar habilitado', async ({
    page,
  }) => {
    await loginAsAdmin(page);
    installMocks(page);

    // ── STEP 1: criar vaga ──────────────────────────────────────────────────
    await page.goto('/admin/vacancies/new');
    await expect(page.getByText('Nueva Vacante')).toBeVisible({ timeout: 15_000 });

    // case-select é um SearchableSelect (custom dropdown). Clica no trigger
    // (button com aria-haspopup="listbox"), depois na option pelo nome.
    await page
      .locator('[data-testid="case-select"] button[aria-haspopup="listbox"]')
      .click();
    await page
      .getByRole('option', { name: new RegExp(`CASO\\s*${CASE_OPTION.caseNumber}`, 'i') })
      .click();

    // Endereço auto-selecionado (1 só endereço — comportamento desde o fix)
    await expect(
      page.locator(`[data-testid="address-option-${PATIENT_ADDRESS.id}"]`),
    ).toBeVisible({ timeout: 8_000 });

    // Tipo de profesional é um checkbox group com input sr-only — clicar
    // direto no input dá pointer-events intercept. Clica no label que envolve.
    await page.locator('label[for="profession-AT"]').click();

    // Schedule — 1 slot 09-17 segunda
    const addSlotBtn = page
      .locator('button[aria-label*="orario"], button[aria-label*="lots"]')
      .first();
    await addSlotBtn.click();

    // Meet link
    const meetInput = page.locator('[data-testid="meet-link-0"]');
    await meetInput.fill(MEET_LINK);
    await meetInput.blur();
    await expect(meetInput).toHaveValue(MEET_LINK);

    // Click Continuar — vai pro Step 2
    await page.getByTestId('create-vacancy-save-btn').click();
    await expect(page).toHaveURL(
      new RegExp(`/admin/vacancies/${CREATED_VACANCY_ID}/talentum`),
      { timeout: 20_000 },
    );

    // ── STEP 2: arrived ─────────────────────────────────────────────────────
    await expect(
      page.locator('ol[aria-label="Progress"] li[aria-current="step"]'),
    ).toContainText(/Configuración Talentum/i);

    // ── STEP 2 → STEP 1 edit: clica Volver no header ────────────────────────
    await page.getByRole('button', { name: /^Volver$/i }).click();
    await expect(page).toHaveURL(
      new RegExp(`/admin/vacancies/${CREATED_VACANCY_ID}/edit`),
      { timeout: 10_000 },
    );

    // ── STEP 1 EDIT: regression checks ──────────────────────────────────────
    // Stepper marca Step 1 ativo de novo
    await expect(
      page.locator('ol[aria-label="Progress"] li[aria-current="step"]'),
    ).toContainText(/Datos de la vacante/i);

    // Endereço linkado pré-selecionado (border-primary)
    const linkedBtn = page.locator(`[data-testid="address-option-${PATIENT_ADDRESS.id}"]`);
    await expect(linkedBtn).toBeVisible({ timeout: 8_000 });
    await expect(linkedBtn).toHaveClass(/border-primary/);

    // Meet link populado
    await expect(page.locator('[data-testid="meet-link-0"]')).toHaveValue(MEET_LINK);

    // Botão Continuar HABILITADO (regression — antes do fix ficava travado em
    // disabled porque o gate `formComplete` ficava preso em false durante a
    // hidratação assíncrona)
    const saveBtn = page.getByTestId('create-vacancy-save-btn');
    await expect(saveBtn).toBeEnabled({ timeout: 5_000 });

    // Visual snapshot — header com Continuar enabled + form hidratado
    await expect(page).toHaveScreenshot('create-vacancy-full-flow-back-nav-step1-edit.png', {
      fullPage: false,
      maxDiffPixelRatio: 0.05,
    });
  });
});
