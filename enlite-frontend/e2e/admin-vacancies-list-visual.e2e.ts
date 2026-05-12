/**
 * admin-vacancies-list-visual.e2e.ts
 *
 * Visual + structural regression for the admin vacancies listing
 * (/admin/vacancies) after the 2026-05-12 refactor:
 *
 *   - Removed "Grado de Dependencia" column
 *   - Removed "Clientes" filter
 *   - Added "Prioridad" column with badge
 *   - Estado/Prioridad filters aligned with the 8 canonical statuses
 *     (SEARCHING, SEARCHING_REPLACEMENT, RAPID_RESPONSE,
 *      PENDING_ACTIVATION, ACTIVE, ON_HOLD, SUSPENDED, CLOSED)
 *     and 4 canonical priorities (URGENT/HIGH/NORMAL/LOW)
 *   - Filter selects switched from h-60 SelectField to h-12 Select atom
 */

import { test, expect, Page } from '@playwright/test';
import { execSync } from 'child_process';

const FIREBASE_EMULATOR = 'http://127.0.0.1:9099';
const FIREBASE_API_KEY = 'test-api-key';

// ── Mock data ────────────────────────────────────────────────────────────────

const MOCK_VACANCIES = [
  {
    id: 'v-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    caso: 'Caso 234-12',
    status: 'Activo',
    statusRaw: 'ACTIVE',
    priority: 'URGENT',
    diasAberto: '05',
    convidados: '12',
    postulados: '07',
    selecionados: '02',
    faltantes: '01',
  },
  {
    id: 'v-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
    caso: 'Caso 245-04',
    status: 'En Espera',
    statusRaw: 'ON_HOLD',
    priority: 'HIGH',
    diasAberto: '12',
    convidados: '20',
    postulados: '08',
    selecionados: '01',
    faltantes: '00',
  },
  {
    id: 'v-cccc-cccc-cccc-cccccccccccc',
    caso: 'Caso 257-02',
    status: 'Buscando AT',
    statusRaw: 'SEARCHING',
    priority: 'NORMAL',
    diasAberto: '02',
    convidados: '02',
    postulados: '01',
    selecionados: '00',
    faltantes: '02',
  },
];

const MOCK_STATS = [
  { label: '+7 días',           value: '4',   icon: 'clock'        as const },
  { label: '+24 días',          value: '12',  icon: 'clock'        as const },
  { label: 'En selección',      value: '38',  icon: 'user-check'   as const },
  { label: 'Total de Vacantes', value: '5h',  icon: 'user-search'  as const },
];

// ── Helpers ──────────────────────────────────────────────────────────────────

async function seedAdminAndLogin(page: Page): Promise<void> {
  const rnd = Math.random().toString(36).slice(2, 8);
  const email = `e2e.vacs.visual.${Date.now()}.${rnd}@test.com`;
  const password = 'TestAdmin123!';

  const signUpRes = await fetch(
    `${FIREBASE_EMULATOR}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=${FIREBASE_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, returnSecureToken: true }),
    },
  );
  const signUpData = (await signUpRes.json()) as { localId?: string };
  if (!signUpData.localId) throw new Error(`Firebase sign-up failed: ${JSON.stringify(signUpData)}`);
  const uid = signUpData.localId;

  const sql = `
    INSERT INTO users (firebase_uid, email, display_name, role, created_at, updated_at)
      VALUES ('${uid}', '${email}', 'Vacs Visual E2E', 'admin', NOW(), NOW()) ON CONFLICT DO NOTHING;
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
        data: { id: uid, email, role: 'superadmin', firstName: 'Vacs', lastName: 'Visual', isActive: true, mustChangePassword: false },
      }),
    }),
  );

  await page.goto('/admin/login');
  await page.locator('input[type="email"]').fill(email);
  await page.locator('input[type="password"]').fill(password);
  await page.locator('button[type="submit"]').click();
  await expect(page).not.toHaveURL(/.*login.*/, { timeout: 20000 });
}

async function mockVacanciesEndpoints(page: Page): Promise<void> {
  await page.route('**/api/admin/vacancies/stats*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, data: MOCK_STATS }),
    }),
  );
  await page.route('**/api/admin/vacancies?**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        data: MOCK_VACANCIES,
        total: MOCK_VACANCIES.length,
        limit: 20,
        offset: 0,
      }),
    }),
  );
  await page.route('**/api/admin/vacancies', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        data: MOCK_VACANCIES,
        total: MOCK_VACANCIES.length,
        limit: 20,
        offset: 0,
      }),
    }),
  );
}

// ── Tests ────────────────────────────────────────────────────────────────────

test.describe('AdminVacanciesPage — list visual + structural regression', () => {
  test.setTimeout(90000);

  test('renders without "Grado de Dependencia" column and without Clientes filter', async ({ page }) => {
    await seedAdminAndLogin(page);
    await mockVacanciesEndpoints(page);

    await page.addInitScript(() => {
      localStorage.setItem('i18nextLng', 'es');
    });

    await page.goto('/admin/vacancies');
    await expect(page.getByText('Caso 234-12')).toBeVisible({ timeout: 15000 });

    // Coluna removida não pode estar no DOM
    await expect(page.getByRole('columnheader', { name: /Grado de Dependencia/i })).toHaveCount(0);

    // Coluna nova precisa estar visível
    await expect(page.getByRole('columnheader', { name: /Prioridad/i })).toBeVisible();

    // Filtro Clientes removido
    await expect(page.getByText(/^Clientes$/)).toHaveCount(0);

    // Filtros restantes (Estado, Prioridad) presentes
    await expect(page.getByText(/^Estado$/).first()).toBeVisible();
    await expect(page.getByText(/^Prioridad$/).first()).toBeVisible();

    // Apenas 2 selects de filtro + 1 de paginação (== 3 comboboxes total)
    await expect(page.locator('select')).toHaveCount(3);
  });

  test('Estado filter exposes the 8 canonical job_postings.status values', async ({ page }) => {
    await seedAdminAndLogin(page);
    await mockVacanciesEndpoints(page);

    await page.addInitScript(() => {
      localStorage.setItem('i18nextLng', 'es');
    });

    await page.goto('/admin/vacancies');
    await expect(page.getByText('Caso 234-12')).toBeVisible({ timeout: 15000 });

    const statusSelect = page.locator('select').nth(0);
    const values = await statusSelect.locator('option').evaluateAll(
      (opts) => opts.map((o) => (o as HTMLOptionElement).value).filter((v) => v.length > 0),
    );
    expect(values.sort()).toEqual(
      [
        'ACTIVE',
        'CLOSED',
        'ON_HOLD',
        'PENDING_ACTIVATION',
        'RAPID_RESPONSE',
        'SEARCHING',
        'SEARCHING_REPLACEMENT',
        'SUSPENDED',
      ].sort(),
    );
  });

  test('Prioridad filter exposes the 4 canonical priorities', async ({ page }) => {
    await seedAdminAndLogin(page);
    await mockVacanciesEndpoints(page);

    await page.addInitScript(() => {
      localStorage.setItem('i18nextLng', 'es');
    });

    await page.goto('/admin/vacancies');
    await expect(page.getByText('Caso 234-12')).toBeVisible({ timeout: 15000 });

    const prioritySelect = page.locator('select').nth(1);
    const values = await prioritySelect.locator('option').evaluateAll(
      (opts) => opts.map((o) => (o as HTMLOptionElement).value).filter((v) => v.length > 0),
    );
    expect(values).toEqual(['URGENT', 'HIGH', 'NORMAL', 'LOW']);
  });

  test('Status filter forwards canonical value to /api/admin/vacancies query', async ({ page }) => {
    await seedAdminAndLogin(page);
    await mockVacanciesEndpoints(page);

    await page.addInitScript(() => {
      localStorage.setItem('i18nextLng', 'es');
    });

    await page.goto('/admin/vacancies');
    await expect(page.getByText('Caso 234-12')).toBeVisible({ timeout: 15000 });

    const statusSelect = page.locator('select').nth(0);

    const reqWait = page.waitForRequest((req) =>
      req.url().includes('/api/admin/vacancies') && req.url().includes('status=ON_HOLD'),
    );
    await statusSelect.selectOption('ON_HOLD');
    const req = await reqWait;
    expect(req.url()).toContain('status=ON_HOLD');
  });

  test('matches Playwright screenshot baseline (es locale)', async ({ page }) => {
    await seedAdminAndLogin(page);
    await mockVacanciesEndpoints(page);

    await page.addInitScript(() => {
      localStorage.setItem('i18nextLng', 'es');
    });

    await page.goto('/admin/vacancies');
    await expect(page.getByText('Caso 234-12')).toBeVisible({ timeout: 15000 });
    await expect(page.getByText('Caso 245-04')).toBeVisible({ timeout: 10000 });
    await expect(page.getByText('Caso 257-02')).toBeVisible({ timeout: 10000 });

    await expect(page).toHaveScreenshot('admin-vacancies-list.png', {
      fullPage: true,
      maxDiffPixelRatio: 0.05,
    });
  });
});
