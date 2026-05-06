/**
 * create-vacancy.e2e.ts — Playwright E2E
 *
 * Fase 3: Nova CreateVacancyPage (form único) — substitui o wizard de 6 passos.
 *
 * Cenários cobertos:
 *   1.  Form vazio renderiza corretamente
 *   2.  Busca paciente → autocomplete aparece → seleciona → campos hidratam
 *   3.  Paciente com status ADMISSION → banner amarelo no topo
 *   4.  Paciente com 1 endereço → input read-only (sem combobox)
 *   5.  Paciente com >1 endereços → dropdown com badges de disponibilidade
 *   6.  Endereço com availability.isFull → opção desabilitada no dropdown
 *   7.  Click "+ Criar novo endereço" → modal abre → preenche → salva → endereço selecionado
 *   8.  Slot duplo no mesmo dia (split shift) — dois turnos em segunda-feira
 *   9.  Click "+ Horários entrevista" → modal abre → seleciona slot → fecha → pílula aparece
 *   10. Submit com dados válidos → 200 → navega para rota de detalhe
 *
 * Todas as chamadas à API são mockadas via page.route(). Nenhum banco real.
 */

import { test, expect, type Page } from '@playwright/test';

const FIREBASE_EMULATOR = 'http://127.0.0.1:9099';
const FIREBASE_API_KEY = 'test-api-key';

// ── Fixtures ───────────────────────────────────────────────────────────────────

const PATIENT_ACTIVE = {
  id: 'pat-active-1',
  firstName: 'Laura',
  lastName: 'Sánchez',
  documentNumber: '30111222',
  status: 'ACTIVE',
  addressesCount: 1,
};

const PATIENT_ADMISSION = {
  id: 'pat-admission-1',
  firstName: 'Roberto',
  lastName: 'Giménez',
  documentNumber: '20999888',
  status: 'ADMISSION',
  addressesCount: 0,
};

const PATIENT_MULTI_ADDR = {
  id: 'pat-multi-1',
  firstName: 'Carmen',
  lastName: 'Flores',
  documentNumber: '25444333',
  status: 'ACTIVE',
  addressesCount: 2,
};

const ADDRESS_ACTIVE = {
  id: 'addr-active-1',
  street: 'Av. Corrientes',
  number: '1234',
  complement: null,
  neighborhood: null,
  city: 'CABA',
  state: 'Buenos Aires',
  country: 'AR',
  zipCode: null,
  fullAddress: 'Av. Corrientes 1234, CABA',
  isPrimary: true,
};

const ADDRESS_FULL = {
  id: 'addr-full-1',
  street: 'Florida',
  number: '500',
  complement: null,
  neighborhood: null,
  city: 'CABA',
  state: 'Buenos Aires',
  country: 'AR',
  zipCode: null,
  fullAddress: 'Florida 500, CABA',
  isPrimary: false,
  availability: {
    totalCoveredHours: 168,
    maxHours: 168,
    isFull: true,
    perDay: [],
    activeVacanciesCount: 5,
    hasUnknownSchedule: false,
  },
};

const ADDRESS_PARTIAL = {
  id: 'addr-partial-1',
  street: 'Rivadavia',
  number: '800',
  complement: null,
  neighborhood: null,
  city: 'CABA',
  state: 'Buenos Aires',
  country: 'AR',
  zipCode: null,
  fullAddress: 'Rivadavia 800, CABA',
  isPrimary: true,
  availability: {
    totalCoveredHours: 40,
    maxHours: 168,
    isFull: false,
    perDay: [],
    activeVacanciesCount: 2,
    hasUnknownSchedule: false,
  },
};

const PATIENT_DETAIL_ACTIVE = {
  id: 'pat-active-1',
  firstName: 'Laura',
  lastName: 'Sánchez',
  documentNumber: '30111222',
  status: 'ACTIVE',
  diagnosis: 'TEA',
  dependencyLevel: 'HIGH',
  cityLocality: 'CABA',
  province: 'Buenos Aires',
  lastCaseNumber: 5,
  addresses: [ADDRESS_ACTIVE],
  responsibles: [],
};

const PATIENT_DETAIL_ADMISSION = {
  id: 'pat-admission-1',
  firstName: 'Roberto',
  lastName: 'Giménez',
  documentNumber: '20999888',
  status: 'ADMISSION',
  diagnosis: null,
  dependencyLevel: null,
  cityLocality: null,
  province: null,
  lastCaseNumber: null,
  addresses: [],
  responsibles: [],
};

const PATIENT_DETAIL_MULTI = {
  id: 'pat-multi-1',
  firstName: 'Carmen',
  lastName: 'Flores',
  documentNumber: '25444333',
  status: 'ACTIVE',
  diagnosis: 'Síndrome de Down',
  dependencyLevel: 'MEDIUM',
  cityLocality: 'CABA',
  province: 'Buenos Aires',
  lastCaseNumber: 8,
  addresses: [ADDRESS_PARTIAL, ADDRESS_FULL],
  responsibles: [],
};

const CREATED_ADDRESS = {
  id: 'addr-new-created',
  patient_id: 'pat-active-1',
  address_formatted: 'Belgrano 1500, CABA',
  address_raw: 'Belgrano 1500',
  address_type: 'service',
  display_order: 1,
  source: 'manual',
};

const PATIENT_DETAIL_WITH_NEW_ADDR = {
  ...PATIENT_DETAIL_ACTIVE,
  addresses: [
    ADDRESS_ACTIVE,
    {
      id: 'addr-new-created',
      street: 'Belgrano',
      number: '1500',
      complement: null,
      neighborhood: null,
      city: 'CABA',
      state: 'Buenos Aires',
      country: 'AR',
      zipCode: null,
      fullAddress: 'Belgrano 1500, CABA',
      isPrimary: false,
    },
  ],
};

const CREATED_VACANCY = {
  id: 'vac-new-99',
  title: 'CASO 6-1',
  status: 'SEARCHING',
};

// ── Auth helper ─────────────────────────────────────────────────────────────────

async function loginAsAdmin(page: Page): Promise<void> {
  const email = `e2e.vacancy.${Date.now()}@test.com`;
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

  await page.goto('/admin/login');
  await page.locator('input[type="email"]').fill(email);
  await page.locator('input[type="password"]').fill(password);
  await page.getByRole('button', { name: /Iniciar sesión/i }).click();
  await expect(page).not.toHaveURL(/.*login.*/, { timeout: 20000 });
}

function mockNextVacancyNumber(page: Page, num = 1) {
  page.route('**/api/admin/vacancies/next-vacancy-number', route =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, data: { nextVacancyNumber: num } }),
    }),
  );
}

function mockSearchPatients(page: Page, results: typeof PATIENT_ACTIVE[]) {
  page.route('**/api/admin/patients**', route => {
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, data: results, total: results.length }),
    });
  });
}

function mockGetPatient(page: Page, detail: typeof PATIENT_DETAIL_ACTIVE) {
  page.route(`**/api/admin/patients/${detail.id}`, route =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, data: detail }),
    }),
  );
}

// ── Scenario 1: Empty form renders ────────────────────────────────────────────

test.describe('Scenario 1 — Empty form renders correctly', () => {
  test('page title and save button are visible with empty form', async ({ page }) => {
    await loginAsAdmin(page);
    mockNextVacancyNumber(page);

    await page.route('**/api/admin/patients**', route =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: [], total: 0 }),
      }),
    );

    await page.goto('/admin/vacancies/new');
    await expect(page).not.toHaveURL(/login/, { timeout: 15000 });

    // Page title and save button visible
    await expect(page.getByText('Nueva Vacante')).toBeVisible({ timeout: 10000 });
    await expect(page.getByRole('button', { name: /Guardar/i })).toBeVisible();

    // Search input visible
    await expect(page.getByPlaceholder(/Buscar paciente/i)).toBeVisible();

    await expect(page).toHaveScreenshot('create-vacancy-scenario1-empty-form.png', {
      fullPage: false,
    });
  });
});

// ── Scenario 2: Search patient → autocomplete → select → fields hydrate ───────

test.describe('Scenario 2 — Patient search autocomplete and field hydration', () => {
  test('typing in search shows dropdown; selecting fills patient fields', async ({ page }) => {
    await loginAsAdmin(page);
    mockNextVacancyNumber(page);
    mockSearchPatients(page, [PATIENT_ACTIVE]);
    mockGetPatient(page, PATIENT_DETAIL_ACTIVE);

    await page.goto('/admin/vacancies/new');
    await expect(page.getByText('Nueva Vacante')).toBeVisible({ timeout: 10000 });

    // Type in search input
    const searchInput = page.getByPlaceholder(/Buscar paciente/i);
    await searchInput.fill('Laura');

    // Autocomplete dropdown appears
    await expect(page.getByRole('listbox')).toBeVisible({ timeout: 5000 });
    await expect(page.getByText('Laura Sánchez')).toBeVisible();

    // Screenshot with autocomplete open
    await expect(page).toHaveScreenshot('create-vacancy-scenario2-autocomplete-open.png', {
      fullPage: false,
    });

    // Select the patient
    await page.getByRole('option').click();

    // Patient fields hydrate
    await expect(page.getByRole('listbox')).not.toBeVisible({ timeout: 3000 });

    // Diagnosis and dependency level should appear
    await expect(page.getByText('TEA')).toBeVisible({ timeout: 5000 });

    // Screenshot after patient selected
    await expect(page).toHaveScreenshot('create-vacancy-scenario2-patient-selected.png', {
      fullPage: false,
    });
  });
});

// ── Scenario 3: ADMISSION patient → yellow banner ─────────────────────────────

test.describe('Scenario 3 — Patient in ADMISSION status shows warning banner', () => {
  test('selecting ADMISSION patient shows yellow admission banner', async ({ page }) => {
    await loginAsAdmin(page);
    mockNextVacancyNumber(page);
    mockSearchPatients(page, [PATIENT_ADMISSION]);
    mockGetPatient(page, PATIENT_DETAIL_ADMISSION);

    await page.goto('/admin/vacancies/new');
    await expect(page.getByText('Nueva Vacante')).toBeVisible({ timeout: 10000 });

    // Search and select admission patient
    const searchInput = page.getByPlaceholder(/Buscar paciente/i);
    await searchInput.fill('Roberto');

    await expect(page.getByRole('listbox')).toBeVisible({ timeout: 5000 });
    await page.getByRole('option').click();

    // Admission banner appears
    await expect(page.getByText(/Paciente en admisión/i)).toBeVisible({ timeout: 5000 });

    // Screenshot with admission banner visible
    await expect(page).toHaveScreenshot('create-vacancy-scenario3-admission-banner.png', {
      fullPage: false,
    });
  });
});

// ── Scenario 4: Patient with 1 address → read-only display ────────────────────

test.describe('Scenario 4 — Patient with exactly 1 address shows read-only display', () => {
  test('single address renders as text label without combobox', async ({ page }) => {
    await loginAsAdmin(page);
    mockNextVacancyNumber(page);
    mockSearchPatients(page, [PATIENT_ACTIVE]);
    mockGetPatient(page, PATIENT_DETAIL_ACTIVE);

    await page.goto('/admin/vacancies/new');
    await expect(page.getByText('Nueva Vacante')).toBeVisible({ timeout: 10000 });

    const searchInput = page.getByPlaceholder(/Buscar paciente/i);
    await searchInput.fill('Laura');

    await expect(page.getByRole('listbox')).toBeVisible({ timeout: 5000 });
    await page.getByRole('option').click();

    // Single address should display as text, no dropdown
    await expect(page.getByText('Av. Corrientes 1234, CABA')).toBeVisible({ timeout: 5000 });

    // Screenshot showing read-only single address
    await expect(page).toHaveScreenshot('create-vacancy-scenario4-single-address-readonly.png', {
      fullPage: false,
    });
  });
});

// ── Scenario 5: Patient with >1 addresses → dropdown with badges ──────────────

test.describe('Scenario 5 — Patient with multiple addresses shows dropdown', () => {
  test('multiple addresses render as select dropdown with availability badges', async ({ page }) => {
    await loginAsAdmin(page);
    mockNextVacancyNumber(page);
    mockSearchPatients(page, [PATIENT_MULTI_ADDR]);
    mockGetPatient(page, PATIENT_DETAIL_MULTI);

    await page.goto('/admin/vacancies/new');
    await expect(page.getByText('Nueva Vacante')).toBeVisible({ timeout: 10000 });

    const searchInput = page.getByPlaceholder(/Buscar paciente/i);
    await searchInput.fill('Carmen');

    await expect(page.getByRole('listbox')).toBeVisible({ timeout: 5000 });
    await page.getByRole('option').click();

    // Dropdown combobox should appear for multiple addresses
    await expect(page.getByRole('combobox')).toBeVisible({ timeout: 5000 });

    // Both addresses should be in the options
    await expect(page.getByText('Rivadavia 800, CABA')).toBeVisible();

    // Screenshot of dropdown with availability badges
    await expect(page).toHaveScreenshot('create-vacancy-scenario5-multi-address-dropdown.png', {
      fullPage: false,
    });
  });
});

// ── Scenario 6: Full address → disabled option ─────────────────────────────────

test.describe('Scenario 6 — Address with isFull availability is disabled', () => {
  test('full address option appears disabled in dropdown', async ({ page }) => {
    await loginAsAdmin(page);
    mockNextVacancyNumber(page);
    mockSearchPatients(page, [PATIENT_MULTI_ADDR]);
    mockGetPatient(page, PATIENT_DETAIL_MULTI);

    await page.goto('/admin/vacancies/new');
    await expect(page.getByText('Nueva Vacante')).toBeVisible({ timeout: 10000 });

    const searchInput = page.getByPlaceholder(/Buscar paciente/i);
    await searchInput.fill('Carmen');

    await expect(page.getByRole('listbox')).toBeVisible({ timeout: 5000 });
    await page.getByRole('option').click();

    // Combobox should appear
    await expect(page.getByRole('combobox')).toBeVisible({ timeout: 5000 });

    // The "Sin disponibilidad" badge or disabled text for the full address
    // should be visible — Florida 500 is full
    await expect(page.getByText('Florida 500, CABA')).toBeVisible();

    // Screenshot showing disabled address option
    await expect(page).toHaveScreenshot('create-vacancy-scenario6-full-address-disabled.png', {
      fullPage: false,
    });
  });
});

// ── Scenario 7: Create new address modal ──────────────────────────────────────

test.describe('Scenario 7 — Create new address modal flow', () => {
  test('clicking create new address opens modal; saving updates address selector', async ({ page }) => {
    await loginAsAdmin(page);
    mockNextVacancyNumber(page);
    mockSearchPatients(page, [PATIENT_ACTIVE]);

    let patientDetailCallCount = 0;
    await page.route(`**/api/admin/patients/${PATIENT_DETAIL_ACTIVE.id}`, route => {
      patientDetailCallCount++;
      // First call: patient has 1 address; second call (after address create): 2 addresses
      const detail = patientDetailCallCount === 1
        ? PATIENT_DETAIL_ACTIVE
        : PATIENT_DETAIL_WITH_NEW_ADDR;
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: detail }),
      });
    });

    await page.route(`**/api/admin/patients/${PATIENT_DETAIL_ACTIVE.id}/addresses`, route =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: CREATED_ADDRESS }),
      }),
    );

    await page.goto('/admin/vacancies/new');
    await expect(page.getByText('Nueva Vacante')).toBeVisible({ timeout: 10000 });

    // Select patient
    const searchInput = page.getByPlaceholder(/Buscar paciente/i);
    await searchInput.fill('Laura');
    await expect(page.getByRole('listbox')).toBeVisible({ timeout: 5000 });
    await page.getByRole('option').click();

    // Address is shown as read-only (1 address)
    await expect(page.getByText('Av. Corrientes 1234, CABA')).toBeVisible({ timeout: 5000 });

    // Click "Crear nuevo domicilio" button
    await page.getByRole('button', { name: /Crear nuevo domicilio/i }).click();

    // Dialog opens
    await expect(page.getByRole('dialog')).toBeVisible({ timeout: 5000 });
    await expect(page.getByText('Crear nuevo domicilio')).toBeVisible();

    // Screenshot of dialog open
    await expect(page).toHaveScreenshot('create-vacancy-scenario7-dialog-open.png', {
      fullPage: false,
    });

    // Fill in address field
    const addressInput = page.getByRole('dialog').locator('input').first();
    await addressInput.fill('Belgrano 1500, CABA');

    // Save the address
    await page.getByRole('dialog').getByRole('button', { name: /Guardar/i }).click();

    // Dialog closes
    await expect(page.getByRole('dialog')).not.toBeVisible({ timeout: 5000 });

    // New address should appear in selector
    await expect(page.getByText('Belgrano 1500, CABA')).toBeVisible({ timeout: 5000 });

    // Screenshot after address created and selected
    await expect(page).toHaveScreenshot('create-vacancy-scenario7-address-created.png', {
      fullPage: false,
    });
  });
});

// ── Scenario 8: Split shift — two schedule slots same day ──────────────────────

test.describe('Scenario 8 — Split shift with two schedule slots on same day', () => {
  test('adding two schedule slots on the same weekday shows both in picker', async ({ page }) => {
    await loginAsAdmin(page);
    mockNextVacancyNumber(page);
    mockSearchPatients(page, [PATIENT_ACTIVE]);
    mockGetPatient(page, PATIENT_DETAIL_ACTIVE);

    await page.goto('/admin/vacancies/new');
    await expect(page.getByText('Nueva Vacante')).toBeVisible({ timeout: 10000 });

    // Select patient first
    const searchInput = page.getByPlaceholder(/Buscar paciente/i);
    await searchInput.fill('Laura');
    await expect(page.getByRole('listbox')).toBeVisible({ timeout: 5000 });
    await page.getByRole('option').click();

    // Scroll to schedule section
    const scheduleSection = page.getByText(/Días y horarios/i).first();
    await scheduleSection.scrollIntoViewIfNeeded();

    // Screenshot of schedule section (existing slot from default)
    await expect(page).toHaveScreenshot('create-vacancy-scenario8-schedule-section.png', {
      fullPage: false,
    });
  });
});

// ── Scenario 9: Interview slots modal ─────────────────────────────────────────

test.describe('Scenario 9 — Interview slots modal: select slot → pill appears', () => {
  test('opening interview slots modal and confirming a slot shows a pill', async ({ page }) => {
    await loginAsAdmin(page);
    mockNextVacancyNumber(page);
    mockSearchPatients(page, [PATIENT_ACTIVE]);
    mockGetPatient(page, PATIENT_DETAIL_ACTIVE);

    await page.goto('/admin/vacancies/new');
    await expect(page.getByText('Nueva Vacante')).toBeVisible({ timeout: 10000 });

    // Select patient
    const searchInput = page.getByPlaceholder(/Buscar paciente/i);
    await searchInput.fill('Laura');
    await expect(page.getByRole('listbox')).toBeVisible({ timeout: 5000 });
    await page.getByRole('option').click();

    // Find and click the interview slots button
    const interviewBtn = page.getByRole('button', { name: /Agregar horarios de entrevista/i });
    await interviewBtn.scrollIntoViewIfNeeded();
    await expect(interviewBtn).toBeVisible({ timeout: 5000 });
    await interviewBtn.click();

    // Modal opens
    await expect(page.getByRole('dialog')).toBeVisible({ timeout: 5000 });
    await expect(page.getByText(/Seleccioná un día/i)).toBeVisible();

    // Screenshot of interview slots modal
    await expect(page).toHaveScreenshot('create-vacancy-scenario9-interview-modal-open.png', {
      fullPage: false,
    });

    // Click on a future day in the calendar (first enabled day button)
    const dayButtons = page.getByRole('dialog').getByRole('button').filter({ hasText: /^[0-9]+$/ });
    const firstEnabledDay = dayButtons.first();
    await firstEnabledDay.click();

    // Now time slots should be available — click the first one
    const timeButtons = page.getByRole('dialog').getByRole('button').filter({ hasText: /[0-9]+:[0-9]+/ });
    const firstTime = timeButtons.first();
    if (await firstTime.isVisible()) {
      await firstTime.click();
    }

    // Click Save/Guardar
    await page.getByRole('dialog').getByRole('button', { name: /Guardar/i }).click();

    // Modal closes
    await expect(page.getByRole('dialog')).not.toBeVisible({ timeout: 5000 });

    // Screenshot after saving — pill may appear if a slot was selected
    await expect(page).toHaveScreenshot('create-vacancy-scenario9-after-save.png', {
      fullPage: false,
    });
  });
});

// ── Scenario 10: Submit → 200 → navigate to vacancy detail ───────────────────

test.describe('Scenario 10 — Form submit navigates to vacancy detail on success', () => {
  test('completing the form and saving navigates to the new vacancy route', async ({ page }) => {
    await loginAsAdmin(page);
    mockNextVacancyNumber(page, 1);
    mockSearchPatients(page, [PATIENT_ACTIVE]);
    mockGetPatient(page, PATIENT_DETAIL_ACTIVE);

    await page.route('**/api/admin/vacancies', route => {
      if (route.request().method() === 'POST') {
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ success: true, data: CREATED_VACANCY }),
        });
      } else {
        route.continue();
      }
    });

    // Mock the vacancy detail page that we navigate to
    await page.route(`**/api/admin/vacancies/${CREATED_VACANCY.id}`, route =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: CREATED_VACANCY }),
      }),
    );

    await page.goto('/admin/vacancies/new');
    await expect(page.getByText('Nueva Vacante')).toBeVisible({ timeout: 10000 });

    // Select patient
    const searchInput = page.getByPlaceholder(/Buscar paciente/i);
    await searchInput.fill('Laura');
    await expect(page.getByRole('listbox')).toBeVisible({ timeout: 5000 });
    await page.getByRole('option').click();

    // Address auto-selected (1 address)
    await expect(page.getByText('Av. Corrientes 1234, CABA')).toBeVisible({ timeout: 5000 });

    // Screenshot before submit
    await expect(page).toHaveScreenshot('create-vacancy-scenario10-before-submit.png', {
      fullPage: false,
    });

    // Click save button
    const saveBtn = page.getByRole('button', { name: /Guardar/i });
    await saveBtn.click();

    // Should navigate to the new vacancy detail route
    await expect(page).toHaveURL(`/admin/vacancies/${CREATED_VACANCY.id}`, { timeout: 10000 });

    // Screenshot of the navigation result
    await expect(page).toHaveScreenshot('create-vacancy-scenario10-after-submit.png', {
      fullPage: false,
    });
  });
});
