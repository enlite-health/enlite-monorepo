/**
 * patient-chat-ids.integration.e2e.ts @integration
 *
 * Caminho feliz da vinculação semiautomática de Chat ID (ClickUp 86ajy085a),
 * na TELA REAL contra o backend real e o Postgres real:
 *
 *   abre o paciente → aba Rede de apoio → "Vincular chats" → "Buscar chats"
 *   → lista de candidatos → escolhe família e prestadores → salva
 *   → o valor persistido aparece no card.
 *
 * O que é real: o frontend (vite), a API (`worker-functions` no Docker), o
 * Postgres (migration 260 aplicada) e o paciente, criado por POST de verdade.
 * O que NÃO é real: a API do Periskope — o backend do container aponta
 * PERISKOPE_BASE_URL para o stub local abaixo, que responde no formato
 * capturado da produção. Teste não fala com serviço externo vivo.
 *
 * ⚠️ Portanto este teste prova A NOSSA TELA e o nosso backend, não o contrato
 * com o fornecedor. Essa outra metade é a sonda ao vivo somente leitura em
 * `worker-functions/scripts/probe-periskope-chats.ts`.
 *
 * Grava VÍDEO do caminho feliz (recordVideo) e uma screenshot do card com o
 * valor persistido.
 */

import { test, expect, type Page, type Route } from '@playwright/test';
import http from 'http';

// ── Auth (mesmo padrão dos demais @integration) ───────────────────────────────

const MOCK_ADMIN_USER = {
  uid: 'e2e-patient-chat-ids',
  email: 'admin.chat-ids@e2e.test',
  // 'admin' é o papel que o backend reconhece como STAFF (requireStaff aceita
  // admin | recruiter | community_manager). O 'superadmin' do perfil abaixo é
  // vocabulário do FRONTEND e não vale como papel no token.
  role: 'admin',
};

const MOCK_TOKEN =
  'mock_' + Buffer.from(JSON.stringify(MOCK_ADMIN_USER), 'utf-8').toString('base64');

const FAKE_ID_TOKEN =
  'eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.' +
  Buffer.from(
    JSON.stringify({
      sub: MOCK_ADMIN_USER.uid,
      uid: MOCK_ADMIN_USER.uid,
      email: MOCK_ADMIN_USER.email,
      iss: 'https://securetoken.google.com/enlite-prd',
      aud: 'enlite-prd',
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600,
    }),
  ).toString('base64url') +
  '.';

const API_URL = process.env.PW_API_URL ?? 'http://127.0.0.1:8080';
const STUB_PORT = Number(process.env.PERISKOPE_STUB_PORT ?? 9911);

// Nome sintético: nada de nome real de paciente num vídeo anexado a task.
const PATIENT_FIRST = 'Zortea';
const PATIENT_LAST = 'Videoproof';

// IDs únicos por execução: um grupo só pode estar preso a UM paciente (índice
// único da migration 260), então reusar os mesmos ids faria a 2ª execução
// bater em 409 — que é a trava funcionando, mas deixaria o teste não-idempotente.
const RUN = String(Date.now());
const GROUP_FAMILY = `12036309${RUN}1@g.us`;
const GROUP_PROVIDERS = `12036309${RUN}2@g.us`;
const GROUP_UNRELATED = `12036309${RUN}3@g.us`;
const CHAT_ONE_TO_ONE = '5491162180721@c.us';

const STUB_CHATS = [
  { chat_id: GROUP_FAMILY, chat_name: `Flia ${PATIENT_FIRST} ${PATIENT_LAST}`, chat_type: 'group', member_count: 7 },
  { chat_id: GROUP_PROVIDERS, chat_name: `Prestadores ${PATIENT_FIRST} ${PATIENT_LAST}`, chat_type: 'group', member_count: 12 },
  { chat_id: GROUP_UNRELATED, chat_name: 'Flia Otronombre Distinto', chat_type: 'group', member_count: 5 },
  { chat_id: CHAT_ONE_TO_ONE, chat_name: `${PATIENT_FIRST} ${PATIENT_LAST}`, chat_type: 'user', member_count: null },
];

/** Stub do Periskope no formato real de `GET /v1/chats`. Só leitura. */
function startStub(): Promise<http.Server> {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://stub');
    if (req.method !== 'GET' || url.pathname !== '/v1/chats') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'stub aceita apenas GET /v1/chats' }));
      return;
    }
    const groups = url.searchParams.get('chat_type') === 'group'
      ? STUB_CHATS.filter(c => c.chat_type === 'group')
      : STUB_CHATS;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ from: 1, to: groups.length, count: groups.length, chats: groups }));
  });
  return new Promise(resolve => server.listen(STUB_PORT, '0.0.0.0', () => resolve(server)));
}

async function installInterceptors(page: Page): Promise<void> {
  await page.route('**/identitytoolkit.googleapis.com/**', async (route: Route) => {
    const url = route.request().url();
    if (url.includes('signInWithPassword') || url.includes('signUp')) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          kind: 'identitytoolkit#VerifyPasswordResponse',
          localId: MOCK_ADMIN_USER.uid,
          email: MOCK_ADMIN_USER.email,
          idToken: FAKE_ID_TOKEN,
          refreshToken: 'fake-refresh-token',
          expiresIn: '3600',
          registered: true,
        }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        users: [{ localId: MOCK_ADMIN_USER.uid, email: MOCK_ADMIN_USER.email, emailVerified: true }],
      }),
    });
  });

  await page.route('**/securetoken.googleapis.com/**', async (route: Route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        access_token: FAKE_ID_TOKEN,
        expires_in: '3600',
        token_type: 'Bearer',
        refresh_token: 'fake-refresh-token',
        id_token: FAKE_ID_TOKEN,
      }),
    });
  });

  // Só o profile é mockado (não existe usuário admin no banco de teste);
  // TODO o resto de /api/** vai para o backend real com o token mock_*.
  await page.route('**/api/**', async (route: Route) => {
    if (route.request().url().includes('/api/admin/auth/profile')) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          data: {
            id: MOCK_ADMIN_USER.uid,
            email: MOCK_ADMIN_USER.email,
            role: 'superadmin',
            firstName: 'ChatIds',
            lastName: 'Admin',
            isActive: true,
            mustChangePassword: false,
          },
        }),
      });
      return;
    }
    const headers = { ...route.request().headers(), authorization: `Bearer ${MOCK_TOKEN}` };
    await route.continue({ headers });
  });
}

async function loginAsAdmin(page: Page): Promise<void> {
  await installInterceptors(page);
  await page.goto('/admin/login');
  await page.locator('input[type="email"]').fill(MOCK_ADMIN_USER.email);
  await page.locator('input[type="password"]').fill('TestAdmin123!');
  await page.getByRole('button', { name: /Iniciar sesión/i }).click();
  await expect(page).not.toHaveURL(/.*login.*/, { timeout: 20_000 });
}

/** Cria o paciente pela API REAL (POST /api/admin/patients). */
async function createPatient(): Promise<string> {
  const res = await fetch(`${API_URL}/api/admin/patients`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${MOCK_TOKEN}` },
    body: JSON.stringify({
      firstName: PATIENT_FIRST,
      lastName: PATIENT_LAST,
      phoneWhatsapp: '+5491100000777',
      // Obrigatório desde o ABAC de país (fase 1): o país do paciente é
      // declarado por quem cria, não inferido por default.
      country: 'AR',
    }),
  });
  const json = await res.json();
  if (!json.success) throw new Error(`Falha ao criar paciente: ${JSON.stringify(json)}`);
  return json.data.id as string;
}

async function readChatIdsFromApi(patientId: string) {
  const res = await fetch(`${API_URL}/api/admin/patients/${patientId}`, {
    headers: { Authorization: `Bearer ${MOCK_TOKEN}` },
  });
  const json = await res.json();
  return { familyChatId: json.data.familyChatId, providersChatId: json.data.providersChatId };
}

// ── Teste ─────────────────────────────────────────────────────────────────────

test.use({ video: { mode: 'on', size: { width: 1440, height: 900 } }, viewport: { width: 1440, height: 900 } });

test.describe('Chat IDs do paciente — vinculação semiautomática @integration', () => {
  test.setTimeout(120_000);

  let stub: http.Server;
  let patientId: string;

  test.beforeAll(async () => {
    stub = await startStub();
    patientId = await createPatient();
  });

  test.afterAll(async () => {
    await new Promise<void>(resolve => stub.close(() => resolve()));
  });

  test('caminho feliz: buscar → escolher família e prestadores → salvar → ver na tela', async ({ page }) => {
    await loginAsAdmin(page);

    // 1. Abre o paciente e vai para a aba onde o card vive.
    await page.goto(`/admin/patients/${patientId}`);
    await expect(page.getByText(PATIENT_LAST).first()).toBeVisible({ timeout: 20_000 });

    await page.getByRole('button', { name: /Red de apoyo|Rede de apoio/i }).click();
    const card = page.getByTestId('patient-chat-ids-card');
    await expect(card).toBeVisible();

    // 2. Antes de vincular: os dois campos aparecem como não vinculados.
    await expect(page.getByTestId('chat-id-family-value')).toContainText(/Sin vincular|Não vinculado/i);
    await expect(page.getByTestId('chat-id-providers-value')).toContainText(/Sin vincular|Não vinculado/i);
    await card.scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);
    await card.screenshot({ path: 'e2e/artifacts/chat-ids-01-antes.png' });

    // 3. Abre o drawer e busca os chats no Periskope.
    await page.getByTestId('chat-ids-edit-btn').click();
    await expect(page.getByTestId('chat-ids-drawer')).toBeVisible();
    await page.waitForTimeout(500); // deixa a animação terminar (vídeo legível)

    await page.getByTestId('chat-ids-search-btn').click();

    // 4. A lista de candidatos aparece — só grupos, ranqueados pelo nome.
    const candidates = page.getByTestId('chat-ids-candidates');
    await expect(candidates).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId(`chat-candidate-${GROUP_FAMILY}`)).toBeVisible();
    await expect(page.getByTestId(`chat-candidate-${GROUP_PROVIDERS}`)).toBeVisible();
    // Conversa 1-1 e grupo de outro nome NÃO entram.
    await expect(page.getByTestId(`chat-candidate-${CHAT_ONE_TO_ONE}`)).toHaveCount(0);
    await expect(page.getByTestId(`chat-candidate-${GROUP_UNRELATED}`)).toHaveCount(0);
    await page.screenshot({ path: 'e2e/artifacts/chat-ids-02-candidatos.png' });

    // 5. O humano escolhe os papéis.
    await page.getByTestId('chat-ids-family-select').selectOption(GROUP_FAMILY);
    await page.getByTestId('chat-ids-providers-select').selectOption(GROUP_PROVIDERS);
    await page.waitForTimeout(400);
    await page.screenshot({ path: 'e2e/artifacts/chat-ids-03-escolhido.png' });

    // 6. Salva.
    await page.getByTestId('chat-ids-save').click();
    await expect(page.getByTestId('chat-ids-drawer')).toHaveCount(0, { timeout: 20_000 });

    // 7. O valor PERSISTIDO aparece na tela (não é estado local: veio do refetch).
    await expect(page.getByTestId('chat-id-family-value')).toContainText(GROUP_FAMILY, { timeout: 20_000 });
    await expect(page.getByTestId('chat-id-providers-value')).toContainText(GROUP_PROVIDERS);
    await card.scrollIntoViewIfNeeded();
    await page.waitForTimeout(600);
    // Recorte do card (o valor que a task pede) + a tela inteira, para provar
    // que o card está mesmo dentro da ficha do paciente e não isolado.
    await card.screenshot({ path: 'e2e/artifacts/chat-ids-04-persistido.png' });
    await page.screenshot({ path: 'e2e/artifacts/chat-ids-05-tela-inteira.png' });

    // 8. E está mesmo no banco, pela API.
    expect(await readChatIdsFromApi(patientId)).toEqual({
      familyChatId: GROUP_FAMILY,
      providersChatId: GROUP_PROVIDERS,
    });

    // 9. Recarrega a página do zero: o valor continua lá.
    await page.reload();
    await page.getByRole('button', { name: /Red de apoyo|Rede de apoio/i }).click();
    await expect(page.getByTestId('chat-id-family-value')).toContainText(GROUP_FAMILY, { timeout: 20_000 });
  });
});
