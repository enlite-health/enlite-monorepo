/**
 * admin-vacancies-filters.integration.e2e.ts @integration
 *
 * Validates the 6 new advanced filters on /admin/vacancies:
 *   - Tipo (worker_type)
 *   - Provincia (state)
 *   - Localidad (city)
 *   - Sexo (required_sex)
 *   - Días (days — MultiSelect)
 *   - Horario De/Hasta (time_from / time_to)
 *
 * Auth: same mock-Firebase pattern as admin-vacancies-list-visual.
 * API:  all /api/** calls are intercepted — no real backend needed.
 */

import { test, expect, type Page, type Route } from '@playwright/test';

// ── Mock identities ───────────────────────────────────────────────────────────

const MOCK_ADMIN_USER = {
  uid: 'e2e-vac-filters',
  email: 'admin.vac-filters@e2e.test',
  role: 'superadmin',
};
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

// ── Mock data ─────────────────────────────────────────────────────────────────

const MOCK_VACANCIES = [
  {
    id: 'v-f001',
    caso: 'Caso 300-01',
    status: 'Activo',
    statusRaw: 'ACTIVE',
    priority: 'NORMAL',
    diasAberto: '03',
    convidados: '5',
    postulados: '2',
    confirmados: '1',
    selecionados: '1',
    faltantes: '0',
  },
];

const MOCK_STATS = [
  { label: '+7 días', value: '1', icon: 'clock' },
  { label: '+24 días', value: '0', icon: 'clock' },
  { label: 'En selección', value: '1', icon: 'user-check' },
  { label: 'Total de Vacantes', value: '1', icon: 'user-search' },
];

const MOCK_FILTER_OPTIONS = {
  states: ['Buenos Aires', 'Córdoba', 'Santa Fe'],
  cities: ['Palermo', 'Belgrano', 'Flores'],
};

// ── Auth + API interceptors ───────────────────────────────────────────────────

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
            firstName: 'Filter',
            lastName: 'Tester',
            isActive: true,
            mustChangePassword: false,
          },
        }),
      });
      return;
    }

    if (url.includes('/api/admin/vacancies/filter-options')) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: MOCK_FILTER_OPTIONS }),
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

    await route.continue();
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

/**
 * Returns the advanced-filters row (second row inside the filter bar).
 * The filter bar is the rounded-bottom container. The advanced row is the
 * second flex row within it (after search + status + priority).
 */
function filterBar(page: Page) {
  return page.locator('div.rounded-b-\\[20px\\]').first();
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test.describe('AdminVacanciesPage — advanced filters @integration', () => {
  test.setTimeout(90_000);

  test('renders all 6 new filter labels in es-AR', async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto('/admin/vacancies');
    await expect(page.getByText('Caso 300-01')).toBeVisible({ timeout: 15_000 });

    const bar = filterBar(page);
    // Use .first() to avoid strict-mode issues with repeated text in options
    await expect(bar.getByText('Tipo').first()).toBeVisible();
    await expect(bar.getByText('Provincia').first()).toBeVisible();
    await expect(bar.getByText('Localidad').first()).toBeVisible();
    await expect(bar.getByText('Sexo').first()).toBeVisible();
    await expect(bar.getByText('Días').first()).toBeVisible();
    await expect(bar.getByText('Horario').first()).toBeVisible();
  });

  test('filter-options populates Provincia dropdown from API', async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto('/admin/vacancies');
    await expect(page.getByText('Caso 300-01')).toBeVisible({ timeout: 15_000 });

    // Provincia é combobox com busca (REQ-06): a lista só existe depois de abrir.
    await page.getByTestId('vacancy-filter-province').click();
    const opts = await page.getByRole('option').allTextContents();
    expect(opts).toContain('Buenos Aires');
    expect(opts).toContain('Córdoba');
  });

  test('selecting Tipo=AT sends worker_type=AT in request', async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto('/admin/vacancies');
    await expect(page.getByText('Caso 300-01')).toBeVisible({ timeout: 15_000 });

    // Tipo is the 3rd select (0-indexed: 0=status, 1=priority, 2=type)
    const selects = page.locator('select');

    const reqWait = page.waitForRequest((req) =>
      req.url().includes('/api/admin/vacancies') &&
      !req.url().includes('filter-options') &&
      !req.url().includes('stats') &&
      req.url().includes('worker_type=AT'),
    );
    await selects.nth(2).selectOption('AT');
    const req = await reqWait;
    expect(req.url()).toContain('worker_type=AT');
  });

  test('selecting Sexo=F sends required_sex=F in request', async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto('/admin/vacancies');
    await expect(page.getByText('Caso 300-01')).toBeVisible({ timeout: 15_000 });

    // Sexo is the 6th select (0=status,1=priority,2=type,3=province,4=city,5=sex)
    const selects = page.locator('select');

    const reqWait = page.waitForRequest((req) =>
      req.url().includes('/api/admin/vacancies') &&
      !req.url().includes('filter-options') &&
      !req.url().includes('stats') &&
      req.url().includes('required_sex=F'),
    );
    // Selects nativos restantes: status(0), priority(1), type(2), sex(3) — Provincia/Localidad/horários viraram combobox.
    await selects.nth(3).selectOption('F');
    const req = await reqWait;
    expect(req.url()).toContain('required_sex=F');
  });

  test('selecting days via MultiSelect sends days in request', async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto('/admin/vacancies');
    await expect(page.getByText('Caso 300-01')).toBeVisible({ timeout: 15_000 });

    // MultiSelect trigger button — the one with aria-expanded attribute
    const multiBtn = page.locator('[aria-expanded]').first();
    await multiBtn.click();

    const listbox = page.getByRole('listbox');
    await expect(listbox).toBeVisible({ timeout: 5_000 });

    const reqWait = page.waitForRequest((req) =>
      req.url().includes('/api/admin/vacancies') &&
      !req.url().includes('filter-options') &&
      !req.url().includes('stats') &&
      req.url().includes('days='),
    );

    // Click first option (Lun)
    await listbox.locator('button').first().click();
    const req = await reqWait;
    expect(req.url()).toContain('days=');
  });

  test('setting time range sends time_from and time_to together', async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto('/admin/vacancies');
    await expect(page.getByText('Caso 300-01')).toBeVisible({ timeout: 15_000 });


    // First set only time_from — should NOT trigger a request with time_to absent
    // Then set time_to — request should fire with both
    const reqWait = page.waitForRequest((req) =>
      req.url().includes('/api/admin/vacancies') &&
      !req.url().includes('filter-options') &&
      !req.url().includes('stats') &&
      req.url().includes('time_from=') &&
      req.url().includes('time_to='),
    );

    // Horários viraram combobox com busca (REQ-06): abre, escolhe a opção.
    await page.getByTestId('time-from').click();
    await page.getByRole('option', { name: '09:00' }).click();
    await page.getByTestId('time-to').click();
    await page.getByRole('option', { name: '17:00' }).click();

    const req = await reqWait;
    expect(req.url()).toContain('time_from=09%3A00');
    expect(req.url()).toContain('time_to=17%3A00');
  });

  test('screenshot: filter bar with Tipo=AT applied', async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto('/admin/vacancies');
    await expect(page.getByText('Caso 300-01')).toBeVisible({ timeout: 15_000 });

    // Apply Tipo = AT (3rd select)
    const selects = page.locator('select');
    await selects.nth(2).selectOption('AT');

    // Wait for filter request to complete
    await page.waitForResponse((res) =>
      res.url().includes('/api/admin/vacancies') &&
      !res.url().includes('filter-options') &&
      !res.url().includes('stats'),
    );

    // Small stable delay for any animations
    await page.waitForTimeout(300);

    const bar = filterBar(page);
    await expect(bar).toHaveScreenshot('admin-vacancies-filters-filled.png', {
      maxDiffPixelRatio: 0.05,
    });
  });

  test('Limpiar filtros button resets Tipo filter', async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto('/admin/vacancies');
    await expect(page.getByText('Caso 300-01')).toBeVisible({ timeout: 15_000 });

    // Apply Tipo = AT (3rd select)
    const selects = page.locator('select');
    await selects.nth(2).selectOption('AT');

    // Limpiar button should appear
    const clearBtn = filterBar(page).getByText('Limpiar filtros');
    await expect(clearBtn).toBeVisible({ timeout: 5_000 });

    await clearBtn.click();

    // After clear, the Tipo select should be back to empty
    await expect(selects.nth(2)).toHaveValue('');
  });
});
