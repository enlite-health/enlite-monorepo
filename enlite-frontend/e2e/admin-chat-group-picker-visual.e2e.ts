/**
 * admin-chat-group-picker-visual.e2e.ts
 *
 * PROVA VISUAL do seletor de grupo POR BUSCA — o caminho do papel
 * COMPARTILHADO (obra social / gestión).
 *
 * ⚠️ SEM MOCK DE PAYLOAD DA NOSSA API. O que este teste faz, na ordem:
 *   1. sobe um stub da API do PERISKOPE (só `GET /v1/chats`) no formato real
 *      capturado de produção — é a única peça substituída, porque teste não
 *      fala com serviço externo vivo (regra dura do repo, há incidente);
 *   2. cria um admin no Firebase Auth Emulator e um paciente REAL no Postgres;
 *   3. faz login pela TELA e abre a ficha;
 *   4. abre o drawer e fotografa: o papel EXCLUSIVO com o seletor ranqueado, o
 *      COMPARTILHADO com a busca;
 *   5. busca "gestion" e fotografa o resultado — o grupo que o ranqueamento
 *      NUNCA traria, porque tem semelhança zero com o nome do paciente.
 *
 * 🚨 Nenhuma escrita no Periskope: o stub responde 405 a qualquer coisa que não
 * seja `GET /v1/chats`, e o teste falha se alguma escrita for tentada.
 */

import { test, expect, Page } from '@playwright/test';
import { execSync } from 'child_process';
import { randomUUID } from 'crypto';
import { createServer, type Server } from 'http';

const FIREBASE_EMULATOR = 'http://127.0.0.1:9099';
const FIREBASE_API_KEY = 'test-api-key';
const API = 'http://127.0.0.1:8080';
const STUB_PORT = 9911;

const PATIENT_ID = randomUUID();
const GESTION_DAS = '120363077000000001@g.us';
const GESTION_OSPJN = '120363077000000002@g.us';
const FLIA = '120363077000000003@g.us';

/** Formato REAL do `GET /chats` do Periskope, capturado de produção. */
const CHATS = [
  { chat_id: GESTION_DAS, chat_name: 'Gestión: EnLite <> DAS', chat_type: 'group', member_count: 16, org_phone: '5491176360496@c.us' },
  { chat_id: GESTION_OSPJN, chat_name: 'Gestión: EnLite <> OSPJN', chat_type: 'group', member_count: 16, org_phone: '5491176360496@c.us' },
  { chat_id: FLIA, chat_name: 'Flia Grupovisual', chat_type: 'group', member_count: 5, org_phone: '5491176360496@c.us' },
];

/** Requisições que NÃO são `GET /v1/chats` — precisa continuar vazio. */
const escritas: string[] = [];

function startStub(): Promise<Server> {
  return new Promise(resolve => {
    const server = createServer((req, res) => {
      const url = req.url ?? '';
      if (req.method === 'GET' && url.startsWith('/v1/chats')) {
        const offset = Number(new URL(url, 'http://x').searchParams.get('offset') ?? 0);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ chats: offset === 0 ? CHATS : [] }));
        return;
      }
      escritas.push(`${req.method} ${url}`);
      res.writeHead(405).end();
    });
    server.listen(STUB_PORT, () => resolve(server));
  });
}

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
  const email = `e2e.picker.${randomUUID()}@test.com`;
  const password = 'TestAdmin123!';

  const res = await fetch(
    `${FIREBASE_EMULATOR}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=${FIREBASE_API_KEY}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password, returnSecureToken: true }) },
  );
  const data = (await res.json()) as { localId?: string; idToken?: string };
  if (!data.localId || !data.idToken) throw new Error(`sign-up falhou: ${JSON.stringify(data)}`);

  psql(`
    INSERT INTO users (firebase_uid, email, display_name, role, is_active, created_at, updated_at)
      VALUES ('${data.localId}', '${email}', 'Picker E2E', 'admin', true, NOW(), NOW())
      ON CONFLICT DO NOTHING;
  `);

  const claimRes = await fetch(
    `${FIREBASE_EMULATOR}/identitytoolkit.googleapis.com/v1/projects/${projectFromToken(data.idToken)}/accounts:update`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer owner' },
      body: JSON.stringify({ localId: data.localId, customAttributes: JSON.stringify({ role: 'admin' }) }),
    },
  );
  if (!claimRes.ok) throw new Error(`set claims falhou: ${claimRes.status}`);

  const signIn = await fetch(
    `${FIREBASE_EMULATOR}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${FIREBASE_API_KEY}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password, returnSecureToken: true }) },
  );
  const signInData = (await signIn.json()) as { idToken?: string };
  if (!signInData.idToken) throw new Error('sign-in falhou');

  return { email, password, token: signInData.idToken };
}

async function login(page: Page, email: string, password: string): Promise<void> {
  await page.goto('/admin/login');
  await page.locator('input[type="email"]').fill(email);
  await page.locator('input[type="password"]').fill(password);
  await page.locator('button[type="submit"]').click();
  await expect(page).not.toHaveURL(/.*login.*/, { timeout: 30000 });
}

async function abrirDrawer(page: Page): Promise<void> {
  await page.goto(`/admin/patients/${PATIENT_ID}`);
  await expect(page.getByText('Zortea Grupovisual')).toBeVisible({ timeout: 20000 });
  await page.getByText('Red de Apoyo', { exact: false }).first().click();

  const card = page.getByTestId('patient-chat-ids-card');
  await expect(card).toBeVisible({ timeout: 15000 });
  await card.scrollIntoViewIfNeeded();
  await page.getByTestId('chat-ids-edit-btn').click();
  await expect(page.getByTestId('chat-ids-drawer')).toBeVisible();
}

test.describe('Seletor de grupo por busca — prova visual', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(180000);

  let creds: { email: string; password: string; token: string };
  let stub: Server;

  test.beforeAll(async () => {
    stub = await startStub();
    creds = await signUpAdmin();
    psql(`
      INSERT INTO patients (id, clickup_task_id, first_name, last_name, country, status, created_at, updated_at)
        VALUES ('${PATIENT_ID}', 'e2e-picker-${PATIENT_ID}', 'Zortea', 'Grupovisual', 'AR', 'ACTIVE', NOW(), NOW());
    `);
  });

  test.afterAll(async () => {
    try { psql(`DELETE FROM patients WHERE id = '${PATIENT_ID}';`); } catch { /* best effort */ }
    await new Promise<void>(r => stub.close(() => r()));
  });

  test('papel exclusivo abre SELETOR; compartilhado abre BUSCA', async ({ page }) => {
    await login(page, creds.email, creds.password);
    await abrirDrawer(page);

    // exclusivos (catálogo semeado pela 262)
    await expect(page.getByTestId('chat-ids-FAMILY-select')).toBeVisible();
    await expect(page.getByTestId('chat-ids-PROVIDERS-select')).toBeVisible();

    // compartilhado: a busca, não o seletor
    await expect(page.getByTestId('chat-ids-HEALTH_PLAN-picker')).toBeVisible();
    await expect(page.getByTestId('chat-ids-HEALTH_PLAN-select')).toHaveCount(0);

    await page.waitForTimeout(700);
    await page.screenshot({ path: 'e2e/__screenshots__/chat-group-picker-drawer.png', fullPage: false });
  });

  test('buscar "gestion" ACHA o grupo que o ranqueamento nunca traria', async ({ page }) => {
    await login(page, creds.email, creds.password);
    await abrirDrawer(page);

    await page.getByTestId('chat-ids-HEALTH_PLAN-search').fill('gestion');

    // O grupo do pagador: semelhança ZERO com "Zortea Grupovisual".
    const opt = page.getByTestId(`chat-ids-HEALTH_PLAN-option-${GESTION_DAS}`);
    await expect(opt).toBeVisible({ timeout: 15000 });
    await expect(opt).toContainText('Gestión: EnLite <> DAS');
    // a contagem de uso aparece como informação
    await expect(opt).toContainText('paciente(s)');
    // e o grupo da família NÃO entra na busca por "gestion"
    await expect(page.getByTestId(`chat-ids-HEALTH_PLAN-option-${FLIA}`)).toHaveCount(0);

    await page.getByTestId('chat-ids-HEALTH_PLAN-picker').scrollIntoViewIfNeeded();
    await page.waitForTimeout(400);
    await page.screenshot({ path: 'e2e/__screenshots__/chat-group-picker-busca.png', fullPage: false });
  });

  test('escolher o grupo mostra o escolhido, e NENHUMA escrita foi ao Periskope', async ({ page }) => {
    await login(page, creds.email, creds.password);
    await abrirDrawer(page);

    await page.getByTestId('chat-ids-HEALTH_PLAN-search').fill('DAS');
    await page.getByTestId(`chat-ids-HEALTH_PLAN-option-${GESTION_DAS}`).click({ timeout: 15000 });

    const chosen = page.getByTestId('chat-ids-HEALTH_PLAN-chosen');
    await expect(chosen).toBeVisible();
    await expect(chosen).toContainText(GESTION_DAS);

    await page.waitForTimeout(400);
    await page.screenshot({ path: 'e2e/__screenshots__/chat-group-picker-escolhido.png', fullPage: false });

    // 🚨 A trava dura do repo, verificada e não assumida.
    expect(escritas).toEqual([]);
  });
});
