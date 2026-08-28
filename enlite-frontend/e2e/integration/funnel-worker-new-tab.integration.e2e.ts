/**
 * funnel-worker-new-tab.integration.e2e.ts @integration
 *
 * PONTA A PONTA SEM MOCK: navegador real → worker-functions real (Docker) →
 * Postgres real → Firebase Auth EMULATOR real (docker-compose.firebase.yml,
 * USE_MOCK_AUTH=false). Nenhum `page.route`: o login é o fluxo de produção
 * (SDK do Firebase contra o emulador; o backend valida o token no emulador e
 * lê o papel do staff na tabela users — FirebaseAuthStrategy.getRoleFromDB).
 *
 * O que prova (planning 26/08, 2026-08-26a#REQ-05, correção do Gabriel 28/08):
 *   - na LISTA do funil da vaga e no KANBAN, o nome do prestador é um link
 *     real que abre o perfil em NOVA ABA; a tela da vaga fica intacta atrás.
 *
 * Pré-requisitos:
 *   cd worker-functions && docker compose -f docker-compose.yml -f docker-compose.test.yml \
 *     -f docker-compose.firebase.yml up -d postgres firebase-emulator api
 *   cd enlite-frontend && VITE_FIREBASE_PROJECT_ID=enlite-e2e-test  # = MultiAuthService fora de prod \
 *     VITE_FIREBASE_AUTH_EMULATOR=http://localhost:9099 VITE_API_WORKER_FUNCTIONS_URL=http://localhost:8080 pnpm dev
 *   pnpm exec playwright test funnel-worker-new-tab --project=integration
 */

import { test, expect, type Page } from '@playwright/test';
import { execSync } from 'child_process';
import {
  insertTestPatient,
  insertBaseVacancy,
  insertTestWorker,
  cleanupTestWorker,
  cleanupTestPatient,
} from '../helpers/db-test-helper';
import { insertWJA, cleanupWJAAndEncuadre } from '../helpers/wja-test-helper';

const EMULATOR = 'http://127.0.0.1:9099';
// O emulador do compose sobe como demo-no-project (ver docker-compose.firebase.yml).
const EMULATOR_PROJECT = 'demo-no-project';
const WORKER_FIRST = 'Req05';
const WORKER_LAST = `NovaAba${Date.now().toString().slice(-5)}`;
const WORKER_FULL = `${WORKER_FIRST} ${WORKER_LAST}`;
const STAFF_EMAIL = `e2e.req05.${Date.now()}@enlite.health`;
const STAFF_PASSWORD = 'TestAdmin123!';

function runSQL(sql: string): string {
  return execSync(
    `docker exec enlite-postgres psql -U enlite_admin -d enlite_e2e -tAc "${sql.replace(/"/g, '\\"')}"`,
    { encoding: 'utf-8' },
  ).trim();
}

/** Cria o staff no emulador (REST do Identity Toolkit) e loga pela UI real. */
async function loginAsRealStaff(page: Page): Promise<void> {
  const res = await fetch(`${EMULATOR}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=any`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: STAFF_EMAIL, password: STAFF_PASSWORD, returnSecureToken: true }),
  });
  expect(res.ok, `signUp no emulador falhou: ${res.status}`).toBe(true);
  const { localId } = (await res.json()) as { localId: string };
  // Claim de papel no token (o que setCustomUserClaims faz no auto-provision): em modo
  // emulador o FirebaseAuthStrategy lê o papel SÓ do token, sem fallback no banco.
  const claims = await fetch(`${EMULATOR}/identitytoolkit.googleapis.com/v1/projects/${EMULATOR_PROJECT}/accounts:update`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer owner' },
    body: JSON.stringify({ localId, customAttributes: JSON.stringify({ role: 'admin' }) }),
  });
  expect(claims.ok, `customAttributes no emulador falhou: ${claims.status}`).toBe(true);
  // Staff convidado (como faz POST /api/admin/users): a linha em `users` é o que o
  // FirebaseAuthStrategy consulta quando o token não traz claim de papel — sem ela
  // o 1º login auto-provisiona RECRUITER mas o token já emitido não carrega o papel.
  runSQL(
    `INSERT INTO users (firebase_uid, email, display_name, role, is_active, email_verified) ` +
      `VALUES ('${localId}', '${STAFF_EMAIL}', 'E2E Req05', 'admin', true, true) ON CONFLICT (firebase_uid) DO NOTHING`,
  );

  await page.addInitScript(() => localStorage.setItem('i18nextLng', 'es'));
  await page.goto('/admin/login');
  await page.locator('input[type="email"]').fill(STAFF_EMAIL);
  await page.locator('input[type="password"]').fill(STAFF_PASSWORD);
  await page.getByRole('button', { name: /Iniciar sesi/i }).click();
  await expect(page).not.toHaveURL(/login/, { timeout: 30_000 });
}

// Vídeo + viewport no topo: `test.use` dentro de describe força worker novo (regra do Playwright).
test.use({ viewport: { width: 1600, height: 900 }, video: 'on' });

test.describe('Funil da vaga → perfil do prestador em NOVA ABA (real) @integration', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(180_000);

  let patientId = '';
  let vacancyId = '';
  let workerId = '';

  test.beforeAll(() => {
    const { patientId: pid, addressId } = insertTestPatient({ withAddress: true, firstName: 'Paciente', lastName: 'Req05' });
    patientId = pid;
    vacancyId = insertBaseVacancy({
      patientId,
      patientAddressId: addressId!,
      caseNumber: 90500 + Math.floor(Math.random() * 400),
      status: 'SEARCHING',
      isDraft: false,
    });
    workerId = insertTestWorker({ firstName: WORKER_FIRST, lastName: WORKER_LAST, occupation: 'AT' });
    insertWJA({ workerId, jobPostingId: vacancyId, funnelStage: 'INVITED', source: 'manual' });
  });

  test.afterAll(() => {
    try { cleanupWJAAndEncuadre(workerId, vacancyId); } catch { /* já limpo */ }
    cleanupTestWorker(workerId);
    cleanupTestPatient(patientId);
    runSQL(`DELETE FROM users WHERE email = '${STAFF_EMAIL}'`);
  });

  test('lista e Kanban: o nome é link, abre o perfil em nova aba e a vaga fica atrás', async ({ page, context }, testInfo) => {
    await loginAsRealStaff(page);

    // ── LISTA (vista padrão do funil) ──────────────────────────────────────
    await page.goto(`/admin/vacancies/${vacancyId}`);
    const listLink = page.getByTestId('funnel-worker-link').filter({ hasText: WORKER_FULL });
    await expect(listLink).toBeVisible({ timeout: 30_000 });
    await expect(listLink).toHaveAttribute('href', `/admin/workers/${workerId}`);
    await expect(listLink).toHaveAttribute('target', '_blank');
    await expect(listLink).toHaveAttribute('rel', 'noopener noreferrer');

    await expect(page).toHaveScreenshot('req05-lista-nome-link.png', { fullPage: true, maxDiffPixelRatio: 0.05 });
    await page.screenshot({ path: testInfo.outputPath('01-lista-nome-link.png'), fullPage: true });

    const [popup1] = await Promise.all([context.waitForEvent('page'), listLink.click()]);
    await popup1.waitForURL(new RegExp(`/admin/workers/${workerId}$`), { timeout: 30_000 });
    await expect(popup1.getByText(WORKER_FULL, { exact: false }).first()).toBeVisible({ timeout: 30_000 });
    await expect(page).toHaveURL(new RegExp(`/admin/vacancies/${vacancyId}$`)); // a vaga ficou atrás
    await expect(popup1).toHaveScreenshot('req05-nova-aba-perfil.png', { fullPage: true, maxDiffPixelRatio: 0.05 });
    await popup1.screenshot({ path: testInfo.outputPath('02-nova-aba-perfil.png'), fullPage: true });
    await popup1.close();

    // ── KANBAN ─────────────────────────────────────────────────────────────
    await page.getByRole('button', { name: 'Kanban' }).click();
    const cardLink = page.getByRole('link', { name: WORKER_FULL });
    await expect(cardLink).toBeVisible({ timeout: 30_000 });
    await expect(cardLink).toHaveAttribute('href', `/admin/workers/${workerId}`);
    await expect(cardLink).toHaveAttribute('target', '_blank');

    await expect(page).toHaveScreenshot('req05-kanban-nome-link.png', { fullPage: true, maxDiffPixelRatio: 0.05 });
    await page.screenshot({ path: testInfo.outputPath('03-kanban-nome-link.png'), fullPage: true });

    const [popup2] = await Promise.all([context.waitForEvent('page'), cardLink.click()]);
    await popup2.waitForURL(new RegExp(`/admin/workers/${workerId}$`), { timeout: 30_000 });
    await expect(popup2.getByText(WORKER_FULL, { exact: false }).first()).toBeVisible({ timeout: 30_000 });
    await expect(page).toHaveURL(new RegExp(`/admin/vacancies/${vacancyId}$`));
    await popup2.screenshot({ path: testInfo.outputPath('04-kanban-nova-aba-perfil.png'), fullPage: true });
    await popup2.close();

    expect(context.pages().map((p) => p.url())).toHaveLength(1); // só a vaga ficou aberta
  });
});
