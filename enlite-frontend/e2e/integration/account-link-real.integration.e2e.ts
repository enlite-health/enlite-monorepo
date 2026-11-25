/**
 * account-link-real.integration.e2e.ts @integration
 *
 * PONTA A PONTA COM DADOS REAIS: navegador → API real (worker-functions no
 * Docker, ACCOUNT_LINK_ENABLED=true) → Postgres real → merge real. NENHUM
 * mock de /api — o que aparece na tela é o que o sistema devolve de verdade,
 * inclusive os ERROS (código de OTP errado).
 *
 * Única mediação: auth do Firebase interceptada (`loginNewWorker`, o helper da
 * casa: mock_ token com o auth_uid do worker semeado + troca do /v1/me/areas) e
 * OTP em bypass E2E do backend (`E2E_OTP_BYPASS`, docker-compose.test.yml —
 * nenhum canal real; o e-mail de aviso do merge não sai: NODE_ENV=test e
 * SENDGRID_API_KEY vazia no mesmo compose).
 *
 * Screenshots (e2e/__screenshots__/vinculo-real-*.png) para julgar se as
 * mensagens REAIS estão amigáveis.
 *
 * Pré-requisitos: api com docker-compose.accountlink.yml (ACCOUNT_LINK_ENABLED=true,
 * como em prd — o job padrão do `_frontend-integration.yml` sobe assim) + vite em 5173.
 * A massa 00000031-* (contas nova/antiga do cenário Edith) é semeada AQUI, no beforeAll:
 * antes ela era um seed manual fora do git, e por isso o spec nunca rodou no CI.
 */

import { test, expect } from '@playwright/test';
import { execSync } from 'child_process';
import { loginNewWorker } from '../helpers/worker-realreg-auth-helper';

const NEW_ID = '00000031-aaaa-aaaa-aaaa-000000000001';
const OLD_ID = '00000031-bbbb-bbbb-bbbb-000000000002';
const OLD_PHONE = '5491177889012';
const PHONE_TYPED = '1177889012';

const MOCK_WORKER = {
  uid: 'e2e-link-worker-real',
  email: 'edith.nueva.real@e2e.test',
};
// Conta ANTIGA: login REAL (auth_uid não sintético → PHONE_IN_USE, não claim); o e-mail mascarado é `edit•••@e2e.test`.
const OLD_UID = 'e2e-link-worker-antiga';
const OLD_EMAIL = 'edith.antigua@e2e.test';

function runSQL(sql: string): string {
  return execSync(
    `docker exec enlite-postgres psql -U enlite_admin -d enlite_e2e -tAc "${sql.replace(/"/g, '\\"')}"`,
    { encoding: 'utf-8' },
  ).trim();
}

const CLEANUP_SQL = [
  `DELETE FROM account_link_events WHERE worker_id::text LIKE '00000031%' OR other_worker_id::text LIKE '00000031%'`,
  `DELETE FROM worker_merge_snapshots WHERE absorbed_worker_id::text LIKE '00000031%'`,
  `DELETE FROM worker_merge_audit WHERE survivor_id::text LIKE '00000031%' OR absorbed_id::text LIKE '00000031%'`,
  `DELETE FROM worker_availability WHERE worker_id::text LIKE '00000031%'`,
  `DELETE FROM worker_documents WHERE worker_id::text LIKE '00000031%'`,
  `DELETE FROM domain_events WHERE payload->>'workerId' LIKE '00000031%'`,
  `UPDATE workers SET merged_into_id = NULL WHERE id::text LIKE '00000031%'`,
  `DELETE FROM workers WHERE id::text LIKE '00000031%'`,
];

function cleanup(): void {
  for (const sql of CLEANUP_SQL) {
    try { runSQL(sql); } catch { /* cleanup best-effort */ }
  }
}

/**
 * Massa do cenário Edith: duas contas REAIS. A NOVA (logada) sem telefone e com profissão AT; a ANTIGA com o telefone e
 * profissão CAREGIVER — o único campo de `WORKER_COMPARE_FIELDS` em conflito (knowledge_level/years_experience nulos nas duas).
 * Sem WJA nem dado de pagamento: a antiga não é "alto valor" (o confirm não cai em REQUIRES_REVIEW).
 */
function seed(): void {
  runSQL(
    `INSERT INTO workers (id, auth_uid, email, phone, status, country, profession, occupation, created_at, updated_at) VALUES ` +
      `('${NEW_ID}', '${MOCK_WORKER.uid}', '${MOCK_WORKER.email}', NULL, 'INCOMPLETE_REGISTER', 'AR', 'AT', 'AT', NOW(), NOW()), ` +
      `('${OLD_ID}', '${OLD_UID}', '${OLD_EMAIL}', '${OLD_PHONE}', 'INCOMPLETE_REGISTER', 'AR', 'CAREGIVER', 'CAREGIVER', NOW() - INTERVAL '30 days', NOW() - INTERVAL '30 days')`,
  );
}

test.describe('Vínculo de contas — ponta a ponta REAL @integration', () => {
  test.setTimeout(180_000);

  // Limpa ANTES de semear: um retry (ou uma rodada anterior interrompida) não deixa resíduo que quebre o INSERT.
  test.beforeAll(() => {
    cleanup();
    seed();
  });
  test.afterAll(() => cleanup());

  test('PHONE_IN_USE real → modal real → OTP errado (erro real) → certo → conflito real → merge real → resumo', async ({ page }) => {
    // Login pela UI (auth interceptado; todo o resto é real)
    await loginNewWorker(page, MOCK_WORKER.uid, MOCK_WORKER.email);

    await page.goto('/worker/profile');
    await page.waitForLoadState('networkidle');

    // O telefone não é mais digitado no perfil (emenda 077 §6, AC-16): entra pela verificação.
    // Informa o número da conta ANTIGA no modal → phone/start REAL → PHONE_IN_USE REAL do backend.
    await page.goto('/worker/profile?tab=general', { waitUntil: 'networkidle' });
    await expect(page.getByTestId('phone-readonly')).toBeVisible({ timeout: 15_000 });
    await page.getByTestId('phone-change-button').click();
    const phoneInput = page.getByRole('dialog').locator('input[type="tel"]');
    await expect(phoneInput).toBeVisible({ timeout: 15_000 });
    await phoneInput.fill(PHONE_TYPED);
    await page.getByTestId('phone-verification-send').click();

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
