/**
 * worker-catchall-redirect.e2e.ts
 *
 * Testa o catch-all de rota (path="*") do App.tsx:
 * - Rota inexistente → redireciona para "/" (home do worker)
 * - Rota "/worker" (sem match exato) → redireciona para "/"
 * - Screenshot baseline confirma que a home do worker renderizou
 *
 * API mockada — não requer backend rodando.
 */

import { test, expect } from '@playwright/test';

test.use({ storageState: 'e2e/.auth/profile-worker.json' });

// ── Mocks de API ─────────────────────────────────────────────────────────────

const MOCK_WORKER_PROGRESS = {
  success: true,
  data: {
    id: 'test-worker-id',
    email: 'test@enlite-test.com',
    firstName: 'Test',
    lastName: 'Worker',
    generalInfo: null,
    serviceArea: null,
    availability: null,
    profession: null,
  },
};

const MOCK_DOCUMENTS = {
  success: true,
  data: {
    id: 'test-docs-id',
    workerId: 'test-worker-id',
    resumeCvUrl: null,
    identityDocumentUrl: null,
    identityDocumentBackUrl: null,
    criminalRecordUrl: null,
    professionalRegistrationUrl: null,
    liabilityInsuranceUrl: null,
    monotributoCertificateUrl: null,
    atCertificateUrl: null,
    aptoPsicofisicoUrl: null,
    analiticoUniversitarioUrl: null,
    cartaRecomendacionUrl: null,
    documentsStatus: 'pending',
    submittedAt: null,
    updatedAt: new Date().toISOString(),
  },
};

const MOCK_AVAILABILITY = {
  success: true,
  data: [],
};

async function mockAllApis(page: import('@playwright/test').Page): Promise<void> {
  // Worker progress
  await page.route('**/api/workers/me/progress**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(MOCK_WORKER_PROGRESS),
    }),
  );

  // Worker documents
  await page.route('**/api/workers/me/documents**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(MOCK_DOCUMENTS),
    }),
  );

  // Worker availability
  await page.route('**/api/workers/me/availability**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(MOCK_AVAILABILITY),
    }),
  );

  // Worker me (generic)
  await page.route('**/api/workers/me**', (route) => {
    if (route.request().method() !== 'GET') {
      return route.continue();
    }
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, data: MOCK_WORKER_PROGRESS.data }),
    });
  });

  // Jobs API (lista vazia — determinismo visual)
  await page.route('**/api/jobs**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, count: 0, data: [] }),
    }),
  );

  // Public jobs API (lista vazia)
  await page.route('**/api/public/v1/jobs**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, data: [] }),
    }),
  );

  // Catch-all worker APIs
  await page.route('**/api/workers/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, data: {} }),
    }),
  );
}

// ── Testes ────────────────────────────────────────────────────────────────────

test.describe('Catch-all de rota — redirect para home', () => {
  test.setTimeout(30000);

  test('Caso 1: rota inexistente /ruta-inexistente-xyz → redireciona para /', async ({ page }) => {
    await mockAllApis(page);
    await page.goto('/ruta-inexistente-xyz');
    await page.waitForLoadState('networkidle');

    const currentPathname = new URL(page.url()).pathname;
    expect(currentPathname).toBe('/');

    // Raiz não está vazia — home do worker renderizou algum conteúdo
    const root = page.locator('#root');
    const childCount = await root.evaluate((el) => el.childElementCount);
    expect(childCount).toBeGreaterThan(0);

    await expect(page).toHaveScreenshot('catchall-home.png', { maxDiffPixelRatio: 0.02 });
  });

  test('Caso 2: /worker (sem match exato) → redireciona para /', async ({ page }) => {
    await mockAllApis(page);
    await page.goto('/worker');
    await page.waitForLoadState('networkidle');

    const currentPathname = new URL(page.url()).pathname;
    expect(currentPathname).toBe('/');

    // Raiz não está vazia
    const root = page.locator('#root');
    const childCount = await root.evaluate((el) => el.childElementCount);
    expect(childCount).toBeGreaterThan(0);
  });
});
