/**
 * admissao-083-sino-import-bloqueado.integration.e2e.ts @integration — spec 083 F4 (CA-14), o aviso do sino
 * `ADMISSION_IMPORT_BLOCKED` ("a transcrição da sua reunião não chegou porque o Tactiq não está vinculado") lido da TELA.
 *
 * E2E DE TELA, sem mock de dado e sem `page.route`: o aviso é semeado por SQL no banco da stack (o mesmo par evento + destinatário que
 * o job de importação grava), e o texto é lido do sino pelo caminho real — `GET /api/admin/notifications` → `notificationTypeRegistry`
 * → i18n → `NotificationCard`. Abre o sino e clica no cartão COMO HUMANO (click, sem `evaluate`).
 *
 *  feliz pt-BR / es — host vê "não conseguimos trazer a transcrição…" no idioma da tela; o cartão INTEIRO é o link: o clique leva ao Perfil (seção Tactiq).
 *  alt 1            — supervisor (`will_be_lost`) vê a versão com o NOME de quem fez a reunião; sem nome, "a pessoa responsável".
 *  alt 2            — lembrete e expirou (host), e o enquadre / conta errada.
 * Em cada um: o texto da TELA não tem termo técnico (mesma lista do CA-11) nem nome/dado de paciente (o aviso não tem paciente).
 *
 * ⚠️ Mesma stack do `admissao-050-sino-extension-tactiq` (engine ABAC ligado, staff REAL em grupo): o nome entra no `--grep` do job
 * `integration-e2e-group-simulation` do `_frontend-integration.yml` pelo token `admissao-083` — o token PRECISA estar lá (conjunto fechado).
 * Dados SINTÉTICOS: o nome do host é inventado, sem e-mail de pessoa, sem paciente. Datas fixas (17:00Z = 14:00 em Buenos Aires).
 */
import { test, expect, type Page } from '@playwright/test';
import {
  psql, scalar, safeSql, seedStaffInGroup, cleanupStaffAndGroup, grantCell, loginAs, ABAC_TENANT,
} from '../helpers/abac-stack-helper';

const RUN_ID = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
const UID = `e2e-083x-operadora-${RUN_ID}`;
const OPERADORA = { uid: UID, email: `${UID}@e2e.test`, role: 'recruiter', country: 'AR' };
const ATOR = `system-admission-083-${RUN_ID}`;
const HOST_SINTETICO = 'Marina Quintana';

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

test.describe('admissao-083 — sino: aviso de transcrição que não chegou por falta do Tactiq (spec 083 F4) @integration', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(120_000);

  test.beforeAll(() => {
    groupId = seedStaffInGroup({ uid: UID, email: OPERADORA.email, groupName: `Adm083X Operadora ${RUN_ID}`, country: 'AR' }).groupId;
    grantCell(groupId, 'own_notifications', 'read');
    grantCell(groupId, 'own_notifications', 'update');
    grantCell(groupId, 'own_tactiq_link', 'read'); // a seção Tactiq do Perfil, destino do clique
    grantCell(groupId, 'own_tactiq_link', 'create');
  });

  test.afterAll(() => {
    safeSql(`DELETE FROM notifications WHERE recipient_uid = '${UID}'`);
    safeSql(`DELETE FROM notification_events WHERE actor_uid = '${ATOR}'`);
    cleanupStaffAndGroup(UID, groupId);
    safeSql(`DELETE FROM iam.permission_groups WHERE tenant_id = '${ABAC_TENANT}' AND name LIKE 'Adm083X % ${RUN_ID}'`);
  });

  test('feliz pt-BR: host vê "Não conseguimos trazer a transcrição…" em português e o cartão leva ao Tactiq do Perfil', async ({ page }, testInfo) => {
    const id = semearAviso({ stage: 'blocked', kind: 'admission', reason: 'no_link', audience: 'host' });
    expect(psql(`SELECT payload->>'stage' FROM notification_events e JOIN notifications n ON n.event_id = e.id WHERE n.id = '${id}'`).trim()).toBe('blocked');

    const item = await abrirSinoNoItem(page, id, 'pt-BR');
    await expect(item.getByTestId(`notification-excerpt-${id}`)).toContainText(
      'Não conseguimos trazer a transcrição da sua reunião de admissão de 4 de nov. às 14:00, porque a sua conta do Tactiq não está conectada.',
    );
    await expect(item.getByTestId(`notification-patient-${id}`)).toHaveText('Vincular Tactiq');
    await expect(item).toContainText('Você tem até 6 de nov. às 14:00');
    await expectLinguagemDePessoa(item);
    await page.screenshot({ path: testInfo.outputPath('1-feliz-pt.png'), fullPage: true });
    await expectCartaoLevaAoTactiq(page, item);
  });

  test('feliz es: o mesmo aviso em espanhol (voseo), com a data no fuso de Buenos Aires', async ({ page }, testInfo) => {
    const id = semearAviso({ stage: 'blocked', kind: 'admission', reason: 'wrong_account', audience: 'host' });
    const item = await abrirSinoNoItem(page, id, 'es');
    await expect(item.getByTestId(`notification-excerpt-${id}`)).toContainText(
      'No pudimos traer la transcripción de tu reunión de admisión del 4 de nov. a las 14:00, porque la cuenta de Tactiq conectada no es la tuya.',
    );
    await expect(item.getByTestId(`notification-patient-${id}`)).toHaveText('Vincular Tactiq');
    await expectLinguagemDePessoa(item);
    await page.screenshot({ path: testInfo.outputPath('2-feliz-es.png'), fullPage: true });
    await expectCartaoLevaAoTactiq(page, item);
  });

  test('alt 1: supervisor vê a versão com o NOME de quem fez a reunião (e "a pessoa responsável" quando o nome não vem)', async ({ page }, testInfo) => {
    const comNome = semearAviso({ stage: 'will_be_lost', kind: 'admission', reason: 'no_link', audience: 'supervisor', hostName: HOST_SINTETICO });
    const semNome = semearAviso({ stage: 'will_be_lost', kind: 'enquadre', reason: 'wrong_account', audience: 'supervisor' });

    const itemComNome = await abrirSinoNoItem(page, comNome, 'pt-BR');
    await expect(itemComNome.getByTestId(`notification-excerpt-${comNome}`)).toContainText(
      `A gravação e a transcrição da reunião de admissão de ${HOST_SINTETICO} de 4 de nov. às 14:00 ainda não chegaram, porque a conta do Tactiq de ${HOST_SINTETICO} não está conectada.`,
    );
    await expectLinguagemDePessoa(itemComNome);

    const itemSemNome = page.getByTestId('notification-panel').getByTestId(`notification-item-${semNome}`);
    await expect(itemSemNome).toBeVisible();
    await expect(itemSemNome).toContainText('a pessoa responsável');
    await expect(itemSemNome).not.toContainText(HOST_SINTETICO);
    await expectLinguagemDePessoa(itemSemNome);
    await page.screenshot({ path: testInfo.outputPath('3-alt1-supervisor.png'), fullPage: true });
    await expectCartaoLevaAoTactiq(page, itemComNome);
  });

  test('alt 2: lembrete e expirou (host) têm texto PRÓPRIO, sem "avise a coordenação", e o cartão leva ao Tactiq', async ({ page }, testInfo) => {
    const lembrete = semearAviso({ stage: 'reminder', kind: 'enquadre', reason: 'no_link', audience: 'host' });
    const expirou = semearAviso({ stage: 'expired', kind: 'admission', reason: 'no_link', audience: 'host' });

    const itemLembrete = await abrirSinoNoItem(page, lembrete, 'es');
    await expect(itemLembrete.getByTestId(`notification-excerpt-${lembrete}`)).toContainText('Recordatorio: todavía no pudimos traer la transcripción de tu entrevista de encuadre');
    await expectLinguagemDePessoa(itemLembrete);

    const itemExpirou = page.getByTestId('notification-panel').getByTestId(`notification-item-${expirou}`);
    await expect(itemExpirou).toBeVisible();
    await expect(itemExpirou.getByTestId(`notification-excerpt-${expirou}`)).toContainText('Se pasó el plazo y no pudimos traer la transcripción');
    await expect(itemExpirou).not.toContainText(/coordinaci[oó]n/i);
    await expectLinguagemDePessoa(itemExpirou);
    await page.screenshot({ path: testInfo.outputPath('4-alt2-lembrete-expirou.png'), fullPage: true });
    await expectCartaoLevaAoTactiq(page, itemExpirou);
  });
});
