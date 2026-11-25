/**
 * phone-verification.integration.e2e.ts @integration
 *
 * Emenda 077 §6 (AC-16), T-F3c-148 — e2e de TELA do celular verificado na web, contra o backend e o
 * banco REAIS do job de integração. Zero `page.route` de dado: o único dublê é a auth (Firebase,
 * interceptado por `loginNewWorker`); o código do WhatsApp é o do bypass declarado da stack de teste
 * (`E2E_OTP_BYPASS` / `E2E_OTP_CODE=123456`, docker-compose.test.yml) — nenhum canal real é tocado.
 *
 * A ficha nasce com `phoneVerified: false` (o helper grava a prova por padrão desde a migration 594).
 *
 *   F  (feliz)  ficha com telefone SEM verificar → "Verificar" → modal → código → o selo vira
 *               "Verificado" SÓ depois de reler `GET /api/workers/me` (a leitura que o app faz;
 *               o `GET /api/workers/me/progress` do cartão não existe: o progresso é esta rota).
 *   A1          código errado → erro no modal e o selo NÃO muda.
 *   A2          número em uso por conta real → o `PhoneConflictModal` abre.
 */

import { test, expect, type Page } from '@playwright/test';
import {
  insertEligibilityWorker,
  cleanupEligibilityWorker,
  type InsertEligibilityWorkerResult,
} from '../helpers/eligibility-worker-helper';
import { loginNewWorker } from '../helpers/worker-realreg-auth-helper';

const OTP_CODE = '123456'; // E2E_OTP_CODE do docker-compose.test.yml
const WRONG_CODE = '000000';

const isMeGet = (r: { url: () => string; request: () => { method: () => string } }): boolean =>
  new URL(r.url()).pathname === '/api/workers/me' && r.request().method() === 'GET';

test.describe('@integration Celular verificado na web (emenda 077 §6, AC-16)', () => {
  test.setTimeout(120_000);
  const seeded: InsertEligibilityWorkerResult[] = [];

  test.afterAll(() => {
    for (const w of seeded) cleanupEligibilityWorker(w.workerId);
  });

  async function abrirInformacionGeneral(page: Page, w: InsertEligibilityWorkerResult): Promise<void> {
    seeded.push(w);
    await loginNewWorker(page, w.authUid, w.email);
    await page.goto('/worker/profile?tab=general', { waitUntil: 'networkidle', timeout: 30_000 });
    await expect(page.getByTestId('phone-readonly')).toBeVisible({ timeout: 30_000 });
  }

  async function enviarCodigoDoNumeroAtual(page: Page): Promise<void> {
    await page.getByTestId('phone-verify-button').click();
    await page.getByTestId('phone-verification-send').click();
    await expect(page.getByTestId('phone-verification-code')).toBeVisible({ timeout: 20_000 });
  }

  test('T-F3c-148 F: "Verificar" → modal → código → selo "Verificado" só depois de reler o perfil', async ({ page }) => {
    await abrirInformacionGeneral(page, insertEligibilityWorker({ phoneVerified: false }));

    const badge = page.getByTestId('phone-badge');
    await expect(badge).toHaveAttribute('data-state', 'unverified', { timeout: 20_000 });

    await enviarCodigoDoNumeroAtual(page);
    await page.getByTestId('phone-verification-code').click();
    await page.keyboard.type(OTP_CODE, { delay: 30 }); // digitação real, não fill()
    await expect(page.getByTestId('phone-verification-code')).toHaveValue(OTP_CODE);

    // Confirmar → o servidor grava a prova → a tela RELÊ o perfil → só então o selo muda.
    const [reread] = await Promise.all([
      page.waitForResponse(isMeGet, { timeout: 20_000 }),
      page.getByTestId('phone-verification-confirm').click(),
    ]);
    const body = await reread.json();
    expect(body.data.phoneVerification.state).toBe('verified');

    await expect(page.getByTestId('phone-verification-code')).toHaveCount(0);
    await expect(badge).toHaveAttribute('data-state', 'verified', { timeout: 20_000 });
    await expect(page.getByTestId('phone-verify-button')).toHaveCount(0);

    // Régua de pronto do enlite-frontend/CLAUDE.md: validação visual (o número é aleatório: mascarado).
    await expect(page.locator('#phone')).toHaveScreenshot('celular-verificado.png', {
      mask: [page.getByTestId('phone-readonly')],
      maxDiffPixelRatio: 0.02,
    });
  });

  test('T-F3c-148 A1: código errado mostra o erro no modal e o selo não muda', async ({ page }) => {
    await abrirInformacionGeneral(page, insertEligibilityWorker({ phoneVerified: false }));
    const badge = page.getByTestId('phone-badge');
    await expect(badge).toHaveAttribute('data-state', 'unverified', { timeout: 20_000 });

    await enviarCodigoDoNumeroAtual(page);
    await page.getByTestId('phone-verification-code').click();
    await page.keyboard.type(WRONG_CODE, { delay: 30 });
    await page.getByTestId('phone-verification-confirm').click();

    await expect(page.getByTestId('phone-verification-error')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('phone-verification-code')).toHaveValue(''); // o campo é limpo

    await page.getByRole('button', { name: /cancelar/i }).click();
    await expect(page.getByTestId('phone-verification-code')).toHaveCount(0);
    await expect(badge).toHaveAttribute('data-state', 'unverified');
  });

  test('T-F3c-148 A2: número em uso por conta real abre o PhoneConflictModal', async ({ page }) => {
    const dono = insertEligibilityWorker(); // conta real que já tem o número
    seeded.push(dono);
    await abrirInformacionGeneral(page, insertEligibilityWorker());

    await page.getByTestId('phone-change-button').click();
    const dialogoPhone = page.getByRole('dialog').locator('input[type="tel"]');
    await expect(dialogoPhone).toBeVisible({ timeout: 15_000 });
    // '+54911XXXXXXXX' no banco = '11' + os 8 dígitos digitados no campo nacional (AR).
    await dialogoPhone.fill(`11${(dono.phone as string).slice(-8)}`);
    await page.getByTestId('phone-verification-send').click();

    await expect(page.getByTestId('phone-conflict-modal')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('phone-verification-send')).toHaveCount(0);
  });
});
