/**
 * fsm-picker-visual.e2e.ts
 *
 * PROVA VISUAL da tela de escolha da mensagem por etapa (DEC-12 / PEND-14).
 *
 * Auth pelo Firebase Emulator real (mesmo padrão do admin-api-docs). O payload
 * de `/api/admin/funnel-stage-messages` é fixado aqui com os DADOS REAIS de
 * produção lidos em 31/08/2026 — inclusive o corpo aprovado que veio da Content
 * API — para fotografar os três estados que importam:
 *   1. a tabela com a célula de UMA linha (mensagem de 398 caracteres cortada);
 *   2. a modal com a prévia do texto e os inelegíveis agrupados por motivo;
 *   3. o estado em que o texto ainda não foi sincronizado.
 */
import { test, expect, Page } from '@playwright/test';

const FIREBASE_EMULATOR = 'http://127.0.0.1:9099';
const FIREBASE_API_KEY = 'test-api-key';

const REPROGRAM_BODY =
  '¡Perfecto! Entendemos que a veces los tiempos no se acomodan y no hay ningún problema. 😊\n\n' +
  'Tu solicitud de reagendamiento para el caso {{case_number}} quedó registrada.\n\n' +
  'En cuanto se abran las nuevas agendas para este caso, te enviaremos un mensaje con las opciones ' +
  'de día y horario para que puedas elegir el que más te convenga.\n\n' +
  '¡Gracias por tu interés y por seguir siendo parte de este proceso! 💛';

const STAGES = ['INVITED', 'PRE_SCREENING', 'IN_PROGRESS', 'COMPLETED', 'QUALIFIED', 'IN_DOUBT', 'CONFIRMED', 'SELECTED', 'REJECTED'];

const tpl = (slug: string, body: string | null, bodyTwilio: string | null, category: string, eligible: boolean, reason: string | null) =>
  ({ slug, name: slug, body, bodyTwilio, category, eligible, reason, placeholders: [], unsupported: [] });

const PAYLOAD = {
  success: true,
  data: {
    country: 'AR',
    stages: STAGES.map((stage) => ({
      stage,
      templateSlug: stage === 'IN_PROGRESS' ? 'qualified_reprogram_confirm' : null,
      enabled: stage === 'IN_PROGRESS',
      channel: 'whatsapp',
      builtin: stage === 'QUALIFIED' ? 'interview_invite' : null,
      updatedBy: stage === 'IN_PROGRESS' ? 'Ana Joulie' : null,
      updatedAt: stage === 'IN_PROGRESS' ? '2026-08-30T14:32:00Z' : null,
    })),
    templates: [
      tpl('qualified_reprogram_confirm', REPROGRAM_BODY, REPROGRAM_BODY.replace('{{case_number}}', '{{1}}'), 'UTILITY', true, null),
      // Texto vindo da Content API: 2 slots, e nós preenchemos 0 → SLOT_MISMATCH.
      tpl('ar_finalize_signup_luz', '(ver Twilio Content Builder: HX54d6)', 'Hola {{1}}, soy Luz. Para terminar tu inscripción entrá acá: {{2}}', 'UTILITY', false, 'SLOT_MISMATCH'),
      tpl('ar_finalize_signup_direct', '(ver Twilio Content Builder: HXeb5e)', null, 'UTILITY', true, null),
      tpl('ar_invite_luz_personal', 'Hola', null, 'MARKETING', false, 'CATEGORY'),
      tpl('ar_invite_open', 'Hola', null, 'MARKETING', false, 'CATEGORY'),
      tpl('complete_register_ofc', 'Hola', null, 'MARKETING', false, 'CATEGORY'),
      tpl('admission_reminder_es', 'Hola {{1}}', null, 'UTILITY', false, 'DENY_LIST'),
      tpl('talentum_incomplete_reminder', 'Hola {{worker_name}}', null, 'UTILITY', false, 'DENY_LIST'),
      tpl('admission_confirmation_es', 'Hola {{1}} {{2}}', null, 'UTILITY', false, 'PLACEHOLDERS'),
      tpl('qualified_worker', 'Caso {{4}}', null, 'UTILITY', false, 'PLACEHOLDERS'),
    ],
  },
};

async function loginAsAdmin(page: Page): Promise<void> {
  const email = `e2e.fsmvisual.${Date.now()}@test.com`;
  const password = 'TestAdmin123!';
  const signUp = await fetch(`${FIREBASE_EMULATOR}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=${FIREBASE_API_KEY}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, returnSecureToken: true }),
  });
  const { localId: uid } = (await signUp.json()) as { localId: string };
  expect(uid).toBeTruthy();

  await page.route('**/identitytoolkit.googleapis.com/**', async (route) => {
    const parsed = new URL(route.request().url());
    const url = `${FIREBASE_EMULATOR}/identitytoolkit.googleapis.com${parsed.pathname}?${parsed.searchParams.toString().replace(/key=[^&]+/, `key=${FIREBASE_API_KEY}`)}`;
    const res = await fetch(url, { method: route.request().method(), headers: { 'Content-Type': 'application/json' }, body: route.request().postData() ?? undefined });
    await route.fulfill({ status: res.status, contentType: 'application/json', body: await res.text() });
  });
  await page.route('**/securetoken.googleapis.com/**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ access_token: 'mock', expires_in: '3600', token_type: 'Bearer', refresh_token: 'mock', id_token: 'mock', user_id: uid, project_id: 'enlite-prd' }) }));
  await page.route('**/api/admin/auth/profile', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data: { id: uid, email, role: 'admin', displayName: 'Gabriel', isActive: true } }) }));

  await page.addInitScript(() => localStorage.setItem('i18nextLng', 'es'));
  await page.goto('/admin/login');
  await page.locator('input[type="email"]').fill(email);
  await page.locator('input[type="password"]').fill(password);
  await page.getByRole('button', { name: /Iniciar sesi/i }).click();
  await expect(page).not.toHaveURL(/login/, { timeout: 45_000 });
}

test.use({ viewport: { width: 1440, height: 900 } });

test.describe('Mensajes por etapa — elegir mensaje viendo el texto', () => {
  test('tabela, modal com prévia e estado sem texto sincronizado', async ({ page }, testInfo) => {
    await loginAsAdmin(page);
    await page.route('**/api/admin/funnel-stage-messages', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(PAYLOAD) }));

    await page.goto('/admin/mensajes-por-etapa');
    await expect(page.getByTestId('fsm-table')).toBeVisible({ timeout: 30_000 });

    // 1. A tabela: a mensagem de 398 caracteres ocupa UMA linha, como as vazias.
    await expect(page.getByTestId('fsm-template-IN_PROGRESS')).toContainText('¡Perfecto!');
    await page.screenshot({ path: testInfo.outputPath('01-tabela.png') });

    // 2. A modal: prévia com os valores de exemplo e os bloqueados por motivo.
    await page.getByTestId('fsm-open-PRE_SCREENING').click();
    await expect(page.getByTestId('fsm-modal')).toBeVisible();
    await page.getByTestId('fsm-option-qualified_reprogram_confirm').click();
    await expect(page.getByTestId('fsm-preview')).toContainText('CASO 1042');
    await expect(page.getByTestId('fsm-blocked-CATEGORY')).toContainText('ar_invite_open');
    await expect(page.getByTestId('fsm-blocked-SLOT_MISMATCH')).toContainText('ar_finalize_signup_luz');
    await page.screenshot({ path: testInfo.outputPath('02-modal-previa.png') });

    // 3. O que sobra sem sincronizar: aviso explícito, nunca o corpo-ponteiro.
    await page.getByTestId('fsm-option-ar_finalize_signup_direct').click();
    await expect(page.getByTestId('fsm-preview-unsynced')).toBeVisible();
    await expect(page.getByTestId('fsm-modal')).not.toContainText('Content Builder');
    await page.screenshot({ path: testInfo.outputPath('03-modal-sem-texto.png') });

    await expect(page.getByTestId('fsm-modal')).toHaveScreenshot('fsm-picker-modal.png', { maxDiffPixelRatio: 0.05 });
  });
});
