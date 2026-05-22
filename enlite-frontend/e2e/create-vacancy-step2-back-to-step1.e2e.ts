/**
 * create-vacancy-step2-back-to-step1.e2e.ts — Playwright E2E
 *
 * Cobre o flow de voltar do Step 2 (TalentumConfig) pro Step 1
 * (CreateVacancyPage em edit mode), preservando todos os dados.
 *
 * Cenário:
 *   - Navega direto pra /admin/vacancies/:id/edit (simula a chegada via
 *     botão "Volver" no header do Step 2).
 *   - Verifica que a vaga é carregada via getVacancyById.
 *   - Confirma que o form hidrata com os dados existentes (case readonly,
 *     endereço linkado pré-selecionado, meet link populado).
 *   - REGRESSION: o botão "Continuar" tem que estar HABILITADO mesmo durante
 *     a janela de hidratação assíncrona — esse era o bug que motivou o
 *     bypass de `formComplete` em edit mode.
 *   - Screenshot anchor do form hidratado.
 *
 * Mocks (sem rede externa, sem Gemini, sem Talentum):
 *   - GET /vacancies/:id      → fixture rica com todos os campos do form
 *   - GET /patients/:id       → fixture
 *   - GET /patients/:id/addresses → 2 endereços (linkado + outro)
 *
 * Auth: Firebase Emulator (mesmo padrão dos outros E2E).
 */
import { test, expect, type Page } from '@playwright/test';

const FIREBASE_EMULATOR = 'http://127.0.0.1:9099';
const FIREBASE_API_KEY = 'test-api-key';

// ── Fixtures ───────────────────────────────────────────────────────────────────

const VACANCY_ID = 'vac-back-nav-1';
const PATIENT_ID = 'pat-back-nav-1';
const ADDRESS_LINKED_ID = 'addr-linked-back-1';
const ADDRESS_OTHER_ID = 'addr-other-back-2';

const PATIENT_DETAIL = {
  id: PATIENT_ID,
  firstName: 'María',
  lastName: 'Gómez',
  documentNumber: '30111222',
  status: 'ACTIVE',
  diagnosis: 'TEA leve',
  dependencyLevel: 'SEVERE',
  serviceType: ['AT'],
  lastCaseNumber: 77,
  responsibles: [],
};

const ADDRESS_LINKED = {
  id: ADDRESS_LINKED_ID,
  patient_id: PATIENT_ID,
  address_formatted: 'Av. Corrientes 1234, CABA, Buenos Aires, Argentina',
  address_raw: 'Av. Corrientes 1234',
  address_type: 'service',
  display_order: 1,
  source: 'manual',
  complement: 'Piso 3, Depto B',
  lat: -34.6037,
  lng: -58.3816,
};

const ADDRESS_OTHER = {
  ...ADDRESS_LINKED,
  id: ADDRESS_OTHER_ID,
  address_formatted: 'Carlos Gardel 2466, Olivos, Buenos Aires, Argentina',
  address_raw: 'Carlos Gardel 2466',
  display_order: 2,
};

// Vaga já criada/persistida com todos os campos preenchidos. O form em edit
// mode hidrata via `reset(...)` e o flow.selectCase usa patient_address_id
// como preferredAddressId.
const EXISTING_VACANCY = {
  id: VACANCY_ID,
  case_number: 77,
  vacancy_number: 1,
  patient_id: PATIENT_ID,
  patient_address_id: ADDRESS_LINKED_ID,
  title: 'CASO 77-1',
  status: 'SEARCHING',
  required_professions: ['AT'],
  required_sex: '',
  age_range_min: null,
  age_range_max: null,
  required_experience: '',
  worker_attributes: '',
  providers_needed: 1,
  work_schedule: '',
  schedule: [{ dayOfWeek: 1, startTime: '09:00', endTime: '17:00' }],
  salary_text: '',
  payment_day: '',
  daily_obs: '',
  published_at: null,
  closes_at: null,
  meet_link_1: 'https://meet.google.com/abc-defg-hij',
  meet_link_2: null,
  meet_link_3: null,
  meet_datetime_1: '2026-05-10T15:00:00-03:00',
  meet_datetime_2: null,
  meet_datetime_3: null,
  patient_first_name: PATIENT_DETAIL.firstName,
  patient_last_name: PATIENT_DETAIL.lastName,
  caseNumber: 77,
  vacancyNumber: 1,
};

// ── Auth helper ─────────────────────────────────────────────────────────────────

async function loginAsAdmin(page: Page): Promise<void> {
  const email = `e2e.back.${Date.now()}@test.com`;
  const password = 'TestAdmin123!';
  const signUpRes = await fetch(
    `${FIREBASE_EMULATOR}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=${FIREBASE_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, returnSecureToken: true }),
    },
  );
  const { localId: uid } = (await signUpRes.json()) as { localId: string };

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
  await expect(page).not.toHaveURL(/.*login.*/, { timeout: 20_000 });
}

// ── Mock installer ─────────────────────────────────────────────────────────────

function installEditModeMocks(page: Page): void {
  page.route('**/api/admin/vacancies/cases-for-select', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        data: [
          {
            caseNumber: EXISTING_VACANCY.case_number,
            patientId: PATIENT_ID,
            dependencyLevel: PATIENT_DETAIL.dependencyLevel,
          },
        ],
      }),
    }),
  );

  page.route('**/api/admin/vacancies/next-vacancy-number', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, data: { nextVacancyNumber: 2 } }),
    }),
  );

  page.route(`**/api/admin/patients/${PATIENT_ID}`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, data: PATIENT_DETAIL }),
    }),
  );

  page.route(`**/api/admin/patients/${PATIENT_ID}/addresses`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        data: [ADDRESS_LINKED, ADDRESS_OTHER],
      }),
    }),
  );

  // GET /vacancies/:id — full payload pra hidratação do form
  page.route(`**/api/admin/vacancies/${VACANCY_ID}`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, data: EXISTING_VACANCY }),
    }),
  );
}

// ── Test ───────────────────────────────────────────────────────────────────────

test.describe('CreateVacancy — Step 2 → Voltar → Step 1 (edit mode)', () => {
  test('hidrata vaga existente, pré-seleciona endereço linkado e habilita Continuar', async ({
    page,
  }) => {
    await loginAsAdmin(page);
    installEditModeMocks(page);

    // Navega direto pra rota de edit (simula chegada via botão "Volver" do Step 2)
    await page.goto(`/admin/vacancies/${VACANCY_ID}/edit`);
    await expect(page.getByText('Nueva Vacante')).toBeVisible({ timeout: 15_000 });

    // Endereço linkado da vaga (Av. Corrientes 1234) tem que aparecer e estar
    // pré-selecionado (border-primary)
    const linkedBtn = page.locator(`[data-testid="address-option-${ADDRESS_LINKED_ID}"]`);
    await expect(linkedBtn).toBeVisible({ timeout: 8_000 });
    await expect(linkedBtn).toHaveClass(/border-primary/);

    // Outro endereço (Olivos) também aparece, mas NÃO selecionado
    const otherBtn = page.locator(`[data-testid="address-option-${ADDRESS_OTHER_ID}"]`);
    await expect(otherBtn).toBeVisible();
    await expect(otherBtn).not.toHaveClass(/border-primary/);

    // Meet link existente populado no input
    const meetInput = page.locator('[data-testid="meet-link-0"]');
    await expect(meetInput).toHaveValue('https://meet.google.com/abc-defg-hij');

    // REGRESSION: o botão Continuar tem que estar HABILITADO logo após o
    // form hidratar — antes do fix, ficava travado em disabled porque o
    // gate `formComplete` dependia da hidratação assíncrona do useWatch +
    // flow.selectedAddressId. O bypass em edit mode + o set síncrono do
    // selectedAddressId garantem que esse expect passa.
    const saveBtn = page.getByTestId('create-vacancy-save-btn');
    await expect(saveBtn).toBeEnabled({ timeout: 5_000 });

    // Stepper marca Step 1 como step ativo (não Step 2)
    await expect(
      page.locator('ol[aria-label="Progress"] li[aria-current="step"]'),
    ).toContainText(/Datos de la vacante/i);

    // Visual snapshot — header com Continuar habilitado + endereço linkado
    // selecionado serve de regression visual.
    await expect(page).toHaveScreenshot('create-vacancy-edit-mode-hydrated.png', {
      fullPage: false,
      maxDiffPixelRatio: 0.05,
    });
  });
});
