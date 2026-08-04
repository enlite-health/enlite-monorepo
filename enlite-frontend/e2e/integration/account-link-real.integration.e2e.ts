/**
 * account-link-real.integration.e2e.ts @integration
 *
 * PONTA A PONTA COM DADOS REAIS: navegador → API real (worker-functions no
 * Docker, ACCOUNT_LINK_ENABLED=true) → Postgres real → merge real. NENHUM
 * mock de /api — o que aparece na tela é o que o sistema devolve de verdade,
 * inclusive os ERROS (código de OTP errado).
 *
 * Única mediação: auth do Firebase interceptada (padrão integration da casa,
 * mock_ token com o auth_uid do worker semeado) e OTP em bypass E2E do
 * backend (SMS real só em prod — runbook do Bloco 4).
 *
 * Screenshots (e2e/__screenshots__/vinculo-real-*.png) para julgar se as
 * mensagens REAIS estão amigáveis.
 *
 * Pré-requisitos: api com docker-compose.accountlink.yml + seed 00000031-*
 * (contas nova/antiga do cenário Edith) + vite em 5173.
 */

import { test, expect, type Page, type Route } from '@playwright/test';
import { execSync } from 'child_process';

const NEW_ID = '00000031-aaaa-aaaa-aaaa-000000000001';
const OLD_ID = '00000031-bbbb-bbbb-bbbb-000000000002';
const OLD_PHONE = '5491177889012';
const PHONE_TYPED = '1177889012';

const MOCK_WORKER = {
  uid: 'e2e-link-worker-real',
  email: 'edith.nueva.real@e2e.test',
  role: 'worker',
};
const MOCK_TOKEN = 'mock_' + Buffer.from(JSON.stringify(MOCK_WORKER), 'utf-8').toString('base64');
const FAKE_ID_TOKEN =
  'eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.' +
  Buffer.from(JSON.stringify({
    sub: MOCK_WORKER.uid, uid: MOCK_WORKER.uid, email: MOCK_WORKER.email,
    iss: 'https://securetoken.google.com/enlite-prd', aud: 'enlite-prd',
    iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600,
  })).toString('base64url') + '.';

function runSQL(sql: string): string {
  return execSync(
    `docker exec enlite-postgres psql -U enlite_admin -d enlite_e2e -tAc "${sql.replace(/"/g, '\\"')}"`,
    { encoding: 'utf-8' },
  ).trim();
}

async function installInterceptors(page: Page): Promise<void> {
  await page.route('**/identitytoolkit.googleapis.com/**', async (route: Route) => {
    const url = route.request().url();
    if (url.includes('signInWithPassword') || url.includes('signUp')) {
      await route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({
          kind: 'identitytoolkit#VerifyPasswordResponse',
          localId: MOCK_WORKER.uid, email: MOCK_WORKER.email,
          idToken: FAKE_ID_TOKEN, refreshToken: 'fake-refresh-token',
          expiresIn: '3600', registered: true,
        }),
      });
      return;
    }
    await route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ users: [{ localId: MOCK_WORKER.uid, email: MOCK_WORKER.email, emailVerified: true }] }),
    });
  });

  await page.route('**/securetoken.googleapis.com/**', (route: Route) =>
    route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({
        access_token: FAKE_ID_TOKEN, expires_in: '3600', token_type: 'Bearer',
        refresh_token: 'fake-refresh-token', id_token: FAKE_ID_TOKEN,
      }),
    }),
  );

  // TUDO de /api vai pro backend REAL — só o Authorization é trocado pelo mock.
  await page.route('**/api/**', async (route: Route) => {
    const headers = { ...route.request().headers(), authorization: `Bearer ${MOCK_TOKEN}` };
    await route.continue({ headers });
  });
}

test.describe('Vínculo de contas — ponta a ponta REAL @integration', () => {
  test.setTimeout(180_000);

  test.afterAll(() => {
    for (const sql of [
      `DELETE FROM account_link_events WHERE worker_id::text LIKE '00000031%' OR other_worker_id::text LIKE '00000031%'`,
      `DELETE FROM worker_merge_snapshots WHERE absorbed_worker_id::text LIKE '00000031%'`,
      `DELETE FROM worker_merge_audit WHERE survivor_id::text LIKE '00000031%' OR absorbed_id::text LIKE '00000031%'`,
      `DELETE FROM worker_availability WHERE worker_id::text LIKE '00000031%'`,
      `DELETE FROM worker_documents WHERE worker_id::text LIKE '00000031%'`,
      `DELETE FROM domain_events WHERE payload->>'workerId' LIKE '00000031%'`,
      `UPDATE workers SET merged_into_id = NULL WHERE id::text LIKE '00000031%'`,
      `DELETE FROM workers WHERE id::text LIKE '00000031%'`,
    ]) {
      try { runSQL(sql); } catch { /* cleanup best-effort */ }
    }
  });

  test('409 real → modal real → OTP errado (erro real) → certo → conflito real → merge real → resumo', async ({ page }) => {
    await installInterceptors(page);

    // Login pela UI (auth interceptado; todo o resto é real)
    await page.goto('/login');
    await page.locator('input[type="email"]').fill(MOCK_WORKER.email);
    await page.locator('input[type="password"]').fill('Anything123!');
    await page.getByRole('button', { name: /iniciar sesi[oó]n|entrar/i }).first().click();
    await expect(page).not.toHaveURL(/\/login/, { timeout: 20_000 });

    await page.goto('/worker/profile');
    await page.waitForLoadState('networkidle');

    // Digita o número da conta ANTIGA → autosave REAL → 409 REAL do backend
    const phoneInput = page.locator('input[type="tel"]').first();
    await expect(phoneInput).toBeVisible({ timeout: 15_000 });
    await phoneInput.fill(PHONE_TYPED);
    await phoneInput.blur();

    // ── Modal com dados REAIS (email mascarado veio do banco) ─────────────
    const modal = page.getByTestId('phone-conflict-modal');
    await expect(modal).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('phone-conflict-email')).toHaveText('edit•••@e2e.test');
    await page.screenshot({ path: 'e2e/__screenshots__/vinculo-real-1-modal.png' });

    // ── Vincular → OTP REAL (bypass do backend gera sid; SMS só em prod) ──
    await page.getByTestId('phone-conflict-link-button').click();
    await expect(page.getByTestId('phone-conflict-step-otp')).toBeVisible({ timeout: 15_000 });
    await page.screenshot({ path: 'e2e/__screenshots__/vinculo-real-2-otp.png' });

    // Código ERRADO → mensagem de erro REAL do backend na tela
    await page.getByTestId('account-link-otp-input').fill('999999');
    await page.getByTestId('account-link-otp-confirm').click();
    await expect(page.getByTestId('account-link-otp-error')).toBeVisible({ timeout: 15_000 });
    await page.screenshot({ path: 'e2e/__screenshots__/vinculo-real-3-otp-erro.png' });

    // Código CERTO → conflito REAL (profession divergente no banco)
    await page.getByTestId('account-link-otp-input').fill('123456');
    await page.getByTestId('account-link-otp-confirm').click();
    await expect(page.getByTestId('phone-conflict-step-conflicts')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('conflict-field-profession')).toBeVisible();
    await page.screenshot({ path: 'e2e/__screenshots__/vinculo-real-4-conflito.png' });

    // Escolhe o valor da conta ANTERIOR e finaliza → merge REAL
    await page.getByTestId(`conflict-profession-${OLD_ID}`).click();
    await page.getByTestId('account-link-conflicts-confirm').click();
    await expect(page.getByTestId('phone-conflict-step-summary')).toBeVisible({ timeout: 20_000 });
    await page.screenshot({ path: 'e2e/__screenshots__/vinculo-real-5-resumo.png' });

    // ── Prova no BANCO: o merge aconteceu de verdade ──────────────────────
    expect(runSQL(`SELECT phone FROM workers WHERE id = '${NEW_ID}'`)).toBe(OLD_PHONE);
    expect(runSQL(`SELECT profession FROM workers WHERE id = '${NEW_ID}'`)).toBe('CAREGIVER');
    expect(runSQL(`SELECT merged_into_id FROM workers WHERE id = '${OLD_ID}'`)).toBe(NEW_ID);
    expect(runSQL(`SELECT source FROM worker_merge_audit WHERE survivor_id = '${NEW_ID}' ORDER BY created_at DESC LIMIT 1`)).toBe('self_service_link');
    expect(Number(runSQL(`SELECT COUNT(*) FROM account_link_events WHERE worker_id = '${NEW_ID}' AND event = 'merged'`))).toBe(1);
  });
});
