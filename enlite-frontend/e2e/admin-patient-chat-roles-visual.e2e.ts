/**
 * admin-patient-chat-roles-visual.e2e.ts
 *
 * PROVA VISUAL da tela de administração do CATÁLOGO de papéis (ClickUp
 * 86ajy1jhz, migration 262).
 *
 * ⚠️ SEM MOCK DE PAYLOAD. O que este teste faz, na ordem:
 *   1. cria um usuário admin no Firebase Auth Emulator e a linha em `users`;
 *   2. semeia um paciente REAL e vincula um grupo pela NOSSA API
 *      (PUT /api/admin/patients/:id/chat-ids) — para a coluna "Em uso" da tela
 *      mostrar um número que veio de uma linha que existe em `patient_chat_ids`;
 *   3. faz login pela TELA;
 *   4. abre /admin/patient-chat-roles, fotografa a lista;
 *   5. TENTA desativar o papel em uso e fotografa a RECUSA com a contagem —
 *      que é a metade da feature que não pode falhar em silêncio;
 *   6. abre o formulário de criação e fotografa.
 *
 * Ou seja: cada pixel veio do banco através da nossa API. Contagem no DOM não é
 * prova visual, e mock de payload também não é.
 *
 * 🚨 Nenhuma escrita no Periskope: esta tela nem fala com o fornecedor.
 */

import { test, expect, Page } from '@playwright/test';
import { execSync } from 'child_process';
import { randomUUID } from 'crypto';

const FIREBASE_EMULATOR = 'http://127.0.0.1:9099';
const FIREBASE_API_KEY = 'test-api-key';
const API = 'http://127.0.0.1:8080';

const PATIENT_ID = randomUUID();
const GROUP_FAMILY = '120363090000000201@g.us';

function projectFromToken(idToken: string): string {
  const payload = JSON.parse(Buffer.from(idToken.split('.')[1], 'base64').toString()) as { aud?: string };
  if (!payload.aud) throw new Error('token do emulador sem `aud`');
  return payload.aud;
}

function psql(sql: string): void {
  execSync(
    `docker exec enlite-postgres psql -U enlite_admin -d enlite_e2e -v ON_ERROR_STOP=1 -c "${sql.replace(/\n/g, ' ').trim()}"`,
    { stdio: 'pipe' },
  );
}

async function signUpAdmin(): Promise<{ email: string; password: string; token: string }> {
  const email = `e2e.chatroles.${randomUUID()}@test.com`;
  const password = 'TestAdmin123!';

  const res = await fetch(
    `${FIREBASE_EMULATOR}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=${FIREBASE_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, returnSecureToken: true }),
    },
  );
  const data = (await res.json()) as { localId?: string; idToken?: string };
  if (!data.localId || !data.idToken) throw new Error(`sign-up falhou: ${JSON.stringify(data)}`);

  psql(`
    INSERT INTO users (firebase_uid, email, display_name, role, is_active, created_at, updated_at)
      VALUES ('${data.localId}', '${email}', 'ChatRoles E2E', 'admin', true, NOW(), NOW())
      ON CONFLICT DO NOTHING;
  `);

  // Em modo emulador o backend lê o papel do CLAIM do JWT, não do banco.
  const claimRes = await fetch(
    `${FIREBASE_EMULATOR}/identitytoolkit.googleapis.com/v1/projects/${projectFromToken(data.idToken)}/accounts:update`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer owner' },
      body: JSON.stringify({ localId: data.localId, customAttributes: JSON.stringify({ role: 'admin' }) }),
    },
  );
  if (!claimRes.ok) throw new Error(`set claims falhou: ${claimRes.status} ${await claimRes.text()}`);

  const signInRes = await fetch(
    `${FIREBASE_EMULATOR}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${FIREBASE_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, returnSecureToken: true }),
    },
  );
  const signInData = (await signInRes.json()) as { idToken?: string };
  if (!signInData.idToken) throw new Error(`sign-in falhou: ${JSON.stringify(signInData)}`);

  return { email, password, token: signInData.idToken };
}

async function login(page: Page, email: string, password: string): Promise<void> {
  await page.goto('/admin/login');
  await page.locator('input[type="email"]').fill(email);
  await page.locator('input[type="password"]').fill(password);
  await page.locator('button[type="submit"]').click();
  await expect(page).not.toHaveURL(/.*login.*/, { timeout: 30000 });
}

test.describe('Catálogo de papéis de chat — prova visual', () => {
  // SERIAL: os três testes compartilham o MESMO paciente e o MESMO papel do
  // catálogo. Em paralelo, o teste que tenta desativar FAMILY correria contra o
  // que lê a contagem, e cada worker rodaria o `beforeAll` de novo (o segundo
  // sign-up bate em EMAIL_EXISTS).
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(180000);

  let creds: { email: string; password: string; token: string };

  test.beforeAll(async () => {
    creds = await signUpAdmin();

    psql(`
      INSERT INTO patients (id, clickup_task_id, first_name, last_name, country, status, created_at, updated_at)
        VALUES ('${PATIENT_ID}', 'e2e-roles-${PATIENT_ID}', 'Catalogo', 'Rolesvisual', 'AR', 'ACTIVE', NOW(), NOW());
    `);

    // Um vínculo REAL, pela nossa API — é ele que faz a coluna "Em uso" da tela
    // mostrar 1 em vez de 0, e é o que faz a recusa de desativação acontecer.
    const res = await fetch(`${API}/api/admin/patients/${PATIENT_ID}/chat-ids`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${creds.token}` },
      body: JSON.stringify({ chatIds: { FAMILY: GROUP_FAMILY } }),
    });
    if (res.status !== 200) {
      throw new Error(`PUT chat-ids falhou: ${res.status} ${JSON.stringify(await res.json())}`);
    }
  });

  test.afterAll(() => {
    try {
      psql(`DELETE FROM patients WHERE id = '${PATIENT_ID}';`);
    } catch { /* best effort */ }
  });

  test('a tela lista o catálogo com a política e a contagem de uso REAL', async ({ page }) => {
    await login(page, creds.email, creds.password);
    await page.goto('/admin/patient-chat-roles');

    const table = page.getByTestId('chat-roles-table');
    await expect(table).toBeVisible({ timeout: 20000 });

    // Os três papéis semeados pela 262
    await expect(page.getByTestId('chat-role-row-FAMILY')).toBeVisible();
    await expect(page.getByTestId('chat-role-row-PROVIDERS')).toBeVisible();
    await expect(page.getByTestId('chat-role-row-HEALTH_PLAN')).toBeVisible();

    // HEALTH_PLAN aparece como COMPARTILHADO — é a decisão dos 27 pagadores,
    // visível na tela e não só no banco.
    await expect(page.getByTestId('chat-role-exclusive-FAMILY')).toContainText(/Exclusivo/i);
    await expect(page.getByTestId('chat-role-exclusive-HEALTH_PLAN')).toContainText(/Compartid/i);

    // A contagem vem do vínculo que criamos pela API.
    await expect(page.getByTestId('chat-role-usage-FAMILY')).toContainText('1');
    await expect(page.getByTestId('chat-role-usage-PROVIDERS')).toContainText('0');

    await table.scrollIntoViewIfNeeded();
    await page.waitForTimeout(400);
    await page.screenshot({ path: 'e2e/__screenshots__/chat-roles-lista.png', fullPage: false });
    await table.screenshot({ path: 'e2e/__screenshots__/chat-roles-tabela.png' });
  });

  test('desativar papel EM USO é recusado NA TELA, com a contagem', async ({ page }) => {
    // Esta é a metade da feature que não pode falhar em silêncio. A mensagem
    // que aparece é a do backend, com o número — trocá-la por um texto genérico
    // tiraria justamente o que decide o que a pessoa faz em seguida.
    await login(page, creds.email, creds.password);
    await page.goto('/admin/patient-chat-roles');
    await expect(page.getByTestId('chat-roles-table')).toBeVisible({ timeout: 20000 });

    await page.getByTestId('chat-role-toggle-FAMILY').click();

    const erro = page.getByTestId('chat-roles-action-error');
    await expect(erro).toBeVisible({ timeout: 15000 });
    // TRADUZIDA (o painel é es-AR) e COM a contagem que veio do servidor.
    await expect(erro).toContainText('1 paciente');
    await expect(erro).not.toContainText('Chat role is in use');

    // e o papel continua ATIVO — a recusa não deixou meio-estado
    await expect(page.getByTestId('chat-role-status-FAMILY')).toContainText(/Activo|Ativo/i);

    await erro.scrollIntoViewIfNeeded();
    await page.waitForTimeout(400);
    await page.screenshot({ path: 'e2e/__screenshots__/chat-roles-recusa-em-uso.png', fullPage: false });
  });

  test('o formulário de criação abre com os campos do catálogo', async ({ page }) => {
    await login(page, creds.email, creds.password);
    await page.goto('/admin/patient-chat-roles');
    await expect(page.getByTestId('chat-roles-table')).toBeVisible({ timeout: 20000 });

    await page.getByTestId('chat-role-new-btn').click();
    const modal = page.getByTestId('chat-role-form-modal');
    await expect(modal).toBeVisible();
    await page.waitForTimeout(600);

    // Erro de forma do código aparece ANTES do round-trip.
    await page.getByTestId('chat-role-code-input').fill('HEALTH PLAN');
    await expect(page.getByTestId('chat-role-code-error')).toBeVisible();
    await expect(page.getByTestId('chat-role-save')).toBeDisabled();

    // Código válido + os dois rótulos liberam o salvar.
    await page.getByTestId('chat-role-code-input').fill('MANAGEMENT');
    await page.getByTestId('chat-role-label-es-input').fill('Grupo de gestión');
    await page.getByTestId('chat-role-label-pt-input').fill('Grupo de gestão');
    await expect(page.getByTestId('chat-role-code-error')).toHaveCount(0);
    await expect(page.getByTestId('chat-role-save')).toBeEnabled();

    await page.screenshot({ path: 'e2e/__screenshots__/chat-roles-formulario.png', fullPage: false });
  });
});
