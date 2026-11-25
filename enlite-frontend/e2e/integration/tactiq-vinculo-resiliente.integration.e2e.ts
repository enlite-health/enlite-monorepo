/**
 * tactiq-vinculo-resiliente.integration.e2e.ts @integration — change `tactiq-vinculo-resiliente` F6 (T602): as telas da change lidas COMO HUMANO.
 *
 * E2E DE TELA, sem interceptar rota e sem mock de dado: frontend + API + Postgres reais, engine ABAC LIGADO, staff REAL em grupo (células por
 * SQL). Todo dado é semeado por SQL no banco da stack — a trilha (`admission_events`, só-acréscimo), `tactiq_links`, o par evento+destinatário
 * do sino (`notification_events` + `notifications`) e `interview_hosts` — e lido pelo caminho real (API → registry → i18n → tela). Interação
 * por clique/teclado (`loginAs`) e texto LIDO da tela; os textos esperados vêm do `es.json` REAL (lido do disco, nunca copiado aqui).
 * Nenhum canal real: o OAuth do Tactiq não é tocado (nada aqui chega a `POST /me/tactiq-link`).
 *
 *  Perfil (D13/D14) — feliz `seatAuto` (a queda por assento volta sozinha); alt `seatWait` (não volta sozinha: escopo sem detalhes) e alt
 *                     `seatAskAdmin` (ninguém avisou o administrador). Em nenhum a orientação manda "vincular" e a ajuda de `broken` some.
 *  Sino (D11/D14)   — feliz `not_recorded` (host); alt `seat_missing` ao host; alt `seat_missing` ao Master, com o NOME de quem está sem licença.
 *  Entrevistadores (F5, D16) — o Master marca "Licencia asignada" na linha do host: o perfil do host passa de SEM botão
 *                     (`seatNotDeclared`) a COM botão "Vincular Tactiq".
 *
 * ⚠️ Precisa do engine ABAC LIGADO e do `abac-stack-helper`: o título do describe carrega `admissao-083`, que já está no `--grep` do job
 * `integration-e2e-group-simulation` do `_frontend-integration.yml` (o grep casa também com o título; o `pr-gate.yml` roda com o engine OFF).
 * Eventos `tactiq_link.*` NUNCA se apagam (trigger append-only, migration 504): o e-mail com RUN_ID isola cada rodada.
 * Dados SINTÉTICOS (@e2e.test / @example.test), sem paciente. Datas fixas (17:00Z = 14:00 em Buenos Aires).
 * Escrito sem rodar local (a stack de integração é do CI); quem prova que PASSA é o CI.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test, expect, type Page, type Locator } from '@playwright/test';
import {
  psql, scalar, safeSql, seedStaffInGroup, cleanupStaffAndGroup, grantCell, loginAs, ABAC_TENANT, type MockUser,
} from '../helpers/abac-stack-helper';
import { seedInterviewHost, cleanupInterviewHosts } from '../helpers/interview-host-seed';

/** O `es.json` REAL (a fonte dos textos): lido do disco, só as chaves que este arquivo usa. */
interface EsTexts {
  admin: {
    tactiqLink: Record<'seatAuto' | 'seatWait' | 'seatAskAdmin' | 'seatNotDeclared' | 'signInHint' | 'link', string>;
    notifications: {
      tactiq: Record<'seatAuto' | 'masterSeat' | 'masterSeatAuto', string>;
      importBlocked: { notRecorded: { title: string; body: string } };
    };
    interviewHosts: { title: string; seatLabel: string };
  };
}
const ES = (JSON.parse(readFileSync(fileURLToPath(new URL('../../src/infrastructure/i18n/locales/es.json', import.meta.url)), 'utf8')) as EsTexts).admin;

const RUN_ID = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
const ATOR = `system-tactiq-resiliente-${RUN_ID}`;
const PERFIL = /\/admin\/mi-cuenta\/?$/;
const MEETING_AT = '2026-11-04T17:00:00.000Z'; // 14:00 em Buenos Aires
const DEADLINE_AT = '2026-11-06T17:00:00.000Z';
const HOST_SINTETICO = 'Marina Quintana';

const mk = (nome: string): MockUser => {
  const uid = `e2e-tvr-${nome}-${RUN_ID}`;
  return { uid, email: `${uid}@e2e.test`, role: 'recruiter', country: 'AR' };
};
const auto = mk('auto');
const espera = mk('espera');
const pedeAdmin = mk('pedeadmin');
const operadora = mk('operadora'); // sino + Master de Entrevistadores
const hostF5 = mk('hostf5');
const todos = [auto, espera, pedeAdmin, operadora, hostF5];
const HOST_F5_NOME = `Host Licencia ${RUN_ID}`;

const grupos: Record<string, string> = {};
let hostF5RowId = '';

// ── semeadura (SQL) ────────────────────────────────────────────────────────────────────────────────

/** Vínculo caído por falta de assento, como o `completeLink` o deixa: linha `broken` + evento `broken` `access_action:request_seat`. */
function semearQuedaPorAssento(u: MockUser, opts: { scope?: string; administradorAvisado: boolean }): void {
  psql(`INSERT INTO tactiq_links (host_email, firebase_uid, status, last_check_outcome)
        VALUES ('${u.email}', '${u.uid}', 'broken', 'unauthorized')`);
  const ref = JSON.stringify({ source: 'link', ...(opts.scope ? { scope: opts.scope } : {}) });
  psql(`INSERT INTO admission_events (host_email, kind, reason, ref, at)
        VALUES ('${u.email}', 'tactiq_link.broken', 'access_action:request_seat', '${ref}'::jsonb, now() - interval '2 hours')`);
  if (opts.administradorAvisado) {
    psql(`INSERT INTO admission_events (host_email, kind, outcome, reason, ref, at)
          VALUES ('${u.email}', 'tactiq_link.notified', 'sent', 'seat_missing_master', '{"source":"link","recipients":1}'::jsonb, now() - interval '1 hour')`);
  }
}

function semearAviso(typeCode: 'ADMISSION_IMPORT_BLOCKED' | 'ADMISSION_TACTIQ_LINK_REQUIRED', payload: Record<string, unknown>): string {
  const eventId = scalar(
    `INSERT INTO notification_events (type_code, actor_uid, payload)
     VALUES ('${typeCode}', '${ATOR}', '${JSON.stringify(payload)}'::jsonb) RETURNING id`,
  );
  return scalar(`INSERT INTO notifications (event_id, recipient_uid) VALUES ('${eventId}', '${operadora.uid}') RETURNING id`);
}

// ── leitura da tela ────────────────────────────────────────────────────────────────────────────────

/** Entra como humano e abre o Perfil pelo rodapé da sidebar. */
async function abrirPerfil(page: Page, u: MockUser): Promise<void> {
  await loginAs(page, u);
  await page.getByTestId('sidebar-profile-link').click();
  await expect(page).toHaveURL(PERFIL);
  await expect(page.getByTestId('tactiq-link-card')).toBeVisible({ timeout: 30_000 });
}

/** Perfil com negativa de assento: a caixa diz SÓ o texto esperado, nunca manda "vincular" e a ajuda genérica de `broken` não aparece. */
async function expectOrientacaoDeAssento(page: Page, esperado: string, outras: string[]): Promise<void> {
  const caixa = page.getByTestId('tactiq-access-denial');
  await expect(caixa).toBeVisible({ timeout: 30_000 });
  await expect(caixa).toContainText(esperado);
  const texto = (await caixa.innerText()).replace(/\s+/g, ' ');
  expect(texto.length).toBeGreaterThan(40); // controle positivo: leu o texto de verdade
  expect(texto, 'a orientação de assento não manda vincular').not.toMatch(/vincular/i);
  for (const outra of outras) await expect(caixa).not.toContainText(outra);
  await expect(page.getByTestId('tactiq-state-help')).toHaveCount(0); // "Volvé a vincularlo" contradiz a orientação
  await expect(page.locator('body')).not.toContainText('request_seat');
  await expect(page.locator('body')).not.toContainText('access_action');
}

/** Entra, abre o sino como humano e devolve o item da notificação semeada. */
async function abrirSinoNoItem(page: Page, notificationId: string): Promise<Locator> {
  await loginAs(page, operadora);
  const sino = page.getByTestId('notification-bell-btn');
  await expect(sino).toBeVisible({ timeout: 15_000 });
  await sino.click();
  const painel = page.getByTestId('notification-panel');
  await expect(painel).toHaveClass(/translate-x-0/);
  const item = painel.getByTestId(`notification-item-${notificationId}`);
  await expect(item).toBeVisible({ timeout: 15_000 });
  return item;
}

/** O corpo do `es.json` tem `{{marcadores}}`: o texto na tela tem de conter cada pedaço fixo entre eles, na ordem em que o JSON os escreve. */
function pedacosFixos(modelo: string): string[] {
  return modelo.split(/\{\{[^}]+\}\}/).map((p) => p.trim()).filter((p) => p.length > 0);
}

test.describe('admissao-083 — tactiq-vinculo-resiliente: perfil, sino e Entrevistadores lidos da tela @integration', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(120_000);

  test.beforeAll(() => {
    for (const u of todos) {
      grupos[u.uid] = seedStaffInGroup({ uid: u.uid, email: u.email, groupName: `TactiqRes ${u.uid}`, country: 'AR' }).groupId;
      grantCell(grupos[u.uid], 'own_tactiq_link', 'read');
      grantCell(grupos[u.uid], 'own_tactiq_link', 'create');
    }
    grantCell(grupos[operadora.uid], 'own_notifications', 'read');
    grantCell(grupos[operadora.uid], 'own_notifications', 'update');
    grantCell(grupos[operadora.uid], 'interview_host', 'read');
    grantCell(grupos[operadora.uid], 'interview_host', 'update');

    // Perfil: três quedas por assento que só diferem no que decide a chave (D13).
    semearQuedaPorAssento(auto, { administradorAvisado: true }); // sem escopo gravado = "não apurado" → volta sozinha
    semearQuedaPorAssento(espera, { scope: 'mcp:meetings', administradorAvisado: true }); // escopo congelado SEM detalhes → não volta sozinha
    semearQuedaPorAssento(pedeAdmin, { administradorAvisado: false }); // ninguém avisou o administrador

    // Entrevistadores: o usuário do host já existe (staff acima); `seedInterviewHost` reaproveita o uid dele (ON CONFLICT por e-mail).
    hostF5RowId = seedInterviewHost({ email: hostF5.email, displayName: HOST_F5_NOME });
  });

  test.afterAll(() => {
    const uids = todos.map((u) => `'${u.uid}'`).join(',');
    safeSql(`DELETE FROM notifications WHERE recipient_uid IN (${uids})`);
    safeSql(`DELETE FROM notification_events WHERE actor_uid = '${ATOR}'`);
    safeSql(`DELETE FROM tactiq_links WHERE lower(host_email) IN (${todos.map((u) => `'${u.email}'`).join(',')})`);
    cleanupInterviewHosts([hostF5.email]);
    for (const u of todos) cleanupStaffAndGroup(u.uid, grupos[u.uid]);
    safeSql(`DELETE FROM iam.permission_groups WHERE tenant_id = '${ABAC_TENANT}' AND name LIKE 'TactiqRes %${RUN_ID}'`);
  });

  // ── Perfil ─────────────────────────────────────────────────────────────────────────────────────
  test('perfil feliz: queda por assento, administrador avisado e volta sozinha → "seatAuto", sem mandar vincular', async ({ page }, testInfo) => {
    await abrirPerfil(page, auto);
    await expectOrientacaoDeAssento(page, ES.tactiqLink.seatAuto, [ES.tactiqLink.seatWait, ES.tactiqLink.seatAskAdmin]);
    await page.screenshot({ path: testInfo.outputPath('1-perfil-seat-auto.png'), fullPage: true });
    await page.reload(); // o texto vem do estado salvo, não da URL
    await expect(page.getByTestId('tactiq-access-denial')).toContainText(ES.tactiqLink.seatAuto, { timeout: 30_000 });
  });

  test('perfil alt 1: não volta sozinha (escopo sem detalhes) → "seatWait"', async ({ page }, testInfo) => {
    await abrirPerfil(page, espera);
    await expectOrientacaoDeAssento(page, ES.tactiqLink.seatWait, [ES.tactiqLink.seatAuto, ES.tactiqLink.seatAskAdmin]);
    await page.screenshot({ path: testInfo.outputPath('2-perfil-seat-wait.png'), fullPage: true });
  });

  test('perfil alt 2: ninguém avisou o administrador → "seatAskAdmin" (pede a um administrador do Tactiq)', async ({ page }, testInfo) => {
    await abrirPerfil(page, pedeAdmin);
    await expectOrientacaoDeAssento(page, ES.tactiqLink.seatAskAdmin, [ES.tactiqLink.seatAuto, ES.tactiqLink.seatWait]);
    await page.screenshot({ path: testInfo.outputPath('3-perfil-seat-ask-admin.png'), fullPage: true });
  });

  // ── Sino ───────────────────────────────────────────────────────────────────────────────────────
  test('sino feliz: reunião que não foi gravada (not_recorded) → título e corpo próprios, e o cartão leva ao Perfil', async ({ page }, testInfo) => {
    const id = semearAviso('ADMISSION_IMPORT_BLOCKED', {
      meetingAt: MEETING_AT, deadlineAt: DEADLINE_AT, stage: 'expired', kind: 'admission', reason: 'not_recorded', audience: 'host',
    });
    const item = await abrirSinoNoItem(page, id);
    // O cartão não renderiza o título: ele vai só no `aria-label` ("título. corpo", `notificationTypeRegistry.buildText`).
    const tituloEscapado = ES.notifications.importBlocked.notRecorded.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    await expect(item).toHaveAttribute('aria-label', new RegExp(`^${tituloEscapado}\\.`));
    const corpo = item.getByTestId(`notification-excerpt-${id}`);
    const pedacos = pedacosFixos(ES.notifications.importBlocked.notRecorded.body);
    expect(pedacos.length).toBeGreaterThan(1); // controle positivo: o modelo do JSON foi lido
    for (const pedaco of pedacos) await expect(corpo).toContainText(pedaco);
    await expect(item).not.toContainText(/hasta el 6 de nov|porque tu cuenta/); // sem prazo, sem "motivo"
    await page.screenshot({ path: testInfo.outputPath('4-sino-not-recorded.png'), fullPage: true });
    await item.click();
    await expect(page).toHaveURL(PERFIL);
    await expect(page.getByTestId('tactiq-link-card')).toBeVisible({ timeout: 15_000 });
  });

  test('sino alt 1: seat_missing ao host (administrador avisado, volta sozinho) → "seatAuto", sem mandar vincular', async ({ page }, testInfo) => {
    const id = semearAviso('ADMISSION_TACTIQ_LINK_REQUIRED', { reason: 'seat_missing', audience: 'host', adminNotified: true, autoReactivates: true });
    const item = await abrirSinoNoItem(page, id);
    const corpo = item.getByTestId(`notification-excerpt-${id}`);
    await expect(corpo).toContainText(ES.notifications.tactiq.seatAuto);
    expect((await corpo.innerText()).replace(/\s+/g, ' '), 'o aviso de assento não manda vincular').not.toMatch(/vincular/i);
    await page.screenshot({ path: testInfo.outputPath('5-sino-seat-missing-host.png'), fullPage: true });
    await item.click();
    await expect(page).toHaveURL(PERFIL);
  });

  test('sino alt 2: seat_missing ao Master → o NOME de quem está sem licença + "o vínculo se ativa solo"', async ({ page }, testInfo) => {
    const id = semearAviso('ADMISSION_TACTIQ_LINK_REQUIRED', {
      reason: 'seat_missing', audience: 'master', hostName: HOST_SINTETICO, autoReactivates: true,
    });
    const item = await abrirSinoNoItem(page, id);
    const corpo = item.getByTestId(`notification-excerpt-${id}`);
    await expect(corpo).toContainText(ES.notifications.tactiq.masterSeat.replace('{{host}}', HOST_SINTETICO));
    await expect(corpo).toContainText(ES.notifications.tactiq.masterSeatAuto.replace('{{host}}', HOST_SINTETICO).trim());
    await expect(corpo).toContainText(HOST_SINTETICO);
    await page.screenshot({ path: testInfo.outputPath('6-sino-seat-missing-master.png'), fullPage: true });
  });

  // ── Entrevistadores (F5) ───────────────────────────────────────────────────────────────────────
  test('entrevistadores (F5): o Master marca "Licencia asignada" na linha do host → o perfil do host passa de SEM botão a COM botão', async ({ page, browser }, testInfo) => {
    // 1) Antes: o host nunca teve vínculo e a licença não está declarada → sem botão, com o porquê.
    await abrirPerfil(page, hostF5);
    const semBotao = page.getByTestId('tactiq-seat-not-declared');
    await expect(semBotao).toBeVisible({ timeout: 30_000 });
    await expect(semBotao).toContainText(ES.tactiqLink.seatNotDeclared);
    await expect(page.getByTestId('tactiq-link-button')).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath('7-host-sem-botao.png'), fullPage: true });

    // 2) O Master (outro navegador) abre Entrevistadores e marca a licença na linha do host, com o mouse.
    const baseURL = testInfo.project.use.baseURL;
    const contextoMaster = await browser.newContext({ baseURL });
    try {
      const master = await contextoMaster.newPage();
      await loginAs(master, operadora);
      await master.goto('/admin/entrevistadores');
      await expect(master.getByRole('heading', { name: ES.interviewHosts.title })).toBeVisible({ timeout: 30_000 });
      const linha = master.getByRole('row').filter({ hasText: hostF5.email });
      await expect(linha).toBeVisible({ timeout: 15_000 });
      const caixa = linha.getByRole('checkbox', { name: ES.interviewHosts.seatLabel.replace('{{name}}', HOST_F5_NOME) });
      await expect(caixa).not.toBeChecked(); // controle: a licença começa NÃO declarada
      await caixa.click();
      await expect(caixa).toBeChecked({ timeout: 15_000 });
      await master.screenshot({ path: testInfo.outputPath('8-master-marca-licenca.png'), fullPage: true });

      // O banco concorda: o evento mais novo da trilha é a declaração (o dono da regra é a trilha, não uma coluna).
      await expect.poll(
        () => psql(`SELECT kind FROM admission_events WHERE lower(host_email) = '${hostF5.email}' AND kind IN ('tactiq_link.seat_declared','tactiq_link.seat_undeclared') ORDER BY at DESC, id DESC LIMIT 1`).trim(),
        { timeout: 15_000 },
      ).toBe('tactiq_link.seat_declared');
      expect(hostF5RowId).not.toBe(''); // a linha do `interview_hosts` que o Master marcou é a semeada
      await master.reload(); // a marcação vem do estado salvo, não do clique
      await expect(master.getByRole('row').filter({ hasText: hostF5.email }).getByRole('checkbox', { name: ES.interviewHosts.seatLabel.replace('{{name}}', HOST_F5_NOME) })).toBeChecked({ timeout: 30_000 });
    } finally {
      await contextoMaster.close();
    }

    // 3) Depois: o MESMO host, recarregando o Perfil, agora tem o botão (e a dica de entrar com o e-mail certo) e perde o aviso de "sem licença".
    await page.reload();
    const botao = page.getByTestId('tactiq-link-button');
    await expect(botao).toBeVisible({ timeout: 30_000 });
    await expect(botao).toHaveText(ES.tactiqLink.link);
    await expect(page.getByTestId('tactiq-signin-hint')).toHaveText(ES.tactiqLink.signInHint);
    await expect(page.getByTestId('tactiq-seat-not-declared')).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath('9-host-com-botao.png'), fullPage: true });
  });
});
