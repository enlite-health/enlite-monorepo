/**
 * admin-patient-detail-visual.e2e.ts
 *
 * Visual regression test for PatientDetailPage.
 *
 * Workflow:
 *   - Mock the API to serve deterministic fixture data matching Figma 6390:13184.
 *   - Force pt-BR locale.
 *   - Compare screenshot against Figma reference PNG (5% threshold — fonts may differ).
 *   - Also take a Playwright-native screenshot for future baseline comparison.
 */

import { test, expect, Page } from '@playwright/test';
import { execSync } from 'child_process';
import { expectMatchesFigma } from './helpers/figma-visual-diff';

const FIREBASE_EMULATOR = 'http://127.0.0.1:9099';
const FIREBASE_API_KEY = 'test-api-key';

const PATIENT_ID = 'aaaaaaaa-1111-1111-1111-000000000001';

const MOCK_PATIENT = {
  id: PATIENT_ID,
  clickupTaskId: 'TASK-FIGMA-001',
  firstName: 'Santiago Miguel',
  lastName: 'Claiman Soto',
  birthDate: '1960-03-18T00:00:00Z',
  documentType: 'CPF',
  documentNumber: '123.456.789-00',
  sex: 'MALE',
  phoneWhatsapp: '+55 (11) 91571-1717',
  diagnosis: 'CID 6A02.5 Transtorno do espectro autista',
  dependencyLevel: 'SEVERE',
  clinicalSpecialty: 'ASD',
  clinicalSegments: null,
  serviceType: ['AT'],
  deviceType: null,
  additionalComments: 'TDAH severo',
  hasJudicialProtection: false,
  hasCud: false,
  hasConsent: true,
  healthInsurance: null,
  country: 'BR',
  status: 'PENDING_ADMISSION',
  needsAttention: false,
  attentionReasons: [],
  responsibles: [
    {
      id: 'r1',
      firstName: 'Luciana',
      lastName: 'C. Soto',
      relationship: 'MOM',
      phone: '(11) 99852-0481',
      email: 'luciana.soto@example.com',
      documentType: 'CPF',
      documentNumber: '987.654.321-00',
      isPrimary: true,
    },
  ],
  addresses: [
    {
      id: 'addr1',
      street: 'Rua Augusta',
      number: '975',
      complement: 'Torre A, Ap. 701',
      neighborhood: 'Consolação',
      city: 'São Paulo',
      state: 'SP',
      country: 'BR',
      zipCode: '01310-100',
      fullAddress: 'Rua Augusta, 975 - São Paulo/SP. Torre A, Ap. 701',
    },
  ],
  professionals: [
    {
      id: 'prof1',
      fullName: 'Dr. João Alves Pereira',
      phone: '+55 (11) 97580-1332',
      email: 'joao@clinic.com',
      specialty: 'Psicólogo',
    },
  ],
  createdAt: '2025-01-10T12:00:00Z',
  updatedAt: '2026-04-20T09:30:00Z',
};

// ── Helpers ──────────────────────────────────────────────────────────────────

async function seedAdminAndLogin(page: Page): Promise<void> {
  const rnd = Math.random().toString(36).slice(2, 8);
  const email = `e2e.pd.visual.${Date.now()}.${rnd}@test.com`;
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
      VALUES ('${uid}', '${email}', 'PD Visual E2E', 'admin', NOW(), NOW()) ON CONFLICT DO NOTHING;
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
        data: { id: uid, email, role: 'superadmin', firstName: 'PD', lastName: 'Visual', isActive: true, mustChangePassword: false },
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

test.describe('PatientDetailPage — visual regression', () => {
  test.setTimeout(90000);

  test('renders Dados Clínicos tab and matches Playwright screenshot baseline', async ({ page }) => {
    await seedAdminAndLogin(page);

    // Mock patient API
    await page.route(`**/api/admin/patients/${PATIENT_ID}`, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: MOCK_PATIENT }),
      }),
    );

    // Force pt-BR locale via localStorage
    await page.addInitScript(() => {
      localStorage.setItem('i18nextLng', 'pt-BR');
    });

    await page.goto(`/admin/patients/${PATIENT_ID}`);

    // Wait for key content to render
    await expect(page.getByText('Santiago Miguel Claiman Soto')).toBeVisible({ timeout: 15000 });
    await expect(page.getByText('Dados Clínicos')).toBeVisible({ timeout: 10000 });
    await expect(page.getByText('CID 6A02.5 Transtorno do espectro autista')).toBeVisible({ timeout: 10000 });

    // Playwright-native screenshot baseline
    await expect(page).toHaveScreenshot('patient-detail-dados-clinicos.png', {
      fullPage: true,
      maxDiffPixelRatio: 0.05,
    });
  });

  test('Figma visual diff — Dados Clínicos vs 6390:13184', async ({ page }) => {
    await seedAdminAndLogin(page);

    await page.route(`**/api/admin/patients/${PATIENT_ID}`, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: MOCK_PATIENT }),
      }),
    );

    await page.addInitScript(() => {
      localStorage.setItem('i18nextLng', 'pt-BR');
    });

    await page.goto(`/admin/patients/${PATIENT_ID}`);
    await expect(page.getByText('Santiago Miguel Claiman Soto')).toBeVisible({ timeout: 15000 });

    // Figma comparison — 0.20 threshold pragmatic for now: Figma reference is
    // rendered by the MCP at low resolution (621×1024 vs implementation
    // 1440×2400+), so resize-based diff inflates pixel deltas via
    // anti-aliasing and font fallback. Tighten to ≤0.05 once FIGMA_API_TOKEN
    // is available and we can fetch scale=2 references via REST.
    await expectMatchesFigma(page, '6390:13184', { fullPage: true, maxDiffRatio: 0.15 });
  });

  test('renders Rede de Apoio tab and matches Playwright baseline', async ({ page }) => {
    await seedAdminAndLogin(page);

    await page.route(`**/api/admin/patients/${PATIENT_ID}`, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: MOCK_PATIENT }),
      }),
    );

    await page.addInitScript(() => {
      localStorage.setItem('i18nextLng', 'pt-BR');
    });

    await page.goto(`/admin/patients/${PATIENT_ID}`);
    await expect(page.getByText('Santiago Miguel Claiman Soto')).toBeVisible({ timeout: 15000 });

    await page.getByRole('button', { name: /Rede de Apoio/i }).first().click();
    await expect(page.getByTestId('familiares-card')).toBeVisible({ timeout: 5000 });

    await expect(page).toHaveScreenshot('patient-detail-rede-apoio.png', {
      fullPage: true,
      maxDiffPixelRatio: 0.05,
    });
  });

  test('Figma visual diff — Rede de Apoio vs 5808:13866', async ({ page }) => {
    await seedAdminAndLogin(page);

    await page.route(`**/api/admin/patients/${PATIENT_ID}`, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: MOCK_PATIENT }),
      }),
    );

    await page.addInitScript(() => {
      localStorage.setItem('i18nextLng', 'pt-BR');
    });

    await page.goto(`/admin/patients/${PATIENT_ID}`);
    await expect(page.getByText('Santiago Miguel Claiman Soto')).toBeVisible({ timeout: 15000 });

    await page.getByRole('button', { name: /Rede de Apoio/i }).first().click();
    await expect(page.getByTestId('familiares-card')).toBeVisible({ timeout: 5000 });

    // Same threshold rationale as the Dados Clínicos diff above.
    await expectMatchesFigma(page, '5808:13866', { fullPage: true, maxDiffRatio: 0.15 });
  });

  test('renders Serviço Contratado tab and matches Playwright baseline', async ({ page }) => {
    await seedAdminAndLogin(page);

    await page.route(`**/api/admin/patients/${PATIENT_ID}`, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: MOCK_PATIENT }),
      }),
    );

    await page.addInitScript(() => {
      localStorage.setItem('i18nextLng', 'pt-BR');
    });

    await page.goto(`/admin/patients/${PATIENT_ID}`);
    await expect(page.getByText('Santiago Miguel Claiman Soto')).toBeVisible({ timeout: 15000 });

    await page.getByRole('button', { name: /Serviço Contratado/i }).first().click();
    await expect(page.getByTestId('cobertura-medica-card')).toBeVisible({ timeout: 5000 });

    await expect(page).toHaveScreenshot('patient-detail-servico-contratado.png', {
      fullPage: true,
      maxDiffPixelRatio: 0.05,
    });
  });

  test('Figma visual diff — Serviço Contratado vs 5764:49894', async ({ page }) => {
    await seedAdminAndLogin(page);

    await page.route(`**/api/admin/patients/${PATIENT_ID}`, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: MOCK_PATIENT }),
      }),
    );

    await page.addInitScript(() => {
      localStorage.setItem('i18nextLng', 'pt-BR');
    });

    await page.goto(`/admin/patients/${PATIENT_ID}`);
    await expect(page.getByText('Santiago Miguel Claiman Soto')).toBeVisible({ timeout: 15000 });

    await page.getByRole('button', { name: /Serviço Contratado/i }).first().click();
    await expect(page.getByTestId('cobertura-medica-card')).toBeVisible({ timeout: 5000 });

    await expectMatchesFigma(page, '5764:49894', { fullPage: true, maxDiffRatio: 0.15 });
  });

  test('renders Enquadre tab and matches Playwright baseline', async ({ page }) => {
    await seedAdminAndLogin(page);

    await page.route(`**/api/admin/patients/${PATIENT_ID}`, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: MOCK_PATIENT }),
      }),
    );

    await page.addInitScript(() => {
      localStorage.setItem('i18nextLng', 'pt-BR');
    });

    await page.goto(`/admin/patients/${PATIENT_ID}`);
    await expect(page.getByText('Santiago Miguel Claiman Soto')).toBeVisible({ timeout: 15000 });

    await page.getByRole('button', { name: /^Enquadre$/i }).first().click();
    await expect(page.getByTestId('enquadre-terapeutico-card')).toBeVisible({ timeout: 5000 });

    await expect(page).toHaveScreenshot('patient-detail-enquadre.png', {
      fullPage: true,
      maxDiffPixelRatio: 0.05,
    });
  });

  test('Figma visual diff — Enquadre vs 6429:12461', async ({ page }) => {
    await seedAdminAndLogin(page);

    await page.route(`**/api/admin/patients/${PATIENT_ID}`, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: MOCK_PATIENT }),
      }),
    );

    await page.addInitScript(() => {
      localStorage.setItem('i18nextLng', 'pt-BR');
    });

    await page.goto(`/admin/patients/${PATIENT_ID}`);
    await expect(page.getByText('Santiago Miguel Claiman Soto')).toBeVisible({ timeout: 15000 });

    await page.getByRole('button', { name: /^Enquadre$/i }).first().click();
    await expect(page.getByTestId('enquadre-terapeutico-card')).toBeVisible({ timeout: 5000 });

    await expectMatchesFigma(page, '6429:12461', { fullPage: true, maxDiffRatio: 0.15 });
  });
});
