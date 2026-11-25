/**
 * admissao-083-sino-nao-gravada.integration.e2e.ts @integration — tactiq-vinculo-resiliente F4 (T411): o aviso `not_recorded`
 * ("Esta entrevista no quedó grabada en Tactiq") lido da TELA, no molde de `admissao-083-sino-import-bloqueado`.
 *
 * E2E DE TELA, sem interceptar rota e sem mock de dado: o aviso (`ADMISSION_IMPORT_BLOCKED`, stage `expired`, reason `not_recorded`,
 * audience `host`) é semeado por SQL no banco da stack e lido do sino pelo caminho real (API → registry → i18n → `NotificationCard`).
 * Abre o sino e lê o texto da tela COMO HUMANO (click + texto lido do cartão; nada de `fill()`).
 *  feliz es / pt-BR — título e corpo próprios de D14 (sem prazo, sem "Vincular Tactiq" como pedido); o cartão leva ao Perfil.
 * O nome do arquivo carrega o token `admissao-083` (conjunto fechado do `--grep` do job de integração do CI).
 * Dados SINTÉTICOS, sem paciente. Datas fixas (17:00Z = 14:00 em Buenos Aires).
 */
import { test, expect, type Page } from '@playwright/test';
import {
  psql, scalar, safeSql, seedStaffInGroup, cleanupStaffAndGroup, grantCell, loginAs, ABAC_TENANT,
} from '../helpers/abac-stack-helper';

const RUN_ID = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
const UID = `e2e-083f4-operadora-${RUN_ID}`;
const OPERADORA = { uid: UID, email: `${UID}@e2e.test`, role: 'recruiter', country: 'AR' };
const ATOR = `system-admission-083f4-${RUN_ID}`;

const MEETING_AT = '2026-11-04T17:00:00.000Z'; // 14:00 em Buenos Aires
const DEADLINE_AT = '2026-11-06T17:00:00.000Z';

type Payload = { stage: string; kind: string; reason: string; audience: string; hostName?: string };
const base = { meetingAt: MEETING_AT, deadlineAt: DEADLINE_AT };

/** Mesma lista do CA-11 (`importBlockedTexts.test.ts`) — palavra inteira, sem caixa. "Vincular" é permitido. */
const TERMOS_PROIBIDOS = [
  'import', 'importação', 'importar', 'no_link', 'wrong_account', 'blocked', 'expired', 'reason', 'stage', 'payload',
  'appointment', 'link', 'vínculo', 'vinculación', 'token', 'oauth', 'mcp', 'job', 'rodada', 'fila', 'evento', 'status', 'error', 'erro',
];
const PROIBIDOS_RE = TERMOS_PROIBIDOS.map((t) => new RegExp(`(?<![\\p{L}\\p{N}])${t}(?![\\p{L}\\p{N}])`, 'iu'));
const CODIGOS_RE = [/ADM-[0-9A-Z]{6}/, /[0-9a-f]{8}-[0-9a-f]{4}-/i, /\{\{|\}\}/, /\d{5,}/, /paciente/i];

let groupId = '';


function semearAviso(payload: Payload): string {
  const eventId = scalar(
    `INSERT INTO notification_events (type_code, actor_uid, payload)
     VALUES ('ADMISSION_IMPORT_BLOCKED', '${ATOR}', '${JSON.stringify({ ...base, ...payload })}'::jsonb) RETURNING id`,
  );
  return scalar(`INSERT INTO notifications (event_id, recipient_uid) VALUES ('${eventId}', '${UID}') RETURNING id`);
}

/** Entra (o login é em espanhol), troca o idioma da tela e abre o sino como humano. Devolve o item da notificação semeada. */
async function abrirSinoNoItem(page: Page, notificationId: string, lng: 'es' | 'pt-BR') {
  await loginAs(page, OPERADORA);
  if (lng === 'pt-BR') {
    await page.evaluate(() => window.localStorage.setItem('i18nextLng', 'pt-BR'));
    await page.reload();
  }
  const sino = page.getByTestId('notification-bell-btn');
  await expect(sino).toBeVisible({ timeout: 15_000 });
  await sino.click();
  const painel = page.getByTestId('notification-panel');
  await expect(painel).toHaveClass(/translate-x-0/);
  const item = painel.getByTestId(`notification-item-${notificationId}`);
  await expect(item).toBeVisible({ timeout: 15_000 });
  return item;
}

/** O que a pessoa LÊ no cartão: sem termo técnico, sem código, sem dado de paciente. */
async function expectLinguagemDePessoa(item: ReturnType<Page['getByTestId']>) {
  const tela = (await item.innerText()).replace(/\s+/g, ' ');
  expect(tela.length).toBeGreaterThan(40); // controle positivo: leu o texto de verdade
  for (const re of [...PROIBIDOS_RE, ...CODIGOS_RE]) expect(tela, `termo proibido ${re} na tela`).not.toMatch(re);
}

/** O cartão INTEIRO é o link: o clique leva ao Perfil, seção Tactiq. */
async function expectCartaoLevaAoTactiq(page: Page, item: ReturnType<Page['getByTestId']>) {
  await item.click();
  await expect(page).toHaveURL(/\/admin\/mi-cuenta\/?$/);
  await expect(page.getByTestId('tactiq-link-card')).toBeVisible({ timeout: 15_000 });
}

test.describe('admissao-083 — sino: reunião que não foi gravada no Tactiq (tactiq-vinculo-resiliente F4) @integration', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(120_000);

  test.beforeAll(() => {
    groupId = seedStaffInGroup({ uid: UID, email: OPERADORA.email, groupName: `Adm083X Operadora ${RUN_ID}`, country: 'AR' }).groupId;
    grantCell(groupId, 'own_notifications', 'read');
    grantCell(groupId, 'own_notifications', 'update');
    grantCell(groupId, 'own_tactiq_link', 'read');
    grantCell(groupId, 'own_tactiq_link', 'create');
  });

  test.afterAll(() => {
    safeSql(`DELETE FROM notifications WHERE recipient_uid = '${UID}'`);
    safeSql(`DELETE FROM notification_events WHERE actor_uid = '${ATOR}'`);
    cleanupStaffAndGroup(UID, groupId);
    safeSql(`DELETE FROM iam.permission_groups WHERE tenant_id = '${ABAC_TENANT}' AND name LIKE 'Adm083X % ${RUN_ID}'`);
  });

  test('feliz es: o host lê "Esta entrevista no quedó grabada en Tactiq" com a data no fuso de Buenos Aires, sem prazo', async ({ page }, testInfo) => {
    const id = semearAviso({ stage: 'expired', kind: 'admission', reason: 'not_recorded', audience: 'host' });
    expect(psql(`SELECT payload->>'reason' FROM notification_events e JOIN notifications n ON n.event_id = e.id WHERE n.id = '${id}'`).trim()).toBe('not_recorded');

    const item = await abrirSinoNoItem(page, id, 'es');
    await expect(item).toContainText('Esta entrevista no quedó grabada en Tactiq');
    await expect(item.getByTestId(`notification-excerpt-${id}`)).toContainText(
      'Tu reunión de admisión del 4 de nov. a las 14:00 no quedó grabada en Tactiq, así que no hay transcripción ni resumen.',
    );
    await expect(item.getByTestId(`notification-excerpt-${id}`)).toContainText('revisá que la extensión de Tactiq esté activa en Chrome');
    await expect(item).not.toContainText(/hasta el 6 de nov|porque tu cuenta/);
    await expectLinguagemDePessoa(item);
    await page.screenshot({ path: testInfo.outputPath('1-nao-gravada-es.png'), fullPage: true });
    await expectCartaoLevaAoTactiq(page, item);
  });

  test('feliz pt-BR: o mesmo aviso em português, enquadre', async ({ page }, testInfo) => {
    const id = semearAviso({ stage: 'expired', kind: 'enquadre', reason: 'not_recorded', audience: 'host' });
    const item = await abrirSinoNoItem(page, id, 'pt-BR');
    await expect(item).toContainText('Esta entrevista não foi gravada no Tactiq');
    await expect(item.getByTestId(`notification-excerpt-${id}`)).toContainText(
      'A sua entrevista de enquadre de 4 de nov. às 14:00 não foi gravada no Tactiq, então não há transcrição nem resumo.',
    );
    await expect(item).not.toContainText(/Você tem até|porque a sua conta/);
    await expectLinguagemDePessoa(item);
    await page.screenshot({ path: testInfo.outputPath('2-nao-gravada-pt.png'), fullPage: true });
    await expectCartaoLevaAoTactiq(page, item);
  });
});
