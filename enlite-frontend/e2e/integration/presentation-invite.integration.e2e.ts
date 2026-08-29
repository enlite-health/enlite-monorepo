/**
 * presentation-invite.integration.e2e.ts @integration — REQ-09 / REQ-20 (planning 26/08)
 *
 * PONTA A PONTA SEM MOCK DE API: navegador real → worker-functions real (imagem desta branch,
 * migration 293) → Postgres real → Firebase Auth EMULATOR real.
 *
 * O que prova:
 *   - /admin/invitacion-presentacion: admin configura link do Meet + horário + template, liga e salva
 *     → banco + auditoria; link que não é sala do Meet é recusado pelo backend e o erro aparece;
 *   - Kanban da vaga: clique em "Invitar a reunión de presentación" na tarjeta → outbox pending +
 *     log queued com o uid de quem clicou (origem kanban, vaga anexada) → "Última invitación" na tarjeta;
 *   - lista de prestadores: clique na linha de quem NÃO terminou o registro (REQ-04) → log (origem
 *     workers_list); ficha IMPORTADA → "sin vínculo" na tela e zero outbox (lex C1);
 *   - `toHaveScreenshot` da config e da tarjeta; vídeo/prints para a task.
 * Nenhuma mensagem sai: template é fixture do e2e, canal pausado (kill-switch), Twilio desconfigurado.
 */
import { test, expect, type Page } from '@playwright/test';
import { execSync } from 'child_process';
import { insertTestPatient, cleanupTestPatient, insertBaseVacancy, cleanupVacancies, insertTestWorker, cleanupTestWorker } from '../helpers/db-test-helper';
import { openKanban } from '../helpers/talentumWebhookHelper';

const EMULATOR = 'http://127.0.0.1:9099';
const EMULATOR_PROJECT = 'demo-no-project';
const STAFF_EMAIL = `e2e.pi.${Date.now()}@enlite.health`;
const STAFF_PASSWORD = 'TestAdmin123!';
const TEMPLATE = 'pi_ui_invite';
const MEET = 'https://meet.google.com/abc-defg-hij';
const CASE_NUMBER = 99940 + Math.floor(Math.random() * 10);

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
  runSQL(`INSERT INTO users (firebase_uid, email, display_name, role, is_active, email_verified) VALUES ('${localId}', '${STAFF_EMAIL}', 'E2E PI Admin', 'admin', true, true) ON CONFLICT (firebase_uid) DO NOTHING`);
  await page.addInitScript(() => localStorage.setItem('i18nextLng', 'es'));
  await page.goto('/admin/login');
  await page.locator('input[type="email"]').fill(STAFF_EMAIL);
  await page.locator('input[type="password"]').fill(STAFF_PASSWORD);
  await page.getByRole('button', { name: /Iniciar sesi/i }).click();
  await expect(page).not.toHaveURL(/login/, { timeout: 45_000 });
  return localId;
}

test.use({ viewport: { width: 1600, height: 1000 }, video: 'on' });

test.describe('Convite à reunión de presentación: config, tarjeta e lista (REQ-09) @integration', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(240_000);

  let patientId = ''; let vacancyId = ''; let workerId = ''; let wjaId = ''; let importedId = ''; let incompleteId = '';
  const tag = Date.now().toString().slice(-5);

  test.beforeAll(() => {
    runSQL(`INSERT INTO messaging_channel_pause (channel, paused, paused_at, paused_by) VALUES ('whatsapp', true, NOW(), 'e2e-pi-ui') ON CONFLICT (channel) DO UPDATE SET paused = true, paused_by = 'e2e-pi-ui'`);
    runSQL(`INSERT INTO message_templates (slug, name, body, category, is_active, created_at, updated_at) VALUES ('${TEMPLATE}', 'PI UI', 'Hola {{worker_name}}, {{schedule_label}} {{meet_link}}. Respondé BAJA para no recibir más.', 'UTILITY', true, NOW(), NOW()) ON CONFLICT (slug) DO UPDATE SET body = EXCLUDED.body, category = EXCLUDED.category, is_active = true`);
    runSQL(`INSERT INTO presentation_invite_settings (country, enabled) VALUES ('AR', false) ON CONFLICT (country) DO NOTHING`);
    runSQL(`UPDATE presentation_invite_settings SET template_slug = NULL, meet_link = NULL, schedule_label = NULL, enabled = false WHERE country = 'AR'`);
    const p = insertTestPatient({ firstName: 'Paciente', lastName: `Pi${tag}`, withAddress: true, addressLat: -34.6037, addressLng: -58.3816 });
    patientId = p.patientId;
    vacancyId = insertBaseVacancy({ patientId, patientAddressId: p.addressId as string, caseNumber: CASE_NUMBER, status: 'SEARCHING', isDraft: false });
    // Candidata REGISTERED com vínculo verificável (aceitou termos) — o Kanban só aceita WJA de REGISTERED (trigger)
    workerId = insertTestWorker({ firstName: `Pi${tag}`, lastName: 'Invita', occupation: 'AT', status: 'REGISTERED', lat: -34.6, lng: -58.4 });
    runSQL(`UPDATE workers SET privacy_accepted_at = NOW(), phone = '+5491177780${tag.slice(-3)}', country = 'AR' WHERE id = '${workerId}'`);
    runSQL(`INSERT INTO worker_job_applications (worker_id, job_posting_id, application_funnel_stage, source) VALUES ('${workerId}', '${vacancyId}', 'INVITED', 'manual') ON CONFLICT (worker_id, job_posting_id) DO UPDATE SET application_funnel_stage = 'INVITED'`);
    wjaId = runSQL(`SELECT id FROM worker_job_applications WHERE worker_id = '${workerId}' AND job_posting_id = '${vacancyId}'`);
    // Quem NÃO terminou o registro mas aceitou os termos (REQ-04: convidável pela lista, lex C1 ok)
    incompleteId = insertTestWorker({ firstName: `Pi${tag}`, lastName: 'Incompleta', occupation: 'AT', status: 'INCOMPLETE_REGISTER', lat: -34.6, lng: -58.4 });
    runSQL(`UPDATE workers SET privacy_accepted_at = NOW(), phone = '+5491177760${tag.slice(-3)}', country = 'AR' WHERE id = '${incompleteId}'`);
    // Ficha importada de planilha: nunca se cadastrou — não pode ser convidada
    importedId = insertTestWorker({ firstName: `Pi${tag}`, lastName: 'Importada', occupation: 'AT', status: 'INCOMPLETE_REGISTER', lat: -34.6, lng: -58.4 });
    runSQL(`UPDATE workers SET email = 'pi-imp-${tag}@enlite.import', auth_uid = 'base1import_pi_${tag}', privacy_accepted_at = NULL, phone = '+5491177790${tag.slice(-3)}', country = 'AR' WHERE id = '${importedId}'`);
    expect(wjaId).toMatch(/^[0-9a-f-]{36}$/);
  });

  test.afterAll(() => {
    runSQL(`UPDATE presentation_invite_settings SET template_slug = NULL, meet_link = NULL, schedule_label = NULL, enabled = false WHERE country = 'AR'`);
    runSQL(`UPDATE messaging_channel_pause SET paused = false WHERE channel = 'whatsapp' AND paused_by = 'e2e-pi-ui'`);
    cleanupTestWorker(workerId); cleanupTestWorker(importedId); cleanupTestWorker(incompleteId);
    cleanupVacancies([vacancyId]);
    cleanupTestPatient(patientId);
    runSQL(`DELETE FROM users WHERE email = '${STAFF_EMAIL}'`);
  });

  test('config: link não-Meet é recusado; admin configura, liga e salva → banco + auditoria', async ({ page }, testInfo) => {
    const uid = await loginAsRealAdmin(page);
    await page.goto('/admin/invitacion-presentacion');
    await expect(page.getByTestId('pi-form')).toBeVisible({ timeout: 30_000 });
    await page.getByTestId('pi-meet-link').fill('https://zoom.us/j/123');
    await page.getByTestId('pi-schedule-label').fill('Todos los martes a las 18:00 (hora de Buenos Aires)');
    await page.getByTestId('pi-template').selectOption(TEMPLATE);
    await page.getByTestId('pi-enabled').check();
    await page.getByTestId('pi-save').click();
    await expect(page.getByTestId('pi-error')).toBeVisible({ timeout: 15_000 });
    expect(runSQL(`SELECT enabled FROM presentation_invite_settings WHERE country = 'AR'`)).toBe('f');
    await page.getByTestId('pi-meet-link').fill(MEET);
    await page.screenshot({ path: testInfo.outputPath('01-config-invitacion-presentacion.png') });
    await expect(page.getByTestId('pi-form')).toHaveScreenshot('pi-config-form.png', { maxDiffPixelRatio: 0.05 });
    await page.getByTestId('pi-save').click();
    await expect(page.getByTestId('pi-saved')).toBeVisible({ timeout: 15_000 });
    expect(runSQL(`SELECT template_slug || '|' || meet_link || '|' || enabled::text || '|' || updated_by FROM presentation_invite_settings WHERE country = 'AR'`)).toBe(`${TEMPLATE}|${MEET}|true|${uid}`);
    expect(runSQL(`SELECT COUNT(*) FROM presentation_invite_settings_audit WHERE actor_uid = '${uid}' AND enabled = true`)).not.toBe('0');
    await expect(page.getByTestId('pi-last-edit')).toContainText('E2E PI Admin');
  });

  test('Kanban: clique na tarjeta → outbox + log com autoria (origem kanban, vaga) → "Última invitación" na tarjeta', async ({ page }, testInfo) => {
    const uid = await loginAsRealAdmin(page);
    await openKanban(page, vacancyId);
    await page.evaluate(() => { document.querySelector('[data-testid="kanban-board"]')?.scrollIntoView({ block: 'start' }); });
    const card = page.getByTestId(`kanban-card-${wjaId}`);
    await expect(card).toBeVisible({ timeout: 30_000 });
    await expect(card.getByTestId('presentation-invite-last')).toContainText(/Sin invitaci/);
    await card.getByTestId('presentation-invite-button').click();
    await expect(card.getByTestId('presentation-invite-feedback')).toContainText(/Invitaci.n enviada/, { timeout: 15_000 });
    await expect(card.getByTestId('presentation-invite-last')).toContainText(/ltima invitaci/);
    expect(runSQL(`SELECT template_slug || '|' || status FROM messaging_outbox WHERE worker_id = '${workerId}' AND template_slug = '${TEMPLATE}'`)).toBe(`${TEMPLATE}|pending`);
    expect(runSQL(`SELECT status || '|' || actor_uid || '|' || source || '|' || COALESCE(job_posting_id::text, '') FROM presentation_invite_log WHERE worker_id = '${workerId}' ORDER BY created_at DESC LIMIT 1`)).toBe(`queued|${uid}|kanban|${vacancyId}`);
    await card.scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath('02-tarjeta-invitacion.png') });
    await expect(card).toHaveScreenshot('pi-card-invited.png', { maxDiffPixelRatio: 0.05 });
    // recarregar: o "último convite" vem do backend (/last), não do estado local
    await openKanban(page, vacancyId);
    await expect(page.getByTestId(`kanban-card-${wjaId}`).getByTestId('presentation-invite-last')).toContainText(/ltima invitaci/, { timeout: 30_000 });
  });

  test('lista de prestadores: registro incompleto → convite (REQ-04); 2º clique em 7 d → "ya fue invitada"; ficha importada → "sin vínculo", zero outbox (lex C1)', async ({ page }, testInfo) => {
    const uid = await loginAsRealAdmin(page);
    await page.goto(`/admin/workers?search=Pi${tag}`);
    const rowInc = page.locator(`tr:has-text("Pi${tag} Incompleta")`).first();
    await expect(rowInc).toBeVisible({ timeout: 30_000 });
    await rowInc.getByTestId('presentation-invite-button').click();
    await expect(rowInc.getByTestId('presentation-invite-feedback')).toContainText(/Invitaci.n enviada/, { timeout: 15_000 });
    expect(runSQL(`SELECT status || '|' || actor_uid || '|' || source FROM presentation_invite_log WHERE worker_id = '${incompleteId}' ORDER BY created_at DESC LIMIT 1`)).toBe(`queued|${uid}|workers_list`);
    const rowOk = page.locator(`tr:has-text("Pi${tag} Invita")`).first();
    await expect(rowOk).toBeVisible();
    await rowOk.getByTestId('presentation-invite-button').click();
    await expect(rowOk.getByTestId('presentation-invite-feedback')).toContainText(/Ya fue invitada/, { timeout: 15_000 });
    const rowImp = page.locator(`tr:has-text("Pi${tag} Importada")`).first();
    await expect(rowImp).toBeVisible();
    await rowImp.getByTestId('presentation-invite-button').click();
    await expect(rowImp.getByTestId('presentation-invite-feedback')).toContainText(/Sin v.nculo/, { timeout: 15_000 });
    expect(runSQL(`SELECT COUNT(*) FROM messaging_outbox WHERE worker_id = '${importedId}'`)).toBe('0');
    expect(runSQL(`SELECT skip_reason || '|' || source FROM presentation_invite_log WHERE worker_id = '${importedId}' ORDER BY created_at DESC LIMIT 1`)).toBe('SIN_VINCULO|workers_list');
    await page.screenshot({ path: testInfo.outputPath('03-lista-prestadores-invitacion.png') });
    await expect(rowImp).toHaveScreenshot('pi-workers-row-sin-vinculo.png', { maxDiffPixelRatio: 0.05 });
    expect(runSQL(`SELECT paused FROM messaging_channel_pause WHERE channel = 'whatsapp'`)).toBe('t');
    expect(runSQL(`SELECT COUNT(*) FROM messaging_outbox WHERE template_slug = '${TEMPLATE}' AND status <> 'pending'`)).toBe('0');
  });
});
