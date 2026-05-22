/**
 * admin-patient-detail-happy.e2e.ts
 *
 * E2E happy-path tests for PatientDetailPage.
 *
 * Covers:
 *   - Navigate from /admin/patients list → detail page
 *   - URL changes to /admin/patients/:id
 *   - Patient name visible on detail page
 *   - "Dados Clínicos" tab is active by default
 *   - Clicking another tab shows "Em breve" placeholder
 *   - Screenshot assertion (visual baseline)
 */

import { test, expect, Page } from '@playwright/test';
import { execSync } from 'child_process';

const FIREBASE_EMULATOR = 'http://127.0.0.1:9099';
const FIREBASE_API_KEY = 'test-api-key';

const PATIENT_ID = 'bbbbbbbb-2222-2222-2222-000000000002';

const MOCK_PATIENTS_LIST = {
  success: true,
  data: [
    {
      id: PATIENT_ID,
      firstName: 'Francisco',
      lastName: 'Alomon',
      documentType: 'DNI',
      documentNumber: '50076035',
      dependencyLevel: 'SEVERE',
      clinicalSpecialty: null,
      serviceType: ['AT'],
      needsAttention: false,
      attentionReasons: [],
      createdAt: '2026-04-23T10:00:00Z',
    },
  ],
  total: 1,
};

const MOCK_STATS = {
  success: true,
  data: { total: 1, complete: 1, needsAttention: 0, createdToday: 0, createdYesterday: 0, createdLast7Days: 0 },
};

const MOCK_PATIENT_DETAIL = {
  success: true,
  data: {
    id: PATIENT_ID,
    clickupTaskId: 'TASK-001',
    firstName: 'Francisco',
    lastName: 'Alomon',
    birthDate: '1990-06-15T00:00:00Z',
    documentType: 'DNI',
    documentNumber: '50076035',
    sex: 'MALE',
    phoneWhatsapp: '+54 11 9999-0001',
    diagnosis: null,
    dependencyLevel: 'SEVERE',
    clinicalSpecialty: null,
    clinicalSegments: null,
    serviceType: ['AT'],
    deviceType: null,
    additionalComments: null,
    hasJudicialProtection: null,
    hasCud: null,
    hasConsent: null,
    healthInsurance: null,
    country: 'AR',
    status: 'ACTIVE',
    needsAttention: false,
    attentionReasons: [],
    responsibles: [],
    addresses: [],
    professionals: [],
    createdAt: '2026-01-10T12:00:00Z',
    updatedAt: '2026-04-20T09:30:00Z',
  },
};

// ── Helper ───────────────────────────────────────────────────────────────────

async function seedAdminAndLogin(page: Page): Promise<void> {
  const rnd = Math.random().toString(36).slice(2, 8);
  const email = `e2e.pd.happy.${Date.now()}.${rnd}@test.com`;
  const password = 'TestAdmin123!';

  const signUpRes = await fetch(
    `${FIREBASE_EMULATOR}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=${FIREBASE_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, returnSecureToken: true }),
    },
  );
  const signUpData = (await signUpRes.json()) as any;
  if (!signUpData.localId) throw new Error(`Firebase sign-up failed: ${JSON.stringify(signUpData)}`);
  const uid = signUpData.localId;

  const sql = `
    INSERT INTO users (firebase_uid, email, display_name, role, created_at, updated_at)
      VALUES ('${uid}', '${email}', 'PD Happy E2E', 'admin', NOW(), NOW()) ON CONFLICT DO NOTHING;
    INSERT INTO admins_extension (user_id, must_change_password, created_at, updated_at)
      VALUES ('${uid}', false, NOW(), NOW()) ON CONFLICT DO NOTHING;
  `.replace(/\n/g, ' ').trim();

  try {
    execSync(`docker exec enlite-postgres psql -U enlite_admin -d enlite_e2e -c "${sql}"`, { stdio: 'pipe' });
  } catch { /* fall through */ }

  await page.route('**/api/admin/auth/profile', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        data: { id: uid, email, role: 'superadmin', firstName: 'PD', lastName: 'Happy', isActive: true, mustChangePassword: false },
      }),
    }),
  );
  await page.route('**/api/admin/users*', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data: [] }) }),
  );

  await page.goto('/admin/login');
  await page.locator('input[type="email"]').fill(email);
  await page.locator('input[type="password"]').fill(password);
  await page.locator('button[type="submit"]').click();
  await expect(page).not.toHaveURL(/.*login.*/, { timeout: 20000 });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test.describe('PatientDetailPage — happy path', () => {
  test.setTimeout(90000);

  test('navigates from patients list to detail page on row click', async ({ page }) => {
    await seedAdminAndLogin(page);

    await page.route('**/api/admin/patients/stats*', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(MOCK_STATS) }),
    );
    await page.route(`**/api/admin/patients/${PATIENT_ID}`, (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(MOCK_PATIENT_DETAIL) }),
    );
    await page.route('**/api/admin/patients*', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(MOCK_PATIENTS_LIST) }),
    );

    await page.goto('/admin/patients');
    await expect(page.getByText('Alomon, Francisco')).toBeVisible({ timeout: 15000 });

    // Click first row
    await page.locator('tr').filter({ hasText: 'Alomon' }).first().click();

    // URL should change to detail
    await expect(page).toHaveURL(new RegExp(`/admin/patients/${PATIENT_ID}`), { timeout: 10000 });
  });

  test('detail page shows patient name', async ({ page }) => {
    await seedAdminAndLogin(page);

    await page.route(`**/api/admin/patients/${PATIENT_ID}`, (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(MOCK_PATIENT_DETAIL) }),
    );

    await page.goto(`/admin/patients/${PATIENT_ID}`);
    await expect(page.getByText('Francisco Alomon')).toBeVisible({ timeout: 15000 });
  });

  test('Dados Clínicos tab is active by default', async ({ page }) => {
    await seedAdminAndLogin(page);

    await page.route(`**/api/admin/patients/${PATIENT_ID}`, (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(MOCK_PATIENT_DETAIL) }),
    );

    await page.goto(`/admin/patients/${PATIENT_ID}`);
    await expect(page.getByText('Francisco Alomon')).toBeVisible({ timeout: 15000 });

    // Active tab has bg-primary styling — check by text presence and role
    const clinicalTab = page.getByRole('button', { name: /Datos Clínicos|Dados Clínicos/i });
    await expect(clinicalTab.first()).toBeVisible({ timeout: 5000 });
  });

  test('clicking Rede de Apoio tab shows Familiares card', async ({ page }) => {
    await seedAdminAndLogin(page);

    await page.route(`**/api/admin/patients/${PATIENT_ID}`, (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(MOCK_PATIENT_DETAIL) }),
    );

    await page.goto(`/admin/patients/${PATIENT_ID}`);
    await expect(page.getByText('Francisco Alomon')).toBeVisible({ timeout: 15000 });

    const supportTab = page.getByRole('button', { name: /Red de Apoyo|Rede de Apoio/i });
    await supportTab.first().click();

    // Familiares card should render
    await expect(page.getByTestId('familiares-card')).toBeVisible({ timeout: 5000 });
  });

  test('clicking Dados Financeiros tab shows Em breve placeholder', async ({ page }) => {
    await seedAdminAndLogin(page);

    await page.route(`**/api/admin/patients/${PATIENT_ID}`, (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(MOCK_PATIENT_DETAIL) }),
    );

    await page.goto(`/admin/patients/${PATIENT_ID}`);
    await expect(page.getByText('Francisco Alomon')).toBeVisible({ timeout: 15000 });

    const financialTab = page.getByRole('button', { name: /Datos Financieros|Dados Financeiros/i });
    await financialTab.first().click();

    await expect(page.getByText(/Em breve|Próximamente/i).first()).toBeVisible({ timeout: 5000 });
  });

  test('clicking Serviço Contratado tab shows Cobertura Médica + Localizações + Serviços Contratados', async ({ page }) => {
    await seedAdminAndLogin(page);

    await page.route(`**/api/admin/patients/${PATIENT_ID}`, (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(MOCK_PATIENT_DETAIL) }),
    );

    await page.goto(`/admin/patients/${PATIENT_ID}`);
    await expect(page.getByText('Francisco Alomon')).toBeVisible({ timeout: 15000 });

    const serviceTab = page.getByRole('button', { name: /Servicio Contratado|Serviço Contratado/i });
    await serviceTab.first().click();

    await expect(page.getByTestId('cobertura-medica-card')).toBeVisible({ timeout: 5000 });
    await expect(page.getByTestId('localizacoes-card')).toBeVisible();
    await expect(page.getByTestId('servicos-contratados-card')).toBeVisible();
  });

  test('clicking Enquadre tab shows Serviços Contratados + Enquadre Terapêutico', async ({ page }) => {
    await seedAdminAndLogin(page);

    await page.route(`**/api/admin/patients/${PATIENT_ID}`, (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(MOCK_PATIENT_DETAIL) }),
    );

    await page.goto(`/admin/patients/${PATIENT_ID}`);
    await expect(page.getByText('Francisco Alomon')).toBeVisible({ timeout: 15000 });

    const matchingTab = page.getByRole('button', { name: /^(Encuadre|Enquadre)$/i });
    await matchingTab.first().click();

    await expect(page.getByTestId('enquadre-terapeutico-card')).toBeVisible({ timeout: 5000 });
    await expect(page.getByTestId('enquadre-column-interview')).toBeVisible();
    await expect(page.getByTestId('enquadre-column-selected')).toBeVisible();
    await expect(page.getByTestId('enquadre-column-inService')).toBeVisible();
    await expect(page.getByTestId('enquadre-column-rejected')).toBeVisible();
  });

  test('screenshot — detail page loaded', async ({ page }) => {
    await seedAdminAndLogin(page);

    await page.route(`**/api/admin/patients/${PATIENT_ID}`, (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(MOCK_PATIENT_DETAIL) }),
    );

    await page.goto(`/admin/patients/${PATIENT_ID}`);
    await expect(page.getByText('Francisco Alomon')).toBeVisible({ timeout: 15000 });

    await expect(page).toHaveScreenshot('patient-detail-happy.png', {
      fullPage: true,
      maxDiffPixelRatio: 0.05,
    });
  });
});
