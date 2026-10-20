/**
 * servico-dados-recrutamento-copiar-turnos.integration.e2e.ts @integration — 058b/B2 (T246): "Copiar a…" no editor de turnos do
 * serviço contratado, exercitado por um HUMANO contra o stack REAL (frontend + API + Postgres), sem interceptar rota e sem mock de
 * dado de negócio — só a auth é o mock do stack (`loginComoStaffMock`). Dado sintético, sem texto clínico.
 *
 * Canal real: NENHUM. Mapa do outbound: o PATCH do serviço (`ServiceSlotWriter.replaceServiceSlots`) só escreve em Postgres
 * (faixas do itinerário); o paciente não tem vaga ativa, então nada de Talentum/Twilio/Periskope/Ana Care/e-mail.
 *
 * Os testes (o nome do arquivo casa o `--grep servico-dados-recrutamento` do `pr-gate.yml`):
 *   1. FELIZ — copia o turno de segunda para terça–sexta e salva; o horário do serviço mostra os 5 dias;
 */
import { test, expect, type Page, type APIRequestContext } from '@playwright/test';
import { insertTestPatient, cleanupTestPatient } from '../helpers/db-test-helper';
import { sqlComVars } from '../helpers/sql-com-vars';
import { loginComoStaffMock } from '../helpers/login-mock-staff';
import { tokenFor, type MockUser } from '../helpers/abac-stack-helper';

const BACKEND_URL = process.env.E2E_BACKEND_URL ?? process.env.API_BASE_URL ?? 'http://localhost:8080';
const STAFF: MockUser = { uid: `e2e-copiar-turnos-${Date.now()}`, email: `e2e.copiar-turnos.${Date.now()}@enlite.health`, role: 'admin', country: 'AR' };
const AUTH_HEADERS = { Authorization: `Bearer ${tokenFor(STAFF)}`, 'Content-Type': 'application/json' };
const ABA_SERVICO = 'Servicio Contratado';

type Faixa = { dayOfWeek: number; startTime: string; durationMinutes: number };

test.describe('servico-dados-recrutamento-copiar-turnos — "Copiar a…" do editor de turnos @integration', () => {
  test.setTimeout(150_000);
  const pacientes: string[] = [];
  test.afterAll(() => { pacientes.forEach((id) => cleanupTestPatient(id)); });

  /** Paciente + serviço (endereço e horário) criados pela API; `providersNeeded: 1`. */
  async function semear(request: APIRequestContext, schedule: Faixa[]) {
    const seeded = insertTestPatient({
      status: 'PENDING_ADMISSION', firstName: 'CopiarTurnos', lastName: `Patient${Date.now()}${pacientes.length}`,
      withAddress: true, hasConsent: true, insuranceInformed: 'OSDE',
    });
    pacientes.push(seeded.patientId);
    expect(seeded.addressId, 'insertTestPatient não devolveu addressId').toBeTruthy();
    const svc = await request.post(`${BACKEND_URL}/api/admin/patients/${seeded.patientId}/contracted-services`, {
      headers: AUTH_HEADERS,
      data: { serviceCode: 'AT', providersNeeded: 1, careLocation: 'HOME', addressId: seeded.addressId, schedule },
    });
    expect(svc.ok(), `POST contracted-services falhou: ${svc.status()} ${await svc.text()}`).toBe(true);
    return { patientId: seeded.patientId, serviceId: (await svc.json()).data.id as string };
  }

  async function abrirCardDoServico(page: Page, patientId: string, serviceId: string): Promise<void> {
    await page.goto(`/admin/patients/${patientId}`);
    await page.getByTestId('patient-profile-tabs').getByRole('button', { name: ABA_SERVICO }).click();
    await expect(page.getByTestId(`contracted-service-row-${serviceId}`)).toBeVisible({ timeout: 20_000 });
  }

  async function abrirEdicao(page: Page, serviceId: string): Promise<void> {
    await page.getByTestId(`contracted-service-edit-${serviceId}`).click();
    await expect(page.getByRole('dialog', { name: 'Editar servicio contratado' })).toBeVisible();
  }

  const ehPatchDoServico = (serviceId: string) => (r: { method(): string; url(): string }): boolean =>
    r.method() === 'PATCH' && r.url().endsWith(`/contracted-services/${serviceId}`);

  const faixasVigentes = (serviceId: string): number =>
    Number(sqlComVars("SELECT count(*) FROM patient_itinerary_slot WHERE contracted_service_id = :'id'::uuid AND upper_inf(valid)", { id: serviceId }));

  /** Escolhe a hora no TimeSelect como um humano: abre a lista e clica na opção. */
  async function escolherHora(page: Page, testId: string, hora: string): Promise<void> {
    await page.getByTestId(testId).click();
    await page.getByTestId(`${testId}-option-${hora}`).click();
    await expect(page.getByTestId(testId)).toContainText(hora);
  }

  /** `GET …/contracted-services` real — o schedule do serviço como a API o devolve. */
  async function lerSchedule(request: APIRequestContext, patientId: string, serviceId: string): Promise<Array<Faixa & { endTime: string }> | null> {
    const res = await request.get(`${BACKEND_URL}/api/admin/patients/${patientId}/contracted-services`, { headers: AUTH_HEADERS });
    expect(res.status()).toBe(200);
    const json = (await res.json()) as { data?: { services: Array<{ id: string; schedule: Array<Faixa & { endTime: string }> | null }> } };
    const svc = (json.data?.services ?? []).find((x) => x.id === serviceId);
    if (!svc) throw new Error('copiar-turnos: serviço ausente no GET');
    return svc.schedule;
  }

  test('FELIZ: copia o turno de segunda para terça–sexta e salva; o horário do serviço mostra os 5 dias', async ({ page, request }) => {
    const { patientId, serviceId } = await semear(request, [{ dayOfWeek: 1, startTime: '09:00', durationMinutes: 480 }]);
    expect(faixasVigentes(serviceId), 'controle: antes de copiar só a segunda').toBe(1);
    await loginComoStaffMock(page, STAFF, 'E2E Copiar Turnos');
    await abrirCardDoServico(page, patientId, serviceId);
    await abrirEdicao(page, serviceId);

    await page.getByTestId('svc-shift-copy-1-1').click();
    await page.getByTestId('svc-shift-copy-weekdays-1').click();
    await page.getByTestId('svc-shift-copy-apply-1').click();
    for (const dia of [2, 3, 4, 5]) {
      await expect(page.getByTestId(`svc-shift-start-1-${dia}-0`)).toContainText('09:00');
    }

    const [patch] = await Promise.all([
      page.waitForResponse((r) => ehPatchDoServico(serviceId)(r.request())),
      page.getByTestId(`contracted-service-save-${serviceId}`).click(),
    ]);
    expect(patch.status()).toBe(200);
    expect(faixasVigentes(serviceId)).toBe(5);

    // Recarregar e reabrir: a tela hidrata os 5 dias — leitura da API, não estado local.
    await page.reload();
    await page.getByTestId('patient-profile-tabs').getByRole('button', { name: ABA_SERVICO }).click();
    await abrirEdicao(page, serviceId);
    for (const dia of [1, 2, 3, 4, 5]) {
      await expect(page.getByTestId(`svc-shift-start-1-${dia}-0`)).toContainText('09:00');
    }
  });

  test('ALTERNATIVO 1 (UI): terça já tem 10:00–12:00 → copiar 09:00–17:00 de segunda mantém o existente e mostra o aviso do dia; salvar grava só o existente', async ({ page, request }) => {
    const { patientId, serviceId } = await semear(request, [
      { dayOfWeek: 1, startTime: '09:00', durationMinutes: 480 },
      { dayOfWeek: 2, startTime: '10:00', durationMinutes: 120 },
    ]);
    await loginComoStaffMock(page, STAFF, 'E2E Copiar Turnos');
    await abrirCardDoServico(page, patientId, serviceId);
    await abrirEdicao(page, serviceId);

    await page.getByTestId('svc-shift-copy-1-1').click();
    await page.getByTestId('svc-shift-copy-target-1-tuesday').click();
    await page.getByTestId('svc-shift-copy-apply-1').click();
    await expect(page.getByTestId('svc-shift-copy-conflict-1-2')).toContainText('La franja ya existente se mantuvo en: martes');
    await expect(page.getByTestId('svc-shift-start-1-2-1')).toHaveCount(0);

    const [patch] = await Promise.all([
      page.waitForResponse((r) => ehPatchDoServico(serviceId)(r.request())),
      page.getByTestId(`contracted-service-save-${serviceId}`).click(),
    ]);
    expect(patch.status()).toBe(200);
    // Terça: só a faixa existente (120 min), nada copiado por cima.
    expect(
      Number(sqlComVars("SELECT count(*) FROM patient_itinerary_slot WHERE contracted_service_id = :'id'::uuid AND weekday = 2 AND upper_inf(valid)", { id: serviceId })),
    ).toBe(1);
    expect(
      Number(sqlComVars("SELECT count(*) FROM patient_itinerary_slot WHERE contracted_service_id = :'id'::uuid AND weekday = 2 AND upper_inf(valid) AND duration_minutes = 120", { id: serviceId })),
    ).toBe(1);
  });

  test('ALTERNATIVO 2 (servidor recusa): depois de copiar segunda → quarta, o humano soma à mão um turno 10:00–12:00 na quarta (a tela deixa) → Guardar → 409 SLOT_OVERLAP com mensagem; o horário não muda', async ({ page, request }) => {
    const { patientId, serviceId } = await semear(request, [{ dayOfWeek: 1, startTime: '09:00', durationMinutes: 480 }]);
    const antes = await lerSchedule(request, patientId, serviceId);
    expect(antes).toEqual([{ dayOfWeek: 1, startTime: '09:00', durationMinutes: 480, endTime: '17:00' }]);
    await loginComoStaffMock(page, STAFF, 'E2E Copiar Turnos');
    await abrirCardDoServico(page, patientId, serviceId);
    await abrirEdicao(page, serviceId);

    await page.getByTestId('svc-shift-copy-1-1').click();
    await page.getByTestId('svc-shift-copy-target-1-wednesday').click();
    await page.getByTestId('svc-shift-copy-apply-1').click();
    await expect(page.getByTestId('svc-shift-start-1-3-0')).toContainText('09:00');

    await page.getByTestId('svc-shift-add-1-3').click();
    await expect(page.getByTestId('svc-shift-start-1-3-1')).toBeVisible();
    await escolherHora(page, 'svc-shift-start-1-3-1', '10:00');
    await escolherHora(page, 'svc-shift-end-1-3-1', '12:00'); // 10:00–12:00 cruza o 09:00–17:00 copiado

    const [patch] = await Promise.all([
      page.waitForResponse((r) => ehPatchDoServico(serviceId)(r.request())),
      page.getByTestId(`contracted-service-save-${serviceId}`).click(),
    ]);
    expect(patch.status()).toBe(409);
    expect((await patch.json()).code).toBe('SLOT_OVERLAP');
    const aviso = page.getByTestId('svc-schedule-overlap-1');
    await expect(aviso).toBeVisible();
    await expect(aviso).toContainText('Dos turnos del mismo servicio se superponen.');

    expect(await lerSchedule(request, patientId, serviceId)).toEqual(antes); // nada gravado
  });
});
