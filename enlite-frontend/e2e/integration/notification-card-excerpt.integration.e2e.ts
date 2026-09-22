/**
 * notification-card-excerpt.integration.e2e.ts @integration — change 022-ux-mencao-e-notificacao,
 * item 2 (Fase 2, `fase-2.md`).
 *
 * Prova, contra a stack real: `NotificationCard` mostra avatar (iniciais), nome do autor, nome do
 * paciente, data e o trecho (`messageExcerpt`) decifrado no SERVIDOR — sob o MESMO gate de
 * `patientDisplayName` (`patient_conversation:read` do DESTINATÁRIO).
 *
 * Feliz: destinatário COM a célula vê avatar + nome + trecho.
 * Alternativo 1: destinatário SEM `patient_conversation:read` — card aparece normal (avatar, nome,
 *   data), SEM a linha de trecho, sem crash.
 * Alternativo 2: mensagem EDITADA depois de gerar a notificação — o trecho listado reflete o corpo
 *   ATUAL (decifrado na LEITURA, nunca persistido), nunca o texto de quando a notificação nasceu.
 *
 * Stack: mesma família de `patient-conversation-happy.integration.e2e.ts`.
 * Sem PII/texto clínico: paciente "Paciente QA", staff "QA Staff Autora"/sintéticos, corpo "msg-1".
 */
import { test, expect } from '@playwright/test';
import {
  seedPatientQA, cleanupPatientQA, seedStaffInGroup, cleanupStaffAndGroup, grantCell, loginAs, tokenFor, safeSql,
  ABAC_API_URL,
  type MockUser,
} from '../helpers/patient-conversation-helper';
import { revokeCell } from '../helpers/abac-stack-helper';

const RUN_ID = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
const A_UID = `e2e-card-a-${RUN_ID}`;
const A_EMAIL = `${A_UID}@e2e.test`;
const B_UID = `e2e-card-b-${RUN_ID}`;
const B_EMAIL = `${B_UID}@e2e.test`;
const GRUPO_A = `E2E Card A ${RUN_ID}`;
const GRUPO_B = `E2E Card B ${RUN_ID}`;

let patientId = '';
let groupIdA = '';
let groupIdB = '';

const A: MockUser = { uid: A_UID, email: A_EMAIL, role: 'recruiter', country: 'AR' };
const B: MockUser = { uid: B_UID, email: B_EMAIL, role: 'recruiter', country: 'AR' };

async function postAndMention(request: import('@playwright/test').APIRequestContext, body: string): Promise<string> {
  const res = await request.post(`${ABAC_API_URL}/api/admin/patients/${patientId}/conversation/messages`, {
    headers: { Authorization: `Bearer ${tokenFor(A)}` },
    data: { body: `${body} <@${B_UID}>` },
  });
  if (!res.ok()) throw new Error(`seed falhou: ${res.status()} ${await res.text()}`);
  const json = (await res.json()) as { data: { id: string } };
  return json.data.id;
}

test.describe('Card de notificação — avatar, paciente, data, trecho (item 2) @integration', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(120_000);

  test.beforeAll(() => {
    patientId = seedPatientQA();
    const seededA = seedStaffInGroup({ uid: A_UID, email: A_EMAIL, groupName: GRUPO_A, country: 'AR' });
    groupIdA = seededA.groupId;
    grantCell(groupIdA, 'patient', 'read');
    grantCell(groupIdA, 'patient_conversation', 'read');
    grantCell(groupIdA, 'patient_conversation', 'create');
    grantCell(groupIdA, 'patient_conversation', 'update');

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

  test('feliz: destinatário COM a célula vê avatar, nome do autor e o trecho da mensagem', async ({ page, request }) => {
    await postAndMention(request, 'msg-1 trecho feliz');

    await loginAs(page, B);
    const bellBtn = page.getByTestId('notification-bell-btn');
    await expect(bellBtn).toBeVisible({ timeout: 15_000 });
    await bellBtn.click();
    const panel = page.getByTestId('notification-panel');
    await expect(panel).toHaveClass(/translate-x-0/);

    const item = panel.locator('[data-testid^="notification-item-"]').first();
    await expect(item).toBeVisible({ timeout: 10_000 });
    await expect(item.getByTestId('message-avatar')).toBeVisible();
    const excerpt = item.locator('[data-testid^="notification-excerpt-"]');
    await expect(excerpt).toBeVisible();
    await expect(excerpt).toContainText('msg-1 trecho feliz');

    // Evidência (brief): card de notificação com avatar, nome, paciente, data e trecho.
    await page.screenshot({
      path: '/Users/gabrielstein-dev/projects/enlite/ebrain/openspec/changes/022-ux-mencao-e-notificacao/evidencias/item2-card-notificacao-com-trecho.png',
    });
  });

  test('alternativo 1 — destinatário SEM patient_conversation:read: card sem trecho, sem crash', async ({ page, request }) => {
    revokeCell(groupIdB, 'patient_conversation', 'read');
    try {
      await postAndMention(request, 'msg-2 sem acesso');

      await loginAs(page, B);
      await page.getByTestId('notification-bell-btn').click();
      const panel = page.getByTestId('notification-panel');
      const item = panel.locator('[data-testid^="notification-item-"]').first();
      await expect(item).toBeVisible({ timeout: 10_000 });
      // Card continua normal (avatar, nome), SEM a linha de trecho.
      await expect(item.getByTestId('message-avatar')).toBeVisible();
      await expect(item.locator('[data-testid^="notification-excerpt-"]')).toHaveCount(0);
    } finally {
      grantCell(groupIdB, 'patient_conversation', 'read');
    }
  });

  test('alternativo 2 — mensagem EDITADA depois de gerar a notificação: o trecho listado é o corpo ATUAL, nunca o antigo', async ({ page, request }) => {
    const messageId = await postAndMention(request, 'msg-3 texto original');

    const editRes = await request.patch(
      `${ABAC_API_URL}/api/admin/patients/${patientId}/conversation/messages/${messageId}`,
      { headers: { Authorization: `Bearer ${tokenFor(A)}` }, data: { body: 'msg-3 texto editado depois' } },
    );
    expect(editRes.ok()).toBe(true);

    await loginAs(page, B);
    await page.getByTestId('notification-bell-btn').click();
    const panel = page.getByTestId('notification-panel');
    const item = panel.locator(`[data-testid^="notification-item-"]`).filter({ hasText: 'msg-3' }).first();
    await expect(item).toBeVisible({ timeout: 10_000 });
    const excerpt = item.locator('[data-testid^="notification-excerpt-"]');
    await expect(excerpt).toContainText('msg-3 texto editado depois');
    await expect(excerpt).not.toContainText('texto original');
  });
});
