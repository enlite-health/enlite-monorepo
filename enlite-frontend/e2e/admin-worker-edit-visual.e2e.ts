/**
 * admin-worker-edit-visual.e2e.ts
 *
 * Playwright E2E — edição administrativa de worker no WorkerDetailPage.
 * Gate de célula: `PATCH /workers/:id/profile` → `worker:write`. Quem não tem
 * a célula (com `enforcement: 'on'`) não vê o botão "Editar" nem o modal.
 * Papel não decide nada: o contrato ABAC não carrega mais `role`.
 *
 * Cobre:
 *   - com worker:write: vê o botão e abre o modal (screenshot do modal)
 *   - sem worker:write (engine ON): NÃO vê o botão (screenshot do card)
 *   - com worker:write: edita o nome e salva → modal fecha e o nome atualiza
 */

import { test, expect, Page } from '@playwright/test';

const FIREBASE_EMULATOR = 'http://127.0.0.1:9099';
const FIREBASE_API_KEY = 'test-api-key';
const WORKER_ID = 'worker-edit-visual-001';

function makeWorker(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: WORKER_ID, email: 'edit-visual@test.com',
    phone: '+5491155550100', whatsappPhone: '+5491155550100',
    country: 'AR', timezone: 'America/Argentina/Buenos_Aires',
    status: 'REGISTERED', overallStatus: 'QUALIFIED',
    availabilityStatus: 'available', dataSources: ['talentum'],
    platform: 'talentum', createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-03-10T00:00:00Z', firstName: 'Lucía',
    lastName: 'Fernández', sex: null, gender: null, birthDate: null,
    documentType: 'DNI', documentNumber: '30111222', profilePhotoUrl: null,
    profession: 'CAREGIVER', occupation: null, knowledgeLevel: null,
    titleCertificate: null, experienceTypes: [], yearsExperience: null,
    preferredTypes: [], preferredAgeRange: [], languages: [],
    sexualOrientation: null, race: null, religion: null,
    weightKg: null, heightCm: null, hobbies: [],
    diagnosticPreferences: [], linkedinUrl: null,
    isMatchable: true, isActive: true, isTest: false, serviceAreas: [],
    location: null, encuadres: [], availability: [], documents: null,
    ...overrides,
  };
}

/**
 * `permissions === null` = sem contrato: engine desligado, a tela aparece como
 * sempre apareceu (régua de rollout D268). Um array liga `enforcement: 'on'`.
 */
async function seedAndLogin(page: Page, permissions: string[] | null = null): Promise<void> {
  const rnd = Math.random().toString(36).slice(2, 8);
  const email = `e2e.edit.${Date.now()}.${rnd}@test.com`;
  const password = 'TestAdmin123!';
  const res = await fetch(
    `${FIREBASE_EMULATOR}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=${FIREBASE_API_KEY}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, returnSecureToken: true }) },
  );
  const data = (await res.json()) as Record<string, unknown>;
  if (!data.localId) throw new Error(`Firebase sign-up failed: ${JSON.stringify(data)}`);
  const uid = data.localId as string;

  await page.route('**/api/admin/auth/profile', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ success: true, data: { id: uid, email,
        firstName: 'Edit', lastName: 'Visual', isActive: true, mustChangePassword: false } }) }));
  if (permissions !== null) {
    await page.route('**/v1/me/authz', (r) =>
      r.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify({ uid, tenantId: 't', status: 'ACTIVE', permissions,
          countries: ['AR'], groups: [], features: {}, enforcement: 'on' }) }));
  }
  await page.route('**/api/admin/workers/stats', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ success: true, data: { today: 0, yesterday: 0, sevenDaysAgo: 0 } }) }));
  await page.route('**/api/admin/workers/case-options', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ success: true, data: [] }) }));

  await page.goto('/admin/login');
  await page.locator('input[type="email"]').fill(email);
  await page.locator('input[type="password"]').fill(password);
  await page.getByRole('button', { name: /Iniciar|Entrar/i }).click();
  await expect(page).not.toHaveURL(/.*login.*/, { timeout: 20_000 });
}

async function mockWorkerDetail(page: Page, overrides: Record<string, unknown> = {}): Promise<void> {
  await page.route(`**/api/admin/workers/${WORKER_ID}`, (route) => {
    if (route.request().url().includes('/documents') || route.request().url().includes('/additional')) {
      return route.continue();
    }
    return route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ success: true, data: makeWorker(overrides) }) });
  });
  await page.route(`**/api/admin/workers/${WORKER_ID}/additional-documents`, (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) });
  });
}

async function navigate(page: Page): Promise<void> {
  await page.goto(`/admin/workers/${WORKER_ID}`);
  await expect(page.getByText('Datos Personales', { exact: false }).first()).toBeVisible({ timeout: 20_000 });
}

test.describe('Admin Worker Edit — Visual + Gate', () => {
  test.setTimeout(90_000);
  test.use({ viewport: { width: 1440, height: 900 } });

  test('com worker:write: vê o botão Editar e abre o modal', async ({ page }) => {
    await seedAndLogin(page, ['worker:read', 'worker_pii:read', 'worker_document:read', 'worker:write']);
    await mockWorkerDetail(page);
    await navigate(page);

    const editButton = page.locator('[data-testid="worker-edit-button"]');
    await expect(editButton).toBeVisible({ timeout: 10_000 });
    await editButton.click();

    const modal = page.locator('[data-testid="worker-edit-modal"]');
    await expect(modal).toBeVisible({ timeout: 10_000 });
    await expect(modal.locator('[data-testid="we-firstName"]')).toHaveValue('Lucía');
    await expect(modal.locator('[data-testid="we-profession"]')).toBeVisible();

    await expect(modal).toHaveScreenshot('worker-edit-modal-com-celula.png');
  });

  test('sem worker:write (engine ON): NÃO vê o botão Editar', async ({ page }) => {
    await seedAndLogin(page, ['worker:read', 'worker_pii:read', 'worker_document:read']);
    await mockWorkerDetail(page);
    await navigate(page);

    await expect(page.locator('[data-testid="worker-edit-button"]')).toHaveCount(0);

    await expect(page.getByText('Datos Personales', { exact: false }).first())
      .toHaveScreenshot('worker-detail-no-edit-sem-celula.png');
  });

  test('com worker:write: edita o nome e salva → modal fecha e nome atualiza', async ({ page }) => {
    await seedAndLogin(page, ['worker:read', 'worker_pii:read', 'worker_document:read', 'worker:write']);
    await mockWorkerDetail(page);
    await navigate(page);

    await page.locator('[data-testid="worker-edit-button"]').click();
    const modal = page.locator('[data-testid="worker-edit-modal"]');
    await expect(modal).toBeVisible();

    await modal.locator('[data-testid="we-firstName"]').fill('Mariana');

    // PATCH /profile → 200; refetch devolve o nome atualizado
    await page.route(`**/api/admin/workers/${WORKER_ID}/profile`, (r) =>
      r.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify({ success: true, data: { workerId: WORKER_ID, fieldsUpdated: ['firstName'] } }) }));
    await mockWorkerDetail(page, { firstName: 'Mariana' });

    await modal.locator('[data-testid="we-save"]').click();

    await expect(modal).toHaveCount(0, { timeout: 10_000 });
    await expect(page.getByText('Mariana', { exact: false }).first()).toBeVisible({ timeout: 10_000 });
  });
});
