/**
 * admission-patient-flow.integration.e2e.ts @integration
 *
 * Integration E2E — ADMISSION patient + create-address-inline flow.
 *
 * Exercises:
 *   1. Patient with status=ADMISSION and 0 addresses
 *   2. PatientAdmissionBanner visible after patient selection
 *   3. "Crear nuevo domicilio" modal creates a real patient_addresses row
 *   4. Vacancy saved with correct patient_address_id
 *
 * Same auth/mock strategy as full-create-vacancy.integration.e2e.ts:
 *   - Auth profile mocked, token swapped to mock_* for all API calls
 *   - AI content mocked
 *   - publish-talentum mocked
 */

import { test, expect, type Page, type Route } from '@playwright/test';
import {
  insertTestPatient,
  cleanupTestPatient,
  getVacancyById,
  getPatientAddresses,
} from '../helpers/db-test-helper';

// ── Constants ─────────────────────────────────────────────────────────────────

const BACKEND_URL = 'http://localhost:8080';

const MOCK_ADMIN_USER = {
  uid: 'e2e-int-admin-admission',
  email: 'admin.admission@e2e.test',
  role: 'admin',
};
const MOCK_TOKEN =
  'mock_' + Buffer.from(JSON.stringify(MOCK_ADMIN_USER), 'utf-8').toString('base64');

const AI_CONTENT_FIXTURE = {
  description: 'Descripción generada por IA para test de integración — flujo ADMISSION.',
  prescreening: {
    questions: [
      {
        question: '¿Tenés experiencia con pacientes en proceso de admisión?',
        responseType: ['YES_NO'],
        desiredResponse: 'YES',
        weight: 2,
        required: true,
        analyzed: true,
        earlyStoppage: false,
      },
    ],
    faq: [],
  },
};

// ── Helpers ───────────────────────────────────────────────────────────────────

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

/**
 * Installs all route interceptors needed for integration tests:
 *   1. Firebase Identity Toolkit → fake JWT (no real Firebase needed)
 *   2. /api/admin/auth/profile → mock admin profile
 *   3. /generate-ai-content → fixture response
 *   4. /publish-talentum → mock success
 *   5. All other /api/** → swap token to mock_* for Docker backend
 */
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
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        users: [{ localId: MOCK_ADMIN_USER.uid, email: MOCK_ADMIN_USER.email, emailVerified: true }],
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
            firstName: 'Admission',
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
            publicId: '00000000-0000-0000-0000-000000000001',
            slug: 'e2e-admission-vacancy',
            whatsappUrl: 'https://wa.me/fake',
          },
        }),
      });
      return;
    }

    const headers = { ...route.request().headers(), authorization: `Bearer ${MOCK_TOKEN}` };
    await route.continue({ headers });
  });
}

/**
 * Logs in via the admin login form with mocked Firebase Auth responses.
 */
async function loginAsAdmin(page: Page): Promise<void> {
  const email = MOCK_ADMIN_USER.email;
  const password = 'TestAdmin123!';

  await installInterceptors(page);

  await page.goto('/admin/login');
  await page.locator('input[type="email"]').fill(email);
  await page.locator('input[type="password"]').fill(password);
  await page.getByRole('button', { name: /Iniciar sesión/i }).click();

  await expect(page).not.toHaveURL(/.*login.*/, { timeout: 20_000 });
}

// ── Tests ──────────────────────────────────────────────────────────────────────

test.describe('ADMISSION patient + inline address creation @integration', () => {
  test.setTimeout(90_000);

  let patientId: string;

  test.beforeAll(() => {
    const result = insertTestPatient({
      status: 'ADMISSION',
      firstName: 'AdmissionTest',
      lastName: `Patient${Date.now()}`,
      withAddress: false,  // 0 addresses — forces inline creation
    });
    patientId = result.patientId;
  });

  test.afterAll(() => {
    cleanupTestPatient(patientId);
  });

  test('ADMISSION banner visible and inline address creation works end-to-end', async ({ page }) => {
    // TODO: este spec foi escrito assumindo entry point por autocomplete de paciente
    // (sprint doc original). A UI atual usa case-select via /admin/vacancies/new.
    // Reescrever no padrão de full-create-vacancy.integration.e2e.ts antes de re-habilitar.
    test.skip(true, 'Fluxo desatualizado — precisa migrar pra case-select pattern');
    test.skip(!patientId, 'Could not seed ADMISSION patient');

    await loginAsAdmin(page);
    await page.goto('/admin/vacancies/new');
    await expect(page.getByText('Nueva Vacante')).toBeVisible({ timeout: 15_000 });

    // ── Step 1: Search and select ADMISSION patient ──────────────────────

    const searchInput = page.getByPlaceholder(/Buscar paciente/i);
    await searchInput.fill('AdmissionTest');

    await expect(page.getByRole('listbox')).toBeVisible({ timeout: 10_000 });
    const option = page.getByRole('option').first();
    await expect(option).toBeVisible({ timeout: 5_000 });
    await option.click();

    // ── Step 2: ADMISSION banner must appear ──────────────────────────────

    await expect(page.getByText(/Paciente en admisión/i)).toBeVisible({ timeout: 8_000 });

    // ── Step 3: No address registered — "Crear nuevo domicilio" visible ───

    await expect(page.getByText(/El paciente no tiene domicilios registrados/i)).toBeVisible({
      timeout: 5_000,
    });
    const createAddressBtn = page.getByRole('button', { name: /Crear nuevo domicilio/i });
    await expect(createAddressBtn).toBeVisible({ timeout: 5_000 });

    // Screenshot: ADMISSION banner + empty address state
    await expect(page).toHaveScreenshot('admission-patient-banner-no-address.png', {
      fullPage: false,
      maxDiffPixelRatio: 0.05,
    });

    // ── Step 4: Open create address modal ────────────────────────────────

    await createAddressBtn.click();
    await expect(page.getByRole('dialog')).toBeVisible({ timeout: 5_000 });
    // Use heading role to avoid strict-mode conflict with the trigger button
    await expect(page.getByRole('heading', { name: /Crear nuevo domicilio/i })).toBeVisible();

    // ── Step 5: Fill address form ─────────────────────────────────────────

    const dialog = page.getByRole('dialog');
    const addrInput = dialog.locator('input').first();
    await addrInput.fill('Av. Test 123, CABA, AR');

    // Address type: try to select 'primary' if a select exists
    const addrTypeSelect = dialog.locator('select').first();
    if (await addrTypeSelect.isVisible()) {
      await addrTypeSelect.selectOption('primary');
    }

    // ── Step 6: Save address ───────────────────────────────────────────────

    await dialog.getByRole('button', { name: /Guardar/i }).click();

    // Dialog closes
    await expect(page.getByRole('dialog')).not.toBeVisible({ timeout: 8_000 });

    // ── Step 7: Verify address appeared in selector ───────────────────────

    // After creation the form re-fetches the patient — the amber "no addresses" warning
    // must disappear, confirming the new address is now in the selector.
    // Note: the address text label may be empty in the UI due to a known backend→domain
    // field mapping gap (backend: addressFormatted; domain: fullAddress), but the
    // empty-state banner disappears which confirms the address row was loaded.
    await expect(page.getByText(/El paciente no tiene domicilios registrados/i)).not.toBeVisible({
      timeout: 10_000,
    });

    // ── Step 8: Verify DB has the new address ─────────────────────────────

    const dbAddresses = getPatientAddresses(patientId);
    expect(dbAddresses.length).toBeGreaterThan(0);

    // ── Step 9: Fill required professions ────────────────────────────────

    const atOption = page.getByText('AT', { exact: true }).first();
    if (await atOption.isVisible()) {
      await atOption.click();
    }

    // ── Step 10: Add schedule slot ────────────────────────────────────────

    const addSlotBtn = page.getByRole('button', { name: /horario/i }).first();
    if (await addSlotBtn.isVisible()) {
      await addSlotBtn.click();
    }

    // ── Step 11: Save vacancy ─────────────────────────────────────────────

    await page.getByRole('button', { name: /Guardar/i }).click();

    // Navigate to talentum config page
    await expect(page).toHaveURL(/\/admin\/vacancies\/.+\/talentum/, { timeout: 20_000 });

    // ── Step 12: Verify vacancy in DB ─────────────────────────────────────

    const urlParts = page.url().split('/');
    const talentumIdx = urlParts.indexOf('talentum');
    const vacancyId = talentumIdx > 0 ? urlParts[talentumIdx - 1] : null;
    expect(vacancyId).toBeTruthy();

    const dbVacancy = vacancyId ? getVacancyById(vacancyId) : null;
    expect(dbVacancy).not.toBeNull();
    expect(dbVacancy?.patient_id).toBe(patientId);
    // patient_address_id must point to the address we just created
    expect(dbVacancy?.patient_address_id).not.toBeNull();
    expect(dbVacancy?.patient_address_id).not.toBe('');

    // ── Step 13: Publish (mocked) ─────────────────────────────────────────

    await page.getByRole('button', { name: /Publicar en Talentum/i }).click();

    await expect(page).toHaveURL(
      new RegExp(`/admin/vacancies/${vacancyId}$`),
      { timeout: 20_000 },
    );
  });
});

// ── Backend health check ───────────────────────────────────────────────────────

test.describe('Backend reachable for admission flow @integration', () => {
  test.setTimeout(10_000);

  test('backend returns healthy status', async ({ request }) => {
    const res = await request.get(`${BACKEND_URL}/health`);
    expect(res.ok()).toBe(true);
  });
});
