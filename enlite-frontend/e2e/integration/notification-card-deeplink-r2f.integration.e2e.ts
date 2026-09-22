/**
 * notification-card-deeplink-r2f.integration.e2e.ts @integration — Rodada 2/R2-F (presença +
 * popup de menção estilo ClickUp + notificações), defeitos medidos em prd 21-22/09.
 *
 * Feliz — Defeito 1 (deep-link não rola/destaca com a página JÁ aberta): A menciona B DUAS vezes
 * no MESMO paciente; B abre a 1ª notificação (painel abre, deep-link funciona — já coberto por
 * `notification-bell-deep-link`), continua na MESMA página e clica na 2ª notificação SEM navegar
 * pra fora — antes do conserto (`PatientDetailPage.tsx`, `useEffect` de `location.state`), o
 * `useState` com lazy initializer nunca via o 2º `location.state` (React Router não desmonta a
 * página, mesma rota) e o painel não reagia de novo.
 *
 * Alternativo 1 — Defeito 2 (card em 3 linhas): o nome do paciente (linha 2, elemento PRÓPRIO)
 * tem largura real (`getBoundingClientRect`) e fica DENTRO do card — nunca 0×0 nem cortado atrás
 * do texto da linha 1 (autor+data).
 *
 * Alternativo 2 — Defeito 3 ("Marcar todas" não sobrepõe o ✕): os dois retângulos reais
 * (`getBoundingClientRect`) do botão "Marcar todas" e do ✕ do `SlideOverPanel` NÃO se
 * intersectam — a prova geométrica que o unit test (jsdom, sem layout) não consegue fazer.
 *
 * Stack: mesma família de `notification-bell-deep-link.integration.e2e.ts` (ver o docblock dele
 * para portas/env desta sessão — E2E_PG_CONTAINER/ABAC_API_URL/ABAC_TEST_DB_URL/PW_BASE_URL).
 *
 * Sem PII/texto clínico: paciente "Paciente QA", staff "QA Staff <N>", corpo "msg-1".
 */
import { test, expect } from '@playwright/test';
import {
  seedPatientQA, cleanupPatientQA, seedStaffInGroup, cleanupStaffAndGroup, grantCell, loginAs, safeSql, psql,
  type MockUser,
} from '../helpers/patient-conversation-helper';

function rectsIntersect(a: { x: number; y: number; width: number; height: number }, b: typeof a): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

const RUN_ID = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
const A_UID = `e2e-r2f-a-${RUN_ID}`;
const A_EMAIL = `${A_UID}@e2e.test`;
const B_UID = `e2e-r2f-b-${RUN_ID}`;
const B_EMAIL = `${B_UID}@e2e.test`;
const GRUPO_A = `E2E R2F A ${RUN_ID}`;
const GRUPO_B = `E2E R2F B ${RUN_ID}`;

let patientId = '';
let groupIdA = '';
let groupIdB = '';

const A: MockUser = { uid: A_UID, email: A_EMAIL, role: 'recruiter', country: 'AR' };
const B: MockUser = { uid: B_UID, email: B_EMAIL, role: 'recruiter', country: 'AR' };

test.describe('Notificação — deep-link na mesma página + card em 3 linhas + X sem sobreposição (Rodada 2/R2-F) @integration', () => {
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

  async function aMencionaB(pageA: import('@playwright/test').Page, corpo: string): Promise<void> {
    await pageA.goto(`/admin/patients/${patientId}`);
    const handleBtn = pageA.getByTestId('patient-conversation-handle-btn');
    await expect(handleBtn).toBeVisible({ timeout: 15_000 });
    await handleBtn.click();
    const editor = pageA.getByTestId('composer-editor');
    await editor.click();
    await expect(editor).toBeFocused();
    await pageA.keyboard.type(`${corpo} `);
    await pageA.keyboard.type('@QA');
    const mentionItem = pageA.getByTestId(`composer-mention-item-${B_UID}`);
    await expect(mentionItem).toBeVisible({ timeout: 10_000 });
    await mentionItem.click();
    const posted = pageA.waitForResponse((r) => r.request().method() === 'POST' && /\/conversation\/messages$/.test(r.url()));
    await pageA.getByTestId('composer-send-btn').click();
    await posted;
  }

  test('feliz (Defeito 1): 2ª notificação clicada com a página do MESMO paciente já aberta reage de novo, sem navegar pra fora', async ({ browser }) => {
    const contextA = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const contextB = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const pageA = await contextA.newPage();
    const pageB = await contextB.newPage();
    try {
      await loginAs(pageA, A);
      await aMencionaB(pageA, 'msg-1 primeira mencao');

      await loginAs(pageB, B);
      // B abre a ficha do paciente DIRETO (não pelo sino) — a página já está montada quando o
      // 1º clique do sino chegar, reproduzindo exatamente o cenário do Defeito 1 (React Router
      // não desmonta ao navegar pra MESMA rota).
      await pageB.goto(`/admin/patients/${patientId}`);
      await expect(pageB.getByTestId('patient-conversation-handle-btn')).toBeVisible({ timeout: 15_000 });

      const bellBtn = pageB.getByTestId('notification-bell-btn');
      await expect(bellBtn).toBeVisible({ timeout: 15_000 });
      await expect(pageB.getByTestId('notification-bell-badge')).toBeVisible({ timeout: 10_000 });

      await bellBtn.click();
      const panel = pageB.getByTestId('notification-panel');
      await expect(panel).toHaveClass(/translate-x-0/);
      const item1 = panel.locator('[data-testid^="notification-item-"]').first();
      await item1.click();

      const conversationPanel = pageB.getByTestId('patient-conversation-panel');
      await expect(conversationPanel).toHaveClass(/translate-x-0/, { timeout: 10_000 });

      // Fecha o painel de conversa (mas continua na MESMA página do paciente) e manda a 2ª menção.
      await pageB.getByTestId('patient-conversation-panel-close-btn').click();
      await expect(conversationPanel).not.toHaveClass(/translate-x-0/);

      await aMencionaB(pageA, 'msg-2 segunda mencao');

      // 2º clique: B está na MESMA página (nunca navegou pra fora) — o `useEffect` do token
      // novo em `location.state` é quem tem de reabrir o painel, não o `useState` inicial.
      await expect(pageB.getByTestId('notification-bell-badge')).toBeVisible({ timeout: 10_000 });
      await bellBtn.click();
      await expect(panel).toHaveClass(/translate-x-0/);
      const item2 = panel.locator('[data-testid^="notification-item-"]').first();
      await item2.click();

      await expect(conversationPanel).toHaveClass(/translate-x-0/, { timeout: 10_000 });
      await expect(pageB).toHaveURL(new RegExp(`/admin/patients/${patientId}`));
    } finally {
      await contextA.close();
      await contextB.close();
    }
  });

  test('alternativo 1 (Defeito 2): nome do paciente (linha 2) tem largura real e fica DENTRO do card', async ({ browser }) => {
    const contextA = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const contextB = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const pageA = await contextA.newPage();
    const pageB = await contextB.newPage();
    try {
      await loginAs(pageA, A);
      await aMencionaB(pageA, 'msg-3 card em 3 linhas');

      await loginAs(pageB, B);
      const bellBtn = pageB.getByTestId('notification-bell-btn');
      await expect(pageB.getByTestId('notification-bell-badge')).toBeVisible({ timeout: 10_000 });
      await bellBtn.click();
      const panel = pageB.getByTestId('notification-panel');
      await expect(panel).toHaveClass(/translate-x-0/);

      const item = panel.locator('[data-testid^="notification-item-"]').first();
      const id = (await item.getAttribute('data-testid'))!.replace('notification-item-', '');
      const card = pageB.getByTestId(`notification-item-${id}`);
      const patientLine = pageB.getByTestId(`notification-patient-${id}`);

      const cardBox = await card.boundingBox();
      const patientBox = await patientLine.boundingBox();
      expect(cardBox).not.toBeNull();
      expect(patientBox).not.toBeNull();
      expect(patientBox!.width).toBeGreaterThan(0);
      expect(patientBox!.height).toBeGreaterThan(0);
      // dentro do card — nunca escapando pelas bordas.
      expect(patientBox!.x).toBeGreaterThanOrEqual(cardBox!.x - 1);
      expect(patientBox!.x + patientBox!.width).toBeLessThanOrEqual(cardBox!.x + cardBox!.width + 1);
      expect(patientBox!.y).toBeGreaterThanOrEqual(cardBox!.y - 1);
      expect(patientBox!.y + patientBox!.height).toBeLessThanOrEqual(cardBox!.y + cardBox!.height + 1);
      await expect(patientLine).toContainText('Paciente QA');
    } finally {
      await contextA.close();
      await contextB.close();
    }
  });

  test('alternativo 2 (Defeito 3): "Marcar todas" e o ✕ do painel NUNCA se sobrepõem (rects reais)', async ({ browser }) => {
    const contextA = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const contextB = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const pageA = await contextA.newPage();
    const pageB = await contextB.newPage();
    try {
      await loginAs(pageA, A);
      await aMencionaB(pageA, 'msg-4 sem sobreposicao do x');

      await loginAs(pageB, B);
      await expect(pageB.getByTestId('notification-bell-badge')).toBeVisible({ timeout: 10_000 });
      await pageB.getByTestId('notification-bell-btn').click();
      const panel = pageB.getByTestId('notification-panel');
      await expect(panel).toHaveClass(/translate-x-0/);

      const markAll = pageB.getByTestId('notification-mark-all-read');
      const closeBtn = pageB.getByTestId('notification-panel-close-btn');
      await expect(markAll).toBeVisible();
      await expect(closeBtn).toBeVisible();

      const markAllBox = (await markAll.boundingBox())!;
      const closeBox = (await closeBtn.boundingBox())!;
      expect(rectsIntersect(markAllBox, closeBox)).toBe(false);
    } finally {
      await contextA.close();
      await contextB.close();
    }
  });
});
