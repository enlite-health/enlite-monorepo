/**
 * claim-otp-modal.integration.e2e.ts @integration
 *
 * PONTA A PONTA COM DADOS REAIS: navegador → API real (worker-functions no Docker) → Postgres real.
 * NENHUMA interceptação de rota de dado: o `POST /api/auth/claim/start` que abre o `ClaimOtpModal` é o REAL, e a
 * tela só recebe `{ phoneMasked, verificationSid }` (sem id interno de ficha — a enumeração do start, B4).
 *
 * Única mediação: o Firebase Auth do helper da casa (`loginNewWorker`, como em `account-link-real`) e o OTP em
 * bypass E2E do backend (`E2E_OTP_BYPASS`, docker-compose.test.yml) — nenhum canal real é tocado.
 *
 * Roda só no CI (job do `_frontend-integration.yml`); não rodar contra o stack local.
 */

import { test, expect } from '@playwright/test';
import { execSync } from 'child_process';
import { loginNewWorker } from '../helpers/worker-realreg-auth-helper';

const FICHA_ID = '00000077-cccc-cccc-cccc-000000000001';
const FICHA_UID = 'candidatoimport_uid-teste-claim-web'; // prefixo de ficha IMPORTADA (reclamável)
const FICHA_EMAIL = 'ficha.claim.web@e2e.test';
const FICHA_PHONE = '+5491100000000';
const PHONE_TYPED = '1100000000'; // campo nacional (AR) → +54 9 11 0000 0000

const LOGIN = { uid: 'uid-teste-claim-nueva', email: 'claim.nueva.web@e2e.test' };

function runSQL(sql: string): string {
  return execSync(
    `docker exec enlite-postgres psql -U enlite_admin -d enlite_e2e -tAc "${sql.replace(/"/g, '\\"')}"`,
    { encoding: 'utf-8' },
  ).trim();
}

function cleanup(): void {
  const steps = [
    `DELETE FROM otp_send_events WHERE target_worker_id = '${FICHA_ID}'`,
    `DELETE FROM otp_challenges WHERE worker_id = '${FICHA_ID}'`,
    `DELETE FROM workers WHERE id = '${FICHA_ID}' OR auth_uid = '${LOGIN.uid}'`,
  ];
  for (const sql of steps) {
    try { runSQL(sql); } catch { /* cleanup best-effort */ }
  }
}

function seed(): void {
  runSQL(
    `INSERT INTO workers (id, auth_uid, email, phone, status, country, created_at, updated_at) VALUES ` +
      `('${FICHA_ID}', '${FICHA_UID}', '${FICHA_EMAIL}', '${FICHA_PHONE}', 'INCOMPLETE_REGISTER', 'AR', NOW() - INTERVAL '30 days', NOW() - INTERVAL '30 days')`,
  );
}

test.describe('Claim de ficha importada — modal do código, API real @integration', () => {
  test.use({ viewport: { width: 1440, height: 900 } });
  test.setTimeout(120_000);

  test.beforeAll(() => {
    cleanup();
    seed();
  });
  test.afterAll(() => cleanup());

  test('/complete-whatsapp com o telefone de uma ficha importada → claim/start real → modal do código', async ({ page }) => {
    await loginNewWorker(page, LOGIN.uid, LOGIN.email);

    // O start REAL responde só { phoneMasked, verificationSid }: observamos a resposta, sem interceptá-la.
    const startResponse = page.waitForResponse((r) => r.url().includes('/api/auth/claim/start') && r.request().method() === 'POST');

    await page.goto('/complete-whatsapp', { waitUntil: 'networkidle' });
    const phoneInput = page.locator('input[type="tel"]');
    await expect(phoneInput).toBeVisible({ timeout: 15_000 });
    await phoneInput.fill(PHONE_TYPED);
    await page.locator('button[type="submit"]').click();

    const resp = await startResponse;
    expect(resp.status()).toBe(200);
    const data = (await resp.json()).data as Record<string, unknown>;
    expect(Object.keys(data).sort()).toEqual(['phoneMasked', 'verificationSid']);

    const modal = page.getByRole('dialog');
    await expect(modal).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('otp-input')).toBeVisible();
    await expect(modal).toHaveScreenshot('claim-otp-modal-open-real.png', { maxDiffPixelRatio: 0.02 });
  });
});
