/**
 * worker-sem-email-tela.integration.e2e.ts @integration
 *
 * Spec 040 (gate revisao-pr, critério 4): worker criado pela Talentum v2 só com telefone tem
 * `workers.email = NULL` (migration 499). PONTA A PONTA, com login MOCK de staff: navegador real →
 * worker-functions real (Docker) → Postgres real, worker semeado por SQL (massa sintética).
 *
 * Casos:
 *  a. feliz — a lista de /admin/workers mostra o worker sem e-mail com "—" no lugar do e-mail
 *     (WorkersTable: `row.email || '—'`), e nunca "null";
 *  b. busca por NOME digitada (click + keyboard.type) acha o worker e a API responde 200, não 500
 *     (AdminWorkersController: `worker.email ?? ''` no filtro por nome);
 *  c. detalhe de worker SEM nome e SEM e-mail mostra "—" (cabeçalho, card, e-mail) e nunca "null".
 *
 * Pré-requisitos: stack `docker compose … up -d postgres api` com USE_MOCK_AUTH=true + Vite igual ao do CI.
 */
import { test, expect, type Page } from '@playwright/test';
import { loginComoStaffMock } from '../helpers/login-mock-staff';
import type { MockUser } from '../helpers/abac-stack-helper';
import { runSQL } from '../helpers/patient-detail-a-helper';
import { nameTrgmBidxSql } from '../helpers/patient-detail-c-helper';

const STAFF: MockUser = { uid: 'e2e-int-admin-w040', email: 'admin.w040@e2e.test', role: 'admin', country: 'AR' };
const STAMP = Date.now().toString().slice(-7);
const FIRST = `SinEmail${STAMP}`;
const LAST = 'QA';
const NAME = `${FIRST} ${LAST}`;
const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');
const SHOTS = process.env.E2E_SHOTS_DIR;

test.use({ viewport: { width: 1600, height: 900 } });

test.describe('Worker sem e-mail nas telas de admin (spec 040) @integration', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(180_000);

  let workerComNome = '';
  let workerSemNada = '';

  test.beforeAll(() => {
    workerComNome = runSQL(
      `WITH ins AS (INSERT INTO workers (auth_uid, email, phone, country, timezone, first_name_encrypted, last_name_encrypted, name_trgm_bidx) VALUES ('e2e-w040-a-${STAMP}', NULL, '+5411${STAMP}', 'AR', 'America/Argentina/Buenos_Aires', '${b64(FIRST)}', '${b64(LAST)}', ${nameTrgmBidxSql(FIRST, LAST)}) RETURNING id) SELECT id FROM ins`,
    );
    workerSemNada = runSQL(
      `WITH ins AS (INSERT INTO workers (auth_uid, email, country, timezone) VALUES ('e2e-w040-c-${STAMP}', NULL, 'AR', 'America/Argentina/Buenos_Aires') RETURNING id) SELECT id FROM ins`,
    );
    expect(workerComNome).toMatch(/^[0-9a-f-]{36}$/);
    expect(workerSemNada).toMatch(/^[0-9a-f-]{36}$/);
  });

  test.afterAll(() => {
    for (const id of [workerComNome, workerSemNada]) {
      if (id) runSQL(`DELETE FROM workers WHERE id = '${id}'`);
    }
  });

  async function shot(page: Page, file: string) {
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/${file}`, fullPage: true });
  }

  test('a. FELIZ — a lista mostra o worker sem e-mail com "—" (nunca "null")', async ({ page }) => {
    await loginComoStaffMock(page, STAFF, 'E2E W040');
    await page.goto('/admin/workers');

    const row = page.locator('tr', { hasText: NAME });
    await expect(row).toBeVisible({ timeout: 30_000 });
    const emailLinha = (await row.locator('span').nth(1).textContent())?.trim();
    expect(emailLinha).toBe('—');
    expect(await row.innerText()).not.toContain('null');
    await shot(page, '1-lista-sem-email.png');
  });

  test('b. busca por NOME (digitada) acha o worker sem e-mail e a API responde 200', async ({ page }) => {
    await loginComoStaffMock(page, STAFF, 'E2E W040');
    await page.goto('/admin/workers');
    await expect(page.locator('tr', { hasText: NAME })).toBeVisible({ timeout: 30_000 });

    const status: number[] = [];
    page.on('response', (r) => {
      if (r.url().includes('/api/admin/workers') && r.url().includes('search=')) status.push(r.status());
    });

    const busca = page.getByPlaceholder(/Nombre, email o tel/i);
    await busca.click();
    await expect(busca).toBeFocused();
    await page.keyboard.type(FIRST);
    expect(await busca.inputValue()).toBe(FIRST);

    await expect.poll(() => status.length, { timeout: 15_000 }).toBeGreaterThan(0);
    const row = page.locator('tr', { hasText: NAME });
    await expect(row).toBeVisible({ timeout: 15_000 });
    expect(status.every((s) => s === 200)).toBe(true);
    expect((await row.locator('span').nth(0).textContent())?.trim()).toBe(NAME);
    expect((await row.locator('span').nth(1).textContent())?.trim()).toBe('—');
    await shot(page, '2-busca-por-nome.png');
  });

  test('c. detalhe de worker sem nome e sem e-mail mostra "—" e não "null"', async ({ page }) => {
    await loginComoStaffMock(page, STAFF, 'E2E W040');
    await page.goto(`/admin/workers/${workerSemNada}`);

    const card = page.getByTestId('worker-contact-card');
    await expect(card).toBeVisible({ timeout: 30_000 });
    const titulo = (await card.getByRole('heading', { level: 3 }).first().textContent())?.trim();
    expect(titulo).toBe('—');
    const email = (await card.locator('p, span').filter({ hasText: /^—$/ }).first().textContent())?.trim();
    expect(email).toBe('—');
    expect(await page.locator('body').innerText()).not.toMatch(/\bnull\b/);
    await shot(page, '3-detalhe-sem-nome-sem-email.png');
  });
});
