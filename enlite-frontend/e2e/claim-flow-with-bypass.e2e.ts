import { test, expect } from '@playwright/test';

/**
 * Fluxo completo de claim com OTP bypass (onda 2).
 *
 * Pré-condições:
 *  - Backend rodando com E2E_OTP_BYPASS=true (TwilioVerifyService devolve sid TEST_*)
 *  - Ficha fake importada no DB: phone='+5491100000001', auth_uid='base1import_e2e5491100000001'
 *    (worker_id 3ab76c84-3176-4921-aadf-2ff1e2569fb4)
 *
 * Cenário:
 *  1. Usuário entra em /register
 *  2. Preenche email novo (alias com timestamp) + senha + WhatsApp +5491100000001 + LGPD
 *  3. Submit → backend detecta candidato → retorna claim_pending
 *  4. Modal OTP abre
 *  5. Usuário digita '123456' (E2E_OTP_CODE default)
 *  6. Backend valida via bypass → updateImportedWorkerData → retorna worker reconciliado
 *  7. Frontend navega pra /
 *
 * Idempotência: NÃO é idempotente — após a primeira execução, a ficha fake muda
 * auth_uid pro UID Firebase real e não dispara mais claim_pending. Pra re-rodar:
 *   - Re-setar a ficha via DBA (UPDATE workers SET auth_uid='base1import_e2e5491100000001',
 *     email='e2e_test_import@enlite.test' WHERE id='3ab76c84-3176-4921-aadf-2ff1e2569fb4')
 */

test.describe('Claim flow com OTP bypass', () => {
  // Sem auth — usuário não logado vindo do signup público.
  test.use({ storageState: { cookies: [], origins: [] } });

  test('signup com phone que bate ficha importada → modal OTP → 123456 → reconcilia', async ({ page }) => {
    const emailAlias = `gabriel.g.stein+claimtest${Date.now()}@gmail.com`;
    const targetPhone = '+5491100000001';

    // Captura todas as requests/responses relevantes pra debug
    const apiCalls: Array<{ method: string; url: string; status: number; body?: string }> = [];
    page.on('response', async (response) => {
      const url = response.url();
      if (url.includes('/api/workers/init') || url.includes('/api/auth/claim/')) {
        let body = '';
        try { body = (await response.text()).slice(0, 500); } catch { /* body unreadable, OK */ }
        apiCalls.push({ method: response.request().method(), url, status: response.status(), body });
      }
    });
    page.on('console', (msg) => {
      if (msg.type() === 'error' || msg.type() === 'warning') {
        console.log(`[BROWSER ${msg.type()}]`, msg.text());
      }
    });

    // 1. Goto /register
    await page.goto('/register');
    await expect(page.locator('input[type="email"]')).toBeVisible({ timeout: 10_000 });

    // 2. Preencher form
    await page.locator('input[type="email"]').fill(emailAlias);

    // Triggera blur do email pra terminar o lookup. Email é novo → workerFound=false →
    // phone NÃO fica disabled.
    await page.locator('input[type="email"]').blur();
    await page.waitForTimeout(1500); // espera lookup api retornar

    // Senha + confirmação (Firebase aceita ≥6 chars; usamos a mesma da conta de teste).
    await page.locator('input[type="password"]').first().fill('Teste@123');
    await page.locator('input[type="password"]').nth(1).fill('Teste@123');

    // WhatsApp — react-phone-number-input expõe um input com classe PhoneInputInput.
    await page.locator('input.PhoneInputInput').fill(targetPhone);

    // Checkbox LGPD (id="lgpdOptIn"). Atom Checkbox renderiza um overlay custom
    // sobre o <input> nativo — usamos force:true pra ignorar pointer-intercept.
    await page.locator('#lgpdOptIn').check({ force: true });

    // 3. Submit
    await page.getByRole('button', { name: /Registrarse/i }).first().click();

    // 4. Aguarda modal OTP aparecer (backend dispara bypass e retorna claim_pending).
    const modal = page.getByRole('dialog');
    try {
      await expect(modal).toBeVisible({ timeout: 30_000 });
    } catch (err) {
      console.log('=== API calls capturadas ===');
      apiCalls.forEach(c => console.log(JSON.stringify(c)));
      console.log('=== URL atual ===', page.url());
      throw err;
    }
    await expect(modal.getByText(/Detectamos.*ficha/i)).toBeVisible();

    // 5. Digita '123456' (E2E_OTP_CODE default no bypass)
    await page.getByTestId('otp-input').fill('123456');

    // 6. Confirma + aguarda response do claim/confirm em PARALELO (evita race).
    const confirmResponse = page.waitForResponse(
      (r) => r.url().includes('/api/auth/claim/confirm'),
      { timeout: 15_000 },
    );
    await page.getByRole('button', { name: /Confirmar/i }).click();
    const confirmRes = await confirmResponse;
    expect(confirmRes.status(), 'claim/confirm deveria retornar 200').toBe(200);

    // 7. Assert lógico: init retornou claim_pending (não 'ok' que pularia o modal).
    const initCall = apiCalls.find((c) => c.url.includes('/api/workers/init'));
    expect(initCall, 'POST /api/workers/init não foi chamado').toBeDefined();
    expect(initCall!.status, 'init deveria retornar 200 com claim_pending').toBe(200);
    expect(initCall!.body, 'response body deveria conter claim_pending').toContain('claim_pending');
  });
});
