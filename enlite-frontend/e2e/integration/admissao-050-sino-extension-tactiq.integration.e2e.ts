/**
 * admissao-050-sino-extension-tactiq.integration.e2e.ts @integration — spec 050 F15, o aviso do sino
 * `ADMISSION_TACTIQ_EXTENSION_CHANGED` ("a extensão do Tactiq no seu Chrome mudou de estado") lido da TELA.
 *
 * E2E DE TELA, sem mock de dado e sem `page.route`: o aviso é semeado por SQL no banco da stack (o mesmo par evento + destinatário
 * que o job do relatório do Chrome grava), e o texto é lido do sino pelo caminho real — `GET /api/admin/notifications`
 * (`GetNotificationsUseCase.payloadOf`) → `notificationTypeRegistry` → chave de i18n → `NotificationCard`. Abre o sino com CLIQUE.
 * Se `payloadOf` devolver `null` para o tipo, a tela cai no texto de "não está ativa" mesmo para quem acabou de instalar: o feliz mede isso.
 *
 *  feliz  — `installed`: o sino mostra "quedó instalada ... falta hacer la reunión de prueba" e NÃO o texto de "no está activa".
 *  alt 1  — `missing`:   "no está activa ... Instalala".
 *  alt 2  — `disabled`:  "está desactivada ... Activala de nuevo".
 *
 * ⚠️ Mesma stack do `admissao-049-aba` (engine ABAC ligado, staff REAL em grupo): o nome entra no `--grep` do job
 * `integration-e2e-group-simulation` do `_frontend-integration.yml` pelo token `admissao-050`. Dados SINTÉTICOS (sem e-mail de pessoa,
 * sem paciente): o aviso desta família não tem paciente nem texto livre, só `{ state }` no payload.
 */
import { test, expect, type Page } from '@playwright/test';
import {
  psql, scalar, safeSql, seedStaffInGroup, cleanupStaffAndGroup, grantCell, loginAs, ABAC_TENANT,
} from '../helpers/abac-stack-helper';

const RUN_ID = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
const UID = `e2e-050x-operadora-${RUN_ID}`;
const OPERADORA = { uid: UID, email: `${UID}@e2e.test`, role: 'recruiter', country: 'AR' };
const ATOR = `system-chrome-report-${RUN_ID}`;

const TEXTO = {
  installed: 'La extensión de Tactiq quedó instalada en tu Chrome. Para quedar habilitada para recibir agendas, falta hacer la reunión de prueba.',
  missing: 'La extensión de Tactiq no está activa en tu Chrome. Instalala para seguir recibiendo agendas de admisión.',
  disabled: 'La extensión de Tactiq está desactivada en tu Chrome. Activala de nuevo para seguir recibiendo agendas de admisión.',
} as const;
type Estado = keyof typeof TEXTO;

let groupId = '';

/** Semeia o aviso exatamente como o job grava: 1 evento (`{ state }`) + 1 destinatário. Devolve o id da notificação. */
function semearAviso(state: Estado): string {
  const eventId = scalar(
    `INSERT INTO notification_events (type_code, actor_uid, payload)
     VALUES ('ADMISSION_TACTIQ_EXTENSION_CHANGED', '${ATOR}', '{"state":"${state}"}'::jsonb) RETURNING id`,
  );
  return scalar(`INSERT INTO notifications (event_id, recipient_uid) VALUES ('${eventId}', '${UID}') RETURNING id`);
}

/** Abre o sino como humano (clique) e devolve o item da notificação semeada. */
async function abrirSinoNoItem(page: Page, notificationId: string) {
  await loginAs(page, OPERADORA);
  const sino = page.getByTestId('notification-bell-btn');
  await expect(sino).toBeVisible({ timeout: 15_000 });
  await sino.click();
  const painel = page.getByTestId('notification-panel');
  await expect(painel).toHaveClass(/translate-x-0/);
  const item = painel.getByTestId(`notification-item-${notificationId}`);
  await expect(item).toBeVisible({ timeout: 15_000 });
  return { painel, item };
}

test.describe('admissao-050 — sino: aviso da extensão do Tactiq no Chrome (spec 050 F15) @integration', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(120_000);

  test.beforeAll(() => {
    groupId = seedStaffInGroup({ uid: UID, email: OPERADORA.email, groupName: `Adm050X Operadora ${RUN_ID}`, country: 'AR' }).groupId;
    grantCell(groupId, 'own_notifications', 'read');
    grantCell(groupId, 'own_notifications', 'update');
  });

  test.afterAll(() => {
    safeSql(`DELETE FROM notifications WHERE recipient_uid = '${UID}'`);
    safeSql(`DELETE FROM notification_events WHERE actor_uid = '${ATOR}'`);
    cleanupStaffAndGroup(UID, groupId);
    safeSql(`DELETE FROM iam.permission_groups WHERE tenant_id = '${ABAC_TENANT}' AND name LIKE 'Adm050X % ${RUN_ID}'`);
  });

  test('feliz: extensão instalada — o sino diz que quedó instalada e falta a reunião de prueba (não o texto de "no está activa")', async ({ page }, testInfo) => {
    const id = semearAviso('installed');
    expect(psql(`SELECT payload->>'state' FROM notification_events e JOIN notifications n ON n.event_id = e.id WHERE n.id = '${id}'`).trim()).toBe('installed');

    const { item } = await abrirSinoNoItem(page, id);
    const linha = item.getByTestId(`notification-excerpt-${id}`);
    await expect(linha).toHaveText(TEXTO.installed);
    await expect(item).not.toContainText(TEXTO.missing);
    await expect(item).not.toContainText('no está activa');
    // O leitor de tela ouve a frase inteira: o `aria-label` do item é o mesmo texto.
    await expect(item).toHaveAttribute('aria-label', TEXTO.installed);
    await page.screenshot({ path: testInfo.outputPath('1-feliz-installed.png'), fullPage: true });
  });

  test('alt 1: extensão ausente — o sino diz que não está ativa e manda instalar', async ({ page }, testInfo) => {
    const id = semearAviso('missing');
    const { item } = await abrirSinoNoItem(page, id);
    await expect(item.getByTestId(`notification-excerpt-${id}`)).toHaveText(TEXTO.missing);
    await expect(item).not.toContainText('quedó instalada');
    await page.screenshot({ path: testInfo.outputPath('2-alt1-missing.png'), fullPage: true });
  });

  test('alt 2: extensão desativada — o sino diz que está desactivada e manda ativar de novo', async ({ page }, testInfo) => {
    const id = semearAviso('disabled');
    const { item } = await abrirSinoNoItem(page, id);
    await expect(item.getByTestId(`notification-excerpt-${id}`)).toHaveText(TEXTO.disabled);
    await expect(item).not.toContainText('quedó instalada');
    await expect(item).not.toContainText('no está activa');
    await page.screenshot({ path: testInfo.outputPath('3-alt2-disabled.png'), fullPage: true });
  });
});
