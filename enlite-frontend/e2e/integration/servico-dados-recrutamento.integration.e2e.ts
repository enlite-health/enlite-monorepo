/**
 * servico-dados-recrutamento.integration.e2e.ts @integration — spec 027 Fase 3 (T030), e2e de FECHO por TELA.
 *
 * Os 5 campos do serviço contratado que a vaga copia (tipo de prestador, sexo, experiência, jornada, dia de pagamento
 * ao prestador) e o portão "Activar reclutamiento" (D508 c). Backend real + Postgres real + frontend real, login pelo
 * mock do stack de CI. Dado sintético, sem texto clínico.
 *
 * Canal real: NENHUM. Mapa do outbound do `activate-recruitment` neste commit: 1 INSERT em `job_postings` (rascunho,
 * `is_draft=true`, status PENDING_ACTIVATION), 1 movimento de status do paciente e 1 linha de auditoria. Não emite
 * `vacancy.created`, não chama Talentum, Gemini nem WhatsApp. (Se uma fase futura passar a emitir o evento, o
 * `VacancyAutoInviteHandler` só tem a guarda `is_test` — este spec teria de semear `is_test=true` antes.)
 *
 *  1. feliz: a recrutadora preenche os campos do serviço com click + teclado, guarda, ativa → a vaga nasce rascunho com os
 *     5 valores (lidos da TELA de edição da vaga; experiência e jornada não têm rótulo em nenhuma tela da vaga, então
 *     esses dois são conferidos no banco) e SEM os dois de ficha;
 *  2. alternativo: faltando o sexo → o botão fica desabilitado e o motivo traduzido aparece no tooltip;
 *  3. alternativo: os 5 preenchidos e os dois de ficha vazios → botão habilitado; a vaga não traz atributos/observações.
 *
 * Gesto humano: click + `keyboard.type` nos textos (nunca `fill`); a API só monta o cenário e lê de volta.
 */
import { test, expect, type Page } from '@playwright/test';
import { RECRUITMENT_FIELDS_E2E } from '../helpers/recruitment-fields-e2e';
import { insertTestPatient, cleanupTestPatient } from '../helpers/db-test-helper';
import { runSQL } from '../helpers/patient-detail-a-helper';
import { loginComoStaffMock } from '../helpers/login-mock-staff';
import { tokenFor, type MockUser } from '../helpers/abac-stack-helper';

const BACKEND_URL = process.env.E2E_BACKEND_URL ?? process.env.API_BASE_URL ?? 'http://localhost:8080';
const STAFF: MockUser = { uid: `e2e-servico-recrutamento-${Date.now()}`, email: `e2e.servico-recrutamento.${Date.now()}@enlite.health`, role: 'admin', country: 'AR' };
const AUTH_HEADERS = { Authorization: `Bearer ${tokenFor(STAFF)}`, 'Content-Type': 'application/json' };
const ABA_SERVICO = 'Servicio Contratado';

// Valores distintos dos defaults do helper, para provar que o que a vaga mostra é o que a operadora digitou.
const EXPERIENCIA = 'experiencia-e2e-4-anos';
const DIA_PAGO = 'dia-12-e2e';
const ATRIBUTOS_FICHA = 'ATRIB-FICHA-NAO-COPIAR';
const OBS_FICHA = 'OBS-FICHA-NAO-COPIAR';

test.describe('servico-dados-recrutamento — spec 027 Fase 3 @integration', () => {
  test.setTimeout(150_000);
  const pacientes: string[] = [];
  test.afterAll(() => { pacientes.forEach((id) => cleanupTestPatient(id)); });

  /** Paciente + serviço (endereço e horário) criados pela API; `extra` são os campos de recrutamento que já nascem preenchidos. */
  async function semear(request: import('@playwright/test').APIRequestContext, extra: Record<string, unknown>) {
    const seeded = insertTestPatient({
      status: 'PENDING_ADMISSION', firstName: 'ServicoRecrut', lastName: `Patient${Date.now()}${pacientes.length}`,
      withAddress: true, hasConsent: true, insuranceInformed: 'OSDE',
    });
    pacientes.push(seeded.patientId);
    expect(seeded.addressId, 'insertTestPatient não devolveu addressId').toBeTruthy();
    const svc = await request.post(`${BACKEND_URL}/api/admin/patients/${seeded.patientId}/contracted-services`, {
      headers: AUTH_HEADERS,
      data: {
        serviceCode: 'AT', providersNeeded: 1, careLocation: 'HOME', addressId: seeded.addressId,
        schedule: [{ dayOfWeek: 1, startTime: '08:00', durationMinutes: 240 }], ...extra,
      },
    });
    expect(svc.ok(), `POST contracted-services falhou: ${svc.status()} ${await svc.text()}`).toBe(true);
    return { patientId: seeded.patientId, serviceId: (await svc.json()).data.id as string };
  }

  async function abrirCardDoServico(page: Page, patientId: string, serviceId: string): Promise<void> {
    await page.goto(`/admin/patients/${patientId}`);
    await page.getByTestId('patient-profile-tabs').getByRole('button', { name: ABA_SERVICO }).click();
    await expect(page.getByTestId(`contracted-service-row-${serviceId}`)).toBeVisible({ timeout: 20_000 });
  }

  async function ativar(page: Page, serviceId: string): Promise<string> {
    const resposta = page.waitForResponse((r) => r.request().method() === 'POST' && /\/activate-recruitment$/.test(r.url()));
    await page.getByTestId(`contracted-service-activate-recruitment-${serviceId}`).click();
    const r = await resposta;
    expect(r.status()).toBe(201);
    return ((await r.json()) as { data: { vacancyId: string } }).data.vacancyId;
  }

  /** Tela de edição da vaga rascunho: o que a recrutadora enxerga (coluna esquerda e direita do formulário). */
  async function abrirEdicaoDaVaga(page: Page, vacancyId: string): Promise<void> {
    await page.goto(`/admin/vacancies/${vacancyId}/edit`);
    await expect(page.getByTestId('profession-checkboxes')).toBeVisible({ timeout: 25_000 });
  }

  test('1. feliz — preenche os campos do serviço como humano, guarda, ativa: a vaga nasce rascunho lendo os 5 do serviço, sem cópia, e sem os de ficha', async ({ page, request }) => {
    const { patientId, serviceId } = await semear(request, {});
    await loginComoStaffMock(page, STAFF, 'E2E Servico Recrutamento');
    await abrirCardDoServico(page, patientId, serviceId);

    // Sem os 5 campos o foguete nasce desabilitado.
    await expect(page.getByTestId(`contracted-service-activate-recruitment-${serviceId}`)).toBeDisabled();

    await page.getByTestId(`contracted-service-edit-${serviceId}`).click();
    await expect(page.getByTestId(`contracted-service-form-${serviceId}`)).toBeVisible({ timeout: 15_000 });
    // O input real é `sr-only`: o alvo de um humano é o <label> (mesmo gesto do wizard da vaga).
    await page.locator('label[for="svc-profession-CAREGIVER-1"]').click();
    await page.getByTestId('svc-requiredSex-1').selectOption('F');
    await page.getByTestId('svc-workSchedule-1').selectOption('full-time');
    for (const [id, texto] of [
      ['svc-requiredExperience-1', EXPERIENCIA], ['svc-paymentDay-1', DIA_PAGO],
      ['svc-workerAttributes-1', ATRIBUTOS_FICHA], ['svc-dailyObs-1', OBS_FICHA],
    ] as const) {
      await page.getByTestId(id).click();
      await page.keyboard.type(texto);
    }
    const guardou = page.waitForResponse((r) => r.request().method() === 'PATCH' && new RegExp(`/contracted-services/${serviceId}$`).test(r.url()));
    await page.getByTestId(`contracted-service-save-${serviceId}`).click();
    expect((await guardou).status()).toBe(200);
    await page.getByTestId('patient-contracted-services-edit-drawer').getByLabel('Cerrar').click();
    await expect(page.getByTestId('patient-contracted-services-edit-drawer')).not.toBeVisible({ timeout: 15_000 });

    await expect(page.getByTestId(`contracted-service-activate-recruitment-${serviceId}`)).toBeEnabled({ timeout: 15_000 });
    const vacancyId = await ativar(page, serviceId);

    // A vaga nasce RASCUNHO (T.6) e a TELA mostra os valores copiados.
    expect(runSQL(`SELECT is_draft FROM job_postings WHERE id = '${vacancyId}'`).trim()).toBe('t');
    await abrirEdicaoDaVaga(page, vacancyId);
    await expect(page.getByTestId('profession-checkbox-CAREGIVER')).toBeChecked();
    await expect(page.locator('select').filter({ has: page.locator('option[value="BOTH"]') }).first()).toHaveValue('F');
    // O "Día de pago" é um input de texto sem testid: lê o valor exibido em todos os inputs de texto da tela.
    await expect.poll(() => page.locator('input[type="text"]').evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value))).toContain(DIA_PAGO);
    // Os dois de ficha NÃO atravessam: o textarea de atributos da vaga está vazio.
    await expect(page.getByTestId('worker-attributes-textarea')).toHaveValue('');
    // D523 (057): a vaga com serviço NÃO copia os 5 — as colunas de `job_postings` ficam NULL (e as de ficha também);
    // quem guarda os valores é o SERVIÇO. Experiência e jornada não têm campo de tela na vaga: conferidos no banco.
    const linha = runSQL(`SELECT coalesce(required_experience,'<null>'), coalesce(work_schedule,'<null>'), coalesce(payment_day,'<null>'), coalesce(required_sex,'<null>'), coalesce(required_professions::text,'<null>'), coalesce(worker_attributes,'<null>'), coalesce(daily_obs,'<null>') FROM job_postings WHERE id = '${vacancyId}'`).split('\n')[0].trim();
    expect(linha).toBe('<null>|<null>|<null>|<null>|<null>|<null>|<null>');
    // O serviço guarda os valores digitados na ficha.
    const noServico = runSQL(`SELECT required_experience, work_schedule, payment_day, required_sex FROM patient_contracted_services WHERE id = '${serviceId}'`).split('\n')[0].trim();
    expect(noServico).toBe(`${EXPERIENCIA}|full-time|${DIA_PAGO}|F`);
  });

  test('2. alternativo — faltando o sexo: "Activar reclutamiento" desabilitado e o motivo traduzido aparece', async ({ page, request }) => {
    const { requiredSex: _omitido, ...semSexo } = RECRUITMENT_FIELDS_E2E;
    const { patientId, serviceId } = await semear(request, semSexo);
    await loginComoStaffMock(page, STAFF, 'E2E Servico Recrutamento');
    await abrirCardDoServico(page, patientId, serviceId);

    const botao = page.getByTestId(`contracted-service-activate-recruitment-${serviceId}`);
    await expect(botao).toBeVisible();
    await expect(botao).toBeDisabled();
    await expect(botao).toHaveAttribute('title', /Datos de reclutamiento del servicio/);

    // Nenhuma vaga nasceu.
    expect(runSQL(`SELECT count(*) FROM job_postings WHERE patient_id = '${patientId}'`).trim()).toBe('0');

    // Escolher o sexo como humano destrava (BOTH = indistinto conta como respondido).
    await page.getByTestId(`contracted-service-edit-${serviceId}`).click();
    await expect(page.getByTestId(`contracted-service-form-${serviceId}`)).toBeVisible({ timeout: 15_000 });
    await page.getByTestId('svc-requiredSex-1').selectOption('BOTH');
    const guardou = page.waitForResponse((r) => r.request().method() === 'PATCH' && new RegExp(`/contracted-services/${serviceId}$`).test(r.url()));
    await page.getByTestId(`contracted-service-save-${serviceId}`).click();
    expect((await guardou).status()).toBe(200);
    await page.getByTestId('patient-contracted-services-edit-drawer').getByLabel('Cerrar').click();
    await expect(botao).toBeEnabled({ timeout: 15_000 });
  });

  test('3. alternativo — os 5 preenchidos e atributos/observações vazios: botão habilitado e a vaga não traz atributos nem observação', async ({ page, request }) => {
    const { patientId, serviceId } = await semear(request, { ...RECRUITMENT_FIELDS_E2E });
    await loginComoStaffMock(page, STAFF, 'E2E Servico Recrutamento');
    await abrirCardDoServico(page, patientId, serviceId);

    await expect(page.getByTestId(`contracted-service-activate-recruitment-${serviceId}`)).toBeEnabled({ timeout: 15_000 });
    const vacancyId = await ativar(page, serviceId);

    await abrirEdicaoDaVaga(page, vacancyId);
    await expect(page.getByTestId('profession-checkbox-AT')).toBeChecked();
    await expect(page.getByTestId('worker-attributes-textarea')).toHaveValue('');
    const linha = runSQL(`SELECT coalesce(worker_attributes,'<null>'), coalesce(daily_obs,'<null>'), is_draft FROM job_postings WHERE id = '${vacancyId}'`).split('\n')[0].trim();
    expect(linha).toBe('<null>|<null>|t');
  });
});
