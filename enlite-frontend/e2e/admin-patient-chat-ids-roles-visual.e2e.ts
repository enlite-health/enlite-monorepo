/**
 * admin-patient-chat-ids-roles-visual.e2e.ts
 *
 * PROVA VISUAL da mudança "chat IDs por PAPEL" (ClickUp 86ajy1jhz).
 *
 * ⚠️ SEM MOCK DO PACIENTE. O que este teste faz, na ordem:
 *   1. cria um usuário no Firebase Auth Emulator e a linha de staff no Postgres;
 *   2. semeia um paciente REAL no Postgres;
 *   3. vincula os TRÊS papéis chamando a NOSSA API de verdade
 *      (PUT /api/admin/patients/:id/chat-ids), com o token do emulador;
 *   4. faz login pela TELA e navega até a ficha;
 *   5. abre a aba "Red de Apoyo", rola o card para dentro da viewport e
 *      fotografa.
 *
 * Ou seja: o pixel que aparece na screenshot veio de uma linha que existe em
 * `patient_chat_ids`. Contagem no DOM não é prova visual, e mock de payload
 * também não é — por isso o único `page.route` aqui é o de listagem de usuários
 * do menu, que não tem nada a ver com o que está sendo provado.
 *
 * 🚨 Nenhuma escrita no Periskope: o drawer não é aberto e a busca de candidatos
 * não é acionada.
 */

import { test, expect, Page } from '@playwright/test';
import { execSync } from 'child_process';
import { randomUUID } from 'crypto';

const FIREBASE_EMULATOR = 'http://127.0.0.1:9099';
const FIREBASE_API_KEY = 'test-api-key';

/** Project do token que o emulador emite quando a API key não é reconhecida. */
function projectFromToken(idToken: string): string {
  const payload = JSON.parse(Buffer.from(idToken.split('.')[1], 'base64').toString()) as { aud?: string };
  if (!payload.aud) throw new Error('token do emulador sem `aud`');
  return payload.aud;
}
const API = 'http://127.0.0.1:8080';

const GROUP_FAMILY = '120363090000000101@g.us';
const GROUP_PROVIDERS = '120363090000000102@g.us';
const GROUP_HEALTH_PLAN = '120363090000000103@g.us';

const PATIENT_ID = randomUUID();

function psql(sql: string): void {
  execSync(
    `docker exec enlite-postgres psql -U enlite_admin -d enlite_e2e -v ON_ERROR_STOP=1 -c "${sql.replace(/\n/g, ' ').trim()}"`,
    { stdio: 'pipe' },
  );
}

async function signUpStaff(): Promise<{ email: string; password: string; token: string }> {
  const email = `e2e.chatids.roles.${Date.now()}@test.com`;
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
      VALUES ('${data.localId}', '${email}', 'ChatIds Roles E2E', 'admin', true, NOW(), NOW())
      ON CONFLICT DO NOTHING;
  `);

  // Em modo emulador o backend lê o papel do CLAIM do JWT (FirebaseAuthStrategy
  // .authenticateEmulator), não do banco — sem isto o staffOnly devolve 403.
  const claimRes = await fetch(
    `${FIREBASE_EMULATOR}/identitytoolkit.googleapis.com/v1/projects/${projectFromToken(data.idToken)}/accounts:update`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer owner' },
      body: JSON.stringify({ localId: data.localId, customAttributes: JSON.stringify({ role: 'admin' }) }),
    },
  );
  if (!claimRes.ok) throw new Error(`set claims falhou: ${claimRes.status} ${await claimRes.text()}`);

  // Token novo, já com o claim.
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

test.describe('Chat IDs do paciente por PAPEL — prova visual', () => {
  test.setTimeout(180000);

  let creds: { email: string; password: string; token: string };

  test.beforeAll(async () => {
    creds = await signUpStaff();

    psql(`
      INSERT INTO patients (id, clickup_task_id, first_name, last_name, country, status, created_at, updated_at)
        VALUES ('${PATIENT_ID}', 'e2e-visual-${PATIENT_ID}', 'Zortea', 'Rolesvisual', 'AR', 'ACTIVE', NOW(), NOW());
    `);

    // Vínculo pela NOSSA API real — nada é escrito à mão no banco.
    const res = await fetch(`${API}/api/admin/patients/${PATIENT_ID}/chat-ids`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${creds.token}` },
      body: JSON.stringify({
        chatIds: {
          FAMILY: GROUP_FAMILY,
          PROVIDERS: GROUP_PROVIDERS,
          HEALTH_PLAN: GROUP_HEALTH_PLAN,
        },
      }),
    });
    const body = await res.json();
    if (res.status !== 200) throw new Error(`PUT chat-ids falhou: ${res.status} ${JSON.stringify(body)}`);
  });

  test.afterAll(() => {
    try {
      psql(`DELETE FROM patients WHERE id = '${PATIENT_ID}';`);
    } catch { /* best effort */ }
  });

  test('a aba Red de Apoyo mostra os TRÊS papéis com os grupos gravados (es)', async ({ page }) => {
    await login(page, creds.email, creds.password);

    await page.goto(`/admin/patients/${PATIENT_ID}`);
    await expect(page.getByText('Zortea Rolesvisual')).toBeVisible({ timeout: 20000 });

    await page.getByText('Red de Apoyo', { exact: false }).first().click();

    const card = page.getByTestId('patient-chat-ids-card');
    await expect(card).toBeVisible({ timeout: 15000 });

    // O card fica abaixo da dobra: sem isto a screenshot pega a tela certa e o
    // card fora do quadro. Contagem no DOM não é prova visual.
    await card.scrollIntoViewIfNeeded();
    await page.waitForTimeout(400);

    await expect(page.getByTestId('chat-id-FAMILY-value')).toContainText(GROUP_FAMILY);
    await expect(page.getByTestId('chat-id-PROVIDERS-value')).toContainText(GROUP_PROVIDERS);
    await expect(page.getByTestId('chat-id-HEALTH_PLAN-value')).toContainText(GROUP_HEALTH_PLAN);

    await page.screenshot({ path: 'e2e/__screenshots__/chat-ids-papeis-es.png', fullPage: false });
    await card.screenshot({ path: 'e2e/__screenshots__/chat-ids-papeis-es-card.png' });
  });

  test('o drawer abre com UM seletor por papel, já preenchido', async ({ page }) => {
    // 🚨 O botão "Buscar chats" NÃO é clicado: abrir o drawer não fala com o
    // Periskope. Nenhuma requisição sai para o fornecedor neste teste.
    await login(page, creds.email, creds.password);
    await page.goto(`/admin/patients/${PATIENT_ID}`);
    await expect(page.getByText('Zortea Rolesvisual')).toBeVisible({ timeout: 20000 });
    await page.getByText('Red de Apoyo', { exact: false }).first().click();

    const card = page.getByTestId('patient-chat-ids-card');
    await expect(card).toBeVisible({ timeout: 15000 });
    await card.scrollIntoViewIfNeeded();
    await page.getByTestId('chat-ids-edit-btn').click();

    const drawer = page.getByTestId('chat-ids-drawer');
    await expect(drawer).toBeVisible();
    await page.waitForTimeout(600);

    for (const [role, group] of [
      ['FAMILY', GROUP_FAMILY],
      ['PROVIDERS', GROUP_PROVIDERS],
      ['HEALTH_PLAN', GROUP_HEALTH_PLAN],
    ] as const) {
      await expect(page.getByTestId(`chat-ids-${role}-select`)).toHaveValue(group);
    }
    expect(await page.getByTestId('chat-ids-candidates').count()).toBe(0);

    await page.screenshot({ path: 'e2e/__screenshots__/chat-ids-papeis-drawer.png', fullPage: false });
  });

  test('o mesmo card em pt-BR', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('i18nextLng', 'pt-BR'));
    await login(page, creds.email, creds.password);

    await page.goto(`/admin/patients/${PATIENT_ID}`);
    await expect(page.getByText('Zortea Rolesvisual')).toBeVisible({ timeout: 20000 });
    await page.getByText('Rede de Apoio', { exact: false }).first().click();

    const card = page.getByTestId('patient-chat-ids-card');
    await expect(card).toBeVisible({ timeout: 15000 });
    await card.scrollIntoViewIfNeeded();
    await page.waitForTimeout(400);

    await expect(card).toContainText('Grupo do plano de saúde');
    await page.screenshot({ path: 'e2e/__screenshots__/chat-ids-papeis-ptbr.png', fullPage: false });
    await card.screenshot({ path: 'e2e/__screenshots__/chat-ids-papeis-ptbr-card.png' });
  });
});
