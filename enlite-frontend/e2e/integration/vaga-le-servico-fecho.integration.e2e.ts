/**
 * vaga-le-servico-fecho.integration.e2e.ts @integration — F8 de `vaga-le-do-servico-contratado` (e2e de FECHO, por TELA).
 *
 * Backend real (Docker `enlite-api`) + Postgres real + frontend real. Zero mock de API (só o login, pelo mock do stack
 * de CI). Dado sintético, sem clínico, nenhum canal real: a vaga nasce do serviço contratado pelo foguete (API) e é
 * publicada por SQL (`is_draft=false`; sem Talentum). O operador faz o que faria: clique real e teclado real, na ficha
 * do paciente (aba "Servicio Contratado" → lápis do serviço → formulário) e no detalhe da vaga. Nenhum `fill()`; nenhum
 * PUT/PATCH no lugar do formulário (a API só monta o cenário e lê de volta).
 *
 *  1. muda o HORÁRIO no serviço → abre a vaga e vê o horário novo (e as colunas da vaga seguem NULL);
 *  2. a vaga publicada mostra a faixa de aviso → "marcar como atendido" → some, e continua sumida após recarregar;
 *  3. tenta APAGAR o horário com a vaga viva → o erro aparece na tela (422) e o serviço não muda;
 *  4. QUANTIDADE: muda no serviço → a vaga mostra o novo valor (e abre o aviso do campo);
 *  5. FAIXA etária: muda a banda no serviço → a vaga mostra a nova faixa (e abre o aviso do campo);
 *  6. vaga MANUAL: o lápis do horário abre o modal e salva, como antes — e o serviço do paciente não a afeta.
 *
 * O CI roda este portão com `--ignore-snapshots` (`toHaveScreenshot` existe pela regra do projeto; baseline é gitignored).
 */
import { test, expect, type Page } from '@playwright/test';
import { insertTestPatient, cleanupTestPatient, cleanupVacancies } from '../helpers/db-test-helper';
import { runSQL } from '../helpers/patient-detail-a-helper';
import { loginComoStaffMock } from '../helpers/login-mock-staff';
import { tokenFor, type MockUser } from '../helpers/abac-stack-helper';

const BACKEND_URL = process.env.E2E_BACKEND_URL ?? process.env.API_BASE_URL ?? 'http://localhost:8080';
const STAFF: MockUser = { uid: `e2e-vaga-servico-fecho-${Date.now()}`, email: `e2e.vaga-servico-fecho.${Date.now()}@enlite.health`, role: 'admin', country: 'AR' };
const AUTH_HEADERS = { Authorization: `Bearer ${tokenFor(STAFF)}`, 'Content-Type': 'application/json' };

const ABA_SERVICO = 'Servicio Contratado';
// As 3 colunas migradas da vaga que nasceu de um serviço: NUNCA escritas (psql -tA: `t` = tudo NULL).
const SQL_COLUNAS_NULAS = (id: string) =>
  `SELECT (schedule IS NULL AND providers_needed IS NULL AND age_range_min IS NULL AND age_range_max IS NULL) FROM job_postings WHERE id = '${id}'`;

test.describe('vaga-le-servico-fecho — F8 (vaga-le-do-servico-contratado) @integration', () => {
  // Uma vaga com serviço, compartilhada e mutada em sequência; a vaga MANUAL é semeada à parte no fim.
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(120_000);

  let patientId = '';
  let serviceId = '';
  let vacancyId = '';
  let manualVacancyId = '';

  test.beforeAll(async ({ request }) => {
    const seeded = insertTestPatient({
      status: 'PENDING_ADMISSION',
      firstName: 'ServicoFecho',
      lastName: `Patient${Date.now()}`,
      withAddress: true,
      hasConsent: true,
      insuranceInformed: 'OSDE',
    });
    patientId = seeded.patientId;
    const addressId = seeded.addressId ?? '';
    expect(addressId, 'insertTestPatient não devolveu addressId').toBeTruthy();

    const svc = await request.post(`${BACKEND_URL}/api/admin/patients/${patientId}/contracted-services`, {
      headers: AUTH_HEADERS,
      data: {
        serviceCode: 'AT',
        providersNeeded: 2,
        weeklyHours: 20,
        careLocation: 'HOME',
        providerAgeBand: 'AGE_20_30', // → vaga 20 - 29
        addressId,
        schedule: [{ dayOfWeek: 1, startTime: '08:00', endTime: '12:00' }],
      },
    });
    expect(svc.ok(), `POST contracted-services falhou: ${svc.status()} ${await svc.text()}`).toBe(true);
    serviceId = (await svc.json()).data.id as string;

    const act = await request.post(`${BACKEND_URL}/api/admin/patients/${patientId}/contracted-services/${serviceId}/activate-recruitment`, {
      headers: AUTH_HEADERS,
    });
    expect(act.ok(), `activate-recruitment falhou: ${act.status()} ${await act.text()}`).toBe(true);
    vacancyId = (await act.json()).data.vacancyId as string;

    // Publicada: só o bit `is_draft` importa para a tela e para o aviso (mesmo arranjo do spec da F4).
    runSQL(`UPDATE job_postings SET is_draft = false WHERE id = '${vacancyId}'`);
  });

  test.afterAll(() => {
    if (manualVacancyId) cleanupVacancies([manualVacancyId]);
    cleanupTestPatient(patientId);
  });

  /** Ficha → aba "Servicio Contratado" → lápis da linha do serviço → formulário do serviço aberto. */
  async function abrirFormularioDoServico(page: Page): Promise<void> {
    await page.goto(`/admin/patients/${patientId}`);
    await page.getByTestId('patient-profile-tabs').getByRole('button', { name: ABA_SERVICO }).click();
    await expect(page.getByTestId(`contracted-service-row-${serviceId}`)).toBeVisible({ timeout: 20_000 });
    await page.getByTestId(`contracted-service-edit-${serviceId}`).click();
    await expect(page.getByTestId(`contracted-service-form-${serviceId}`)).toBeVisible({ timeout: 15_000 });
  }

  /** Clique em "Guardar" do serviço e a resposta REAL do PATCH (o app não fecha sozinho; quem espera é o teste). */
  async function guardarServico(page: Page): Promise<number> {
    const [resposta] = await Promise.all([
      page.waitForResponse(
        (r) => r.request().method() === 'PATCH' && new RegExp(`/contracted-services/${serviceId}$`).test(r.url()),
        { timeout: 20_000 },
      ),
      page.getByTestId(`contracted-service-save-${serviceId}`).click(),
    ]);
    return resposta.status();
  }

  async function abrirVaga(page: Page, id: string): Promise<void> {
    await page.goto(`/admin/vacancies/${id}`);
    await expect(page.getByTestId('vacancy-profession-card')).toBeVisible({ timeout: 20_000 });
  }

  const linhaDoRotulo = (page: Page, rotulo: string) => page.getByText(rotulo, { exact: true }).first().locator('..');

  test('1. o operador muda o HORÁRIO na aba Servicio Contratado e a vaga mostra o horário novo', async ({ page }) => {
    await loginComoStaffMock(page, STAFF, 'E2E Servico Fecho');

    // Antes: a vaga mostra o horário original do serviço (segunda 08:00-12:00) e NÃO mostra o que vamos incluir.
    await abrirVaga(page, vacancyId);
    await expect(page.getByTestId('vacancy-profession-card')).toContainText('08:00h - 12:00h');
    await expect(page.getByTestId('vacancy-profession-card')).not.toContainText('09:00h - 17:00h');

    // O operador inclui um turno na quarta (clique no "+" do dia: nasce 09:00-17:00) e guarda.
    await abrirFormularioDoServico(page);
    await page.getByTestId('day-schedule-add-wednesday').click();
    expect(await guardarServico(page)).toBe(200);

    // Abre a vaga: o horário novo está lá, o antigo continua (era segunda), e a vaga não guardou cópia nenhuma.
    await abrirVaga(page, vacancyId);
    const card = page.getByTestId('vacancy-profession-card');
    await expect(card).toContainText('09:00h - 17:00h');
    await expect(card).toContainText('08:00h - 12:00h');
    await expect(card).toHaveScreenshot('vaga-le-servico-fecho-horario-integration.png', { maxDiffPixelRatio: 0.02 });
    expect(runSQL(SQL_COLUNAS_NULAS(vacancyId))).toBe('t');
  });

  test('2. vaga publicada: a faixa de aviso aparece, "marcar como atendido" a fecha e ela não volta ao recarregar', async ({ page, request }) => {
    // O aviso do teste 1 está aberto no backend (lido do GET, não assumido).
    const antes = (await (await request.get(`${BACKEND_URL}/api/admin/vacancies/${vacancyId}`, { headers: AUTH_HEADERS })).json()).data;
    expect(antes.source_change_notices.map((n: { field: string }) => n.field)).toEqual(['schedule']);

    await loginComoStaffMock(page, STAFF, 'E2E Servico Fecho');
    await abrirVaga(page, vacancyId);
    await expect(page.getByTestId('source-change-notice-banner')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('source-change-notice-schedule')).toBeVisible();

    const [ack] = await Promise.all([
      page.waitForResponse((r) => r.request().method() === 'POST' && /\/source-change-notices\/schedule\/ack$/.test(r.url())),
      page.getByTestId('source-change-notice-ack-schedule').click(),
    ]);
    expect(ack.status()).toBe(200);
    await expect(page.getByTestId('source-change-notice-banner')).toHaveCount(0, { timeout: 15_000 });

    await page.reload();
    await expect(page.getByTestId('vacancy-profession-card')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('source-change-notice-banner')).toHaveCount(0);
    const depois = (await (await request.get(`${BACKEND_URL}/api/admin/vacancies/${vacancyId}`, { headers: AUTH_HEADERS })).json()).data;
    expect(depois.source_change_notices).toEqual([]);
  });

  test('3. apagar o horário do serviço com a vaga viva: o erro aparece na tela e o serviço não muda', async ({ page }) => {
    await loginComoStaffMock(page, STAFF, 'E2E Servico Fecho');
    await abrirFormularioDoServico(page);

    // Remove, um clique de cada vez, todos os turnos que o serviço tem (segunda e quarta).
    const remover = page.locator('[data-testid^="day-schedule-remove-"]');
    await expect(remover.first()).toBeVisible();
    while ((await remover.count()) > 0) await remover.first().click();
    await expect(page.getByTestId('svc-schedule-none-1')).toBeVisible(); // o aviso âmbar de "sem horário" acende

    expect(await guardarServico(page)).toBe(422); // SERVICE_FIELD_REQUIRED_BY_LIVE_VACANCY
    const erro = page.getByTestId(`contracted-service-error-${serviceId}`);
    await expect(erro).toBeVisible({ timeout: 15_000 });
    await expect(erro).toContainText('No se pudo actualizar el servicio');

    // Nada foi apagado: o serviço segue com os 2 turnos, a vaga segue lendo o horário.
    expect(runSQL(`SELECT jsonb_array_length(schedule) FROM patient_contracted_services WHERE id = '${serviceId}'`)).toBe('2');
    await abrirVaga(page, vacancyId);
    await expect(page.getByTestId('vacancy-profession-card')).toContainText('09:00h - 17:00h');
  });

  test('4. QUANTIDADE: o operador muda no serviço e a vaga mostra o novo valor (com o aviso do campo)', async ({ page, request }) => {
    await loginComoStaffMock(page, STAFF, 'E2E Servico Fecho');
    await abrirVaga(page, vacancyId);
    await expect(linhaDoRotulo(page, 'Cantidad de Profesionales:')).toContainText('2');

    await abrirFormularioDoServico(page);
    const campo = page.getByTestId('svc-providersNeeded-1');
    await campo.click();
    await page.keyboard.press('End');
    await page.keyboard.press('Backspace'); // apaga o "2"
    await page.keyboard.type('3');
    expect(await guardarServico(page)).toBe(200);

    await abrirVaga(page, vacancyId);
    await expect(linhaDoRotulo(page, 'Cantidad de Profesionales:')).toContainText('3');
    await expect(page.getByTestId('source-change-notice-providers_needed')).toBeVisible();
    const d = (await (await request.get(`${BACKEND_URL}/api/admin/vacancies/${vacancyId}`, { headers: AUTH_HEADERS })).json()).data;
    expect(d.providers_needed).toBe('3');
    expect(runSQL(SQL_COLUNAS_NULAS(vacancyId))).toBe('t');
  });

  test('5. FAIXA etária: o operador muda a banda no serviço e a vaga mostra a nova faixa (com o aviso do campo)', async ({ page, request }) => {
    await loginComoStaffMock(page, STAFF, 'E2E Servico Fecho');
    await abrirVaga(page, vacancyId);
    await expect(linhaDoRotulo(page, 'Rango etario:')).toContainText('20 - 29');

    await abrirFormularioDoServico(page);
    await page.getByTestId('svc-providerAgeBand-1').selectOption('AGE_30_45'); // → 30 - 44
    expect(await guardarServico(page)).toBe(200);

    await abrirVaga(page, vacancyId);
    await expect(linhaDoRotulo(page, 'Rango etario:')).toContainText('30 - 44');
    await expect(page.getByTestId('source-change-notice-age_range')).toBeVisible();
    const d = (await (await request.get(`${BACKEND_URL}/api/admin/vacancies/${vacancyId}`, { headers: AUTH_HEADERS })).json()).data;
    expect([d.age_range_min, d.age_range_max]).toEqual([30, 44]);
    expect(runSQL(SQL_COLUNAS_NULAS(vacancyId))).toBe('t');
  });

  test('6. vaga MANUAL: o lápis do horário abre o modal e salva, como hoje — e o serviço do paciente não a afeta', async ({ page, request }) => {
    // Vaga manual (sem contracted_service_id) do mesmo paciente: dona do próprio horário (sexta 16:30-18:30).
    manualVacancyId = runSQL(
      `INSERT INTO job_postings (title, patient_id, status, is_draft, required_professions, country, is_test, schedule)
       VALUES ('CASO fecho-F8 manual', '${patientId}', 'SEARCHING', false, ARRAY['AT'], 'AR', true,
               '[{"dayOfWeek": 5, "startTime": "16:30", "endTime": "18:30"}]'::jsonb) RETURNING id`,
    ).split('\n')[0].trim();
    expect(manualVacancyId).toMatch(/^[0-9a-f-]{36}$/);

    await loginComoStaffMock(page, STAFF, 'E2E Servico Fecho');
    await abrirVaga(page, manualVacancyId);
    await expect(page.getByTestId('vacancy-profession-card')).toContainText('16:30h - 18:30h');

    // Manual: o lápis é o BOTÃO que abre o modal (não o link para a ficha).
    await expect(page.getByTestId('vacancy-schedule-service-link')).toHaveCount(0);
    await page.getByTestId('vacancy-edit-schedule-trigger').click();
    await expect(page.getByTestId('vacancy-schedule-modal')).toBeVisible();
    await page.getByTestId('day-schedule-add-tuesday').click(); // nasce 09:00-17:00
    const [put] = await Promise.all([
      page.waitForResponse((r) => r.request().method() === 'PUT' && r.url().includes(`/api/admin/vacancies/${manualVacancyId}`)),
      page.getByTestId('vacancy-schedule-save').click(),
    ]);
    expect(put.status()).toBe(200);
    await expect(page.getByTestId('vacancy-schedule-modal')).toHaveCount(0, { timeout: 15_000 });

    await page.reload();
    const card = page.getByTestId('vacancy-profession-card');
    await expect(card).toBeVisible({ timeout: 20_000 });
    await expect(card).toContainText('09:00h - 17:00h');
    await expect(card).toContainText('16:30h - 18:30h');
    expect(runSQL(`SELECT jsonb_array_length(schedule) FROM job_postings WHERE id = '${manualVacancyId}'`)).toBe('2'); // aqui a coluna É o dado

    // O serviço do paciente muda o horário: a vaga manual não é vaga dele — nada muda nela, nem aviso.
    const patch = await request.patch(`${BACKEND_URL}/api/admin/patients/${patientId}/contracted-services/${serviceId}`, {
      headers: AUTH_HEADERS,
      data: { schedule: [{ dayOfWeek: 6, startTime: '10:00', endTime: '14:00' }] },
    });
    expect(patch.ok(), `PATCH do serviço falhou: ${patch.status()} ${await patch.text()}`).toBe(true);
    await page.reload();
    await expect(card).toBeVisible({ timeout: 20_000 });
    await expect(card).not.toContainText('10:00h - 14:00h');
    await expect(card).toContainText('16:30h - 18:30h');
    await expect(page.getByTestId('source-change-notice-banner')).toHaveCount(0);
    await expect(card).toHaveScreenshot('vaga-le-servico-fecho-manual-integration.png', { maxDiffPixelRatio: 0.02 });
  });
});
