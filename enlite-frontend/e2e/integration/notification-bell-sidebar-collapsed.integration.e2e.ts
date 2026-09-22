/**
 * notification-bell-sidebar-collapsed.integration.e2e.ts @integration — change
 * 022-ux-mencao-e-notificacao, item 4 (Fase 2, `fase-2.md`).
 *
 * Feliz: sidebar RECOLHIDA mostra o sino com ícone + badge de contagem, e o poll continua vivo
 *   (contador aparece sem precisar expandir).
 * Alternativo 1: clique no sino COLAPSADO abre a gaveta de notificações normalmente.
 * Alternativo 2: contador zera depois de ler (marcar todas como lidas), continuando colapsada.
 *
 * Stack: mesma família de `patient-conversation-happy.integration.e2e.ts`.
 * Sem PII/texto clínico: paciente "Paciente QA", staff sintéticos, corpo "msg-1".
 */
import { test, expect } from '@playwright/test';
import {
  seedPatientQA, cleanupPatientQA, seedStaffInGroup, cleanupStaffAndGroup, grantCell, loginAs, tokenFor, safeSql,
  ABAC_API_URL,
  type MockUser,
} from '../helpers/patient-conversation-helper';

const RUN_ID = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
const A_UID = `e2e-sb-a-${RUN_ID}`;
const A_EMAIL = `${A_UID}@e2e.test`;
const B_UID = `e2e-sb-b-${RUN_ID}`;
const B_EMAIL = `${B_UID}@e2e.test`;
const GRUPO_A = `E2E SB A ${RUN_ID}`;
const GRUPO_B = `E2E SB B ${RUN_ID}`;

let patientId = '';
let groupIdA = '';
let groupIdB = '';

const A: MockUser = { uid: A_UID, email: A_EMAIL, role: 'recruiter', country: 'AR' };
const B: MockUser = { uid: B_UID, email: B_EMAIL, role: 'recruiter', country: 'AR' };

async function mentionB(request: import('@playwright/test').APIRequestContext, body: string): Promise<void> {
  const res = await request.post(`${ABAC_API_URL}/api/admin/patients/${patientId}/conversation/messages`, {
    headers: { Authorization: `Bearer ${tokenFor(A)}` },
    data: { body: `${body} <@${B_UID}>` },
  });
  if (!res.ok()) throw new Error(`seed falhou: ${res.status()} ${await res.text()}`);
}

/** `AppSidebar` guarda o próprio estado de `isCollapsed` — o único jeito de chegar lá é clicando
 * no toggle real (mesmo padrão de `AppSidebar.test.tsx` no unit, mas aqui contra o DOM de verdade). */
async function collapseSidebar(page: import('@playwright/test').Page): Promise<void> {
  // es-AR é o idioma padrão do painel (`sidebar.collapseMenu` = "Contraer menú").
  await page.getByLabel('Contraer menú').click();
}

test.describe('Sino na sidebar RECOLHIDA — ícone + badge, poll vivo (item 4) @integration', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(120_000);

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

  test('feliz: sidebar recolhida mostra o sino com badge; poll continua contando', async ({ page, request }) => {
    await mentionB(request, 'msg-1 sidebar colapsada');

    await loginAs(page, B);
    await expect(page.getByTestId('notification-bell-btn')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('notification-bell-badge')).toHaveText('1', { timeout: 10_000 });

    // Evidência (brief): sino EXPANDIDO, 1º item, com badge.
    await page.screenshot({
      path: '/Users/gabrielstein-dev/projects/enlite/ebrain/openspec/changes/022-ux-mencao-e-notificacao/evidencias/item4-sino-expandido.png',
    });

    await collapseSidebar(page);
    // O MESMO botão continua montado (nunca desmonta ao recolher, F17) — e o badge, calculado
    // pelo poll que nunca parou, continua visível e correto.
    await expect(page.getByTestId('notification-bell-btn')).toBeVisible();
    await expect(page.getByTestId('notification-bell-badge')).toHaveText('1');

    // Evidência (brief): sino RECOLHIDO — ícone + badge, sem rótulo.
    await page.screenshot({
      path: '/Users/gabrielstein-dev/projects/enlite/ebrain/openspec/changes/022-ux-mencao-e-notificacao/evidencias/item4-sino-recolhido.png',
    });
  });

  // D4 (achado da revisão visual da Fase 2, 22/09): o ícone do sino usava `text-gray-600`, que
  // NESTE projeto (escala de cinza custom, `tailwind.config` — memória
  // `escala-de-cinza-do-frontend-nao-e-tailwind`) resolve pra `#D9D9D9`, quase branco — bem mais
  // claro que os demais ícones da sidebar, que não sobrescrevem cor nenhuma (herdam o padrão).
  test('D4 — ícone do sino usa o MESMO token de cor dos demais itens do menu (nunca cinza-claro isolado)', async ({ page, request }) => {
    await mentionB(request, 'msg-d4 cor do icone');

    await loginAs(page, B);
    await expect(page.getByTestId('notification-bell-btn')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('notification-bell-badge')).toBeVisible({ timeout: 10_000 });

    const colors = await page.evaluate(() => {
      const bellSvg = document.querySelector('[data-testid="notification-bell-btn"] svg');
      const siblingSvg = document.querySelector('aside nav svg');
      return {
        bell: bellSvg ? getComputedStyle(bellSvg).color : null,
        sibling: siblingSvg ? getComputedStyle(siblingSvg).color : null,
      };
    });

    expect(colors.bell, 'ícone do sino não encontrado').not.toBeNull();
    expect(colors.sibling, 'ícone irmão (nav) não encontrado').not.toBeNull();
    // MESMO token — nunca um valor hardcoded: o que importa é bater com o irmão, seja qual for a
    // cor herdada do tema.
    expect(colors.bell).toBe(colors.sibling);

    // O conserto de cor do ÍCONE nunca pode arrastar o badge (contraste alto: vermelho + branco).
    const badgeColors = await page.evaluate(() => {
      const badge = document.querySelector('[data-testid="notification-bell-badge"]');
      const text = badge?.querySelector('span');
      return {
        bg: badge ? getComputedStyle(badge).backgroundColor : null,
        fg: text ? getComputedStyle(text).color : null,
      };
    });
    expect(badgeColors.bg).toBe('rgb(220, 38, 38)'); // bg-red-600
    expect(badgeColors.fg).toBe('rgb(255, 255, 255)'); // text-white

    // Boa vizinhança com o `mode: 'serial'`: a notificação seedada aqui não pode vazar pro
    // contador dos testes seguintes ("alternativo 2" espera um número exato) — marca SÓ a
    // NOTIFICAÇÃO PRÓPRIA como lida (clique no card, nunca "marcar todas", que apagaria também a
    // notificação ainda-não-lida do teste "feliz" anterior).
    await page.getByTestId('notification-bell-btn').click();
    const panel = page.getByTestId('notification-panel');
    await expect(panel).toHaveClass(/translate-x-0/);
    const ownItem = panel.locator('[data-testid^="notification-item-"]').filter({ hasText: 'msg-d4' });
    await expect(ownItem).toHaveCount(1, { timeout: 10_000 });
    await ownItem.click();
  });

  test('alternativo 1 — clique no sino COLAPSADO abre a gaveta normalmente', async ({ page }) => {
    await loginAs(page, B);
    await collapseSidebar(page);

    await page.getByTestId('notification-bell-btn').click();
    const panel = page.getByTestId('notification-panel');
    await expect(panel).toHaveClass(/translate-x-0/);
    await expect(panel.locator('[data-testid^="notification-item-"]').first()).toBeVisible({ timeout: 10_000 });
  });

  test('alternativo 2 — contador zera após ler, continuando colapsada', async ({ page, request }) => {
    await mentionB(request, 'msg-2 zera colapsada');

    await loginAs(page, B);
    await collapseSidebar(page);
    await expect(page.getByTestId('notification-bell-badge')).toHaveText('2', { timeout: 10_000 });

    await page.getByTestId('notification-bell-btn').click();
    await page.getByTestId('notification-mark-all-read').click();

    await expect(page.getByTestId('notification-bell-badge')).not.toBeVisible({ timeout: 10_000 });
    // ainda colapsada — o zerar do contador não depende de expandir.
    await expect(page.getByLabel('Expandir menú')).toBeVisible();
  });
});
