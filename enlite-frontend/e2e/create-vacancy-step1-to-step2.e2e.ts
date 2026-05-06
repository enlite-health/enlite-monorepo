/**
 * create-vacancy-step1-to-step2.e2e.ts — Playwright E2E
 *
 * Cobre o fluxo COMPLETO de criação de vaga:
 *   Step 1 (CreateVacancyPage) → Step 2 (TalentumConfigPage) → Step 3 (Detalhe)
 *
 * Cenários:
 *   - Seleção de caso → hidratação de paciente + endereço
 *   - Form preenchido com link Meet sem `https://` — onBlur normaliza e busca
 *     a data/hora via `meet-links/lookup` (wrapper de `resolveDateTime`)
 *   - Click Guardar → cria vaga, salva meet links, gera IA mockado → /talentum
 *   - Step 2 carregado com description + perguntas + FAQs vindos do mock
 *   - Click Publicar → auto-save prescreening → publish (mockado) → detalhe
 *
 * Mocks (TODAS as APIs externas):
 *   - `/generate-ai-content` → fixture (NÃO chama Gemini real, evita custo)
 *   - `/publish-talentum` → success (NÃO publica vaga real no Talentum)
 *   - `/prescreening-config` POST/GET → success
 *   - `/meet-links/lookup` → datetime fixo (NÃO chama Google Calendar real)
 *   - `/vacancies` POST/GET → fixture (NÃO escreve no banco)
 *
 * Auth: Firebase Emulator (mesmo padrão de create-vacancy.e2e.ts).
 */
import { test, expect, type Page, type Route } from '@playwright/test';

const FIREBASE_EMULATOR = 'http://127.0.0.1:9099';
const FIREBASE_API_KEY = 'test-api-key';

// ── Fixtures ───────────────────────────────────────────────────────────────────

const CASE_OPTION = {
  caseNumber: 42,
  patientId: 'pat-step12-1',
  dependencyLevel: 'SEVERE',
};

const PATIENT_DETAIL = {
  id: CASE_OPTION.patientId,
  firstName: 'María',
  lastName: 'Gómez',
  documentNumber: '30111222',
  status: 'ACTIVE',
  diagnosis: 'TEA leve',
  dependencyLevel: 'SEVERE',
  serviceType: ['AT'],
  cityLocality: 'CABA',
  province: 'Buenos Aires',
  lastCaseNumber: CASE_OPTION.caseNumber,
  responsibles: [],
};

const PATIENT_ADDRESS = {
  id: 'addr-step12-1',
  patient_id: CASE_OPTION.patientId,
  address_formatted: 'Av. Corrientes 1234, CABA, Buenos Aires, Argentina',
  address_raw: 'Av. Corrientes 1234',
  address_type: 'service',
  display_order: 1,
  source: 'manual',
  complement: 'Piso 3, Depto B',
  lat: -34.6037,
  lng: -58.3816,
  isPrimary: true,
};

const CREATED_VACANCY_ID = 'vac-step12-new';
const CREATED_VACANCY = {
  id: CREATED_VACANCY_ID,
  title: 'CASO 42-1',
  status: 'PENDING_ACTIVATION',
};

const AI_CONTENT_FIXTURE = {
  description:
    'Descripción de la Propuesta:\n' +
    'Se requiere un Acompañante Terapéutico para acompañar a paciente con ' +
    'TEA leve en CABA, lunes de 09:00 a 17:00 hs.\n\n' +
    'Perfil Profesional Sugerido:\n' +
    'Buscamos un profesional con certificación en Acompañamiento Terapéutico, ' +
    'con experiencia en TEA y disponibilidad para el turno indicado.',
  prescreening: {
    questions: [
      {
        question: '¿Tenés experiencia trabajando con pacientes con TEA?',
        responseType: ['YES_NO'],
        desiredResponse: 'YES',
        weight: 3,
        required: true,
        analyzed: true,
        earlyStoppage: false,
      },
      {
        question: '¿Disponés de CUD vigente?',
        responseType: ['YES_NO'],
        desiredResponse: 'YES',
        weight: 2,
        required: false,
        analyzed: true,
        earlyStoppage: false,
      },
    ],
    faq: [
      {
        question: '¿Cuál es la modalidad de contratación?',
        answer: 'Contratación bajo modalidad MEI con liquidación mensual.',
      },
    ],
  },
};

// ── Auth helper ─────────────────────────────────────────────────────────────────

async function loginAsAdmin(page: Page): Promise<void> {
  const email = `e2e.step12.${Date.now()}@test.com`;
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

// ── Counters captured by mocks ─────────────────────────────────────────────────

interface FlowCounters {
  meetLookupCalls: { link: string }[];
  vacancyCreated: { calls: number; lastBody: unknown };
  meetLinksPersisted: { calls: number; lastBody: unknown };
  prescreeningSaved: { calls: number; lastBody: unknown };
  publishCalled: { calls: number };
}

function newCounters(): FlowCounters {
  return {
    meetLookupCalls: [],
    vacancyCreated: { calls: 0, lastBody: null },
    meetLinksPersisted: { calls: 0, lastBody: null },
    prescreeningSaved: { calls: 0, lastBody: null },
    publishCalled: { calls: 0 },
  };
}

// ── Mock installer ─────────────────────────────────────────────────────────────

function installApiMocks(page: Page, c: FlowCounters): void {
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

  // GET /patients/:id  + addresses
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

  // POST /vacancies/meet-links/lookup — onBlur (mocked: no Google Calendar call)
  page.route('**/api/admin/vacancies/meet-links/lookup', (route: Route) => {
    const body = route.request().postDataJSON() as { link: string };
    c.meetLookupCalls.push({ link: body.link });
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        data: {
          normalized: body.link.startsWith('http') ? body.link : `https://${body.link}`,
          datetime: '2026-05-10T15:00:00-03:00',
        },
      }),
    });
  });

  // POST /vacancies (create)
  page.route('**/api/admin/vacancies', (route: Route) => {
    if (route.request().method() === 'POST') {
      c.vacancyCreated.calls++;
      c.vacancyCreated.lastBody = route.request().postDataJSON();
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: CREATED_VACANCY }),
      });
    } else {
      route.continue();
    }
  });

  // PUT /vacancies/:id/meet-links — persist after create
  page.route(`**/api/admin/vacancies/${CREATED_VACANCY_ID}/meet-links`, (route: Route) => {
    if (route.request().method() === 'PUT') {
      c.meetLinksPersisted.calls++;
      c.meetLinksPersisted.lastBody = route.request().postDataJSON();
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          data: {
            meet_link_1: 'https://meet.google.com/abc-defg-hij',
            meet_datetime_1: '2026-05-10T15:00:00-03:00',
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

  // POST /vacancies/:id/generate-ai-content — MOCKED (no real Gemini call)
  page.route(
    `**/api/admin/vacancies/${CREATED_VACANCY_ID}/generate-ai-content`,
    (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: AI_CONTENT_FIXTURE }),
      }),
  );

  // POST /vacancies/:id/prescreening-config — auto-save before publish
  // GET /vacancies/:id/prescreening-config — initial load (returns empty,
  // page hydrates from location.state seeded by Step 1).
  page.route(
    `**/api/admin/vacancies/${CREATED_VACANCY_ID}/prescreening-config`,
    (route: Route) => {
      const method = route.request().method();
      if (method === 'POST') {
        c.prescreeningSaved.calls++;
        c.prescreeningSaved.lastBody = route.request().postDataJSON();
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            success: true,
            data: route.request().postDataJSON(),
          }),
        });
      } else {
        // GET
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            success: true,
            data: { questions: [], faq: [] },
          }),
        });
      }
    },
  );

  // POST /vacancies/:id/publish-talentum — MOCKED (no real Talentum publish)
  page.route(
    `**/api/admin/vacancies/${CREATED_VACANCY_ID}/publish-talentum`,
    (route) => {
      c.publishCalled.calls++;
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          data: {
            projectId: 'fake-talentum-project-id',
            publicId: '00000000-0000-0000-0000-000000000000',
            slug: 'e2e-test-vacancy',
            whatsappUrl: 'https://wa.me/fake',
          },
        }),
      });
    },
  );

  // GET /vacancies/:id  — both Step 2 (summary) and Step 3 (detail) read it
  page.route(`**/api/admin/vacancies/${CREATED_VACANCY_ID}`, (route: Route) => {
    if (route.request().method() === 'GET') {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          data: {
            ...CREATED_VACANCY,
            caseNumber: CASE_OPTION.caseNumber,
            vacancyNumber: 1,
            patient_first_name: PATIENT_DETAIL.firstName,
            patient_last_name: PATIENT_DETAIL.lastName,
          },
        }),
      });
    } else {
      route.continue();
    }
  });

  // GET /vacancies/:id/social-links-stats (used by VacancySocialLinksCard)
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

  // GET /vacancies/:id/match-results, /funnel — defensive empty mocks for Step 3
  page.route(
    `**/api/admin/vacancies/${CREATED_VACANCY_ID}/match-results*`,
    (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: { results: [], total: 0 } }),
      }),
  );
  page.route(
    `**/api/admin/vacancies/${CREATED_VACANCY_ID}/funnel`,
    (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: { stages: [] } }),
      }),
  );
}

// ── Test ───────────────────────────────────────────────────────────────────────

test.describe('CreateVacancy — full flow Step 1 → Step 2 → Step 3', () => {
  test('creates vacancy, populates Talentum (mocked AI), publishes (mocked) and lands on detail', async ({
    page,
  }) => {
    const c = newCounters();

    await loginAsAdmin(page);
    installApiMocks(page, c);

    // ── STEP 1: form preenchimento ────────────────────────────────────────
    await page.goto('/admin/vacancies/new');
    await expect(page.getByText('Nueva Vacante')).toBeVisible({ timeout: 15_000 });

    await page
      .locator('[data-testid="case-select"]')
      .selectOption(String(CASE_OPTION.caseNumber));

    await expect(
      page.getByText('Av. Corrientes 1234, CABA, Buenos Aires, Argentina'),
    ).toBeVisible({ timeout: 8_000 });
    await page
      .locator(`[data-testid="address-option-${PATIENT_ADDRESS.id}"]`)
      .click();

    await page.locator('[data-testid="profession-select"]').selectOption('AT');

    // Schedule — VacancyDaySchedulePicker has a "+" button per day card that
    // adds a 09:00–17:00 slot. We click the first add-slot button.
    const addSlotBtn = page
      .locator('button[aria-label*="orario"], button[aria-label*="lots"]')
      .first();
    await addSlotBtn.click();

    // Meet link without https — onBlur normalizes + lookup
    const meetInput = page.locator('[data-testid="meet-link-0"]');
    await meetInput.fill('meet.google.com/abc-defg-hij');
    await meetInput.blur();

    await expect
      .poll(() => c.meetLookupCalls.length, { timeout: 5_000 })
      .toBeGreaterThanOrEqual(1);
    expect(c.meetLookupCalls[0].link).toBe('https://meet.google.com/abc-defg-hij');
    await expect(meetInput).toHaveValue('https://meet.google.com/abc-defg-hij');
    await expect(
      page.locator('[data-testid="meet-link-0-datetime"]'),
    ).toBeVisible({ timeout: 3_000 });

    // ── STEP 1 → 2: Click Guardar ─────────────────────────────────────────
    await page.getByTestId('create-vacancy-save-btn').click();

    await expect(page).toHaveURL(
      new RegExp(`/admin/vacancies/${CREATED_VACANCY_ID}/talentum`),
      { timeout: 20_000 },
    );

    // Stepper marks Step 2 active
    await expect(
      page.locator('ol[aria-label="Progress"] li[aria-current="step"]'),
    ).toContainText(/Configuración Talentum/i);

    // Vacancy create + meet links persistence both happened
    expect(c.vacancyCreated.calls).toBe(1);
    expect(c.meetLinksPersisted.calls).toBe(1);

    // ── STEP 2: AI content (mocked) populated ─────────────────────────────
    // Description textarea has the canonical headers we control via service.
    const descTextarea = page.locator('textarea').first();
    await expect(descTextarea).toHaveValue(/Descripción de la Propuesta:/);
    await expect(descTextarea).toHaveValue(/Perfil Profesional Sugerido:/);

    // Both prescreening question texts are visible
    const allTextValues = await page
      .locator('textarea')
      .evaluateAll((els) => els.map((el) => (el as HTMLTextAreaElement).value));
    expect(
      allTextValues.some((v) => v.includes('experiencia') || v.includes('TEA')),
    ).toBe(true);
    expect(allTextValues.some((v) => v.includes('CUD'))).toBe(true);

    // FAQ visible
    expect(
      allTextValues.some((v) => v.includes('modalidad de contratación')),
    ).toBe(true);

    // Visual snapshot anchor for Step 2
    await expect(page).toHaveScreenshot('create-vacancy-step2-talentum.png', {
      fullPage: false,
      maxDiffPixelRatio: 0.05,
    });

    // ── STEP 2 → 3: Click Publicar en Talentum ────────────────────────────
    await page.getByRole('button', { name: /publicar en talentum/i }).click();

    // Should navigate to /admin/vacancies/:id (no /talentum suffix)
    await expect(page).toHaveURL(
      new RegExp(`/admin/vacancies/${CREATED_VACANCY_ID}$`),
      { timeout: 20_000 },
    );

    // Auto-save of prescreening + publish both happened — both mocked, no
    // real Talentum project created and no Gemini call.
    expect(c.prescreeningSaved.calls).toBeGreaterThanOrEqual(1);
    expect(c.publishCalled.calls).toBe(1);

    // The auto-saved body must include the AI-generated questions/FAQ
    const savedBody = c.prescreeningSaved.lastBody as {
      questions?: unknown[];
      faq?: unknown[];
    };
    expect(savedBody?.questions?.length).toBe(2);
    expect(savedBody?.faq?.length).toBe(1);
  });
});
