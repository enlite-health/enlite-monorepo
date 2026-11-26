/**
 * talentum-webhook-095.integration.e2e.ts @integration — spec 095 (T-095-43), o e2e de TELA exigido pelo gate `revisao-pr` (modo fecho, bloqueio 1, D354).
 *
 * Sem `page.route` de DADO: a API e o banco são os reais da stack do CI (o único `page.route` é o do login, que só troca o Authorization e
 * deixa a REQUEST e a RESPOSTA reais seguirem — `installAuthInterceptors`). Interação humana: o sino abre pelo clique, o cartão é clicado, o
 * seletor de motivo abre pelo clique e as opções são lidas da tela.
 *
 * A) Etiqueta "Talentum expirado" no Kanban da vaga
 *    feliz — o evento de expiração chega pelo webhook REAL (ack + drena a inbox, `sendTalentumWebhook`): o card vai a Rejeitados e a tela
 *            mostra a etiqueta "Talentum expirado" (texto lido do card).
 *    alt 1 — depois da expiração, um ANALYZED/QUALIFIED automático: o card SAI de Rejeitados e a etiqueta some (decisão 8 da spec, a mesma regra do #821).
 *    alt 2 — o seletor humano de motivo de rejeição ("Rechazar") NÃO oferece "Talentum expirado" (motivo só do sistema); controle positivo: oferece "Distancia".
 *
 * B) Sino do aviso TALENTUM_WEBHOOK_ALARM
 *    feliz — o aviso nasce do CICLO REAL: uma linha da inbox FAILED semeada por SQL + `GET /api/internal/events/health` (a rota real, com o
 *            `X-Internal-Secret` do stack) → o notificador publica para quem tem `talentum:update` (grupo PRÓPRIO do teste, nunca grupo da
 *            operação). Abre o sino: autor "Enlite", contexto "Webhook de Talentum" e a frase "Webhook de Talentum: N eventos con error".
 *    alt 1 — alarme `silencio`: a frase NÃO tem quantidade ("…: sin eventos en 6 h"), em pt-BR.
 *            ⚠️ Semeado por SQL (declarado): `silencio` só abre dentro do horário comercial AR com a inbox vazia nas últimas 6 h, e o relógio
 *            do ciclo é o real — não dá para provocá-lo pela borda de forma determinística. É dado no banco, não mock de tela.
 *    alt 2 — alarme DESCONHECIDO (semeado por SQL; o builder do backend o recusaria): a API descarta o payload inválido (payload null) e o front
 *            cai no rótulo genérico com quantidade 1; a tela não quebra; o cartão não leva a lugar nenhum (sem deep link) e o clique o marca como lido.
 *
 * ⚠️ Login pelo mock do CI (`loginAsKanbanAdmin`), engine ABAC OFF — job padrão. O nome entra no `--grep` do `pr-gate.yml` pelo token
 * `talentum-webhook-095` (conjunto fechado: spec fora da lista nunca roda). Nada toca canal real (sem e-mail/WhatsApp; Pub/Sub é mock em NODE_ENV=test).
 * Só dado SINTÉTICO; nenhum PII em log.
 */
import { test, expect, type Page } from '@playwright/test';
import { insertTestWorker, insertTestPatient, insertBaseVacancy, cleanupTestWorker, cleanupTestPatient } from '../helpers/db-test-helper';
import { insertAptoWorker, cleanupEligibilityWorkerChildren } from '../helpers/eligibility-worker-helper';
import {
  sendTalentumWebhook,
  loginAsKanbanAdmin,
  openKanban,
  waitForCardInStage,
  getEncuadreId,
  BACKEND_URL,
  MOCK_ADMIN,
  type TalentumWebhookOpts,
} from '../helpers/talentumWebhookHelper';
import { runSQL } from '../helpers/patient-detail-a-helper';

const RUN = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
const TENANT = '00000000-0000-0000-0000-000000000001';
const SECRET = (): string => process.env.INTERNAL_TOKEN_SECRET ?? 'test-secret-for-e2e-only';
const rand = (): string => String(Math.floor(Math.random() * 9_000_000) + 1_000_000);

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// A) Etiqueta "Talentum expirado"
// ═════════════════════════════════════════════════════════════════════════════════════════════════
test.describe('talentum-webhook-095 — Kanban: etiqueta "Talentum expirado" @integration', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(120_000);
  test.use({ viewport: { width: 1920, height: 1080 } });

  let patientId = '';
  let vacancyId = '';
  let vacancyTitle = '';
  let aptoWorkerId = '';
  let plainWorkerId = '';
  let apto: { email: string; phone: string; profileId: string; prescreeningId: string };
  let plain: { email: string; phone: string; profileId: string; prescreeningId: string };

  const opts = (who: typeof apto, subtype: TalentumWebhookOpts['subtype'], extra: Partial<TalentumWebhookOpts> = {}): TalentumWebhookOpts => ({
    prescreeningId: who.prescreeningId,
    prescreeningName: vacancyTitle,
    profileId: who.profileId,
    profileEmail: who.email,
    profilePhone: who.phone,
    profileFirstName: 'Worker',
    profileLastName: 'Talentum095',
    subtype,
    ...extra,
  });

  test.beforeAll(() => {
    const aptoRow = insertAptoWorker({ docs: 'validated' }); // QUALIFIED só vira "Completado" para prestador APTO (spec 067)
    aptoWorkerId = aptoRow.workerId;
    apto = { email: aptoRow.email, phone: aptoRow.phone!, profileId: `prof-095a-${RUN}`, prescreeningId: `e2e-095a-${RUN}` };

    const plainPhone = `+549122${rand()}`;
    plainWorkerId = insertTestWorker({ firstName: 'Worker', lastName: 'Plain095', phone: plainPhone });
    plain = { email: `e2e-095p-${RUN}@test.com`, phone: plainPhone, profileId: `prof-095p-${RUN}`, prescreeningId: `e2e-095p-${RUN}` };

    const caseNumber = 970_000 + Math.floor(Math.random() * 9_999);
    const { patientId: pid, addressId } = insertTestPatient({ withAddress: true });
    patientId = pid;
    vacancyTitle = `CASO ${caseNumber}-base`;
    vacancyId = insertBaseVacancy({ patientId, patientAddressId: addressId!, caseNumber, status: 'SEARCHING', isDraft: false });
  });

  test.afterAll(() => {
    for (const k of [apto, plain]) {
      if (!k) continue;
      runSQL(`DELETE FROM talentum_webhook_inbox WHERE talentum_prescreening_id = '${k.prescreeningId}'`);
    }
    for (const wid of [aptoWorkerId, plainWorkerId]) {
      if (!wid) continue;
      cleanupEligibilityWorkerChildren(wid);
      cleanupTestWorker(wid);
    }
    if (patientId) cleanupTestPatient(patientId);
  });

  test('feliz: o webhook de expiração do Talentum leva o card a Rejeitados com a etiqueta "Talentum expirado"', async ({ page, request }) => {
    await loginAsKanbanAdmin(page);
    expect(await sendTalentumWebhook(request, opts(apto, 'INITIATED'))).toBe(200);
    expect(await sendTalentumWebhook(request, opts(apto, 'COMPLETED'))).toBe(200);
    expect(await sendTalentumWebhook(request, opts(apto, 'EXPIRED'))).toBe(200);

    const cardId = await getEncuadreId(request, aptoWorkerId, vacancyId);
    expect(cardId, 'a candidatura existe (id "unknown" = o webhook não criou o card)').not.toBe('unknown');
    await waitForCardInStage(page, vacancyId, `kanban-card-${cardId}`, 'REJECTED');

    await expect(page.getByTestId('kanban-column-REJECTED-count')).toHaveText('1');
    const card = page.locator(`[data-testid="kanban-card-${cardId}"][data-stage]`).first();
    const etiqueta = card.getByTestId('rejection-badge');
    await expect(etiqueta).toBeVisible();
    await expect(etiqueta).toHaveText('Talentum expirado'); // lido da tela, não da chave i18n (a chave crua seria "admin.kanban.rejectionLabels…")
  });

  test('alt 1: depois da expiração, um veredito QUALIFIED automático tira o card de Rejeitados e a etiqueta some', async ({ page, request }) => {
    await loginAsKanbanAdmin(page);
    expect(await sendTalentumWebhook(request, opts(apto, 'ANALYZED', { statusLabel: 'QUALIFIED', score: 85 }))).toBe(200);

    const cardId = await getEncuadreId(request, aptoWorkerId, vacancyId);
    await waitForCardInStage(page, vacancyId, `kanban-card-${cardId}`, 'COMPLETED');

    await expect(page.getByTestId('kanban-column-COMPLETED-count')).toHaveText('1');
    await expect(page.getByTestId('kanban-column-REJECTED-count')).toHaveText('0');
    const card = page.locator(`[data-testid="kanban-card-${cardId}"][data-stage]`).first();
    await expect(card.getByTestId('talentum-badge')).toBeVisible(); // controle positivo: o card é o MESMO e o veredito chegou
    await expect(card.getByTestId('rejection-badge')).toHaveCount(0);
  });

  test('alt 2: o seletor humano de motivo ("Rechazar") não oferece "Talentum expirado"', async ({ page, request }) => {
    await loginAsKanbanAdmin(page);
    expect(await sendTalentumWebhook(request, opts(plain, 'INITIATED'))).toBe(200);
    const cardId = await getEncuadreId(request, plainWorkerId, vacancyId);
    expect(cardId).not.toBe('unknown');
    await waitForCardInStage(page, vacancyId, `kanban-card-${cardId}`, 'PRE_SCREENING');

    const card = page.locator(`[data-testid="kanban-card-${cardId}"][data-stage]`).first();
    await card.getByTestId('reject-button').click();
    const modal = page.getByTestId('rejection-modal');
    await expect(modal).toBeVisible();

    await expect(modal.getByTestId('rejection-option-distance')).toBeVisible(); // controle positivo: a lista carregou
    const opcoes = await modal.locator('[data-testid^="rejection-option-"]').count();
    expect(opcoes, 'contagem 0 = não olhei a lista').toBeGreaterThan(3);
    await expect(modal.getByTestId('rejection-option-talentum-expired')).toHaveCount(0);
    await expect(modal).not.toContainText('Talentum expirado');

    await page.getByTestId('rejection-cancel').click(); // cancelar: o card não se move
    await expect(modal).toHaveCount(0);
    await expect(card).toHaveAttribute('data-stage', 'PRE_SCREENING');
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// B) Sino do aviso TALENTUM_WEBHOOK_ALARM
// ═════════════════════════════════════════════════════════════════════════════════════════════════
test.describe('talentum-webhook-095 — sino: aviso TALENTUM_WEBHOOK_ALARM @integration', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(120_000);

  const GROUP_NAME = `E2E Talentum sino 095 ${RUN}`;
  const ACTOR = 'system:talentum-webhook';
  const UID = MOCK_ADMIN.uid;
  const seededInbox: string[] = [];
  let groupId = '';

  /** Primeira linha de dado (o psql imprime também a tag `INSERT 0 1` depois do RETURNING). */
  const sqlOne = (sql: string): string => runSQL(sql).split('\n')[0].trim();

  /** Notificações do ator logado, por tipo — fonte da verdade para localizar o item na tela. */
  const alarmNotificationIds = (): string[] =>
    runSQL(
      `SELECT n.id FROM notifications n JOIN notification_events e ON e.id = n.event_id ` +
        `WHERE n.recipient_uid = '${UID}' AND e.type_code = 'TALENTUM_WEBHOOK_ALARM' ORDER BY n.created_at DESC, n.id`,
    )
      .split('\n')
      .map((s) => s.trim())
      .filter((l) => /^[0-9a-f-]{36}$/.test(l));

  const limpaAvisos = (): void => {
    runSQL(`DELETE FROM notifications WHERE recipient_uid = '${UID}' AND event_id IN (SELECT id FROM notification_events WHERE type_code = 'TALENTUM_WEBHOOK_ALARM')`);
    runSQL(
      `DELETE FROM notification_events e WHERE e.type_code = 'TALENTUM_WEBHOOK_ALARM' AND e.actor_uid = '${ACTOR}' ` +
        `AND NOT EXISTS (SELECT 1 FROM notifications n WHERE n.event_id = e.id)`,
    );
    runSQL(`DELETE FROM talentum_webhook_alarm_state`);
  };

  /** Aviso semeado por SQL (silencio / alarme desconhecido): o mesmo par evento + destinatário que o publicador grava. */
  const semearAviso = (payload: Record<string, unknown>): string => {
    const eventId = sqlOne(
      `INSERT INTO notification_events (type_code, actor_uid, payload) VALUES ('TALENTUM_WEBHOOK_ALARM', '${ACTOR}', '${JSON.stringify(payload)}'::jsonb) RETURNING id`,
    );
    return sqlOne(`INSERT INTO notifications (event_id, recipient_uid) VALUES ('${eventId}', '${UID}') RETURNING id`);
  };

  /** Entra pelo login, escolhe o idioma da tela e abre o sino pelo clique. */
  async function abrirSino(page: Page, lng: 'es' | 'pt-BR'): Promise<ReturnType<Page['getByTestId']>> {
    await loginAsKanbanAdmin(page);
    if (lng === 'pt-BR') {
      await page.evaluate(() => window.localStorage.setItem('i18nextLng', 'pt-BR'));
      await page.reload();
    }
    const sino = page.getByTestId('notification-bell-btn');
    await expect(sino).toBeVisible({ timeout: 15_000 });
    await sino.click();
    const painel = page.getByTestId('notification-panel');
    await expect(painel).toHaveClass(/translate-x-0/);
    return painel;
  }

  test.beforeAll(async ({ browser }) => {
    // O ator logado precisa existir em `users` (o login do helper o semeia); semeio já para poder pô-lo no grupo.
    runSQL(
      `INSERT INTO users (firebase_uid, email, display_name, role, is_active, account_type, status) ` +
        `VALUES ('${UID}', '${MOCK_ADMIN.email}', 'E2E Talentum Kanban', 'admin', true, 'staff', 'ACTIVE') ON CONFLICT (firebase_uid) DO NOTHING`,
    );
    // Grupo PRÓPRIO do teste com a célula `talentum:update` (a que o notificador usa) — nenhum grupo da operação é tocado.
    groupId = sqlOne(
      `INSERT INTO iam.permission_groups (tenant_id, name, description, is_system) VALUES ('${TENANT}', '${GROUP_NAME}', 'e2e sino talentum 095', false) RETURNING id`,
    );
    const granted = runSQL(
      `INSERT INTO iam.group_permissions (group_id, permission_id) SELECT '${groupId}', id FROM iam.permissions WHERE resource = 'talentum' AND action = 'update' RETURNING permission_id`,
    );
    expect(granted.split('\n').filter((l) => l && !l.startsWith('INSERT')), 'a célula talentum:update existe no catálogo: 0 = não semeei, não sucesso').toHaveLength(1);
    runSQL(`INSERT INTO iam.user_groups (user_id, group_id, tenant_id) VALUES ('${UID}', '${groupId}', '${TENANT}')`);
    const efetivas = runSQL(`SELECT iam.effective_permissions('${UID}', '${TENANT}'::uuid)`);
    expect(efetivas, 'o ator logado enxerga a célula pelo grupo próprio').toContain('talentum:update');
    void browser;
    limpaAvisos();
  });

  test.afterAll(() => {
    limpaAvisos();
    for (const id of seededInbox) runSQL(`DELETE FROM talentum_webhook_inbox WHERE id = '${id}'`);
    if (groupId) {
      runSQL(`DELETE FROM iam.user_groups WHERE group_id = '${groupId}'`);
      runSQL(`DELETE FROM iam.group_permissions WHERE group_id = '${groupId}'`);
      runSQL(`DELETE FROM iam.permission_groups WHERE id = '${groupId}'`);
    }
  });

  test('feliz: o ciclo real de events/health publica o aviso e o sino mostra "Webhook de Talentum: N eventos con error" de "Enlite"', async ({ page, request }) => {
    limpaAvisos();
    const inboxId = sqlOne(
      `INSERT INTO talentum_webhook_inbox (body_hash, action, subtype, environment, state, error_code, talentum_prescreening_id, talentum_profile_id, received_at) ` +
        `VALUES ('e2e095-falha-${RUN}', 'PRESCREENING_RESPONSE', 'INITIATED', 'test', 'FAILED', 'e2e_095', 'e2e095-psc-${RUN}', 'e2e095-prof-${RUN}', now()) RETURNING id`,
    );
    seededInbox.push(inboxId);
    const falhas = Number(sqlOne(`SELECT count(*) FROM talentum_webhook_inbox WHERE state IN ('FAILED','REJECTED_SCHEMA','UNSUPPORTED')`));
    expect(falhas, 'contagem 0 = não semeei').toBeGreaterThanOrEqual(1);

    // A rota REAL do ciclo (service route, `X-Internal-Secret` do stack): o detector lê a inbox e o notificador publica no sino.
    const res = await request.get(`${BACKEND_URL}/api/internal/events/health`, { headers: { 'X-Internal-Secret': SECRET() } });
    expect(res.status()).toBe(200);
    const corpo = (await res.json()) as { talentumWebhook?: { inbox_falha: number } | null };
    expect(corpo.talentumWebhook?.inbox_falha, 'o detector rodou e viu a linha FAILED').toBe(falhas);

    const ids = alarmNotificationIds();
    expect(ids, 'o ciclo publicou 1 aviso (inbox_falha) para o ator do teste').toHaveLength(1);

    const painel = await abrirSino(page, 'es');
    const item = painel.getByTestId(`notification-item-${ids[0]}`);
    await expect(item).toBeVisible({ timeout: 15_000 });
    await expect(item.getByText('Enlite', { exact: true })).toBeVisible();
    await expect(item.getByTestId(`notification-patient-${ids[0]}`)).toHaveText('Webhook de Talentum');
    await expect(item.getByTestId(`notification-excerpt-${ids[0]}`)).toHaveText('eventos con error');
    // A frase inteira (com a quantidade) é o que o leitor de tela ouve: `aria-label` do cartão.
    await expect(item).toHaveAttribute('aria-label', `Webhook de Talentum: ${falhas} eventos con error`);

    // Dedup: um 2º ciclo logo depois NÃO publica de novo (alarme já aberto, lembrete só em 24 h).
    expect((await request.get(`${BACKEND_URL}/api/internal/events/health`, { headers: { 'X-Internal-Secret': SECRET() } })).status()).toBe(200);
    expect(alarmNotificationIds()).toHaveLength(1);
  });

  test('alt 1: alarme "silencio" não tem quantidade no texto (pt-BR)', async ({ page }) => {
    limpaAvisos();
    const id = semearAviso({ alarme: 'silencio', quantidade: 1, desde: '2026-11-25T12:00:00.000Z' });
    const painel = await abrirSino(page, 'pt-BR');
    const item = painel.getByTestId(`notification-item-${id}`);
    await expect(item).toBeVisible({ timeout: 15_000 });
    await expect(item.getByText('Enlite', { exact: true })).toBeVisible();
    await expect(item.getByTestId(`notification-patient-${id}`)).toHaveText('Webhook do Talentum');
    await expect(item.getByTestId(`notification-excerpt-${id}`)).toHaveText('sem eventos em 6 h');
    await expect(item).toHaveAttribute('aria-label', 'Webhook do Talentum: sem eventos em 6 h'); // sem "1" nem "N"
  });

  test('alt 2: alarme desconhecido cai no rótulo genérico, a tela não quebra e o clique só marca como lido (sem deep link)', async ({ page }) => {
    limpaAvisos();
    const id = semearAviso({ alarme: 'alarme_inventado', quantidade: 3, desde: '2026-11-25T12:00:00.000Z' });
    const painel = await abrirSino(page, 'es');
    const urlAntes = page.url();
    const item = painel.getByTestId(`notification-item-${id}`);
    await expect(item).toBeVisible({ timeout: 15_000 });
    await expect(item).toHaveAttribute('aria-label', 'Webhook de Talentum: 1 avisos de alarma');
    await expect(item.getByTestId(`notification-excerpt-${id}`)).toHaveText('avisos de alarma');
    await expect(item.getByTestId(`notification-unread-dot-${id}`)).toBeVisible();
    expect(sqlOne(`SELECT count(*) FROM notifications WHERE id = '${id}' AND read_at IS NULL`)).toBe('1');

    await item.click();
    // Marcou como lido: a prova é o banco (o painel não refaz a lista no clique sem deep link; só o contador do sino é atualizado).
    await expect
      .poll(() => sqlOne(`SELECT count(*) FROM notifications WHERE id = '${id}' AND read_at IS NOT NULL`), { timeout: 15_000 })
      .toBe('1');
    expect(page.url(), 'sem deep link: o clique não navega').toBe(urlAntes);
    await expect(page.getByTestId('notification-bell-btn')).toBeVisible(); // a tela segue de pé
  });
});
