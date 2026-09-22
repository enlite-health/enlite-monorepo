/**
 * patient-conversation-happy.integration.e2e.ts @integration — spec 022, Bloco 2, T218.
 *
 * Caminho feliz (US1 postar/ler + US2 menção/thread): login real (humano — click + keyboard.type,
 * `abac-stack-helper.loginAs`), abrir a ficha do paciente com uma conta que TEM a célula, abrir o
 * painel, postar mensagem de topo, mencionar a 2ª conta QA, abrir a thread e responder, `toHaveScreenshot`.
 *
 * Stack desta sessão (NÃO é o padrão 8089/5439 dos specs de `admin-access-*` — porta própria pra
 * não brigar com outra sessão que esteja usando aquele par):
 *   Postgres: container `enlite-pg-022b2`, porta 5442, db `enlite_e2e` (postgis/postgis:16-3.4).
 *   API: `node dist/index.js` compilado, porta 8092, `USE_MOCK_AUTH=true` +
 *        `PERMISSION_ENGINE_ENABLED=true` + `PERMISSION_CATALOG_SYNC_ENABLED=true`.
 *   Frontend: `npx vite --port 5173 --strictPort` (porta fixa — CORS e a chave do Maps dependem
 *   dela), `.env` copiado de `repos/infra/enlite-frontend` com `VITE_API_WORKER_FUNCTIONS_URL`
 *   sobrescrito para `http://localhost:8092`.
 *
 * Rodar com:
 *   E2E_PG_CONTAINER=enlite-pg-022b2 ABAC_API_URL=http://localhost:8092 \
 *   ABAC_TEST_DB_URL=postgresql://enlite_admin:enlite_password@localhost:5442/enlite_e2e \
 *   PW_BASE_URL=http://localhost:5173 \
 *   npx playwright test --project=integration e2e/integration/patient-conversation-happy.integration.e2e.ts
 *
 * Sem PII/texto clínico: paciente "Paciente QA", staff "QA Staff Um"/"QA Staff Dois", corpo "msg-1".
 */
import { test, expect } from '@playwright/test';
import {
  seedPatientQA, cleanupPatientQA, seedPlainStaff, cleanupPlainStaff,
  seedStaffInGroup, cleanupStaffAndGroup, grantCell, loginAs, safeSql,
  type MockUser,
} from '../helpers/patient-conversation-helper';

const RUN_ID = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
const AUTORA_UID = `e2e-conv-autora-${RUN_ID}`;
const AUTORA_EMAIL = `${AUTORA_UID}@e2e.test`;
const MENCIONADO_UID = `e2e-conv-mencionado-${RUN_ID}`;
const MENCIONADO_EMAIL = `${MENCIONADO_UID}@e2e.test`;
const GRUPO = `E2E Conv Happy ${RUN_ID}`;

let patientId = '';
let groupId = '';

const AUTORA: MockUser = { uid: AUTORA_UID, email: AUTORA_EMAIL, role: 'recruiter', country: 'AR' };

test.use({ video: 'on' });

test.describe('Chat interno por paciente — caminho feliz (US1+US2) @integration', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(120_000);

  test.beforeAll(() => {
    patientId = seedPatientQA();
    const seeded = seedStaffInGroup({ uid: AUTORA_UID, email: AUTORA_EMAIL, groupName: GRUPO, country: 'AR' });
    groupId = seeded.groupId;
    grantCell(groupId, 'patient', 'read'); // a ficha em si — mesma família `admin.patients`
    grantCell(groupId, 'patient_conversation', 'read');
    grantCell(groupId, 'patient_conversation', 'create');
    grantCell(groupId, 'patient_conversation', 'update');
    grantCell(groupId, 'patient_conversation', 'delete');
    grantCell(groupId, 'staff_directory', 'read');
    seedPlainStaff(MENCIONADO_UID, MENCIONADO_EMAIL, 'QA Staff Dois');
  });

  test.afterAll(() => {
    cleanupStaffAndGroup(AUTORA_UID, groupId);
    cleanupPlainStaff(MENCIONADO_UID);
    cleanupPatientQA(patientId);
    safeSql(`DELETE FROM conversation_read_marks WHERE conversation_id IN (SELECT id FROM conversations WHERE patient_id = '${patientId}')`);
  });

  test('abrir painel, postar, mencionar, responder em thread', async ({ page }) => {
    await loginAs(page, AUTORA);
    await page.goto(`/admin/patients/${patientId}`);

    const handleBtn = page.getByTestId('patient-conversation-handle-btn');
    await expect(handleBtn).toBeVisible({ timeout: 15_000 });
    await handleBtn.click();

    const panel = page.getByTestId('patient-conversation-panel');
    await expect(panel).toBeVisible();
    await expect(panel).toHaveClass(/translate-x-0/);
    await expect(page.getByTestId('conversation-panel-header')).toHaveText('Mensajes');

    // ── postar mensagem de topo, com uma menção real (US2) — clique + keyboard.type, sem fill ──
    const editor = page.getByTestId('composer-editor');
    await editor.click();
    await expect(editor).toBeFocused();
    await page.keyboard.type('msg-1 hola ');
    // Sem espaço depois do `@QA`: o Mention do TipTap fecha a busca no 1º espaço — digitar
    // "@QA " (com espaço) some com a lista antes do clique (medido nesta sessão).
    await page.keyboard.type('@QA');
    const mentionItem = page.getByTestId(`composer-mention-item-${MENCIONADO_UID}`);
    await expect(mentionItem).toBeVisible({ timeout: 10_000 });
    await mentionItem.click();
    await expect(page.getByTestId('composer-mention-chip')).toContainText('QA Staff Dois');

    const posted = page.waitForResponse((r) => r.request().method() === 'POST' && /\/conversation\/messages$/.test(r.url()));
    await page.getByTestId('composer-send-btn').click();
    const postedBody = (await (await posted).json()) as { data: { id: string; createdAt: string } };
    expect(postedBody.data.id).toBeTruthy();
    const topMessageId = postedBody.data.id;

    const topItem = page.getByTestId(`conversation-message-${topMessageId}`);
    await expect(topItem).toBeVisible();
    await expect(topItem.getByTestId('message-body')).toContainText('msg-1 hola');
    // Conserto DEFEITO 5 (gate b2-fix): o chip mostra o NOME de exibição (cache alimentado pela
    // própria busca do autocomplete, `useStaffNameCache`), não mais o uid cru.
    await expect(topItem.getByTestId('mention-chip')).toHaveText('@QA Staff Dois');

    // ── abrir a thread e responder (US2) ──
    await topItem.getByRole('button').click(); // "N respostas"
    const thread = page.getByTestId('thread-view');
    await expect(thread).toBeVisible();
    await expect(page.getByTestId('thread-root-message')).toContainText('msg-1 hola');

    const replyEditor = page.getByTestId('composer-editor');
    await replyEditor.click();
    await expect(replyEditor).toBeFocused();
    await page.keyboard.type('msg-1 respuesta');
    await page.getByTestId('composer-send-btn').click();
    await expect(page.getByTestId('thread-replies-list')).toContainText('msg-1 respuesta', { timeout: 10_000 });

    // voltar à lista de topo
    await page.getByTestId('thread-back-btn').click();
    await expect(page.getByTestId('conversation-panel-list')).toBeVisible();
    // Selo de contagem (ajustes de UI B5, rodada 2) — mostra só o número, "1 respuesta" vive no
    // aria-label/title (texto visível não usa "thread"/"hilo", pedido do Gabriel).
    const repliesBadge = page.getByTestId(`conversation-message-${topMessageId}`).getByTestId('conversation-message-replies');
    await expect(repliesBadge).toHaveText('1');
    await expect(repliesBadge).toHaveAttribute('aria-label', '1 respuesta');

    await expect(panel).toHaveScreenshot('conversation-happy-painel-aberto.png', {
      mask: [page.locator('[data-testid="message-author"], [data-testid="message-time"]')],
      maxDiffPixelRatio: 0.02,
    });
  });
});
