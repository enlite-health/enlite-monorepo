/**
 * pending-address-review.e2e.ts — Playwright E2E
 *
 * Fase 8: Revisão de domicílios pendentes.
 *
 * Cenários cobertos:
 *   1. Lista com 2 vagas pendentes → screenshot da tabela
 *   2. Resolver vaga com endereço existente → vaga desaparece da lista
 *   3. Resolver vaga criando novo endereço → vaga desaparece da lista
 *
 * Todas as chamadas à API são mockadas via page.route(). Nenhum banco real.
 */

import { test, expect, type Page } from '@playwright/test';

const FIREBASE_EMULATOR = 'http://127.0.0.1:9099';
const FIREBASE_API_KEY = 'test-api-key';

// ── Fixtures ───────────────────────────────────────────────────────────────────

const PENDING_ITEM_1 = {
  id: 'vac-1',
  case_number: 10,
  vacancy_number: 1,
  title: 'CASO 10-1',
  status: 'PENDING_REVIEW',
  service_address_formatted: 'Av. Corrientes 1234, CABA',
  patient_id: 'pat-10',
  patient_name: 'Juan Pérez',
  audit_match_type: 'NONE',
  audit_confidence_score: null,
  audit_attempted_match: null,
};

const PENDING_ITEM_2 = {
  id: 'vac-2',
  case_number: 11,
  vacancy_number: 1,
  title: 'CASO 11-1',
  status: 'PENDING_REVIEW',
  service_address_formatted: 'Belgrano 500, CABA',
  patient_id: 'pat-11',
  patient_name: 'María López',
  audit_match_type: 'FUZZY',
  audit_confidence_score: 0.6,
  audit_attempted_match: 'Belgrano 500',
};

const TWO_ITEMS_RESPONSE = {
  success: true,
  data: [PENDING_ITEM_1, PENDING_ITEM_2],
  total: 2,
};

const EXISTING_ADDRESS = {
  id: 'addr-existing-1',
  patient_id: 'pat-10',
  address_formatted: 'Av. Corrientes 1500, CABA',
  address_raw: 'Corrientes 1500',
  address_type: 'service',
  display_order: 0,
  source: 'manual',
};

// ── Auth helper ─────────────────────────────────────────────────────────────────

async function loginAsAdmin(page: Page): Promise<void> {
  const email = `e2e.pending-addr.${Date.now()}@test.com`;
  const password = 'TestAdmin123!';

  const signUpRes = await fetch(
    `${FIREBASE_EMULATOR}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=${FIREBASE_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, returnSecureToken: true }),
    },
  );
  const { localId: uid } = (await signUpRes.json()) as any;

  await page.route('**/api/admin/auth/profile', route =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        data: {
          id: uid,
          email,
          role: 'superadmin',
          firstName: 'Admin',
          lastName: 'E2E',
          isActive: true,
          mustChangePassword: false,
        },
      }),
    }),
  );

  await page.goto('/login?next=%2Fadmin');
  await page.locator('input[type="email"]').fill(email);
  await page.locator('input[type="password"]').fill(password);
  await page.getByRole('button', { name: /Iniciar sesión/i }).click();
  await expect(page).not.toHaveURL(/.*login.*/, { timeout: 20000 });
}

// ── Scenario 1: List with 2 pending vacancies ──────────────────────────────────

test.describe('Scenario 1 — List with 2 pending vacancies', () => {
  test('shows table with 2 rows and match type badges', async ({ page }) => {
    await loginAsAdmin(page);

    await page.route('**/api/admin/vacancies/pending-address-review**', route =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(TWO_ITEMS_RESPONSE),
      }),
    );

    await page.goto('/admin/vacancies/pending-address-review');
    await expect(page).not.toHaveURL(/login/, { timeout: 15000 });

    // Title visible
    await expect(page.getByText('Revisión de domicilios pendientes')).toBeVisible({
      timeout: 10000,
    });

    // Both rows visible
    await expect(page.getByText('CASO 10-1')).toBeVisible();
    await expect(page.getByText('Juan Pérez')).toBeVisible();
    await expect(page.getByText('CASO 11-1')).toBeVisible();
    await expect(page.getByText('María López')).toBeVisible();

    // Badge types
    await expect(page.getByText('Sin match')).toBeVisible();
    await expect(page.getByText('Aproximado')).toBeVisible();

    // Counter text
    await expect(page.getByText('2 vacantes pendientes')).toBeVisible();

    // Screenshot of the table
    await expect(page).toHaveScreenshot('pending-address-review-list.png', { fullPage: false });
  });
});

// ── Scenario 2: Resolve with existing address ─────────────────────────────────

test.describe('Scenario 2 — Resolve vacancy with existing address', () => {
  test('selecting existing address and confirming removes item from list', async ({ page }) => {
    await loginAsAdmin(page);

    // Static mock — hook uses optimistic removal so no refetch is needed
    await page.route('**/api/admin/vacancies/pending-address-review**', route =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(TWO_ITEMS_RESPONSE),
      }),
    );

    await page.route('**/api/admin/patients/pat-10/addresses', route =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: [EXISTING_ADDRESS] }),
      }),
    );

    await page.route('**/api/admin/vacancies/vac-1/resolve-address-review', route =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: null }),
      }),
    );

    await page.goto('/admin/vacancies/pending-address-review');
    await expect(page.getByText('CASO 10-1')).toBeVisible({ timeout: 10000 });

    // Open resolve modal for vac-1
    const resolveButtons = page.getByRole('button', { name: 'Resolver' });
    await resolveButtons.first().click();

    // Modal opens
    await expect(page.getByText('Confirmar domicilio del paciente')).toBeVisible({
      timeout: 5000,
    });

    // Legacy address is shown as reference
    await expect(page.getByText('Domicilio anterior (referencia)')).toBeVisible();
    await expect(page.getByText('Av. Corrientes 1234, CABA').first()).toBeVisible();
    // Existing address card has a different value
    await expect(page.getByText('Av. Corrientes 1500, CABA')).toBeVisible();

    // Screenshot of modal with existing addresses
    await expect(page).toHaveScreenshot('pending-address-review-modal-existing.png', {
      fullPage: false,
    });

    // Select the existing address card (the button with the candidate address)
    await page.getByRole('button').filter({ hasText: 'Av. Corrientes 1500, CABA' }).click();

    // Confirm button enabled — click it
    const confirmBtn = page.getByRole('button', { name: 'Confirmar' });
    await expect(confirmBtn).not.toBeDisabled();
    await confirmBtn.click();

    // Modal closes and vac-1 disappears from list
    await expect(page.getByText('Confirmar domicilio del paciente')).not.toBeVisible({
      timeout: 5000,
    });
    await expect(page.getByText('CASO 10-1')).not.toBeVisible({ timeout: 5000 });
    await expect(page.getByText('CASO 11-1')).toBeVisible();

    // Screenshot after resolution
    await expect(page).toHaveScreenshot('pending-address-review-after-resolve-existing.png', {
      fullPage: false,
    });
  });
});

// ── Scenario 3: Resolve creating new address ──────────────────────────────────

test.describe('Scenario 3 — Resolve vacancy creating new address', () => {
  test('filling new address form and confirming removes item from list', async ({ page }) => {
    await loginAsAdmin(page);

    await page.route('**/api/admin/vacancies/pending-address-review**', route =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: [PENDING_ITEM_1], total: 1 }),
      }),
    );

    await page.route('**/api/admin/patients/pat-10/addresses', route =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: [] }),
      }),
    );

    await page.route('**/api/admin/vacancies/vac-1/resolve-address-review', route =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: null }),
      }),
    );

    await page.goto('/admin/vacancies/pending-address-review');
    await expect(page.getByText('CASO 10-1')).toBeVisible({ timeout: 10000 });

    // Open modal
    await page.getByRole('button', { name: 'Resolver' }).click();
    await expect(page.getByText('Confirmar domicilio del paciente')).toBeVisible({
      timeout: 5000,
    });

    // No existing addresses — show create form
    await page.getByText('Crear nuevo domicilio').click();

    // Fill in new address (exact match to avoid matching "Dirección abreviada")
    const addressInput = page.getByPlaceholder('Dirección', { exact: true });
    await expect(addressInput).toBeVisible();
    await addressInput.fill('Florida 200, CABA');

    // Screenshot of modal with new address form
    await expect(page).toHaveScreenshot('pending-address-review-modal-create.png', {
      fullPage: false,
    });

    // Confirm button should be enabled
    const confirmBtn = page.getByRole('button', { name: 'Confirmar' });
    await expect(confirmBtn).not.toBeDisabled();
    await confirmBtn.click();

    // Modal closes and item removed from list
    await expect(page.getByText('Confirmar domicilio del paciente')).not.toBeVisible({
      timeout: 5000,
    });

    // Empty state since 1 item was resolved
    await expect(page.getByText('¡Bien! No hay vacantes pendientes de revisión.')).toBeVisible({
      timeout: 5000,
    });

    // Screenshot of empty state
    await expect(page).toHaveScreenshot('pending-address-review-empty-state.png', {
      fullPage: false,
    });
  });
});
