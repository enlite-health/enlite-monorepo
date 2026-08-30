/**
 * funnel-stage-messages.integration.e2e.ts @integration — PEND-14 / DEC-12
 *
 * PONTA A PONTA SEM MOCK DE API: navegador real → worker-functions real (imagem
 * desta branch, migration 292) → Postgres real → Firebase Auth EMULATOR real.
 *
 * O que prova:
 *   - /admin/mensajes-por-etapa: admin escolhe um template ELEGÍVEL para CONFIRMED, liga e salva
 *     → banco (`funnel_stage_messages`) e auditoria; template MARKETING aparece desabilitado com o motivo;
 *   - Kanban da vaga: arrastar a tarjeta de "Invitados" para "Completados" → evento
 *     `funnel_stage.confirmed` gravado com o uid de quem moveu → processado pelo endpoint interno →
 *     outbox com o template + a tarjeta mostra "Mensaje de etapa (Completados): <data>";
 *   - `toHaveScreenshot` da página de config e da tarjeta (visual) + vídeo/prints para a task.
 * Nenhuma mensagem sai (Twilio desconfigurado; canal pausado pelo kill-switch durante o ensaio).
 */
import { test, expect, type Page } from '@playwright/test';
import { execSync } from 'child_process';
import { insertTestPatient, cleanupTestPatient, insertBaseVacancy, cleanupVacancies, insertTestWorker, cleanupTestWorker } from '../helpers/db-test-helper';
import { dndKitDrag } from '../helpers/dndKitDrag';
import { openKanban } from '../helpers/talentumWebhookHelper';

const EMULATOR = 'http://127.0.0.1:9099';
const EMULATOR_PROJECT = 'demo-no-project';
const STAFF_EMAIL = `e2e.fsm.${Date.now()}@enlite.health`;
const STAFF_PASSWORD = 'TestAdmin123!';
const TEMPLATE = 'fsm_ui_stage_notice';
const CASE_NUMBER = 99960 + Math.floor(Math.random() * 10);
const INTERNAL_SECRET = 'test-secret-for-e2e-only';

function runSQL(sql: string): string {
  return execSync(`docker exec enlite-postgres psql -U enlite_admin -d enlite_e2e -tAc "${sql.replace(/"/g, '\\"')}"`, { encoding: 'utf-8' }).trim();
}

async function loginAsRealAdmin(page: Page): Promise<string> {
  const signUp = await fetch(`${EMULATOR}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=any`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: STAFF_EMAIL, password: STAFF_PASSWORD, returnSecureToken: true }),
  });
  const auth = signUp.ok ? signUp : await fetch(`${EMULATOR}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=any`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: STAFF_EMAIL, password: STAFF_PASSWORD, returnSecureToken: true }),
  });
  expect(auth.ok).toBe(true);
  const { localId } = (await auth.json()) as { localId: string };
  const claims = await fetch(`${EMULATOR}/identitytoolkit.googleapis.com/v1/projects/${EMULATOR_PROJECT}/accounts:update`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer owner' },
    body: JSON.stringify({ localId, customAttributes: JSON.stringify({ role: 'admin' }) }),
  });
  expect(claims.ok).toBe(true);
  runSQL(`INSERT INTO users (firebase_uid, email, display_name, role, is_active, email_verified) VALUES ('${localId}', '${STAFF_EMAIL}', 'E2E FSM Admin', 'admin', true, true) ON CONFLICT (firebase_uid) DO NOTHING`);
  await page.addInitScript(() => localStorage.setItem('i18nextLng', 'es'));
  await page.goto('/admin/login');
  await page.locator('input[type="email"]').fill(STAFF_EMAIL);
  await page.locator('input[type="password"]').fill(STAFF_PASSWORD);
  await page.getByRole('button', { name: /Iniciar sesi/i }).click();
  await expect(page).not.toHaveURL(/login/, { timeout: 45_000 });
  return localId;
}

// Viewport largo: as 9 colunas cabem sem rolagem horizontal — com rolagem, o auto-scroll do
// dnd-kit desloca as colunas debaixo do ponteiro e o drop cai na coluna vizinha (visto: Confirmados).
test.use({ viewport: { width: 3000, height: 1100 }, video: 'on' });

test.describe('Mensagem por etapa: configurar e arrastar a tarjeta (PEND-14 / DEC-12) @integration', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(240_000);

  let patientId = ''; let vacancyId = ''; let workerId = ''; let encuadreId = ''; let wjaId = '';
  const workerName = `Fsm${Date.now().toString().slice(-5)}`;

  test.beforeAll(() => {
    runSQL(`INSERT INTO messaging_channel_pause (channel, paused, paused_at, paused_by) VALUES ('whatsapp', true, NOW(), 'e2e-fsm-ui') ON CONFLICT (channel) DO UPDATE SET paused = true, paused_by = 'e2e-fsm-ui'`);
    runSQL(`INSERT INTO message_templates (slug, name, body, category, is_active, created_at, updated_at) VALUES ('${TEMPLATE}', 'FSM UI aviso', 'Hola {{worker_name}}, tu candidatura al caso {{case_number}} avanzó.', 'UTILITY', true, NOW(), NOW()), ('fsm_ui_marketing', 'FSM UI mkt', 'Hola', 'MARKETING', true, NOW(), NOW()) ON CONFLICT (slug) DO UPDATE SET body = EXCLUDED.body, category = EXCLUDED.category, is_active = true`);
    runSQL(`INSERT INTO funnel_stage_messages (country, stage, builtin) VALUES ('AR','INVITED',NULL),('AR','PRE_SCREENING',NULL),('AR','IN_PROGRESS',NULL),('AR','CONFIRMED',NULL),('AR','QUALIFIED','interview_invite'),('AR','IN_DOUBT',NULL),('AR','CONFIRMED',NULL),('AR','SELECTED',NULL),('AR','REJECTED',NULL) ON CONFLICT (country, stage) DO NOTHING`);
    runSQL(`UPDATE funnel_stage_messages SET template_slug = NULL, enabled = false WHERE country = 'AR'`);
    const p = insertTestPatient({ firstName: 'Paciente', lastName: workerName, withAddress: true, addressLat: -34.6037, addressLng: -58.3816 });
    patientId = p.patientId;
    vacancyId = insertBaseVacancy({ patientId, patientAddressId: p.addressId as string, caseNumber: CASE_NUMBER, status: 'SEARCHING', isDraft: false });
    workerId = insertTestWorker({ firstName: workerName, lastName: 'Etapa', occupation: 'AT', status: 'REGISTERED', lat: -34.6, lng: -58.4 });
    runSQL(`INSERT INTO worker_job_applications (worker_id, job_posting_id, application_funnel_stage, source) VALUES ('${workerId}', '${vacancyId}', 'INVITED', 'manual') ON CONFLICT (worker_id, job_posting_id) DO UPDATE SET application_funnel_stage = 'INVITED'`);
    encuadreId = runSQL(`SELECT id FROM encuadres WHERE worker_id = '${workerId}' AND job_posting_id = '${vacancyId}' LIMIT 1`);
    wjaId = runSQL(`SELECT id FROM worker_job_applications WHERE worker_id = '${workerId}' AND job_posting_id = '${vacancyId}'`);
    expect(encuadreId).toMatch(/^[0-9a-f-]{36}$/); expect(wjaId).toMatch(/^[0-9a-f-]{36}$/);
  });

  test.afterAll(() => {
    runSQL(`UPDATE funnel_stage_messages SET template_slug = NULL, enabled = false WHERE country = 'AR'`);
    runSQL(`UPDATE messaging_channel_pause SET paused = false WHERE channel = 'whatsapp' AND paused_by = 'e2e-fsm-ui'`);
    cleanupTestWorker(workerId);
    cleanupVacancies([vacancyId]);
    cleanupTestPatient(patientId);
    runSQL(`DELETE FROM users WHERE email = '${STAFF_EMAIL}'`);
  });

  test('config: ligar CONFIRMED com template elegível → banco + auditoria; MARKETING aparece bloqueado', async ({ page }, testInfo) => {
    const uid = await loginAsRealAdmin(page);
    await page.goto('/admin/mensajes-por-etapa');
    await expect(page.getByTestId('fsm-table')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('fsm-row-QUALIFIED')).toContainText(/Incorporada/i);
    const select = page.getByTestId('fsm-template-CONFIRMED');
    const mktOption = select.locator('option[value="fsm_ui_marketing"]');
    await expect(mktOption).toHaveAttribute('disabled', '');
    await expect(mktOption).toContainText(/UTILITY/);
    await select.selectOption(TEMPLATE);
    await page.getByTestId('fsm-enabled-CONFIRMED').check();
    await page.screenshot({ path: testInfo.outputPath('01-config-etapa-confirmados.png'), fullPage: false });
    await expect(page.getByTestId('fsm-table')).toHaveScreenshot('fsm-config-table.png', { maxDiffPixelRatio: 0.05 });
    await page.getByTestId('fsm-save-CONFIRMED').click();
    await expect(page.getByTestId('fsm-saved-CONFIRMED')).toBeVisible({ timeout: 15_000 });
    expect(runSQL(`SELECT template_slug || '|' || enabled::text || '|' || updated_by FROM funnel_stage_messages WHERE country = 'AR' AND stage = 'CONFIRMED'`)).toBe(`${TEMPLATE}|true|${uid}`);
    expect(runSQL(`SELECT COUNT(*) FROM funnel_stage_messages_audit WHERE stage = 'CONFIRMED' AND actor_uid = '${uid}'`)).not.toBe('0');
    await expect(page.getByTestId('fsm-row-CONFIRMED')).toContainText('E2E FSM Admin');
  });

  test('Kanban: arrastar a tarjeta para Confirmados → evento com autoria → outbox + "Mensaje de etapa" na tarjeta', async ({ page }, testInfo) => {
    const uid = await loginAsRealAdmin(page);
    // A vaga abre em modo tabela; o helper força o Kanban (mesmo caminho do e2e da Fase 1)
    await openKanban(page, vacancyId);
    await page.evaluate(() => { document.querySelector('[data-testid="kanban-board"]')?.scrollIntoView({ block: 'start' }); });
    await page.waitForTimeout(200);
    const card = page.getByTestId(`kanban-card-${wjaId}`);
    await expect(card).toBeVisible({ timeout: 30_000 });
    await expect(card.getByTestId('stage-last-message')).toHaveCount(0);

    // Drag real (dnd-kit, mesmo helper do Kanban da Fase 1): Invitados → Confirmados
    const wrapper = page.locator(`[data-testid="kanban-draggable-${wjaId}"]`);
    const confirmedCol = page.locator('[data-testid="kanban-column-CONFIRMED"]');
    // Só INVITED/CONFIRMED/SELECTED/REJECTED são droppable no Kanban (PRE_SCREENING, IN_PROGRESS e
    // COMPLETED são etapas da Talentum): o humano só consegue disparar a mensagem nessas 4.
    // dnd-kit mede os retângulos das colunas NO INÍCIO do arrasto: rolar o board no meio do
    // arrasto (scrollIntoView do alvo) deixa a colisão com retângulos velhos e o drop cai na
    // coluna vizinha. Origem e destino têm de estar visíveis ANTES de começar.
    await page.evaluate(() => {
      document.querySelectorAll<HTMLElement>('[data-testid="kanban-board"], [data-testid="kanban-board"] *').forEach((el) => { if (el.scrollWidth > el.clientWidth) el.scrollLeft = 0; });
    });
    await page.waitForTimeout(200);
    const vb = page.viewportSize()!;
    for (const loc of [wrapper, confirmedCol]) {
      const b = (await loc.boundingBox())!;
      expect(b.x >= 0 && b.x + b.width <= vb.width, 'origem e destino visíveis sem rolagem').toBe(true);
    }
    await dndKitDrag(page, wrapper, confirmedCol);
    // Confirmados pergunta a data da entrevista; "mover igual" move sem data (o único caminho humano sem modal)
    await expect(page.getByRole('heading', { name: /Cuándo es la entrevista/ })).toBeVisible({ timeout: 10_000 });
    await page.getByText(/mover igual/i).click();

    // Backend: etapa gravada + evento na mesma transação com QUEM moveu
    await expect.poll(() => runSQL(`SELECT application_funnel_stage FROM worker_job_applications WHERE worker_id = '${workerId}' AND job_posting_id = '${vacancyId}'`), { timeout: 15_000 }).toBe('CONFIRMED');
    const eventId = runSQL(`SELECT id FROM domain_events WHERE event = 'funnel_stage.confirmed' AND payload @> '{"workerId":"${workerId}"}' ORDER BY created_at DESC LIMIT 1`);
    expect(eventId).toMatch(/^[0-9a-f-]{36}$/);
    expect(runSQL(`SELECT payload->>'actorUid' FROM domain_events WHERE id = '${eventId}'`)).toBe(uid);

    // Em prod o Pub/Sub empurra; aqui o endpoint interno processa o evento gravado
    const pushBody = { message: { data: Buffer.from(JSON.stringify({ eventId })).toString('base64'), messageId: `ui-${eventId}`, publishTime: new Date().toISOString() }, subscription: 'test-sub' };
    const proc = await page.request.post('http://localhost:8080/api/internal/events/process', { data: pushBody, headers: { 'X-Internal-Secret': INTERNAL_SECRET } });
    expect(proc.status()).toBe(200);
    expect(runSQL(`SELECT template_slug || '|' || status FROM messaging_outbox WHERE worker_id = '${workerId}' AND template_slug = '${TEMPLATE}'`)).toBe(`${TEMPLATE}|pending`);
    expect(runSQL(`SELECT status || '|' || actor_uid FROM funnel_stage_message_log WHERE worker_id = '${workerId}' AND stage = 'CONFIRMED' ORDER BY created_at DESC LIMIT 1`)).toBe(`queued|${uid}`);

    // Tela: a tarjeta mostra o último envio por etapa
    await openKanban(page, vacancyId);
    await page.evaluate(() => { document.querySelector('[data-testid="kanban-board"]')?.scrollIntoView({ block: 'start' }); });
    const cardAfter = page.getByTestId(`kanban-card-${wjaId}`);
    await expect(cardAfter).toBeVisible({ timeout: 30_000 });
    await expect(cardAfter.getByTestId('stage-last-message')).toContainText(/Mensaje de etapa/, { timeout: 15_000 });
    await cardAfter.scrollIntoViewIfNeeded();
    await page.getByTestId('kanban-board').screenshot({ path: testInfo.outputPath('02-tarjeta-mensaje-de-etapa.png') });
    await expect(cardAfter).toHaveScreenshot('fsm-card-stage-message.png', { maxDiffPixelRatio: 0.05 });

    // Kill-switch seguiu ligado o ensaio inteiro: nada saiu
    expect(runSQL(`SELECT paused FROM messaging_channel_pause WHERE channel = 'whatsapp'`)).toBe('t');
  });
});
