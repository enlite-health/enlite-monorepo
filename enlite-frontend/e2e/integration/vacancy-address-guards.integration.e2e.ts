/**
 * vacancy-address-guards.integration.e2e.ts @integration
 *
 * Validação visual + funcional dos guard-rails do Step 1:
 *   1. Paciente com 2 endereços ativos → form lista os DOIS endereços e o
 *      operador consegue escolher qualquer um.
 *   2. Paciente com endereço que JÁ TEM vaga publicada (status SEARCHING,
 *      is_draft=false) → ao selecionar o caso, AddressHasVacancyDialog
 *      aparece com o título "Esse endereço já tem uma vaga" e o link
 *      "Editar a vaga".
 *   3. O operador pode clicar "Editar a vaga" → navega para o detail page
 *      da vaga existente, ou clicar "Criar nova mesmo assim" → modal fecha
 *      e o form continua.
 *
 * Cada cenário captura screenshot via toHaveScreenshot() para regression
 * visual (regra do CLAUDE.md: feedback_visual_tests_required).
 *
 * Estratégia de auth: idêntica à `full-create-vacancy.integration.e2e.ts` —
 * mocka Firebase Identity Toolkit + Securetoken + /api/admin/auth/profile,
 * troca o Authorization header pelo `Bearer mock_<base64>` que o backend
 * aceita em USE_MOCK_AUTH=true.
 */

import { test, expect, type Page, type Route } from '@playwright/test';
import {
  insertTestPatient,
  cleanupTestPatient,
  insertBaseVacancy,
  cleanupVacancies,
} from '../helpers/db-test-helper';
import {
  insertSecondAddress,
  insertOperationalVacancy,
  setPatientCaseNumber,
} from '../helpers/patient-addresses-test-helper';

const MOCK_ADMIN_USER = {
  uid: 'e2e-int-address-guards',
  email: 'admin.guards@e2e.test',
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
      body: JSON.stringify({ users: [{ localId: MOCK_ADMIN_USER.uid, email: MOCK_ADMIN_USER.email, emailVerified: true }] }),
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
            firstName: 'Guards',
            lastName: 'Admin',
            isActive: true,
            mustChangePassword: false,
          },
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
  await page.goto('/admin/login');
  await page.locator('input[type="email"]').fill(MOCK_ADMIN_USER.email);
  await page.locator('input[type="password"]').fill('TestAdmin123!');
  await page.getByRole('button', { name: /Iniciar sesión/i }).click();
  await expect(page).not.toHaveURL(/.*login.*/, { timeout: 20_000 });
}

/**
 * Selects a case via the SearchableSelect dropdown.
 * The case-select wraps a custom <button>+<ul role="listbox"> combo, not a
 * native <select>. Click the button → click the <li role="option"> matching
 * the case number.
 */
async function selectCaseFromDropdown(page: Page, caseNumber: number): Promise<void> {
  const caseSelectWrapper = page.locator('[data-testid="case-select"]');
  await expect(caseSelectWrapper).toBeVisible({ timeout: 10_000 });
  await caseSelectWrapper.locator('button').click();
  const option = page.locator('[role="option"]').filter({ hasText: String(caseNumber) }).first();
  await expect(option).toBeVisible({ timeout: 5_000 });
  await option.click();
}

// ─── Test suite ───────────────────────────────────────────────────────────────

test.describe('Address guards @integration', () => {
  test.setTimeout(120_000);

  // ── Scenario A: Multiple active addresses ──────────────────────────────────

  test.describe('Paciente com 2 endereços ativos', () => {
    let patientId = '';
    let primaryAddressId = '';
    let secondaryAddressId = '';
    let baseVacancyId = '';
    let caseNumber = 0;

    test.beforeAll(() => {
      caseNumber = 970_000 + Math.floor(Math.random() * 9999);
      const patient = insertTestPatient({
        firstName: 'TwoAddrs',
        lastName: `Patient${Date.now()}`,
        diagnosis: 'TEA leve',
        dependencyLevel: 'SEVERE',
        withAddress: true,
      });
      patientId = patient.patientId;
      primaryAddressId = patient.addressId ?? '';
      setPatientCaseNumber(patientId, caseNumber);
      secondaryAddressId = insertSecondAddress({
        patientId,
        addressFormatted: 'Av Sec 4567, Belgrano, CABA',
      });
      // Base vacancy on the PRIMARY address so the case shows up in cases-for-select.
      // Status SEARCHING so it doesn't trigger ResumeDraftVacancyDialog (per-patient).
      baseVacancyId = insertBaseVacancy({
        patientId,
        patientAddressId: primaryAddressId,
        caseNumber,
        status: 'SEARCHING',
        isDraft: false,
      });
    });

    test.afterAll(() => {
      cleanupVacancies([baseVacancyId]);
      cleanupTestPatient(patientId);
    });

    test('form lista os 2 endereços ativos e operador consegue selecionar o secundário', async ({
      page,
    }) => {
      // D425 item 4 (24/09/2026, docs/decisoes.md, Fase 3) — "Nueva" sai temporariamente: o
      // AddressHasVacancyDialog só é alcançável dentro do modo CRIAR do wizard, em
      // /admin/vacancies/new, que agora redireciona pra /admin/vacancies. Skip, não apagado —
      // o componente fica no código, dormente (D425).
      test.skip(true, 'D425 item 4 — "Nueva" fora temporariamente; AddressHasVacancyDialog só existe no modo criar');
      test.skip(!patientId || !primaryAddressId || !secondaryAddressId, 'seed failed');

      await loginAsAdmin(page);
      await page.goto('/admin/vacancies/new');
      await expect(page.getByText(/Nueva Vacante/i)).toBeVisible({ timeout: 15_000 });

      // Selecionar o caso
      await selectCaseFromDropdown(page, caseNumber);

      // Os 2 endereços devem aparecer como buttons selecionáveis
      const addr1 = page.locator(`[data-testid="address-option-${primaryAddressId}"]`);
      const addr2 = page.locator(`[data-testid="address-option-${secondaryAddressId}"]`);
      await expect(addr1).toBeVisible({ timeout: 10_000 });
      await expect(addr2).toBeVisible();

      // Address-has-vacancy dialog deve aparecer (paciente já tem vaga publicada
      // no endereço primário, auto-selecionado). Fechamos pra continuar.
      const dialog = page.locator('[data-testid="address-has-vacancy-dialog"]');
      if (await dialog.isVisible().catch(() => false)) {
        await page.locator('[data-testid="address-has-vacancy-continue"]').click();
      }

      // Snapshot do form com os 2 endereços visíveis e o primeiro selecionado
      await expect(page).toHaveScreenshot(
        'two-addresses-listed.png',
        { maxDiffPixelRatio: 0.02 },
      );

      // Operador clica no endereço secundário
      await addr2.click();
      await expect(addr2).toHaveClass(/border-primary/, { timeout: 5_000 });

      await expect(page).toHaveScreenshot(
        'two-addresses-secondary-selected.png',
        { maxDiffPixelRatio: 0.02 },
      );
    });
  });

  // ── Scenario B: Address already has a published vacancy ────────────────────

  test.describe('Endereço com vaga publicada (SEARCHING)', () => {
    let patientId = '';
    let addressId = '';
    let existingVacancyId = '';
    let caseNumber = 0;

    test.beforeAll(() => {
      caseNumber = 971_000 + Math.floor(Math.random() * 9999);
      const patient = insertTestPatient({
        firstName: 'PubAddr',
        lastName: `Patient${Date.now()}`,
        diagnosis: 'TEA leve',
        dependencyLevel: 'SEVERE',
        withAddress: true,
      });
      patientId = patient.patientId;
      addressId = patient.addressId ?? '';
      setPatientCaseNumber(patientId, caseNumber);
      // Operational vacancy already published — não é draft (is_draft = false).
      // ResumeDraftVacancyDialog NÃO aparece porque o filtro é is_draft=true.
      // AddressHasVacancyDialog APARECE porque a vaga aponta para o address ativo.
      existingVacancyId = insertOperationalVacancy({
        patientId,
        patientAddressId: addressId,
        caseNumber,
        status: 'SEARCHING',
        isDraft: false,
      });
    });

    test.afterAll(() => {
      cleanupVacancies([existingVacancyId]);
      cleanupTestPatient(patientId);
    });

    test('AddressHasVacancyDialog aparece com link para a vaga existente', async ({ page }) => {
      // D425 item 4 (24/09/2026, docs/decisoes.md, Fase 3) — "Nueva" sai temporariamente: o
      // AddressHasVacancyDialog só é alcançável dentro do modo CRIAR do wizard, em
      // /admin/vacancies/new, que agora redireciona pra /admin/vacancies. Skip, não apagado —
      // o componente fica no código, dormente (D425).
      test.skip(true, 'D425 item 4 — "Nueva" fora temporariamente; AddressHasVacancyDialog só existe no modo criar');
      test.skip(!patientId || !addressId, 'seed failed');

      await loginAsAdmin(page);
      await page.goto('/admin/vacancies/new');
      await expect(page.getByText(/Nueva Vacante/i)).toBeVisible({ timeout: 15_000 });

      await selectCaseFromDropdown(page, caseNumber);

      // Dialog aparece — paciente tem vaga publicada no endereço auto-selecionado
      const dialog = page.locator('[data-testid="address-has-vacancy-dialog"]');
      await expect(dialog).toBeVisible({ timeout: 10_000 });

      // O título e o item da vaga aparecem
      await expect(dialog).toContainText(/vaga|vacante/i);
      const vacancyItem = page.locator(`[data-testid="address-vacancy-item-${existingVacancyId}"]`);
      await expect(vacancyItem).toBeVisible();
      await expect(vacancyItem).toContainText(String(caseNumber));

      // Screenshot do diálogo (regression visual)
      await expect(dialog).toHaveScreenshot('address-has-vacancy-dialog.png', {
        maxDiffPixelRatio: 0.02,
      });

      // ── Action 1: "Editar a vaga" ──────────────────────────────────────────
      const editLink = page.locator(`[data-testid="address-vacancy-edit-${existingVacancyId}"]`);
      await editLink.click();

      // Navegou pro detail (vaga operacional → /admin/vacancies/:id)
      await expect(page).toHaveURL(new RegExp(`/admin/vacancies/${existingVacancyId}(?!/edit)`), {
        timeout: 10_000,
      });
    });

    test('"Criar nova mesmo assim" fecha o diálogo e o form fica disponível', async ({
      page,
    }) => {
      // D425 item 4 (24/09/2026, docs/decisoes.md, Fase 3) — "Nueva" sai temporariamente: o
      // AddressHasVacancyDialog só é alcançável dentro do modo CRIAR do wizard, em
      // /admin/vacancies/new, que agora redireciona pra /admin/vacancies. Skip, não apagado —
      // o componente fica no código, dormente (D425).
      test.skip(true, 'D425 item 4 — "Nueva" fora temporariamente; AddressHasVacancyDialog só existe no modo criar');
      test.skip(!patientId || !addressId, 'seed failed');

      await loginAsAdmin(page);
      await page.goto('/admin/vacancies/new');

      await selectCaseFromDropdown(page, caseNumber);

      const dialog = page.locator('[data-testid="address-has-vacancy-dialog"]');
      await expect(dialog).toBeVisible({ timeout: 10_000 });

      // Click "Criar nova mesmo assim"
      await page.locator('[data-testid="address-has-vacancy-continue"]').click();

      // Diálogo some
      await expect(dialog).not.toBeVisible({ timeout: 5_000 });

      // Form continua disponível — case selecionado, address-options visíveis
      const addr = page.locator(`[data-testid="address-option-${addressId}"]`);
      await expect(addr).toBeVisible();
      await expect(addr).toHaveClass(/border-primary/);

      // Screenshot do form pós-override
      await expect(page).toHaveScreenshot(
        'after-continue-creating.png',
        { maxDiffPixelRatio: 0.02 },
      );
    });

    test('"Escolher outro endereço" limpa a seleção do endereço', async ({ page }) => {
      // D425 item 4 (24/09/2026, docs/decisoes.md, Fase 3) — "Nueva" sai temporariamente: o
      // AddressHasVacancyDialog só é alcançável dentro do modo CRIAR do wizard, em
      // /admin/vacancies/new, que agora redireciona pra /admin/vacancies. Skip, não apagado —
      // o componente fica no código, dormente (D425).
      test.skip(true, 'D425 item 4 — "Nueva" fora temporariamente; AddressHasVacancyDialog só existe no modo criar');
      test.skip(!patientId || !addressId, 'seed failed');

      await loginAsAdmin(page);
      await page.goto('/admin/vacancies/new');

      await selectCaseFromDropdown(page, caseNumber);

      const dialog = page.locator('[data-testid="address-has-vacancy-dialog"]');
      await expect(dialog).toBeVisible({ timeout: 10_000 });

      await page.locator('[data-testid="address-has-vacancy-cancel"]').click();
      await expect(dialog).not.toBeVisible();

      // Endereço deselecionado — nenhum address-option com border-primary
      const selected = page.locator('[data-testid^="address-option-"][class*="border-primary"]');
      await expect(selected).toHaveCount(0);
    });
  });
});
