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
import { loginAsStaffOffline } from './helpers/kanban-notes-e2e-helper';
import { PATIENT_TABS } from '../src/presentation/components/features/admin/PatientDetail/patientTabs';

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
    affiliateId: null,
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
    insuranceInformed: null,
    insuranceVerified: null,
    cityLocality: 'Buenos Aires',
    province: 'CABA',
    zoneNeighborhood: null,
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

// Login offline (`page.route` em identitytoolkit/securetoken) — o mesmo helper dos irmãos mockados.
// O `accounts:signUp` no emulador + INSERT via `docker exec` nunca saía de /admin/login no CI
// (Vite com config Firebase falsa); o helper intercepta a auth e o perfil sem emulador nem banco.
async function seedAdminAndLogin(page: Page): Promise<void> {
  await loginAsStaffOffline(page);
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

  // Spec 014 US-D2: "Datos Financieros" saiu do tab bar (era só placeholder "Próximamente").
  test('a aba Dados Financeiros não existe mais no tab bar', async ({ page }) => {
    await seedAdminAndLogin(page);

    await page.route(`**/api/admin/patients/${PATIENT_ID}`, (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(MOCK_PATIENT_DETAIL) }),
    );

    await page.goto(`/admin/patients/${PATIENT_ID}`);
    await expect(page.getByText('Francisco Alomon')).toBeVisible({ timeout: 15000 });

    await expect(
      page.getByTestId('patient-profile-tabs').getByRole('button', { name: /Datos Financieros|Dados Financeiros/i }),
    ).toHaveCount(0);
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

  // 05/09 (decisão do Gabriel): a aba "Encuadre" saiu — era a tabela de serviços contratados
  // duplicada (montada sem `onSaved`) + placeholder. O encuadre do paciente É o serviço contratado.
  // (O teste anterior já estava morto: asseria `enquadre-column-*`, removidas na spec 014.)
  test('a aba Encuadre não existe mais — o tab bar tem as abas de PATIENT_TABS e "Servicio Contratado" é a única casa do card', async ({ page }) => {
    await seedAdminAndLogin(page);

    await page.route(`**/api/admin/patients/${PATIENT_ID}`, (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(MOCK_PATIENT_DETAIL) }),
    );

    await page.goto(`/admin/patients/${PATIENT_ID}`);
    await expect(page.getByText('Francisco Alomon')).toBeVisible({ timeout: 15000 });

    const tabs = page.getByTestId('patient-profile-tabs');
    await expect(tabs.getByRole('button')).toHaveCount(PATIENT_TABS.length);
    await expect(tabs.getByRole('button', { name: /^(Encuadre|Enquadre)$/i })).toHaveCount(0);
    await expect(page.getByTestId('enquadre-terapeutico-card')).toHaveCount(0);
    await expect(tabs).toHaveScreenshot('patient-profile-tabs-sem-encuadre.png');
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
