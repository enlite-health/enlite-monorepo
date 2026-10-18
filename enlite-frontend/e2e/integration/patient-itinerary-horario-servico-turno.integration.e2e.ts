/**
 * patient-itinerary-horario-servico-turno.integration.e2e.ts @integration — spec 056 (Horas com dono
 * único), T1.13: o editor de turnos do serviço contratado (Inicio / Fin / Todo el día), exercitado por
 * um HUMANO contra o stack REAL (frontend + API + Postgres), sem mock de dado de negócio — só a auth é o
 * mock do stack (`loginAs`). Régua humana (memória `e2e-humano-nao-e-fill`): clique real nos controles
 * (o TimeSelect é um listbox de botões — não há campo de texto para digitar), valores lidos da TELA e
 * conferidos na API (`GET …/contracted-services`) na MESMA execução; nenhum preenchimento programático.
 *
 * Side-effect outbound mapeado ANTES: o PATCH do serviço só escreve em Postgres (sem vaga ativa neste
 * paciente, nada de Talentum/Twilio/Periskope/e-mail). O serviço nasce SEM horário (POST pela API real) e
 * o turno é montado pela tela.
 *
 * Os 4 testes (o nome do arquivo casa o `--grep patient-itinerary` do job padrão do `pr-gate.yml`):
 *   1. FELIZ — 20:00 → 08:00 mostra "12 h (+1)", grava durationMinutes 720 e a API devolve 720;
 *   2. ALTERNATIVO 1 — "Todo el día" desabilita Fin, mostra "24 h" e grava 1440;
 *   3. ALTERNATIVO 2 — Fin = Inicio é recusado com "Para 24 h use 'Todo el día'": Guardar bloqueado e
 *      nenhum PATCH sai (2 s de observação);
 *   4. ALTERNATIVO 3 — o servidor recusa: serviço já com seg 08:00 (240 min); adicionar seg 10:00 → 12:00 na tela
 *      e Guardar → 409 SLOT_OVERLAP aparece em `svc-schedule-overlap-1` e o GET confirma que o horário não mudou.
 */
import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import {
  mockAdminUserFor, useLancamentoStaff, LANCAMENTO_VIEWPORT_ES_AR, backendUrl, postContractedServiceViaApi,
} from '../helpers/lancamento-e2e-helper';
import { loginAs, tokenFor } from '../helpers/abac-stack-helper';
import { insertTestPatient } from '../helpers/db-test-helper';
import { cleanupPatientDeep } from '../helpers/patient-detail-a-helper';

const STAFF = mockAdminUserFor('horario-servico-turno');

/** Paciente com endereço + 1 serviço AT SEM horário (POST real); a tela monta o turno. */
async function seedServicoSemHorario(
  request: APIRequestContext,
  schedule?: Array<{ dayOfWeek: number; startTime: string; durationMinutes: number }>,
): Promise<{ patientId: string; serviceId: string }> {
  const { patientId, addressId } = insertTestPatient({ status: 'SEARCHING', withAddress: true, hasConsent: true, insuranceInformed: 'OSDE' });
  if (!addressId) throw new Error('patient-itinerary-horario-servico-turno: insertTestPatient sem addressId');
  try {
    const serviceId = await postContractedServiceViaApi(request, tokenFor(STAFF), patientId, {
      serviceCode: 'AT', providersNeeded: 1, careLocation: 'HOME', addressId,
      ...(schedule ? { schedule } : {}),
    });
    return { patientId, serviceId };
  } catch (err) {
    cleanupPatientDeep(patientId);
    throw err;
  }
}

/** Ficha → aba "Servicio Contratado" → lápis da linha → drawer de ediçãoe cria o turno 0 de segunda-feira pelo "+". */
async function abrirEditorEAdicionarTurno(page: Page, patientId: string, serviceId: string): Promise<void> {
  await page.goto(`/admin/patients/${patientId}`);
  await page.getByTestId('patient-profile-tabs').getByRole('button', { name: 'Servicio Contratado' }).click();
  await page.getByTestId(`contracted-service-edit-${serviceId}`).click();
  await expect(page.getByRole('dialog', { name: 'Editar servicio contratado' })).toBeVisible();
  await page.getByTestId('svc-shift-add-1-1').click(); // índice visual 1, segunda-feira (dayOfWeek 1)
  await expect(page.getByTestId('svc-shift-start-1-1-0')).toBeVisible();
}

/** Escolhe a hora no TimeSelect como um humano: abre a lista e clica na opção. */
async function escolherHora(page: Page, testId: string, hora: string): Promise<void> {
  await page.getByTestId(testId).click();
  await page.getByTestId(`${testId}-option-${hora}`).click();
  await expect(page.getByTestId(testId)).toContainText(hora);
}

/** `GET …/contracted-services` real — o schedule do serviço como a API o devolve. */
async function lerSchedule(request: APIRequestContext, patientId: string, serviceId: string): Promise<Array<{ dayOfWeek: number; startTime: string; durationMinutes: number }> | null> {
  const res = await request.get(`${backendUrl()}/api/admin/patients/${patientId}/contracted-services`, {
    headers: { Authorization: `Bearer ${tokenFor(STAFF)}` },
  });
  expect(res.status()).toBe(200);
  const json = (await res.json()) as { data?: { services: Array<{ id: string; schedule: Array<{ dayOfWeek: number; startTime: string; durationMinutes: number }> | null }> }; services?: Array<{ id: string; schedule: Array<{ dayOfWeek: number; startTime: string; durationMinutes: number }> | null }> };
  const services = json.data?.services ?? json.services ?? [];
  const svc = services.find((s) => s.id === serviceId);
  if (!svc) throw new Error('patient-itinerary-horario-servico-turno: serviço ausente no GET');
  return svc.schedule;
}

const ehPatchDoServico = (serviceId: string) => (r: { method(): string; url(): string }): boolean =>
  r.method() === 'PATCH' && r.url().endsWith(`/contracted-services/${serviceId}`);

test.describe('patient-itinerary-horario-servico-turno: turno Inicio/Fin/Todo el día do serviço @integration', () => {
  test.use({ ...LANCAMENTO_VIEWPORT_ES_AR, deviceScaleFactor: 1 });
  test.setTimeout(120_000);
  useLancamentoStaff(STAFF, 'E2E Horario Servico Turno');

  test('FELIZ: digitar 20:00 → 08:00 grava 720 min e mostra 12 h', async ({ page, request }) => {
    const { patientId, serviceId } = await seedServicoSemHorario(request);
    try {
      await loginAs(page, STAFF);
      await abrirEditorEAdicionarTurno(page, patientId, serviceId);
      await escolherHora(page, 'svc-shift-start-1-1-0', '20:00');
      await escolherHora(page, 'svc-shift-end-1-1-0', '08:00');
      const duracao = page.getByTestId('svc-shift-duration-1-1-0');
      await expect(duracao).toContainText('12 h');
      await expect(duracao).toContainText('(+1)');

      const [patch] = await Promise.all([
        page.waitForResponse((r) => ehPatchDoServico(serviceId)(r.request())),
        page.getByTestId(`contracted-service-save-${serviceId}`).click(),
      ]);
      expect(patch.status()).toBe(200);
      expect(await lerSchedule(request, patientId, serviceId)).toEqual([{ dayOfWeek: 1, startTime: '20:00', durationMinutes: 720 }]);

      // Recarregar e reabrir: a tela hidrata o MESMO turno (12 h) — leitura da API, não estado local.
      await page.reload();
      await page.getByTestId('patient-profile-tabs').getByRole('button', { name: 'Servicio Contratado' }).click();
      await page.getByTestId(`contracted-service-edit-${serviceId}`).click();
      await expect(page.getByTestId('svc-shift-duration-1-1-0')).toContainText('12 h');
    } finally {
      cleanupPatientDeep(patientId);
    }
  });

  test('ALTERNATIVO 1: Todo el día desabilita Fin, mostra 24 h e grava 1440', async ({ page, request }) => {
    const { patientId, serviceId } = await seedServicoSemHorario(request);
    try {
      await loginAs(page, STAFF);
      await abrirEditorEAdicionarTurno(page, patientId, serviceId);
      await page.getByTestId('svc-shift-allday-1-1-0').click();
      await expect(page.getByTestId('svc-shift-end-1-1-0')).toBeDisabled();
      await expect(page.getByTestId('svc-shift-duration-1-1-0')).toContainText('24 h');

      const [patch] = await Promise.all([
        page.waitForResponse((r) => ehPatchDoServico(serviceId)(r.request())),
        page.getByTestId(`contracted-service-save-${serviceId}`).click(),
      ]);
      expect(patch.status()).toBe(200);
      const schedule = await lerSchedule(request, patientId, serviceId);
      expect(schedule?.map((s) => s.durationMinutes)).toEqual([1440]);
    } finally {
      cleanupPatientDeep(patientId);
    }
  });

  test('ALTERNATIVO 2: Fin = Inicio é recusado com "Para 24 h use \'Todo el día\'" e nenhum PATCH sai', async ({ page, request }) => {
    const { patientId, serviceId } = await seedServicoSemHorario(request);
    try {
      await loginAs(page, STAFF);
      await abrirEditorEAdicionarTurno(page, patientId, serviceId);
      await escolherHora(page, 'svc-shift-end-1-1-0', '09:00'); // o turno nasce 09:00–17:00 → Fin = Inicio
      await expect(page.getByTestId('svc-shift-error-1-1-0')).toContainText("Para 24 h use 'Todo el día'");

      const salvar = page.getByTestId(`contracted-service-save-${serviceId}`);
      await expect(salvar).toBeDisabled();
      const saiuPatch = page
        .waitForRequest((r) => ehPatchDoServico(serviceId)(r), { timeout: 2_000 })
        .then(() => true, () => false);
      await salvar.click({ force: true });
      expect(await saiuPatch).toBe(false);
      expect(await lerSchedule(request, patientId, serviceId)).toBeNull();
    } finally {
      cleanupPatientDeep(patientId);
    }
  });

  test('ALTERNATIVO 3: 409 SLOT_OVERLAP aparece na tela e o horário não muda', async ({ page, request }) => {
    const faixaOriginal = [{ dayOfWeek: 1, startTime: '08:00', durationMinutes: 240 }]; // seg 08:00–12:00
    const { patientId, serviceId } = await seedServicoSemHorario(request, faixaOriginal);
    try {
      await loginAs(page, STAFF);
      await page.goto(`/admin/patients/${patientId}`);
      await page.getByTestId('patient-profile-tabs').getByRole('button', { name: 'Servicio Contratado' }).click();
      await page.getByTestId(`contracted-service-edit-${serviceId}`).click();
      await expect(page.getByRole('dialog', { name: 'Editar servicio contratado' })).toBeVisible();
      await expect(page.getByTestId('svc-shift-start-1-1-0')).toContainText('08:00'); // a faixa do servidor chegou na tela

      await page.getByTestId('svc-shift-add-1-1').click(); // 2º turno de segunda
      await expect(page.getByTestId('svc-shift-start-1-1-1')).toBeVisible();
      await escolherHora(page, 'svc-shift-start-1-1-1', '10:00');
      await escolherHora(page, 'svc-shift-end-1-1-1', '12:00'); // 10:00–12:00 cruza 08:00–12:00

      const [patch] = await Promise.all([
        page.waitForResponse((r) => ehPatchDoServico(serviceId)(r.request())),
        page.getByTestId(`contracted-service-save-${serviceId}`).click(),
      ]);
      expect(patch.status()).toBe(409);
      const aviso = page.getByTestId('svc-schedule-overlap-1');
      await expect(aviso).toBeVisible();
      await expect(aviso).toContainText('Dos turnos del mismo servicio se superponen.');

      expect(await lerSchedule(request, patientId, serviceId)).toEqual(faixaOriginal); // nada gravado
    } finally {
      cleanupPatientDeep(patientId);
    }
  });
});
