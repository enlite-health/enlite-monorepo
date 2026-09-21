/**
 * notification-bell-deep-link.integration.e2e.ts @integration — spec 022, Bloco 4, T416.
 *
 * Feliz (US4): conta A menciona conta B num paciente; logada como B, o sino mostra o contador
 * (poll acelerado via `VITE_NOTIFICATION_POLL_MS`, D-10 continua 45s em produção); clicar na
 * notificação marca como lida E navega para `patients/:id` com o painel de conversa JÁ ABERTO
 * na thread certa (deep-link, T413).
 *
 * Alternativo 1: "marcar todas como lidas" zera o contador com 2+ notificações pendentes.
 * Alternativo 2: ator SEM `own_notifications:read` — o sino nunca mostra contador (a chamada de
 * unread-count falha em silêncio, mesmo padrão de falha silenciosa do poll) e o painel, se aberto,
 * mostra o estado vazio — nunca quebra, nunca vaza dado de quem não tem a célula.
 *
 * Stack desta sessão (porta própria — não é o padrão 8089/5439 de `admin-access-*`):
 *   Postgres: container `pg-022-b4`, porta 5442, dbs `enlite_e2e_022` (jest) E `enlite_e2e`
 *     (Playwright — `db-test-helper.ts` tem o nome hardcoded, achado já documentado em
 *     `b3-conserto-gate.md`).
 *   API: `node dist/index.js` compilado, porta 8092, `USE_MOCK_AUTH=true` +
 *     `PERMISSION_ENGINE_ENABLED=true` + `PERMISSION_CATALOG_SYNC_ENABLED=true` +
 *     `PERMISSION_ENFORCED_ROUTES=admin.patients;admin.users`.
 *   Frontend: `npx vite --port 5173 --strictPort`, `.env` copiado de `repos/infra/enlite-frontend`
 *     com `VITE_API_WORKER_FUNCTIONS_URL=http://localhost:8092` e
 *     `VITE_NOTIFICATION_POLL_MS=800` (só nesta stack de teste — produção continua 45000, D-10).
 *
 * Rodar com:
 *   E2E_PG_CONTAINER=pg-022-b4 ABAC_API_URL=http://localhost:8092 \
 *   ABAC_TEST_DB_URL=postgresql://enlite_admin:enlite_password@localhost:5442/enlite_e2e \
 *   PW_BASE_URL=http://localhost:5173 \
 *   npx playwright test --project=integration e2e/integration/notification-bell-deep-link.integration.e2e.ts
 *
 * Sem PII/texto clínico: paciente "Paciente QA", staff "QA Staff <N>", corpo "msg-1".
 */
import { test, expect } from '@playwright/test';
import {
  seedPatientQA, cleanupPatientQA, seedStaffInGroup, cleanupStaffAndGroup, grantCell, loginAs, safeSql, psql,
  type MockUser,
} from '../helpers/patient-conversation-helper';
import { revokeCell } from '../helpers/abac-stack-helper';

const RUN_ID = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
const A_UID = `e2e-not-a-${RUN_ID}`;
const A_EMAIL = `${A_UID}@e2e.test`;
const B_UID = `e2e-not-b-${RUN_ID}`;
const B_EMAIL = `${B_UID}@e2e.test`;
const GRUPO_A = `E2E Notif A ${RUN_ID}`;
const GRUPO_B = `E2E Notif B ${RUN_ID}`;

let patientId = '';
let groupIdA = '';
let groupIdB = '';

const A: MockUser = { uid: A_UID, email: A_EMAIL, role: 'recruiter', country: 'AR' };
const B: MockUser = { uid: B_UID, email: B_EMAIL, role: 'recruiter', country: 'AR' };

test.use({ video: 'on' });

test.describe('Sino de notificações — deep-link até a conversa (Spec 022, Bloco 4, T416) @integration', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(120_000);

  test.beforeAll(() => {
    patientId = seedPatientQA();
    const seededA = seedStaffInGroup({ uid: A_UID, email: A_EMAIL, groupName: GRUPO_A, country: 'AR' });
    groupIdA = seededA.groupId;
    grantCell(groupIdA, 'patient', 'read');
    grantCell(groupIdA, 'patient_conversation', 'read');
    grantCell(groupIdA, 'patient_conversation', 'create');
    grantCell(groupIdA, 'staff_directory', 'read');

    const seededB = seedStaffInGroup({ uid: B_UID, email: B_EMAIL, groupName: GRUPO_B, country: 'AR' });
    groupIdB = seededB.groupId;
    // `seedStaffInGroup` grava `display_name = 'E2E <uid>'` — o autocomplete de menção busca por
    // nome/e-mail (`staff-directory`), e o composer digita "@QA" (mesmo termo do happy path B2);
    // sem este ajuste, B nunca aparece na lista de sugestões.
    psql(`UPDATE users SET display_name = 'QA Staff B' WHERE firebase_uid = '${B_UID}'`);
    grantCell(groupIdB, 'patient', 'read');
    grantCell(groupIdB, 'patient_conversation', 'read');
    grantCell(groupIdB, 'own_notifications', 'read');
    grantCell(groupIdB, 'own_notifications', 'update');
  });

  test.afterAll(() => {
    cleanupStaffAndGroup(A_UID, groupIdA);
    cleanupStaffAndGroup(B_UID, groupIdB);
    cleanupPatientQA(patientId);
    safeSql(`DELETE FROM notifications WHERE recipient_uid IN ('${A_UID}', '${B_UID}')`);
    safeSql(`DELETE FROM notification_events WHERE actor_uid IN ('${A_UID}', '${B_UID}')`);
  });

  test('feliz: A menciona B; sino de B mostra contador; clique marca lida E abre a conversa certa', async ({ browser }) => {
    const contextA = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const contextB = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const pageA = await contextA.newPage();
    const pageB = await contextB.newPage();
    try {
      // ── A posta e menciona B ──────────────────────────────────────────────────────────────
      await loginAs(pageA, A);
      await pageA.goto(`/admin/patients/${patientId}`);
      const handleBtn = pageA.getByTestId('patient-conversation-handle-btn');
      await expect(handleBtn).toBeVisible({ timeout: 15_000 });
      await handleBtn.click();
      const editor = pageA.getByTestId('composer-editor');
      await editor.click();
      await expect(editor).toBeFocused();
      await pageA.keyboard.type('msg-1 hola ');
      await pageA.keyboard.type('@QA');
      const mentionItem = pageA.getByTestId(`composer-mention-item-${B_UID}`);
      await expect(mentionItem).toBeVisible({ timeout: 10_000 });
      await mentionItem.click();
      const posted = pageA.waitForResponse((r) => r.request().method() === 'POST' && /\/conversation\/messages$/.test(r.url()));
      await pageA.getByTestId('composer-send-btn').click();
      await posted;

      // ── B loga e vê o sino acender (poll acelerado, VITE_NOTIFICATION_POLL_MS) ─────────────
      await loginAs(pageB, B);
      const bellBtn = pageB.getByTestId('notification-bell-btn');
      await expect(bellBtn).toBeVisible({ timeout: 15_000 });
      await expect(pageB.getByTestId('notification-bell-badge')).toBeVisible({ timeout: 10_000 });
      await expect(pageB.getByTestId('notification-bell-badge')).toHaveText('1');

      await bellBtn.click();
      const panel = pageB.getByTestId('notification-panel');
      await expect(panel).toHaveClass(/translate-x-0/);

      const item = panel.locator('[data-testid^="notification-item-"]').first();
      await expect(item).toBeVisible();
      await expect(item).toContainText('QA'); // nome do mencionador, montado no CLIENTE (FR-015)

      await item.click();

      // ── deep-link: cai em patients/:id com o painel de conversa JÁ ABERTO ──────────────────
      await expect(pageB).toHaveURL(new RegExp(`/admin/patients/${patientId}`));
      const conversationPanel = pageB.getByTestId('patient-conversation-panel');
      await expect(conversationPanel).toHaveClass(/translate-x-0/, { timeout: 10_000 });

      // marcado como lida — o badge não reaparece no próximo poll.
      await pageB.waitForTimeout(1_000);
      await expect(pageB.getByTestId('notification-bell-badge')).not.toBeVisible();

      await expect(pageB).toHaveScreenshot('notification-bell-deep-link-conversa-aberta.png', {
        mask: [pageB.locator('[data-testid="message-author"], [data-testid="message-time"]')],
        maxDiffPixelRatio: 0.02,
      });
    } finally {
      await contextA.close();
      await contextB.close();
    }
  });

  test('ALTERNATIVO 1 — marcar todas como lidas zera o contador com 2+ pendentes', async ({ browser }) => {
    const contextA = await browser.newContext();
    const contextB = await browser.newContext();
    const pageA = await contextA.newPage();
    const pageB = await contextB.newPage();
    try {
      await loginAs(pageA, A);
      await pageA.goto(`/admin/patients/${patientId}`);
      await pageA.getByTestId('patient-conversation-handle-btn').click();
      for (const texto of ['msg-2 hola ', 'msg-3 hola ']) {
        const editor = pageA.getByTestId('composer-editor');
        await editor.click();
        await pageA.keyboard.type(texto);
        await pageA.keyboard.type('@QA');
        const mentionItem = pageA.getByTestId(`composer-mention-item-${B_UID}`);
        await expect(mentionItem).toBeVisible({ timeout: 10_000 });
        await mentionItem.click();
        const posted = pageA.waitForResponse((r) => r.request().method() === 'POST' && /\/conversation\/messages$/.test(r.url()));
        await pageA.getByTestId('composer-send-btn').click();
        await posted;
      }

      await loginAs(pageB, B);
      const bellBtn = pageB.getByTestId('notification-bell-btn');
      await expect(pageB.getByTestId('notification-bell-badge')).toHaveText('2', { timeout: 10_000 });
      await bellBtn.click();
      const panel = pageB.getByTestId('notification-panel');

      // 3 no total: a notificação do teste anterior (já lida, `msg-1`) + as 2 novas (não lidas).
      const itemsBefore = panel.locator('[data-testid^="notification-item-"]');
      await expect(itemsBefore).toHaveCount(3);

      await pageB.getByTestId('notification-mark-all-read').click();
      await expect(pageB.getByTestId('notification-bell-badge')).not.toBeVisible({ timeout: 10_000 });
      // "marcar todas como lidas" NÃO some com nenhuma notificação da lista (elas continuam
      // existindo, só com `readAt` preenchido) — a prova é o CONTADOR zerado (já verificado
      // acima) e as MESMAS 3 linhas ainda visíveis, agora TODAS esmaecidas (`opacity-60`).
      await expect(itemsBefore).toHaveCount(3);
      for (const item of await itemsBefore.all()) {
        await expect(item).toHaveClass(/opacity-60/);
      }
    } finally {
      await contextA.close();
      await contextB.close();
    }
  });

  test('ALTERNATIVO 2 — B sem own_notifications:read: sino nunca mostra contador, painel mostra vazio (nunca quebra)', async ({ browser }) => {
    revokeCell(groupIdB, 'own_notifications', 'read');
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      await loginAs(page, B);
      const bellBtn = page.getByTestId('notification-bell-btn');
      await expect(bellBtn).toBeVisible({ timeout: 15_000 });
      // 403 silencioso no poll de unread-count — o badge nunca aparece, mesmo com notificações
      // reais pendentes no banco (as 2 do teste anterior, nunca marcadas como lidas para OUTRO
      // motivo que não fosse o "marcar todas" — aqui a checagem é: célula revogada, nunca vê).
      await page.waitForTimeout(1_500);
      await expect(page.getByTestId('notification-bell-badge')).not.toBeVisible();

      await bellBtn.click();
      const panel = page.getByTestId('notification-panel');
      await expect(panel).toHaveClass(/translate-x-0/);
      await expect(page.getByTestId('notification-empty')).toBeVisible({ timeout: 10_000 });
    } finally {
      grantCell(groupIdB, 'own_notifications', 'read'); // devolve pro afterAll limpar sem surpresa
      await context.close();
    }
  });
});
