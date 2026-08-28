/**
 * kanban-reenviar.integration.e2e.ts @integration
 *
 * PONTA A PONTA SEM MOCK DE API: navegador real → worker-functions real (Docker)
 * → Postgres real → Firebase Auth EMULATOR real. Nenhum `page.route`.
 *
 * O único dublê é o FORNECEDOR de WhatsApp, na fronteira HTTP: o worker de teste
 * usa o canal Periskope e a API do Docker aponta para o stub da casa
 * (host.docker.internal:9911 — docker-compose.test.yml). Mensagem real NUNCA
 * sai daqui (regra dura: teste nunca toca canal real).
 *
 * O que prova (REQ-08 / DEC-19b, planning 26/08):
 *   - a tarjeta tem o botão "Reenviar" e mostra "Último envío" (nunca → "Sin envíos");
 *   - um clique dispara a mensagem (o stub recebe o POST; o log e o messaged_at
 *     ficam no Postgres) e o card passa a mostrar data/hora;
 *   - um segundo clique dentro da janela é recusado com o motivo na tela
 *     (RESEND_COOLDOWN) — sem novo envio.
 */

import { test, expect, type Page } from '@playwright/test';
import { execSync } from 'child_process';
import http from 'http';
import { insertTestPatient, insertBaseVacancy, insertTestWorker, cleanupTestWorker, cleanupTestPatient } from '../helpers/db-test-helper';
import { insertWJA, cleanupWJAAndEncuadre } from '../helpers/wja-test-helper';

const EMULATOR = 'http://127.0.0.1:9099';
const EMULATOR_PROJECT = 'demo-no-project';
const STAFF_EMAIL = `e2e.req08.${Date.now()}@enlite.health`;
const STAFF_PASSWORD = 'TestAdmin123!';
const STUB_PORT = Number(process.env.PERISKOPE_STUB_PORT ?? 9911);
const WORKER_LAST = `Reenviar${Date.now().toString().slice(-5)}`;

function runSQL(sql: string): string {
  return execSync(
    `docker exec enlite-postgres psql -U enlite_admin -d enlite_e2e -tAc "${sql.replace(/"/g, '\\"')}"`,
    { encoding: 'utf-8' },
  ).trim();
}

/** Stub do Periskope: aceita POST /v1/message/send e conta as chamadas. */
function startPeriskopeStub(): { server: http.Server; calls: { path: string; body: string }[] } {
  const calls: { path: string; body: string }[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      if (req.method === 'POST' && req.url?.endsWith('/message/send')) {
        calls.push({ path: req.url, body });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'queued', unique_id: `stub-${calls.length}`, queue_id: 'q-1' }));
        return;
      }
      res.writeHead(405); res.end();
    });
  });
  server.listen(STUB_PORT, '0.0.0.0');
  return { server, calls };
}

async function loginAsRealStaff(page: Page): Promise<void> {
  const res = await fetch(`${EMULATOR}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=any`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: STAFF_EMAIL, password: STAFF_PASSWORD, returnSecureToken: true }),
  });
  const auth = res.ok ? res : await fetch(`${EMULATOR}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=any`, {
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
  runSQL(`INSERT INTO users (firebase_uid, email, display_name, role, is_active, email_verified) VALUES ('${localId}', '${STAFF_EMAIL}', 'E2E Req08', 'admin', true, true) ON CONFLICT (firebase_uid) DO NOTHING`);
  await page.addInitScript(() => localStorage.setItem('i18nextLng', 'es'));
  await page.goto('/admin/login');
  await page.locator('input[type="email"]').fill(STAFF_EMAIL);
  await page.locator('input[type="password"]').fill(STAFF_PASSWORD);
  await page.getByRole('button', { name: /Iniciar sesi/i }).click();
  await expect(page).not.toHaveURL(/login/, { timeout: 30_000 });
}

test.use({ viewport: { width: 1600, height: 900 }, video: 'on' });

test.describe('Tarjeta: "Reenviar" de um clique + último envio (REQ-08) @integration', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(180_000);

  let patientId = '';
  let vacancyId = '';
  let workerId = '';
  let stub: ReturnType<typeof startPeriskopeStub>;

  test.beforeAll(() => {
    stub = startPeriskopeStub();
    // O setup do e2e do backend TRUNCA message_templates: semeia os 2 templates do convite.
    runSQL(`INSERT INTO message_templates (slug, name, body, category, is_active) VALUES
      ('ar_vacancy_match_complete', 'E2E match completo', 'Hola {{worker_name}}, hay una vacante para vos.', 'vacancy', true),
      ('ar_vacancy_match_incomplete', 'E2E match incompleto', 'Hola {{worker_name}}, completá tu registro.', 'vacancy', true)
      ON CONFLICT (slug) DO UPDATE SET is_active = true`);
    const { patientId: pid, addressId } = insertTestPatient({ withAddress: true, firstName: 'Paciente', lastName: 'Req08' });
    patientId = pid;
    vacancyId = insertBaseVacancy({ patientId, patientAddressId: addressId!, caseNumber: 90800 + Math.floor(Math.random() * 150), status: 'SEARCHING', isDraft: false });
    workerId = insertTestWorker({ firstName: 'Prestador', lastName: WORKER_LAST, occupation: 'AT', phone: `+549116${Date.now().toString().slice(-7)}` });
    // Canal Periskope → vai para o stub, nunca para o Twilio.
    runSQL(`UPDATE workers SET messaging_channel = 'periskope' WHERE id = '${workerId}'`);
    insertWJA({ workerId, jobPostingId: vacancyId, funnelStage: 'INVITED', source: 'manual' });
  });

  test.afterAll(() => {
    stub.server.close();
    runSQL(`DELETE FROM whatsapp_bulk_dispatch_logs WHERE worker_id = '${workerId}'`);
    try { cleanupWJAAndEncuadre(workerId, vacancyId); } catch { /* já limpo */ }
    cleanupTestWorker(workerId);
    cleanupTestPatient(patientId);
    runSQL(`DELETE FROM users WHERE email = '${STAFF_EMAIL}'`);
  });

  test('um clique reenvia, o card mostra a hora; o segundo clique é recusado pelo cooldown', async ({ page }, testInfo) => {
    await loginAsRealStaff(page);
    await page.goto(`/admin/vacancies/${vacancyId}`);
    await page.getByRole('button', { name: 'Kanban' }).click();

    const card = page.locator('[data-testid^="kanban-card-"]').filter({ hasText: `Prestador ${WORKER_LAST}` });
    await expect(card).toBeVisible({ timeout: 30_000 });
    await expect(card.getByTestId('resend-last-sent')).toHaveText('Sin envíos');
    await page.screenshot({ path: testInfo.outputPath('01-card-sin-envios.png'), fullPage: true });
    await expect(page).toHaveScreenshot('req08-card-sin-envios.png', { fullPage: true, maxDiffPixelRatio: 0.05 });

    // 1º clique → envia (stub recebe) e o card passa a mostrar a hora
    await card.getByTestId('resend-button').click();
    await expect(card.getByTestId('resend-feedback')).toHaveText('Enviado ✓', { timeout: 30_000 });
    await expect(card.getByTestId('resend-last-sent')).toContainText('Último envío:');
    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0].body).toContain('vacante');
    const logRow = runSQL(`SELECT status || '|' || template_slug || '|' || source || '|' || triggered_by FROM whatsapp_bulk_dispatch_logs WHERE worker_id = '${workerId}' AND job_posting_id = '${vacancyId}'`);
    expect(logRow).toMatch(/^sent\|ar_vacancy_match_complete\|individual\|admin:/);
    expect(runSQL(`SELECT messaged_at IS NOT NULL FROM worker_job_applications WHERE worker_id = '${workerId}' AND job_posting_id = '${vacancyId}'`)).toBe('t');
    await page.screenshot({ path: testInfo.outputPath('02-card-enviado-com-hora.png'), fullPage: true });
    await expect(page).toHaveScreenshot('req08-card-enviado.png', { fullPage: true, maxDiffPixelRatio: 0.05 });

    // 2º clique → RESEND_COOLDOWN na tela, sem novo envio
    await card.getByTestId('resend-button').click();
    await expect(card.getByRole('alert')).toContainText('últimas 24 h', { timeout: 30_000 });
    expect(stub.calls).toHaveLength(1);
    await page.screenshot({ path: testInfo.outputPath('03-card-cooldown.png'), fullPage: true });
  });
});
