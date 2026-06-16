/**
 * public-vacancy.e2e.ts
 *
 * Playwright E2E — Página pública de vaga (/vacantes/:id)
 *
 * Cenários cobertos:
 *   1. Exibe página com dados da vaga corretamente
 *   2. Exibe estado "vaga não encontrada" para ID inexistente
 *   3. Worker não autenticado clica "Postularse" → modal aparece
 *   4. Worker não autenticado clica "Registrarse" no modal → navega para /register
 *   5. Worker com cadastro incompleto clica "Postularse" → navega para /worker/profile
 *   6. Worker com cadastro completo clica "Postularse" → abre WhatsApp
 */

import { test, expect, Page } from '@playwright/test';

const FIREBASE_EMULATOR = 'http://127.0.0.1:9099';
const FIREBASE_API_KEY = 'test-api-key';
const FRONTEND_API_KEY = process.env.VITE_FIREBASE_API_KEY || 'TODO_FIREBASE_API_KEY';

// ── Fixtures de dados mockados ────────────────────────────────────────────────

const MOCK_VACANCY_ID = 'bbbbbbbb-0001-0001-0001-bbbbbbbbbbbb';

const MOCK_VACANCY = {
  id: MOCK_VACANCY_ID,
  case_number: 226,
  title: 'CASO 226 Acompañante Terapéutico',
  status: 'BUSQUEDA',
  dependency_level: 'Grau de Dependência',
  pathology_types: 'Patologias e transtornos neurológicos',
  required_professions: ['Acompañante Terapéutico'],
  required_sex: 'Mujer',
  age_range_min: 80,
  age_range_max: null,
  worker_attributes:
    'É solicitado uma AT mulher, com capacidade de auxiliar o senhor a reativar atividades cotidianas',
  schedule: {
    domingo: [
      { start: '11:00h', end: '13:00h' },
      { start: '21:00h', end: '08:00h' },
    ],
    lunes: [{ start: '11:00h', end: '13:00h' }],
    martes: [
      { start: '11:00h', end: '13:00h' },
      { start: '21:00h', end: '08:00h' },
    ],
    miercoles: [{ start: '21:00h', end: '08:00h' }],
  },
  schedule_days_hours: 'Dom-Qua variado',
  service_device_types: ['Domiciliar'],
  salary_text: 'A convenir',
  talentum_description:
    'Buscamos Acompanhantes Terapêuticos mulheres para acompanhar adultos com mais de 80 anos.',
  talentum_whatsapp_url: 'https://wa.me/5491112345678',
  patient_zone: 'Buenos Aires, Comuna 10',
  country: 'Argentina',
  created_at: '2026-04-01T00:00:00Z',
};

const MOCK_WORKER_INCOMPLETE = {
  id: 'worker-e2e-incomplete',
  authUid: 'uid-e2e-incomplete',
  email: 'incomplete@test.com',
  currentStep: 1,
  status: 'REGISTERED',
  registrationCompleted: false,
  country: 'AR',
  timezone: 'America/Argentina/Buenos_Aires',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

const MOCK_WORKER_COMPLETE = {
  id: 'worker-e2e-complete',
  authUid: 'uid-e2e-complete',
  email: 'complete@test.com',
  currentStep: 5,
  status: 'REGISTERED',
  registrationCompleted: true,
  country: 'AR',
  timezone: 'America/Argentina/Buenos_Aires',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

const MOCK_DOCS_INCOMPLETE = {
  id: 'docs-incomplete',
  workerId: 'worker-e2e-incomplete',
  resumeCvUrl: null,
  identityDocumentUrl: null,
  criminalRecordUrl: null,
  professionalRegistrationUrl: null,
  liabilityInsuranceUrl: null,
  documentsStatus: 'pending',
  submittedAt: null,
  updatedAt: new Date().toISOString(),
};

const MOCK_DOCS_COMPLETE = {
  id: 'docs-complete',
  workerId: 'worker-e2e-complete',
  resumeCvUrl: 'https://storage.googleapis.com/mock/resume.pdf',
  identityDocumentUrl: 'https://storage.googleapis.com/mock/identity.pdf',
  criminalRecordUrl: 'https://storage.googleapis.com/mock/criminal.pdf',
  professionalRegistrationUrl: 'https://storage.googleapis.com/mock/registration.pdf',
  liabilityInsuranceUrl: 'https://storage.googleapis.com/mock/insurance.pdf',
  documentsStatus: 'approved',
  submittedAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Mocks the public vacancy API endpoint with a successful response. */
async function mockVacancySuccess(page: Page): Promise<void> {
  await page.route(`**/api/vacancies/${MOCK_VACANCY_ID}`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, data: MOCK_VACANCY }),
    }),
  );
}

/** Mocks the public vacancy API endpoint with a 404 response. */
async function mockVacancyNotFound(page: Page): Promise<void> {
  await page.route('**/api/vacancies/nonexistent-id', (route) =>
    route.fulfill({
      status: 404,
      contentType: 'application/json',
      body: JSON.stringify({ success: false, error: 'Vacancy not found' }),
    }),
  );
}

/**
 * Mocks POST /api/worker-applications/track-channel.
 * Pass status=403 + code='WORKER_NOT_ELIGIBLE' para simular worker inelegível;
 * omita (padrão 200) para simular worker elegível.
 */
async function mockTrackChannel(
  page: Page,
  opts: { status?: number; code?: string } = {},
): Promise<void> {
  const { status = 200, code } = opts;
  await page.route('**/api/worker-applications/track-channel', (route) => {
    if (status === 200) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: null }),
      });
    }
    return route.fulfill({
      status,
      contentType: 'application/json',
      body: JSON.stringify({ success: false, error: 'Worker not eligible', code }),
    });
  });
}

/**
 * Creates a worker in the Firebase emulator and injects auth state into the
 * browser via addInitScript so that the Firebase SDK sees a logged-in session.
 */
async function createWorkerAndLogin(page: Page): Promise<void> {
  const email = `e2e.public.vacancy.${Date.now()}@test.com`;
  const password = 'TestWorker123!';

  const signUpRes = await fetch(
    `${FIREBASE_EMULATOR}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=${FIREBASE_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, returnSecureToken: true }),
    },
  );
  const signUpData = (await signUpRes.json()) as {
    localId?: string;
    idToken?: string;
    refreshToken?: string;
  };

  const { localId: uid, idToken, refreshToken } = signUpData;
  if (!uid || !idToken || !refreshToken) {
    throw new Error(`Firebase sign-up failed: ${JSON.stringify(signUpData)}`);
  }

  // Inject Firebase auth state into localStorage before first navigation so
  // the Firebase SDK picks it up as an authenticated session.
  await page.addInitScript(
    ({ uid: u, email: e, idToken: t, refreshToken: r, apiKey }) => {
      const authKey = `firebase:authUser:${apiKey}:[DEFAULT]`;
      const authValue = JSON.stringify({
        uid: u,
        email: e,
        emailVerified: false,
        isAnonymous: false,
        providerData: [
          {
            providerId: 'password',
            uid: e,
            displayName: null,
            email: e,
            phoneNumber: null,
            photoURL: null,
          },
        ],
        stsTokenManager: {
          refreshToken: r,
          accessToken: t,
          expirationTime: Date.now() + 3_600_000,
        },
        createdAt: String(Date.now()),
        lastLoginAt: String(Date.now()),
        apiKey,
        appName: '[DEFAULT]',
      });
      localStorage.setItem(authKey, authValue);
    },
    { uid, email, idToken, refreshToken, apiKey: FRONTEND_API_KEY },
  );
}

// ── Testes ────────────────────────────────────────────────────────────────────

test.describe('PublicVacancyPage', () => {
  test.setTimeout(60000);

  // ── Cenário 1: Exibe página com dados da vaga corretamente ──────────────────

  test('exibe página com dados da vaga corretamente', async ({ page }) => {
    await mockVacancySuccess(page);

    await page.goto(`/vacantes/${MOCK_VACANCY_ID}`);

    // Case number visível
    await expect(page.locator('text=CASO 226').first()).toBeVisible({ timeout: 15000 });

    // Status badge visível
    await expect(page.locator('text=Activo').first()).toBeVisible({ timeout: 5000 });

    // Título do card de detalhes com ocupação
    await expect(
      page.locator('text=Acompañantes Terapéuticos').first(),
    ).toBeVisible({ timeout: 5000 });

    // Botão Postularse visível
    await expect(
      page.getByRole('button', { name: /Postularse/i }),
    ).toBeVisible({ timeout: 5000 });

    // Seção de características visível
    await expect(page.locator('text=/Características/i').first()).toBeVisible({ timeout: 5000 });

    // Localização (patient_zone)
    await expect(
      page.locator('text=Buenos Aires, Comuna 10').first(),
    ).toBeVisible({ timeout: 5000 });

    // Seção de horários visível (schedule tem entradas)
    await expect(page.locator('text=/Días y Horarios/i').first()).toBeVisible({ timeout: 5000 });

    // Screenshot: estado carregado completo
    await expect(page).toHaveScreenshot('public-vacancy-loaded.png');
  });

  // ── Cenário 2: Vaga não encontrada ─────────────────────────────────────────

  test('exibe estado "vaga não encontrada" para ID inexistente', async ({ page }) => {
    await mockVacancyNotFound(page);

    await page.goto('/vacantes/nonexistent-id');

    // Mensagem de not found visível
    await expect(
      page.locator('text=/Vacante no encontrada/i').first(),
    ).toBeVisible({ timeout: 15000 });

    // Screenshot: estado de vaga não encontrada
    await expect(page).toHaveScreenshot('public-vacancy-not-found.png');
  });

  // ── Cenário 3: Worker não autenticado → modal aparece ──────────────────────

  test('worker não autenticado clica "Postularse" → modal aparece', async ({ page }) => {
    await mockVacancySuccess(page);

    // Navegar sem auth (não chamar createWorkerAndLogin)
    await page.goto(`/vacantes/${MOCK_VACANCY_ID}`);
    await expect(page.getByRole('button', { name: /Postularse/i })).toBeVisible({
      timeout: 15000,
    });

    // Clicar no botão
    await page.getByRole('button', { name: /Postularse/i }).click();

    // Modal de registro requerido deve aparecer
    await expect(
      page.locator('text=/Registro requerido/i').first(),
    ).toBeVisible({ timeout: 5000 });

    // Botão "Registrarse" visível no modal
    await expect(
      page.getByRole('button', { name: /Registrarse/i }),
    ).toBeVisible({ timeout: 5000 });

    // Screenshot: modal de não autenticado
    await expect(page).toHaveScreenshot('public-vacancy-unauthenticated-modal.png');
  });

  // ── Cenário 4: Clicar "Registrarse" no modal → navega para /register ────────

  test('worker não autenticado clica "Registrarse" no modal → navega para /register', async ({
    page,
  }) => {
    await mockVacancySuccess(page);

    await page.goto(`/vacantes/${MOCK_VACANCY_ID}`);
    await expect(page.getByRole('button', { name: /Postularse/i })).toBeVisible({
      timeout: 15000,
    });

    // Abrir modal
    await page.getByRole('button', { name: /Postularse/i }).click();
    await expect(page.locator('text=/Registro requerido/i').first()).toBeVisible({
      timeout: 5000,
    });

    // Clicar "Registrarse" no modal
    await page.getByRole('button', { name: /Registrarse/i }).click();

    // Deve navegar para /register
    await expect(page).toHaveURL(/\/register/, { timeout: 10000 });
  });

  // ── Cenário 5: Worker com cadastro incompleto → navega para /worker/profile ─

  test('worker com cadastro incompleto clica "Postularse" → navega para /worker/profile', async ({
    page,
  }) => {
    // Injetar auth antes da navegação
    await createWorkerAndLogin(page);
    await mockVacancySuccess(page);

    // track-channel: backend rejeita worker inelegível → hook exibe modal
    await mockTrackChannel(page, { status: 403, code: 'WORKER_NOT_ELIGIBLE' });

    // Mock /api/workers/me com registrationCompleted: false
    await page.route('**/api/workers/me', (route) => {
      // Ignorar chamadas de documento que passam por esta rota
      if (route.request().url().includes('/documents')) {
        return route.continue();
      }
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: MOCK_WORKER_INCOMPLETE }),
      });
    });

    // Mock /api/workers/me/documents com documentos incompletos
    await page.route('**/api/workers/me/documents', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: MOCK_DOCS_INCOMPLETE }),
      }),
    );

    // Mock profile para evitar redirect de admin auth
    await page.route('**/api/admin/auth/profile', (route) =>
      route.fulfill({ status: 401, body: JSON.stringify({ success: false, error: 'Unauthorized' }) }),
    );

    await page.goto(`/vacantes/${MOCK_VACANCY_ID}`);
    await expect(page.getByRole('button', { name: /Postularse/i })).toBeVisible({
      timeout: 15000,
    });

    // Clicar Postularse — deve redirecionar para /worker/profile
    await page.getByRole('button', { name: /Postularse/i }).click();

    await expect(page).toHaveURL(/\/worker\/profile/, { timeout: 10000 });
  });

  // ── Cenário 6: Worker com cadastro completo → abre WhatsApp ────────────────

  test('worker com cadastro completo clica "Postularse" → abre WhatsApp', async ({ page }) => {
    // Injetar auth antes da navegação
    await createWorkerAndLogin(page);
    await mockVacancySuccess(page);

    // track-channel: backend confirma elegibilidade → hook abre WhatsApp
    await mockTrackChannel(page);

    // Mock /api/workers/me com registrationCompleted: true
    await page.route('**/api/workers/me', (route) => {
      if (route.request().url().includes('/documents')) {
        return route.continue();
      }
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: MOCK_WORKER_COMPLETE }),
      });
    });

    // Mock /api/workers/me/documents com todos os 5 docs preenchidos
    await page.route('**/api/workers/me/documents', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: MOCK_DOCS_COMPLETE }),
      }),
    );

    // Mock profile para evitar redirect de admin auth
    await page.route('**/api/admin/auth/profile', (route) =>
      route.fulfill({ status: 401, body: JSON.stringify({ success: false, error: 'Unauthorized' }) }),
    );

    // Interceptar window.open para capturar a URL sem abrir nova aba
    await page.evaluate(() => {
      (window as any).__openedUrls = [];
      window.open = (url?: string | URL, ...args: any[]) => {
        (window as any).__openedUrls.push(String(url));
        return null;
      };
    });

    await page.goto(`/vacantes/${MOCK_VACANCY_ID}`);
    await expect(page.getByRole('button', { name: /Postularse/i })).toBeVisible({
      timeout: 15000,
    });

    // Re-injetar interceptor após navegação (page.goto reseta o contexto JS)
    await page.evaluate(() => {
      (window as any).__openedUrls = [];
      window.open = (url?: string | URL, ...args: any[]) => {
        (window as any).__openedUrls.push(String(url));
        return null;
      };
    });

    // Clicar Postularse
    await page.getByRole('button', { name: /Postularse/i }).click();

    // Aguardar o estado de loading finalizar
    await page.waitForTimeout(1500);

    // Verificar que window.open foi chamado com a URL do WhatsApp
    const openedUrls = await page.evaluate<string[]>(() => (window as any).__openedUrls ?? []);
    expect(openedUrls).toContain(MOCK_VACANCY.talentum_whatsapp_url);
  });
});
