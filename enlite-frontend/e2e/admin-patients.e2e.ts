/**
 * admin-patients.e2e.ts
 *
 * Playwright E2E — Tela de listagem de Pacientes (/admin/patients)
 *
 * Fluxos cobertos:
 *   - Página renderiza corretamente em /admin/patients
 *   - Item "Pacientes" visível no menu lateral (sidebar)
 *   - Tabela exibe dados dos pacientes
 *   - Estado vazio exibe mensagem "Nenhum paciente encontrado"
 *   - Filtro needs_attention=true inclui parâmetro na requisição
 *   - Filtro dependency_level=SEVERE inclui parâmetro na requisição
 *   - Paginação envia offset correto
 *   - Erro de API exibe mensagem de erro
 *   - Big numbers NAO aparecem aqui (moveram para Gestión a la vista)
 *   - Coluna "Servicio" mostra o alias (Acompañante Terapéutico), nunca o ENUM
 *   - Data do registro aparece sob o nome, sem coluna nova
 *   - Screenshot visual obrigatório
 *
 * ⚠️ ESTE ARQUIVO NÃO RODA NO CI — medido em 03/09/2026. O workflow só executa
 * `--project=integration` (que casa apenas `e2e/integration/**`) e três specs
 * de plantillas nomeadas; os projetos `chromium`/`firefox`/`webkit`, onde este
 * arquivo vive, não são invocados, e o runner nem instala firefox/webkit. Ele
 * continua valendo como verificação LOCAL, mas a guarda que precisa reprovar um
 * PR mora em `e2e/integration/admin-patients-tabela.integration.e2e.ts`.
 * Ao acrescentar aqui uma garantia que não pode regredir, acrescente lá também.
 */

import { test, expect, Page } from '@playwright/test';
import { execSync } from 'child_process';

const FIREBASE_EMULATOR = 'http://127.0.0.1:9099';
const FIREBASE_API_KEY  = 'test-api-key';

// ── Mock data ─────────────────────────────────────────────────────────────────

const MOCK_PATIENTS = [
  {
    id: 'p1111111-0001-0001-0001-000000000001',
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
  {
    id: 'p2222222-0002-0002-0002-000000000002',
    firstName: 'Máximo',
    lastName: 'Aquino',
    documentType: null,
    documentNumber: null,
    dependencyLevel: null,
    clinicalSpecialty: 'ASD',
    serviceType: ['AT', 'CAREGIVER'],
    needsAttention: true,
    attentionReasons: ['MISSING_INFO'],
    createdAt: '2026-04-22T08:00:00Z',
  },
];

const MOCK_STATS = {
  success: true,
  data: {
    total: 303,
    complete: 133,
    needsAttention: 170,
    createdToday: 0,
    createdYesterday: 0,
    createdLast7Days: 0,
  },
};

function mockPatientsList(patients = MOCK_PATIENTS, total = MOCK_PATIENTS.length) {
  return JSON.stringify({
    success: true,
    data: patients,
    total,
    limit: 20,
    offset: 0,
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function seedAdminAndLogin(page: Page): Promise<void> {
  const rnd      = Math.random().toString(36).slice(2, 8);
  const email    = `e2e.patients.${Date.now()}.${rnd}@test.com`;
  const password = 'TestAdmin123!';

  // 1. Create user in Firebase Emulator
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

  // 2. Seed Postgres admin record
  const sql = `
    INSERT INTO users (firebase_uid, email, display_name, role, created_at, updated_at)
      VALUES ('${uid}', '${email}', 'Patients E2E', 'admin', NOW(), NOW()) ON CONFLICT DO NOTHING;
    INSERT INTO admins_extension (user_id, must_change_password, created_at, updated_at)
      VALUES ('${uid}', false, NOW(), NOW()) ON CONFLICT DO NOTHING;
  `.replace(/\n/g, ' ').trim();

  try {
    execSync(`docker exec enlite-postgres psql -U enlite_admin -d enlite_e2e -c "${sql}"`, { stdio: 'pipe' });
  } catch {
    // Fall through to mock below
  }

  // 3. Mock /api/admin/auth/profile
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
          firstName: 'Patients',
          lastName: 'E2E',
          isActive: true,
          mustChangePassword: false,
        },
      }),
    }),
  );

  // 4. Mock other pages that could be visited during navigation
  await page.route('**/api/vacancies*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, data: [], total: 0, page: 1, limit: 20 }),
    }),
  );

  await page.route('**/api/admin/users*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, data: [] }),
    }),
  );

  // 5. Login via UI
  await page.goto('/admin/login');
  await page.locator('input[type="email"]').fill(email);
  await page.locator('input[type="password"]').fill(password);
  // Click the submit button (email/password login), NOT "Entrar con Google" (OAuth).
  await page.locator('button[type="submit"]').click();
  await expect(page).not.toHaveURL(/.*login.*/, { timeout: 20000 });
}

async function mockStatsAfterListMock(
  page: Page,
  statsBody = JSON.stringify(MOCK_STATS),
): Promise<void> {
  await page.route('**/api/admin/patients/stats', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: statsBody }),
  );
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test.describe('AdminPatientsPage', () => {
  test.setTimeout(60000);

  test('página /admin/patients renderiza título e tabela (sem big numbers)', async ({ page }) => {
    await seedAdminAndLogin(page);

    await page.route('**/api/admin/patients*', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: mockPatientsList() }),
    );
    await mockStatsAfterListMock(page);

    await page.goto('/admin/patients');

    await expect(page.locator('text=Pacientes').first()).toBeVisible({ timeout: 15000 });
    await expect(page.locator('text=Lista de Pacientes').first()).toBeVisible({ timeout: 10000 });

    // Os big numbers (stats + embudo) moveram para /admin/dashboard — esta tela
    // é operação: lista, filtros e kanban. Aqui garantimos que NAO aparecem.
    await expect(page.getByTestId('patient-stats-total')).toHaveCount(0);
    await expect(page.getByTestId('patient-funnel-section')).toHaveCount(0);

    // Table headers
    await expect(page.locator('text=Nombre').first()).toBeVisible({ timeout: 5000 });
    await expect(page.locator('text=Documento').first()).toBeVisible({ timeout: 5000 });

    // Patient data
    await expect(page.locator('text=Alomon, Francisco').first()).toBeVisible({ timeout: 5000 });
    await expect(page.locator('text=DNI 50076035').first()).toBeVisible({ timeout: 5000 });
  });

  test('item "Pacientes" está visível no menu lateral', async ({ page }) => {
    await seedAdminAndLogin(page);

    await page.route('**/api/admin/patients*', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: mockPatientsList() }),
    );
    await mockStatsAfterListMock(page);

    await page.goto('/admin/patients');
    await expect(page.getByRole('link', { name: /Pacientes/i }).first()).toBeVisible({ timeout: 15000 });
  });

  test('filtro needs_attention=true envia parâmetro correto na URL', async ({ page }) => {
    await seedAdminAndLogin(page);

    let capturedUrl = '';
    await page.route('**/api/admin/patients*', (route) => {
      capturedUrl = route.request().url();
      route.fulfill({ status: 200, contentType: 'application/json', body: mockPatientsList() });
    });
    await mockStatsAfterListMock(page);

    await page.goto('/admin/patients');
    await expect(page.locator('text=Alomon, Francisco').first()).toBeVisible({ timeout: 15000 });

    // Select "Precisa atención" option
    const attentionSelect = page.locator('select').first();
    await attentionSelect.selectOption('needs_attention');

    await page.waitForResponse(
      (resp) =>
        resp.url().includes('/api/admin/patients') &&
        resp.url().includes('needs_attention=true'),
    );

    expect(capturedUrl).toContain('needs_attention=true');
  });

  test('filtro dependency_level=SEVERE envia parâmetro correto na URL', async ({ page }) => {
    await seedAdminAndLogin(page);

    let capturedUrl = '';
    await page.route('**/api/admin/patients*', (route) => {
      capturedUrl = route.request().url();
      route.fulfill({ status: 200, contentType: 'application/json', body: mockPatientsList() });
    });
    await mockStatsAfterListMock(page);

    await page.goto('/admin/patients');
    await expect(page.locator('text=Alomon, Francisco').first()).toBeVisible({ timeout: 15000 });

    const dependencySelect = page.locator('[data-testid="filter-dependency"] select');
    await dependencySelect.selectOption('SEVERE');

    await page.waitForResponse(
      (resp) =>
        resp.url().includes('/api/admin/patients') &&
        resp.url().includes('dependency_level=SEVERE'),
    );

    expect(capturedUrl).toContain('dependency_level=SEVERE');
  });

  test('paginação envia offset correto na segunda página', async ({ page }) => {
    await seedAdminAndLogin(page);

    const page1Patients = Array.from({ length: 10 }, (_, i) => ({
      id: `p-p1-${i}`,
      firstName: `Patient${i + 1}`,
      lastName: `Page1`,
      documentType: 'DNI',
      documentNumber: `1000000${i}`,
      dependencyLevel: null,
      clinicalSpecialty: null,
      serviceType: ['AT'],
      needsAttention: false,
      attentionReasons: [],
      createdAt: '2026-04-23T10:00:00Z',
    }));
    const page2Patients = Array.from({ length: 10 }, (_, i) => ({
      id: `p-p2-${i}`,
      firstName: `Patient${i + 1}`,
      lastName: `Page2`,
      documentType: 'DNI',
      documentNumber: `2000000${i}`,
      dependencyLevel: null,
      clinicalSpecialty: null,
      serviceType: ['AT'],
      needsAttention: false,
      attentionReasons: [],
      createdAt: '2026-04-23T10:00:00Z',
    }));

    const capturedUrls: string[] = [];

    await page.route('**/api/admin/patients*', (route) => {
      const url = route.request().url();
      capturedUrls.push(url);
      const urlObj = new URL(url);
      const offset = parseInt(urlObj.searchParams.get('offset') ?? '0');
      const patients = offset === 0 ? page1Patients : page2Patients;
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: patients, total: 25 }),
      });
    });
    await mockStatsAfterListMock(page);

    await page.goto('/admin/patients');
    await expect(page.locator('text=Page1').first()).toBeVisible({ timeout: 15000 });

    // Change to 10 per page
    const itemsPerPageSelect = page.locator('select').last();
    await itemsPerPageSelect.selectOption('10');
    await page.waitForResponse(
      (r) => r.url().includes('/api/admin/patients') && !r.url().includes('/stats'),
    );

    const nextBtn = page.getByRole('button', { name: /Próxima página/i });
    await expect(nextBtn).not.toBeDisabled();
    await nextBtn.click();

    await expect(page.locator('text=Page2').first()).toBeVisible({ timeout: 15000 });

    const offsetUrls = capturedUrls.filter((u) => u.includes('offset=10') && !u.includes('/stats'));
    expect(offsetUrls.length).toBeGreaterThan(0);
  });

  test('estado vazio exibe mensagem de paciente não encontrado', async ({ page }) => {
    await seedAdminAndLogin(page);

    await page.route('**/api/admin/patients*', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: mockPatientsList([], 0),
      }),
    );
    await mockStatsAfterListMock(page);

    await page.goto('/admin/patients');

    await expect(page.locator('text=No se encontraron pacientes').first()).toBeVisible({ timeout: 15000 });
  });

  test('erro de API exibe mensagem de erro na tela', async ({ page }) => {
    await seedAdminAndLogin(page);

    await page.route('**/api/admin/patients*', (route) =>
      route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ success: false, error: 'Internal Server Error' }),
      }),
    );

    await page.goto('/admin/patients');

    await expect(page.locator('text=Error al cargar pacientes').first()).toBeVisible({ timeout: 15000 });
  });

  test('acesso sem autenticação redireciona para /admin/login', async ({ browser }) => {
    const context = await browser.newContext();
    const page    = await context.newPage();

    await page.goto('/admin/patients');
    await expect(page).toHaveURL(/\/admin\/login/, { timeout: 10000 });

    await context.close();
  });

  test('coluna Servicio mostra o ALIAS (não o ENUM) e a linha mostra a data do registro', async ({ page }) => {
    await seedAdminAndLogin(page);

    await page.route('**/api/admin/patients*', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: mockPatientsList() }),
    );
    await mockStatsAfterListMock(page);

    await page.goto('/admin/patients');
    await expect(page.locator('text=Alomon, Francisco').first()).toBeVisible({ timeout: 15000 });

    // Alias, não ENUM. `AT` sozinho é o sintoma do bug — o texto exato não pode
    // existir em célula nenhuma da tabela.
    await expect(page.getByText('Acompañante Terapéutico', { exact: true }).first()).toBeVisible({ timeout: 5000 });
    await expect(page.getByText('Acompañante Terapéutico + Cuidador', { exact: true }).first()).toBeVisible({ timeout: 5000 });
    await expect(page.getByText('AT', { exact: true })).toHaveCount(0);
    await expect(page.getByText('CAREGIVER', { exact: true })).toHaveCount(0);

    // Data do registro: na MESMA célula do nome (sem coluna nova).
    const nameCell = page.locator('td', { hasText: 'Alomon, Francisco' }).first();
    await expect(nameCell).toContainText('23/04/2026');
    await expect(page.locator('th')).toHaveCount(8);
  });

  test('screenshot visual — estado carregado com dados', async ({ page }) => {
    await seedAdminAndLogin(page);

    await page.route('**/api/admin/patients*', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: mockPatientsList() }),
    );
    await mockStatsAfterListMock(page);

    await page.goto('/admin/patients');

    // Wait for content to be fully loaded
    await expect(page.locator('text=Alomon, Francisco').first()).toBeVisible({ timeout: 15000 });

    // Screenshot assertion — captures and compares the visual state
    await expect(page).toHaveScreenshot('admin-patients-loaded.png', {
      fullPage: false,
      maxDiffPixelRatio: 0.02,
    });
  });

  test('badge de status verde para paciente OK, amarelo para atenção', async ({ page }) => {
    await seedAdminAndLogin(page);

    await page.route('**/api/admin/patients*', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: mockPatientsList() }),
    );
    await mockStatsAfterListMock(page);

    await page.goto('/admin/patients');
    await expect(page.locator('text=Alomon, Francisco').first()).toBeVisible({ timeout: 15000 });

    // OK badge — green for Francisco Alomon (needsAttention: false)
    await expect(page.getByText('OK', { exact: true }).first()).toBeVisible({ timeout: 5000 });

    // Atención badge — amber for Máximo Aquino (needsAttention: true)
    await expect(page.getByText('Atención', { exact: true }).first()).toBeVisible({ timeout: 5000 });
  });
});
