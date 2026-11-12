/**
 * encuadre-rejection.e2e.ts
 *
 * Playwright E2E — Motivo de Rejeição Estruturado na tela de detalhe da vaga
 *
 * Fluxo coberto:
 *   - Encuadres rejeitados sem motivo exibem dropdown "Seleccionar motivo..."
 *   - Encuadres rejeitados COM motivo exibem badge colorido
 *   - Dropdown contém todas as 8 opções de rejeição
 *   - Selecionar uma opção dispara PUT ao backend
 *   - Encuadres não-rejeitados NÃO exibem dropdown
 */

import { test, expect, Page } from '@playwright/test';

const FIREBASE_EMULATOR = 'http://127.0.0.1:9099';
const FIREBASE_API_KEY  = 'test-api-key';

const MOCK_VACANCY_ID = 'cccccccc-0001-0001-0001-cccccccccccc';

const MOCK_VACANCY = {
  id: MOCK_VACANCY_ID,
  case_number: 33001,
  title: 'Caso 33001 — Rejection Test',
  status: 'BUSQUEDA',
  country: 'Argentina',
  patient_first_name: 'Paciente',
  patient_last_name: 'Rejection',
  encuadres: [
    {
      id: 'rej-1',
      worker_name: 'Ana García',
      worker_phone: '+549111',
      interview_date: '2026-03-20',
      resultado: 'RECHAZADO',
      attended: true,
      rejection_reason_category: null, // SEM motivo → dropdown deve aparecer
      rejection_reason: null,
    },
    {
      id: 'rej-2',
      worker_name: 'Bruno López',
      worker_phone: '+549222',
      interview_date: '2026-03-18',
      resultado: 'RECHAZADO',
      attended: true,
      rejection_reason_category: 'DISTANCE', // COM motivo → badge deve aparecer
      rejection_reason: 'Vive lejos',
    },
    {
      id: 'rej-3',
      worker_name: 'Carlos Ruiz',
      worker_phone: '+549333',
      interview_date: '2026-03-25',
      resultado: 'SELECCIONADO', // NÃO rejeitado → sem dropdown
      attended: true,
      rejection_reason_category: null,
      rejection_reason: null,
    },
    {
      id: 'rej-4',
      worker_name: 'Diana Martínez',
      worker_phone: '+549444',
      interview_date: '2026-03-22',
      resultado: 'AT_NO_ACEPTA', // Rejeitado → dropdown deve aparecer
      attended: true,
      rejection_reason_category: 'SCHEDULE_INCOMPATIBLE',
      rejection_reason: null,
    },
  ],
  publications: [],
};

// ── Helpers ───────────────────────────────────────────────────────────────

async function seedAdminAndLogin(page: Page): Promise<void> {
  const email    = `e2e.rejection.${Date.now()}@test.com`;
  const password = 'TestAdmin123!';

  const signUpRes = await fetch(
    `${FIREBASE_EMULATOR}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=${FIREBASE_API_KEY}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password, returnSecureToken: true }) },
  );
  const { localId: uid } = (await signUpRes.json()) as any;

  await page.route('**/api/admin/auth/profile', route =>
    route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ success: true, data: { id: uid, email, role: 'superadmin', firstName: 'Admin', lastName: 'Rejection', isActive: true, mustChangePassword: false } }),
    }),
  );

  await page.goto('/login?next=%2Fadmin');
  await page.locator('input[type="email"]').fill(email);
  await page.locator('input[type="password"]').fill(password);
  await page.getByRole('button', { name: /Iniciar|Entrar/i }).click();
  await expect(page).not.toHaveURL(/.*login.*/, { timeout: 20000 });
}

// ── Testes ────────────────────────────────────────────────────────────────

test.describe('Encuadre Rejection — VacancyDetailPage', () => {
  test.setTimeout(60000);

  test('encuadre rejeitado sem motivo exibe dropdown de seleção', async ({ page }) => {
    await seedAdminAndLogin(page);

    await page.route(`**/api/admin/vacancies/${MOCK_VACANCY_ID}`, route =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data: MOCK_VACANCY }) }),
    );

    await page.goto(`/admin/vacancies/${MOCK_VACANCY_ID}`);

    // Ana García — RECHAZADO sem motivo → dropdown select deve existir na tabela
    await expect(page.locator('text=Ana García').first()).toBeVisible({ timeout: 15000 });
    // O <select> na tabela é o dropdown de motivo de rejeição
    await expect(page.locator('table select').first()).toBeVisible();
  });

  test('encuadre rejeitado COM motivo exibe badge colorido (span, nao option)', async ({ page }) => {
    await seedAdminAndLogin(page);

    await page.route(`**/api/admin/vacancies/${MOCK_VACANCY_ID}`, route =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data: MOCK_VACANCY }) }),
    );

    await page.goto(`/admin/vacancies/${MOCK_VACANCY_ID}`);

    // Bruno López — RECHAZADO com DISTANCE → badge <span> "Distancia al lugar"
    await expect(page.locator('text=Bruno López').first()).toBeVisible({ timeout: 15000 });
    // Badge é um <span> com classe rounded-full, não um <option>
    await expect(page.locator('span.rounded-full:has-text("Distancia al lugar")').first()).toBeVisible();

    // Diana Martínez — AT_NO_ACEPTA com SCHEDULE_INCOMPATIBLE → badge <span>
    await expect(page.locator('text=Diana Martínez').first()).toBeVisible();
    await expect(page.locator('span.rounded-full:has-text("Horario incompatible")').first()).toBeVisible();
  });

  test('encuadre SELECCIONADO não exibe dropdown de rejeição', async ({ page }) => {
    await seedAdminAndLogin(page);

    await page.route(`**/api/admin/vacancies/${MOCK_VACANCY_ID}`, route =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data: MOCK_VACANCY }) }),
    );

    await page.goto(`/admin/vacancies/${MOCK_VACANCY_ID}`);

    // Carlos Ruiz — SELECCIONADO → NÃO deve ter dropdown
    await expect(page.locator('text=Carlos Ruiz').first()).toBeVisible({ timeout: 15000 });

    // O "—" na coluna de motivo deve estar visível para não-rejeitados
    // E NÃO deve haver dropdown extra (contamos os selects na tabela)
    const dropdowns = page.locator('table select');
    // Deve ter exatamente 1 dropdown (apenas Ana García sem motivo)
    await expect(dropdowns).toHaveCount(1);
  });

  test('dropdown contém todas as 8 opções de rejeição', async ({ page }) => {
    await seedAdminAndLogin(page);

    await page.route(`**/api/admin/vacancies/${MOCK_VACANCY_ID}`, route =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data: MOCK_VACANCY }) }),
    );

    await page.goto(`/admin/vacancies/${MOCK_VACANCY_ID}`);

    // Localizar o dropdown de Ana García
    const dropdown = page.locator('table select').first();
    await expect(dropdown).toBeVisible({ timeout: 15000 });

    // Verificar que contém as 8 opções + placeholder
    const options = dropdown.locator('option');
    await expect(options).toHaveCount(9); // 1 placeholder + 8 categories
  });

  test('selecionar motivo dispara PUT para o backend', async ({ page }) => {
    await seedAdminAndLogin(page);

    let capturedRequest: { url: string; body: string } | null = null;

    await page.route(`**/api/admin/vacancies/${MOCK_VACANCY_ID}`, route =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data: MOCK_VACANCY }) }),
    );

    // Interceptar PUT para capturar o request
    await page.route('**/api/admin/encuadres/rej-1/result', route => {
      capturedRequest = {
        url: route.request().url(),
        body: route.request().postData() ?? '',
      };
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data: { encuadreId: 'rej-1', resultado: 'RECHAZADO' } }) });
    });

    await page.goto(`/admin/vacancies/${MOCK_VACANCY_ID}`);

    const dropdown = page.locator('table select').first();
    await expect(dropdown).toBeVisible({ timeout: 15000 });

    // Selecionar "Distancia al lugar" (value: DISTANCE)
    await dropdown.selectOption('DISTANCE');

    // Aguardar o request ser enviado
    await page.waitForTimeout(1000);

    expect(capturedRequest).not.toBeNull();
    expect(capturedRequest!.url).toContain('/api/admin/encuadres/rej-1/result');
    const body = JSON.parse(capturedRequest!.body);
    expect(body.rejectionReasonCategory).toBe('DISTANCE');
    expect(body.resultado).toBe('RECHAZADO');
  });
});
