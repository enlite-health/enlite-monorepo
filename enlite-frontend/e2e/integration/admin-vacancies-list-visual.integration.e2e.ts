/**
 * admin-vacancies-list-visual.integration.e2e.ts @integration
 *
 * Visual + structural regression for the admin vacancies listing
 * (/admin/vacancies) after the 2026-05-12 refactor:
 *
 *   - Removed "Grado de Dependencia" column (patient info, not vacancy)
 *   - Removed "Clientes" filter (was hardcoded fake)
 *   - Spec 046 F1: Prioridad, Días sin difusión e Confirmados saíram da lista,
 *     e o filtro de Prioridad saiu junto
 *   - Estado filter aligned with the 8 canonical statuses
 *   - Filter selects switched from h-60 SelectField to h-42 Select atom
 *
 * Uses the integration auth pattern (mock Firebase Identity Toolkit + mock
 * /api/admin/auth/profile) — does NOT require the Firebase Emulator. The
 * frontend dev server can stay pointed at the real Firebase prod project.
 */

import { test, expect, type Page, type Route } from '@playwright/test';
import { escolherNoCombo } from '../helpers/combobox';

// ── Mock data ────────────────────────────────────────────────────────────────

const MOCK_ADMIN_USER = {
  uid: 'e2e-vac-list-visual',
  email: 'admin.vac-list-visual@e2e.test',
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

const MOCK_VACANCIES = [
  {
    id: 'v-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    caseNumber: 234, caseOrdinal: 12,
    status: 'Activo',
    statusRaw: 'ACTIVE',
    priority: 'URGENT',
    diasAberto: '05',
    convidados: '12',
    postulados: '07',
    confirmados: '03',
    selecionados: '02',
    faltantes: '01',
  },
  {
    id: 'v-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
    caseNumber: 245, caseOrdinal: 4,
    status: 'En Espera',
    statusRaw: 'ON_HOLD',
    priority: 'HIGH',
    diasAberto: '12',
    convidados: '20',
    postulados: '08',
    confirmados: '02',
    selecionados: '01',
    faltantes: '00',
  },
  {
    id: 'v-cccc-cccc-cccc-cccccccccccc',
    caseNumber: 257, caseOrdinal: 2,
    status: 'Buscando AT',
    statusRaw: 'SEARCHING',
    priority: 'NORMAL',
    diasAberto: '02',
    convidados: '02',
    postulados: '01',
    confirmados: '00',
    selecionados: '00',
    faltantes: '02',
  },
];

const MOCK_STATS = [
  { label: '+7 días',           value: '4',   icon: 'clock'       },
  { label: '+24 días',          value: '12',  icon: 'clock'       },
  { label: 'En selección',      value: '38',  icon: 'user-check'  },
  { label: 'Total de Vacantes', value: '5h',  icon: 'user-search' },
];

// ── Auth interceptor ─────────────────────────────────────────────────────────

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
            firstName: 'Vac',
            lastName: 'Visual',
            isActive: true,
            mustChangePassword: false,
          },
        }),
      });
      return;
    }

    if (url.includes('/api/admin/vacancies/stats')) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: MOCK_STATS }),
      });
      return;
    }

    if (/\/api\/admin\/vacancies(\?|$)/.test(url)) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          data: MOCK_VACANCIES,
          total: MOCK_VACANCIES.length,
          limit: 20,
          offset: 0,
        }),
      });
      return;
    }

    const headers = { ...route.request().headers(), authorization: `Bearer ${MOCK_TOKEN}` };
    await route.continue({ headers });
  });
}

async function loginAsAdmin(page: Page): Promise<void> {
  await installInterceptors(page);
  await page.addInitScript(() => {
    localStorage.setItem('i18nextLng', 'es');
  });
  await page.goto('/admin/login');
  await page.locator('input[type="email"]').fill(MOCK_ADMIN_USER.email);
  await page.locator('input[type="password"]').fill('TestAdmin123!');
  await page.getByRole('button', { name: /Iniciar sesi/i }).click();
  await expect(page).not.toHaveURL(/.*login.*/, { timeout: 20_000 });
}

// ── Tests ────────────────────────────────────────────────────────────────────

test.describe('AdminVacanciesPage — list visual + structural regression @integration', () => {
  test.setTimeout(90_000);

  /** Restrict to the visible VacancyFilters bar (rounded-b-[20px] toolbar). */
  function filterBar(page: Page) {
    return page.locator('div.rounded-b-\\[20px\\].border-r-2.border-b-2.border-l-2');
  }

  test('renders without "Grado de Dependencia" column and without Clientes filter', async ({ page }) => {
    await loginAsAdmin(page);

    await page.goto('/admin/vacancies');
    await expect(page.getByText('234#12')).toBeVisible({ timeout: 15_000 });

    // Removed column must not be in the DOM
    await expect(page.getByRole('columnheader', { name: /Grado de Dependencia/i })).toHaveCount(0);

    // Spec 046 F1: as colunas Prioridad e Días sin difusión saíram da lista (a coluna de Confirmados saiu do produto inteiro na 052)
    await expect(page.getByRole('columnheader', { name: /Prioridad/i })).toHaveCount(0);
    await expect(page.getByRole('columnheader', { name: /Días sin difusión/i })).toHaveCount(0);
    await expect(page.getByTestId('vacancies-col-priority')).toHaveCount(0);
    await expect(page.getByTestId('vacancies-col-days-without-divulgation')).toHaveCount(0);

    // Removed Clientes filter
    await expect(page.getByText(/^Clientes$/)).toHaveCount(0);

    // Filter bar has at least 1 combobox (Estado) — Clientes e Prioridad se foram
    // (additional comboboxes added by advanced filters: Tipo, Provincia, Localidad, Sexo, Días)
    const selectCount = await filterBar(page).getByRole('combobox').count();
    expect(selectCount).toBeGreaterThanOrEqual(1);

    // Estado fica na barra; Prioridad não (A4)
    await expect(filterBar(page).getByText(/^Estado$/)).toBeVisible();
    await expect(filterBar(page).getByText(/^Prioridad$/)).toHaveCount(0);
  });

  test('Estado filter exposes the 8 canonical job_postings.status values', async ({ page }) => {
    await loginAsAdmin(page);

    await page.goto('/admin/vacancies');
    await expect(page.getByText('234#12')).toBeVisible({ timeout: 15_000 });

    // O painel só existe aberto: abre o gatilho do Estado e lê os RÓTULOS que o usuário vê (o valor não está no DOM).
    const statusSelect = filterBar(page).getByRole('combobox').nth(0);
    await statusSelect.click();
    const labels = await statusSelect.locator('xpath=..').getByRole('option').allTextContents();
    expect(labels.map((l) => l.trim()).sort()).toEqual(
      [
        'Activo', // ACTIVE
        'Cerrado', // CLOSED
        'En Espera', // ON_HOLD
        'Esperando Activación', // PENDING_ACTIVATION
        'Respuesta Rápida', // RAPID_RESPONSE
        'Buscando AT', // SEARCHING
        'Buscando Sustituto', // SEARCHING_REPLACEMENT
        'Suspendido', // SUSPENDED
      ].sort(),
    );
    await page.keyboard.press('Escape');
  });

  test('Status filter forwards canonical value to /api/admin/vacancies query', async ({ page }) => {
    await loginAsAdmin(page);

    await page.goto('/admin/vacancies');
    await expect(page.getByText('234#12')).toBeVisible({ timeout: 15_000 });

    const statusSelect = filterBar(page).getByRole('combobox').nth(0);

    const reqWait = page.waitForRequest((req) =>
      req.url().includes('/api/admin/vacancies') && req.url().includes('status=ON_HOLD'),
    );
    await escolherNoCombo(page, statusSelect, 'En Espera'); // ON_HOLD = En Espera
    const req = await reqWait;
    expect(req.url()).toContain('status=ON_HOLD');
  });

  test('matches Playwright screenshot baseline (es locale)', async ({ page }) => {
    await loginAsAdmin(page);

    await page.goto('/admin/vacancies');
    await expect(page.getByText('234#12')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('245#04')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText('257#02')).toBeVisible({ timeout: 10_000 });

    await expect(page).toHaveScreenshot('admin-vacancies-list.png', {
      fullPage: true,
      maxDiffPixelRatio: 0.05,
    });
  });
});
