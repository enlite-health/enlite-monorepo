/**
 * phone-conflict-modal.e2e.ts
 *
 * Prova VISUAL do fluxo de vínculo por colisão de telefone (openspec:
 * vinculo-contas-colisao-telefone, Bloco 3 núcleo — caso Edith).
 *
 * Cobre, com screenshot de CADA estado (e2e/__screenshots__/vinculo-*.png):
 *   1. 409 no autosave do telefone → MODAL abre (número por extenso + email
 *      mascarado + 3 saídas) — e NÃO o toast solto de antes.
 *   2. "vincular" → passo OTP (número mascarado da conta antiga).
 *   3. OTP ok + conflito real → passo de escolha de campos.
 *   4. confirmar → resumo com contagens reais ("2 postulaciones y 1 documentos").
 *   5. Flag OFF (start 404) → comportamento ATUAL preservado: toast de erro.
 *   6. Modal aberta → toasts de autosave SUPRIMIDOS (a causa-raiz do caso
 *      Edith era o toast de sucesso abafando o erro).
 *
 * APIs 100% mockadas via page.route (padrão phone-input-reload.e2e.ts).
 */

import { test, expect, Page } from '@playwright/test';

test.use({ storageState: 'e2e/.auth/profile-worker.json' });

const PHONE_TYPED = '1133336012'; // dígitos nacionais AR (o input tem +54)

// Contrato v2: lookup SEM SMS e só mascarados; valores de conflito só no confirm.
const LOOKUP_RESPONSE = {
  success: true,
  data: { otherEmailMasked: 'kete•••@gmail.com', phoneMasked: '+54 9 11 ****-6012' },
};

const START_RESPONSE = {
  success: true,
  data: { verificationSid: 'VE-e2e-mock', phoneMasked: '+54 9 11 ****-6012' },
};

const CONFIRM_RESPONSE = {
  success: true,
  data: {
    status: 'conflicts',
    conflicts: [
      {
        field: 'profession',
        values: { 'cuenta-actual': 'AT', 'cuenta-anterior': 'CAREGIVER' },
        is_encrypted: false,
        has_conflict: true,
        suggested: 'cuenta-actual',
      },
    ],
    linkToken: 'LT-e2e-mock',
    accounts: { current: 'cuenta-actual', other: 'cuenta-anterior' },
  },
};

const FINALIZE_RESPONSE = {
  success: true,
  data: {
    status: 'merged',
    recovered: { worker_job_applications: 2, worker_documents: 1 },
    workerStatus: 'REGISTERED',
  },
};

/** Perfil SEM telefone (a pessoa vai digitá-lo — cenário Edith). */
async function mockProfileApis(page: Page): Promise<void> {
  await page.route('**/api/workers/me', async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          data: {
            email: 'edith.nueva@test.com',
            firstName: 'Edith',
            lastName: 'Gamero',
            phone: null,
            documentNumber: '21570471',
            birthDate: '1969-05-10',
            sex: 'female',
            gender: 'female',
            documentType: 'DNI',
            titleCertificate: '',
            languages: ['es'],
            profession: 'AT',
            knowledgeLevel: 'technical',
            experienceTypes: ['elderly'],
            yearsExperience: '3_5',
            preferredTypes: ['elderly'],
            preferredAgeRange: 'elderly',
            profilePhotoUrl: null,
            serviceAddress: null,
            serviceRadiusKm: 10,
            availability: {},
          },
        }),
      });
    } else {
      await route.continue();
    }
  });
  await page.route('**/api/workers/me/availability', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data: [] }) }),
  );
}

/** Autosave do telefone → 409 PHONE_NOT_AVAILABLE (o gatilho do caso Edith). */
async function mockGeneralInfo409(page: Page): Promise<void> {
  await page.route('**/api/workers/me/general-info', (route) =>
    route.fulfill({
      status: 409,
      contentType: 'application/json',
      body: JSON.stringify({
        success: false,
        error: 'El teléfono ingresado no puede ser utilizado.',
        code: 'PHONE_NOT_AVAILABLE',
      }),
    }),
  );
}

async function typePhoneAndBlur(page: Page): Promise<void> {
  const phoneInput = page.locator('input[type="tel"]').first();
  await expect(phoneInput).toBeVisible({ timeout: 10000 });
  await phoneInput.fill(PHONE_TYPED);
  await phoneInput.blur();
}

test.describe('PhoneConflictModal — colisão de telefone vira caminho, não beco', () => {
  test.setTimeout(90000);

  test('fluxo completo: 409 → modal → OTP → conflito → resumo (screenshots)', async ({ page }) => {
    await mockProfileApis(page);
    await mockGeneralInfo409(page);
    await page.route('**/api/workers/me/account-link/lookup', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(LOOKUP_RESPONSE) }),
    );
    await page.route('**/api/workers/me/account-link/start', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(START_RESPONSE) }),
    );
    await page.route('**/api/workers/me/account-link/confirm', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(CONFIRM_RESPONSE) }),
    );
    await page.route('**/api/workers/me/account-link/finalize', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(FINALIZE_RESPONSE) }),
    );

    await page.goto('/worker/profile');
    await page.waitForLoadState('networkidle');
    await typePhoneAndBlur(page);

    // ── 1. Modal de colisão REALMENTE na tela ────────────────────────────
    const modal = page.getByTestId('phone-conflict-modal');
    await expect(modal).toBeVisible({ timeout: 10000 });
    await expect(page.getByTestId('phone-conflict-step-choice')).toBeVisible();
    // número digitado por extenso + email mascarado
    await expect(page.getByTestId('phone-conflict-phone')).toContainText('6012');
    await expect(page.getByTestId('phone-conflict-email')).toHaveText('kete•••@gmail.com');
    // 3 saídas
    await expect(page.getByTestId('phone-conflict-link-button')).toBeVisible();
    await expect(page.getByTestId('phone-conflict-no-access-button')).toBeVisible();
    await expect(page.getByTestId('phone-conflict-support-link')).toBeVisible();
    await page.screenshot({ path: 'e2e/__screenshots__/vinculo-1-modal-colisao.png', fullPage: false });

    // ── 6. Toasts suprimidos com a modal aberta ──────────────────────────
    // (o autosave dos outros campos segue rodando por baixo; nada de toast)
    await page.waitForTimeout(1200);
    await expect(page.getByText('Información guardada con éxito')).toHaveCount(0);
    await expect(page.getByText('El teléfono ingresado no puede ser utilizado.')).toHaveCount(0);

    // ── 2. Passo OTP ─────────────────────────────────────────────────────
    await page.getByTestId('phone-conflict-link-button').click();
    await expect(page.getByTestId('phone-conflict-step-otp')).toBeVisible();
    await expect(page.getByText('+54 9 11 ****-6012')).toBeVisible(); // número da conta ANTIGA mascarado
    await page.screenshot({ path: 'e2e/__screenshots__/vinculo-2-otp.png', fullPage: false });

    await page.getByTestId('account-link-otp-input').fill('123456');
    await page.getByTestId('account-link-otp-confirm').click();

    // ── 3. Passo de conflito (profession divergente) ─────────────────────
    await expect(page.getByTestId('phone-conflict-step-conflicts')).toBeVisible();
    await expect(page.getByTestId('conflict-field-profession')).toBeVisible();
    // Enums TRADUZIDOS (achado do e2e real: valor cru de banco não é amigável).
    // Escopado ao passo de conflitos: o select de Profesión do form atrás da
    // modal tem o mesmo rótulo (strict mode).
    const conflictsStep = page.getByTestId('phone-conflict-step-conflicts');
    await expect(conflictsStep.getByText('Acompañante Terapéutico', { exact: true })).toBeVisible();
    await expect(conflictsStep.getByText('Cuidador(a)', { exact: true })).toBeVisible();
    await page.screenshot({ path: 'e2e/__screenshots__/vinculo-3-conflitos.png', fullPage: false });

    // escolhe o valor da conta anterior (chip do FieldChoiceList) e confirma
    await page.getByTestId('conflict-profession-cuenta-anterior').click();
    await page.getByTestId('account-link-conflicts-confirm').click();

    // ── 4. Resumo com contagens REAIS ────────────────────────────────────
    await expect(page.getByTestId('phone-conflict-step-summary')).toBeVisible({ timeout: 10000 });
    await expect(page.getByTestId('account-link-summary-text')).toContainText('tus 2 postulaciones');
    await expect(page.getByTestId('account-link-summary-text')).toContainText('tus documentos');
    await page.screenshot({ path: 'e2e/__screenshots__/vinculo-4-resumo.png', fullPage: false });

    await page.getByTestId('account-link-summary-close').click();
    await expect(modal).toHaveCount(0);
  });

  test('flag OFF (start 404): comportamento atual preservado — toast de erro, sem modal', async ({ page }) => {
    await mockProfileApis(page);
    await mockGeneralInfo409(page);
    await page.route('**/api/workers/me/account-link/lookup', (route) =>
      route.fulfill({
        status: 404,
        contentType: 'application/json',
        body: JSON.stringify({ success: false, error: 'Not found' }),
      }),
    );

    await page.goto('/worker/profile');
    await page.waitForLoadState('networkidle');
    await typePhoneAndBlur(page);

    // Toast de erro (comportamento atual) e NENHUMA modal
    await expect(page.getByText('El teléfono ingresado no puede ser utilizado.')).toBeVisible({ timeout: 10000 });
    await expect(page.getByTestId('phone-conflict-modal')).toHaveCount(0);
    await page.screenshot({ path: 'e2e/__screenshots__/vinculo-5-flag-off-toast.png', fullPage: false });
  });
});
