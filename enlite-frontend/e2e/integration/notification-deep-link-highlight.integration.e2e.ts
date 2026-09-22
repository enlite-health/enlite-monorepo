/**
 * notification-deep-link-highlight.integration.e2e.ts @integration — change
 * 022-ux-mencao-e-notificacao, item 3 (Fase 2, `fase-2.md`).
 *
 * `notification-bell-deep-link.integration.e2e.ts` (Bloco 4 original) já prova o caminho feliz de
 * "clique abre a conversa". Este spec cobre o que aquele NÃO cobre, pedido explicitamente pelo
 * "termina quando" da Fase 2: o HIGHLIGHT em si (presente e depois ausente), a mensagem de origem
 * ser uma REPLY (abre a thread certa) e a mensagem estar FORA da 1ª página (carrega até achar).
 *
 * Feliz: clique leva à mensagem de TOPO exata — `message-card-highlighted` aparece e SOME sozinho
 *   (~2s, design.md §3).
 * Alternativo 1: notificação de uma REPLY — abre a THREAD certa e destaca a reply lá dentro.
 * Alternativo 2: mensagem de topo fora da 1ª página (51 mensagens de enchimento antes dela) — o
 *   painel carrega páginas em loop até achar, sem travar a UI (F16, decisão de menor diff).
 *
 * Stack: mesma família de `patient-conversation-happy.integration.e2e.ts`.
 * Sem PII/texto clínico: paciente "Paciente QA", staff sintéticos, corpo "msg-N".
 */
import { test, expect } from '@playwright/test';
import {
  seedPatientQA, cleanupPatientQA, seedStaffInGroup, cleanupStaffAndGroup, grantCell, loginAs, tokenFor, safeSql,
  ABAC_API_URL,
  type MockUser,
} from '../helpers/patient-conversation-helper';

const RUN_ID = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
const A_UID = `e2e-dl-a-${RUN_ID}`;
const A_EMAIL = `${A_UID}@e2e.test`;
const B_UID = `e2e-dl-b-${RUN_ID}`;
const B_EMAIL = `${B_UID}@e2e.test`;
const GRUPO_A = `E2E DL A ${RUN_ID}`;
const GRUPO_B = `E2E DL B ${RUN_ID}`;

let patientId = '';
let groupIdA = '';
let groupIdB = '';

const A: MockUser = { uid: A_UID, email: A_EMAIL, role: 'recruiter', country: 'AR' };
const B: MockUser = { uid: B_UID, email: B_EMAIL, role: 'recruiter', country: 'AR' };

async function postMessage(
  request: import('@playwright/test').APIRequestContext,
  body: string,
  rootMessageId?: string,
): Promise<string> {
  const res = await request.post(`${ABAC_API_URL}/api/admin/patients/${patientId}/conversation/messages`, {
    headers: { Authorization: `Bearer ${tokenFor(A)}` },
    data: { body, rootMessageId },
  });
  if (!res.ok()) throw new Error(`seed falhou: ${res.status()} ${await res.text()}`);
  const json = (await res.json()) as { data: { id: string } };
  return json.data.id;
}

async function openBellAndClickLatest(page: import('@playwright/test').Page, matchText: string) {
  await page.getByTestId('notification-bell-btn').click();
  const panel = page.getByTestId('notification-panel');
  await expect(panel).toHaveClass(/translate-x-0/);
  const item = panel.locator('[data-testid^="notification-item-"]').filter({ hasText: matchText }).first();
  await expect(item).toBeVisible({ timeout: 10_000 });
  await item.click();
}

test.describe('Deep-link — scroll + destaque momentâneo (item 3) @integration', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(180_000);

  test.beforeAll(() => {
    patientId = seedPatientQA();
    const seededA = seedStaffInGroup({ uid: A_UID, email: A_EMAIL, groupName: GRUPO_A, country: 'AR' });
    groupIdA = seededA.groupId;
    grantCell(groupIdA, 'patient', 'read');
    grantCell(groupIdA, 'patient_conversation', 'read');
    grantCell(groupIdA, 'patient_conversation', 'create');

    const seededB = seedStaffInGroup({ uid: B_UID, email: B_EMAIL, groupName: GRUPO_B, country: 'AR' });
    groupIdB = seededB.groupId;
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

  test('feliz: mensagem de TOPO — destaque aparece e SOME sozinho (~2s)', async ({ page, request }) => {
    const messageId = await postMessage(request, `msg-topo-feliz <@${B_UID}>`);

    await loginAs(page, B);
    // O texto do item é montado no CLIENTE (FR-015: "Fulano mencionou você em Paciente QA") —
    // nunca o corpo — por isso o filtro casa pelo NOME do paciente, não pelo texto da mensagem.
    await openBellAndClickLatest(page, 'QA');

    await expect(page).toHaveURL(new RegExp(`/admin/patients/${patientId}`));
    const card = page.getByTestId(`message-card-${messageId}`);
    await expect(card).toBeVisible({ timeout: 10_000 });
    // presente logo após o clique...
    await expect(card).toHaveClass(/message-card-highlighted/);
    // Evidência (brief): highlight momentâneo na mensagem-alvo do deep-link.
    await page.screenshot({
      path: '/Users/gabrielstein-dev/projects/enlite/ebrain/openspec/changes/022-ux-mencao-e-notificacao/evidencias/item3-highlight-mensagem.png',
    });
    // ...e ausente depois de ~2s (design.md §3) — a prova exigida pelo "termina quando" da Fase 2.
    await expect(card).not.toHaveClass(/message-card-highlighted/, { timeout: 4_000 });
  });

  test('alternativo 1 — notificação de uma REPLY: abre a THREAD certa e destaca a reply', async ({ page, request }) => {
    const rootId = await postMessage(request, 'msg-root-para-reply');
    const replyId = await postMessage(request, `msg-reply-destacada <@${B_UID}>`, rootId);

    await loginAs(page, B);
    await openBellAndClickLatest(page, 'QA');

    const thread = page.getByTestId('thread-view');
    await expect(thread).toBeVisible({ timeout: 10_000 });
    const replyCard = page.getByTestId(`message-card-${replyId}`);
    await expect(replyCard).toBeVisible({ timeout: 10_000 });
    await expect(replyCard).toHaveClass(/message-card-highlighted/);
    // root da thread NÃO fica marcado como destacado — só a reply é o alvo.
    await expect(page.getByTestId(`message-card-${rootId}`)).not.toHaveClass(/message-card-highlighted/);
  });

  test('alternativo 2 — mensagem de topo FORA da 1ª página: carrega em loop até achar, sem travar a UI', async ({ page, request }) => {
    // 51 mensagens de enchimento — a página inicial (CONVERSATION_PAGE_SIZE=50) nunca contém a
    // 52ª. `Promise.all` seria mais rápido, mas a ordem de created_at importaria para o teste
    // (ASC) — sequencial garante ordem determinística.
    for (let i = 0; i < 51; i += 1) {
      await postMessage(request, `msg-enchimento-${i}`);
    }
    const targetId = await postMessage(request, `msg-fora-da-pagina-1 <@${B_UID}>`);

    await loginAs(page, B);
    await openBellAndClickLatest(page, 'QA');

    await expect(page).toHaveURL(new RegExp(`/admin/patients/${patientId}`));
    // A UI segue responsiva durante o loop — nunca trava (o `not-found` NUNCA aparece aqui,
    // porque a mensagem EXISTE, só não estava carregada).
    const card = page.getByTestId(`message-card-${targetId}`);
    await expect(card).toBeVisible({ timeout: 20_000 });
    await expect(card).toHaveClass(/message-card-highlighted/);
    await expect(page.getByTestId('conversation-message-not-found')).not.toBeVisible();
  });
});
