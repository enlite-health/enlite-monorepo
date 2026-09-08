/**
 * servico-horario-obrigatorio-humano.integration.e2e.ts @integration — decisão do Gabriel, 07/09/2026
 *
 * A regra: o horário do serviço contratado CONTINUA opcional para salvar, mas o paciente não muda
 * de status para activo/búsqueda/reemplazo sem ele. Este spec prova que o OPERADOR é avisado — em
 * TELA, com mouse e teclado reais (nada de `fill`/`evaluate`: a régua humana da D287).
 *
 * O que ele mede, na ordem em que o operador encontra:
 *   1. no formulário, salvar sem horário CONTINUA funcionando, mas a tela avisa em âmbar o que
 *      vai acontecer depois (avisar na carga é mais barato que descobrir na ativação);
 *   2. na tabela do card, "Sin horario" aparece em âmbar, não em cinza neutro;
 *   3. o checklist da ficha lista "Horario del servicio", e clicar na pílula ABRE o serviço certo;
 *   4. o botão "Activar paciente" recusa e NOMEIA o que falta;
 *   5. depois de preencher o horário, o mesmo botão ativa.
 *
 * API e Postgres reais (stack docker), login real pelo emulador do Firebase.
 */
import { test, expect, type Page } from '@playwright/test';
import { seedActivatablePatient, cleanupPatientDeep, runSQL } from '../helpers/patient-detail-c-helper';

const EMULATOR = process.env.E2E_FIREBASE_EMULATOR || 'http://127.0.0.1:9099';
const EMULATOR_PROJECT = 'demo-no-project';
const STAFF_EMAIL = `e2e.horario.${Date.now()}@enlite.health`;
const STAFF_PASSWORD = 'TestAdmin123!';

/** Login como um humano: clica no campo, digita, clica no botão. Sem `fill`. */
async function loginComoHumano(page: Page): Promise<void> {
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
  runSQL(`INSERT INTO users (firebase_uid, email, display_name, role, is_active, email_verified) VALUES ('${localId}', '${STAFF_EMAIL}', 'E2E Horario', 'admin', true, true) ON CONFLICT (firebase_uid) DO NOTHING`);
  await page.addInitScript(() => localStorage.setItem('i18nextLng', 'es'));
  await page.goto('/admin/login');
  await page.locator('input[type="email"]').click();
  await page.keyboard.type(STAFF_EMAIL);
  await page.locator('input[type="password"]').click();
  await page.keyboard.type(STAFF_PASSWORD);
  await page.getByRole('button', { name: /Iniciar sesi/i }).click();
  await expect(page).not.toHaveURL(/login/, { timeout: 30_000 });
}

test.use({ viewport: { width: 1600, height: 1000 }, video: 'on' });

test.describe('Horário obrigatório para mudar de status — o operador é avisado EM TELA @integration', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(240_000);

  let seed: { patientId: string; addressId: string; stamp: string };

  // faixa própria de `case_number` (700000–789999): não colide com o C (900000) nem com o humano (800000)
  test.beforeAll(() => { seed = seedActivatablePatient(700000); });
  test.afterAll(() => { cleanupPatientDeep(seed.patientId); });

  test('salvar sem horário avisa em âmbar, a ativação é recusada nomeando o que falta, e preencher o horário destrava', async ({ page }) => {
    await loginComoHumano(page);
    await page.goto(`/admin/patients/${seed.patientId}`);

    // ── 1. O formulário: o aviso aparece ANTES de salvar, com o horário vazio ──
    await page.getByTestId('patient-profile-tabs').getByRole('button', { name: 'Servicio Contratado' }).click();
    await page.getByTestId('new-service-btn').click();
    await expect(page.getByTestId('patient-contracted-services-edit-drawer')).toBeVisible();

    const avisoForm = page.getByTestId('svc-schedule-none-1');
    await expect(avisoForm).toBeVisible();
    await expect(avisoForm).toHaveAttribute('role', 'alert');
    await expect(avisoForm).toContainText('todavía no tiene horario');
    await expect(avisoForm).toContainText('activo, búsqueda ni reemplazo');

    // o campo segue OPCIONAL: o rótulo diz "(opcional)", não tem asterisco
    const rotulo = page.locator('label[for="svc-schedule-1"]');
    await expect(rotulo).toContainText('(opcional)');
    await expect(rotulo.locator('.text-red-500')).toHaveCount(0);

    // ── 2. Salvar SEM horário continua funcionando (a decisão de 05/09 não foi revogada) ──
    await page.getByTestId('svc-code-1').selectOption('AT');
    await page.getByTestId('svc-addressId-1').selectOption(seed.addressId);
    await page.getByTestId('contracted-service-new-save').click();
    // 06/09: salvar NÃO fecha — o drawer troca para a EDIÇÃO do recém-criado. O aviso âmbar
    // continua ali, porque o serviço segue sem horário.
    await expect(page.getByRole('dialog', { name: 'Editar servicio contratado' })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('svc-schedule-none-1')).toBeVisible();
    await page.getByLabel('Cerrar').click();
    await expect(page.getByTestId('patient-contracted-services-edit-drawer')).not.toBeVisible();

    // ── 3. A tabela: "Sin horario" em ÂMBAR, não um traço cinza ──
    const celulaSemHorario = page.locator('[data-testid^="contracted-service-schedule-missing-"]').first();
    await expect(celulaSemHorario).toBeVisible();
    await expect(celulaSemHorario).toHaveText('Sin horario');
    await expect(celulaSemHorario).toHaveClass(/text-amber-700/);
    // A CLASSE não prova a cor: o `Text` emite `text-gray-800` por default e vence pela ordem de
    // emissão do Tailwind. A 1ª versão desta célula passou no teste unitário e apareceu CINZA na
    // tela (medido: rgb(115,115,115)). Aqui a régua é a cor computada, não o atributo.
    const corHorario = await celulaSemHorario.evaluate((el) => getComputedStyle(el).color);
    expect(corHorario).toBe('rgb(180, 83, 9)'); // amber-700

    // ── 4. O checklist da ficha nomeia a pendência e LEVA até ela ──
    // a pílula bloqueante tem testid fixo (`completeness-item`); o código vem no TEXTO
    const pilula = page.getByTestId('completeness-item').filter({ hasText: 'Horario del servicio' });
    await expect(pilula).toBeVisible();
    await pilula.click();
    // clicar na pílula abre o drawer JÁ no serviço que está sem horário — a prova de que é ELE
    // (e não um "+ Nuevo") é o serviço vir hidratado: o select de código fica travado na edição.
    const drawer = page.getByTestId('patient-contracted-services-edit-drawer');
    await expect(drawer).toBeVisible();
    await expect(page.getByTestId('svc-code-1')).toBeDisabled();
    await expect(page.getByTestId('svc-schedule-none-1')).toBeVisible();

    // ── 5. Preencher o horário como humano: clicar no dia, e o aviso some ──
    await page.getByTestId('day-schedule-add-monday').click();
    // o aviso âmbar some assim que existe um slot — o operador vê a pendência sair na hora
    await expect(page.getByTestId('svc-schedule-none-1')).toHaveCount(0);
    // Esperar a resposta REAL do PATCH antes de fechar: clicar em "Cerrar" com o formulário ainda
    // sujo abre o "¿Descartar los cambios?" — o app está certo, o teste é que ia rápido demais.
    const salvou = page.waitForResponse(
      (r) => /\/contracted-services\//.test(r.url()) && r.request().method() === 'PATCH' && r.ok(),
      { timeout: 20_000 },
    );
    await page.locator('[data-testid^="contracted-service-save-"]').first().click();
    await salvou;
    await page.getByLabel('Cerrar').click();
    await expect(drawer).not.toBeVisible({ timeout: 15_000 });

    // ── 6. A pendência sai do checklist e a célula deixa de ser âmbar ──
    await expect(page.getByTestId('completeness-item').filter({ hasText: 'Horario del servicio' })).toHaveCount(0);
    await expect(page.locator('[data-testid^="contracted-service-schedule-missing-"]')).toHaveCount(0);

    // ── 7. Com horário, "Activar paciente" ativa ──
    // Recarrega como o operador faria: o pedido de foco do checklist sobrevive ao refetch do card
    // (o `useRef` do `useAutoOpenDrawer` zera na remontagem) e reabre o drawer no fallback
    // "+ Nuevo". É o comportamento que o SERVICE_ADDRESS já tinha desde 06/09 — anotado como
    // achado à parte, não consertado aqui.
    await page.reload();
    await expect(page.getByTestId('patient-contracted-services-edit-drawer')).toHaveCount(0);
    await page.getByTestId('activate-patient-btn').click();
    await page.getByTestId('activate-confirm').click();
    // ativado: o botão some (o checklist/botão só aparecem em ADMISSION/PENDING_ADMISSION)
    await expect(page.getByTestId('activate-patient-btn')).toHaveCount(0, { timeout: 20_000 });
  });

  test('sem horário, "Activar paciente" é RECUSADO e a tela NOMEIA o que falta', async ({ page }) => {
    // paciente próprio: o do teste anterior já foi ativado
    const s2 = seedActivatablePatient(710000);
    try {
      // serviço com endereço e SEM horário, direto no banco (o caminho que o operador teria feito)
      runSQL(
        `INSERT INTO patient_contracted_services (patient_id, service_code, active, country, created_by, updated_by, address_id, schedule)
         VALUES ('${s2.patientId}', 'AT', true, 'AR', 'e2e-horario', 'e2e-horario', '${s2.addressId}', NULL)`,
      );

      await loginComoHumano(page);
      await page.goto(`/admin/patients/${s2.patientId}`);

      await page.getByTestId('activate-patient-btn').click();
      await page.getByTestId('activate-confirm').click();

      // a mensagem de erro nomeia o item com a MESMA palavra do checklist
      const erro = page.getByTestId('activate-error');
      await expect(erro).toBeVisible({ timeout: 20_000 });
      await expect(erro).toContainText('Horario del servicio');

      // e o paciente NÃO foi ativado
      const status = runSQL(`SELECT status FROM patients WHERE id = '${s2.patientId}'`).trim();
      expect(status).toBe('PENDING_ADMISSION');
    } finally {
      cleanupPatientDeep(s2.patientId);
    }
  });
});
