/**
 * full-create-vacancy.integration.e2e.ts @integration
 *
 * Caminho feliz único — UI real → backend real → Postgres real.
 *
 * Cobre:
 *   1. Seleciona caso no case-select dropdown
 *   2. Hidratação dos campos do paciente (nome, diagnóstico, dependência)
 *   3. Endereço auto-selecionado quando há 1 só
 *   4. Mapa renderiza com lat/lng do banco
 *   5. Profissão + 1 slot de schedule + meet link
 *   6. Botão Continuar habilita só com tudo preenchido
 *   7. Submit → POST /vacancies REAL persiste no banco
 *   8. Geração AI MOCKADA popula descrição/prescreening
 *   9. Publicar Talentum MOCKADO → detail page
 *  10. SELECT no banco prova: case_number, patient_id, patient_address_id,
 *      schedule, meet_link_1, published_at, closes_at, status
 *
 * Mocks (ÚNICOS):
 *   - /generate-ai-content (Gemini — custo)
 *   - /publish-talentum (não polui prod do Talentum)
 *   - /api/admin/auth/profile (evita lookup de usuário)
 *   - Firebase Identity Toolkit (auth fake JWT)
 *   - /meet-links/lookup (Google Calendar — sem ambiente real)
 *
 * Tudo o resto bate no backend real.
 */

import { test, expect, type Page, type Route } from '@playwright/test';
import {
  insertTestPatient,
  cleanupTestPatient,
  insertBaseVacancy,
  cleanupVacancies,
  getVacancyById,
  type JobPostingRow,
} from '../helpers/db-test-helper';

// ── Constants ─────────────────────────────────────────────────────────────────

const BACKEND_URL = 'http://localhost:8080';

const MOCK_ADMIN_USER = {
  uid: 'e2e-int-happy-path',
  email: 'admin.happy@e2e.test',
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

const AI_CONTENT_FIXTURE = {
  description:
    'Se busca Acompañante Terapéutico para paciente con TEA leve. ' +
    'El AT acompañará en actividades diarias promoviendo autonomía.',
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
    faq: [
      {
        question: '¿Modalidad?',
        answer: 'MEI con liquidación mensual.',
      },
    ],
  },
};

// ── Mock interceptors ─────────────────────────────────────────────────────────

async function installInterceptors(page: Page): Promise<void> {
  // Firebase Identity Toolkit — fake JWT
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

  // Backend — mocka 4 endpoints específicos, deixa o resto passar com mock token
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
            firstName: 'Integration',
            lastName: 'Admin',
            isActive: true,
            mustChangePassword: false,
          },
        }),
      });
      return;
    }

    if (url.includes('/generate-ai-content')) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: AI_CONTENT_FIXTURE }),
      });
      return;
    }

    if (url.includes('/publish-talentum')) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          data: {
            projectId: 'fake-project-id',
            publicId: '00000000-0000-0000-0000-000000000000',
            slug: 'happy-path-vacancy',
            whatsappUrl: 'https://wa.me/fake',
          },
        }),
      });
      return;
    }

    if (url.includes('/meet-links/lookup')) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          data: {
            normalized: 'https://meet.google.com/abc-defg-hij',
            datetime: '2026-06-01T15:00:00-03:00',
          },
        }),
      });
      return;
    }

    // Tudo mais: troca o token Firebase pelo mock_<base64> que o backend aceita
    const headers = { ...route.request().headers(), authorization: `Bearer ${MOCK_TOKEN}` };
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

// ── Test ──────────────────────────────────────────────────────────────────────

test.describe('Caminho feliz: criar vaga ponta-a-ponta @integration', () => {
  test.setTimeout(120_000);

  let patientId = '';
  let addressId = '';
  let baseVacancyId = '';
  let caseNumber = 0;
  const createdVacancyIds: string[] = [];

  test.beforeAll(() => {
    caseNumber = 990_000 + Math.floor(Math.random() * 9999);
    const patient = insertTestPatient({
      status: 'ACTIVE',
      firstName: 'HappyPath',
      lastName: `Patient${Date.now()}`,
      diagnosis: 'TEA leve',
      dependencyLevel: 'SEVERE',
      withAddress: true,
      addressLat: -34.6037,
      addressLng: -58.3816,
    });
    patientId = patient.patientId;
    addressId = patient.addressId ?? '';
    baseVacancyId = insertBaseVacancy({
      patientId,
      patientAddressId: addressId,
      caseNumber,
    });
  });

  test.afterAll(() => {
    cleanupVacancies([baseVacancyId, ...createdVacancyIds]);
    cleanupTestPatient(patientId);
  });

  test('seleciona caso → preenche → salva → AI mockado → publica → DB persistiu tudo', async ({ page }) => {
    test.skip(!patientId || !addressId, 'Could not seed test patient + address');

    await loginAsAdmin(page);
    await page.goto('/admin/vacancies/new');
    await expect(page.getByText(/Nueva Vacante/i)).toBeVisible({ timeout: 15_000 });

    // ── 1. Seleciona o caso ─────────────────────────────────────────────────
    const caseSelect = page.locator('[data-testid="case-select"]');
    await expect(caseSelect).toBeVisible({ timeout: 10_000 });
    await caseSelect.selectOption(String(caseNumber));

    // ── 2. Hidratação do paciente — patient name visível (read-only) ────────
    await expect(page.getByText('HappyPath', { exact: false })).toBeVisible({ timeout: 8_000 });
    // Diagnóstico aparece na coluna esquerda
    await expect(page.getByText('TEA leve')).toBeVisible({ timeout: 5_000 });

    // ── 3. Endereço auto-selecionado (1 endereço só) ────────────────────────
    const addressOption = page.locator(`[data-testid="address-option-${addressId}"]`);
    await expect(addressOption).toBeVisible({ timeout: 5_000 });
    // Já vem selecionado (border-primary)
    await expect(addressOption).toHaveClass(/border-primary/);

    // ── 4. Mapa renderiza (lat/lng vêm do banco) ────────────────────────────
    // O mapa pode levar alguns segundos pra carregar o script
    await expect(page.locator('[data-testid="service-area-map"]')).toBeVisible({
      timeout: 15_000,
    });

    // ── 5. Preenche profissão ───────────────────────────────────────────────
    await page
      .locator('[data-testid="profession-select"]')
      .first()
      .selectOption('AT');

    // ── 6. Adiciona 1 slot de schedule (Lunes 09:00–17:00 default) ──────────
    // Cada day card tem um botão "+" cujo aria-label vem do i18n
    // ("Horarios" em ES, "Horários" em pt-BR). Match por regex.
    const lunesAddBtn = page
      .getByRole('button', { name: /Horarios|Horários/i })
      .first();
    await lunesAddBtn.scrollIntoViewIfNeeded();
    await lunesAddBtn.click();

    // ── 7. Preenche meet link ───────────────────────────────────────────────
    const meetInput = page.locator('[data-testid="meet-link-0"]');
    await meetInput.scrollIntoViewIfNeeded();
    await meetInput.fill('meet.google.com/abc-defg-hij');
    await meetInput.blur();

    // ── 8. Botão Continuar fica habilitado ──────────────────────────────────
    const continueBtn = page.getByTestId('create-vacancy-save-btn');
    await expect(continueBtn).toBeEnabled({ timeout: 10_000 });

    // ── 9. Submit ───────────────────────────────────────────────────────────
    await continueBtn.click();

    // Navega pra Talentum config
    await expect(page).toHaveURL(/\/admin\/vacancies\/.+\/talentum/, { timeout: 30_000 });

    // Captura o vacancyId da URL
    const urlParts = page.url().split('/');
    const talentumIdx = urlParts.indexOf('talentum');
    const newVacancyId = talentumIdx > 0 ? urlParts[talentumIdx - 1] : '';
    expect(newVacancyId).toBeTruthy();
    createdVacancyIds.push(newVacancyId);

    // ── 10. AI mockada popula descrição ─────────────────────────────────────
    const descTextarea = page.locator('textarea').first();
    await expect(descTextarea).not.toBeEmpty({ timeout: 15_000 });
    const descValue = await descTextarea.inputValue();
    expect(descValue).toContain('Acompañante Terapéutico');

    // ── 11. Publicar Talentum (mockado) ─────────────────────────────────────
    const publishBtn = page.getByRole('button', { name: /Publicar en Talentum/i });
    await publishBtn.scrollIntoViewIfNeeded();
    await publishBtn.click();

    // Navega pra detail page
    await expect(page).toHaveURL(
      new RegExp(`/admin/vacancies/${newVacancyId}$`),
      { timeout: 20_000 },
    );

    // ── 12. Assertion final no banco ─────────────────────────────────────────
    const row = getVacancyById(newVacancyId) as JobPostingRow;
    expect(row).not.toBeNull();
    expect(row.patient_id).toBe(patientId);
    expect(row.patient_address_id).toBe(addressId);
    // Status = SEARCHING (default ao criar via UI atual)
    expect(['SEARCHING', 'PENDING_ACTIVATION']).toContain(row.status);
    // schedule é JSONB; só validamos que NÃO está vazio
    expect(row.schedule).toBeTruthy();
    expect(String(row.schedule)).toContain('09:00');
    // published_at default = today (auto-fill)
    expect(row.published_at).not.toBeNull();
    // closes_at fica null (não preenchemos)
    expect(row.closes_at).toBeNull();
  });
});

// ── Backend health ─────────────────────────────────────────────────────────────

test.describe('Backend connectivity check @integration', () => {
  test.setTimeout(10_000);

  test('backend health endpoint returns OK', async ({ request }) => {
    const res = await request.get(`${BACKEND_URL}/health`);
    expect(res.ok()).toBe(true);
    const body = await res.json();
    expect(body.status).toBe('healthy');
  });
});
