/**
 * vacancy-locked-fields-recruitment-from-service.integration.e2e.ts @integration — spec 057 / T4.5
 * (D523: a vaga com serviço contratado lê os 5 campos de recrutamento do SERVIÇO e os trava).
 *
 * Backend real + Postgres real + frontend real. Só o login é mock (stack de CI). Dado sintético.
 * O nome contém `vacancy-locked-fields`, token que o `grep:` do `pr-gate.yml` já roda no projeto
 * `integration` — o arquivo cai no CI sem tocar o workflow.
 *
 *  1. feliz: vaga com serviço abre no form de edição com profissões/sexo/dia de pagamento `disabled` e os
 *     links da ficha; clique real no link do sexo abre a ficha na aba Servicio Contratado; o sexo é mudado
 *     NO SERVIÇO pela UI da ficha (drawer, click + selectOption) e a vaga passa a mostrar o valor novo;
 *  2. alt: PUT com `required_sex` na vaga com serviço → 422 com `locked_fields` ⊇ required_sex (contrato
 *     de API, via `request`) e o banco não muda;
 *  3. alt: vaga SEM serviço abre com os 3 campos habilitados, sem links, e salva `required_sex` pela tela.
 */
import { test, expect } from '@playwright/test';
import { RECRUITMENT_FIELDS_E2E } from '../helpers/recruitment-fields-e2e';
import { insertTestPatient, cleanupTestPatient, insertBaseVacancy, cleanupVacancies } from '../helpers/db-test-helper';
import { runSQL } from '../helpers/patient-detail-a-helper';
import { loginComoStaffMock } from '../helpers/login-mock-staff';
import { tokenFor, type MockUser } from '../helpers/abac-stack-helper';

const BACKEND_URL = process.env.E2E_BACKEND_URL ?? process.env.API_BASE_URL ?? 'http://localhost:8080';
const STAFF: MockUser = { uid: `e2e-vaga-campos-servico-${Date.now()}`, email: `e2e.vaga-campos-servico.${Date.now()}@enlite.health`, role: 'admin', country: 'AR' };
const AUTH_HEADERS = { Authorization: `Bearer ${tokenFor(STAFF)}`, 'Content-Type': 'application/json' };
const ABA_SERVICO = 'Servicio Contratado';

test.describe('vacancy-locked-fields — 5 campos de recrutamento vindos do serviço (057) @integration', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(150_000);

  const pacientes: string[] = [];
  const vagas: string[] = [];
  test.afterAll(() => {
    cleanupVacancies(vagas);
    pacientes.forEach((id) => cleanupTestPatient(id));
  });

  function semearPaciente(nome: string) {
    const seeded = insertTestPatient({
      status: 'PENDING_ADMISSION', firstName: nome, lastName: `Patient${Date.now()}${pacientes.length}`,
      withAddress: true, hasConsent: true, insuranceInformed: 'OSDE',
    });
    pacientes.push(seeded.patientId);
    expect(seeded.addressId, 'insertTestPatient não devolveu addressId').toBeTruthy();
    return { patientId: seeded.patientId, addressId: seeded.addressId as string };
  }

  /** Montagem de cenário (API): serviço com os 5 campos de recrutamento + foguete → vaga rascunho com serviço. */
  async function semearVagaComServico(request: import('@playwright/test').APIRequestContext) {
    const { patientId, addressId } = semearPaciente('CamposServico');
    const svc = await request.post(`${BACKEND_URL}/api/admin/patients/${patientId}/contracted-services`, {
      headers: AUTH_HEADERS,
      data: {
        serviceCode: 'AT', providersNeeded: 1, careLocation: 'HOME', ...RECRUITMENT_FIELDS_E2E,
        addressId, schedule: [{ dayOfWeek: 1, startTime: '08:00', durationMinutes: 240 }],
      },
    });
    expect(svc.ok(), `POST contracted-services falhou: ${svc.status()} ${await svc.text()}`).toBe(true);
    const serviceId = (await svc.json()).data.id as string;
    const act = await request.post(`${BACKEND_URL}/api/admin/patients/${patientId}/contracted-services/${serviceId}/activate-recruitment`, { headers: AUTH_HEADERS });
    expect(act.ok(), `activate-recruitment falhou: ${act.status()} ${await act.text()}`).toBe(true);
    const vacancyId = (await act.json()).data.vacancyId as string;
    vagas.push(vacancyId);
    return { patientId, serviceId, vacancyId };
  }

  test('1. feliz — vaga com serviço: 3 campos disabled + links; link leva à ficha; sexo mudado no serviço aparece na vaga', async ({ page, request }) => {
    const { patientId, serviceId, vacancyId } = await semearVagaComServico(request);
    const fichaUrl = `/admin/patients/${patientId}?tab=contractedService`;

    await loginComoStaffMock(page, STAFF, 'E2E Campos Servico');
    await page.goto(`/admin/vacancies/${vacancyId}/edit`);
    await expect(page.getByTestId('profession-checkboxes')).toBeVisible({ timeout: 25_000 });

    await expect(page.getByTestId('required-sex-select')).toBeDisabled();
    await expect(page.getByTestId('payment-day-input')).toBeDisabled();
    await expect(page.getByTestId('profession-checkbox-AT')).toBeDisabled();
    for (const id of ['sex', 'professions', 'payment-day']) {
      await expect(page.getByTestId(`locked-field-link-${id}`)).toBeVisible();
      await expect(page.getByTestId(`locked-field-link-${id}`)).toHaveAttribute('href', fichaUrl);
    }
    // Valores vindos do serviço (RECRUITMENT_FIELDS_E2E: BOTH / 'dia 5').
    await expect(page.getByTestId('required-sex-select')).toHaveValue('BOTH');
    await expect(page.getByTestId('payment-day-input')).toHaveValue(RECRUITMENT_FIELDS_E2E.paymentDay);

    // Clique real no link (abre em nova aba): a URL é a da ficha na aba do serviço. A edição segue na aba
    // principal (a nova aba não herda os interceptors de login do mock).
    const [ficha] = await Promise.all([
      page.context().waitForEvent('page'),
      page.getByTestId('locked-field-link-sex').click(),
    ]);
    await expect(ficha).toHaveURL(new RegExp(`/admin/patients/${patientId}\\?tab=contractedService$`), { timeout: 20_000 });
    await ficha.close();

    // Edita o sexo NO SERVIÇO pela UI da ficha (drawer do serviço, gesto humano).
    await page.goto(`/admin/patients/${patientId}`);
    await page.getByTestId('patient-profile-tabs').getByRole('button', { name: ABA_SERVICO }).click();
    await expect(page.getByTestId(`contracted-service-row-${serviceId}`)).toBeVisible({ timeout: 20_000 });
    await page.getByTestId(`contracted-service-edit-${serviceId}`).click();
    await expect(page.getByTestId(`contracted-service-form-${serviceId}`)).toBeVisible({ timeout: 15_000 });
    await page.getByTestId('svc-requiredSex-1').selectOption('F');
    const guardou = page.waitForResponse((r) => r.request().method() === 'PATCH' && new RegExp(`/contracted-services/${serviceId}$`).test(r.url()));
    await page.getByTestId(`contracted-service-save-${serviceId}`).click();
    expect((await guardou).status()).toBe(200);
    await page.getByTestId('patient-contracted-services-edit-drawer').getByLabel('Cerrar').click();
    await expect(page.getByTestId('patient-contracted-services-edit-drawer')).not.toBeVisible({ timeout: 15_000 });

    // Volta à vaga: o valor novo do serviço aparece (a vaga lê do serviço, não de uma cópia).
    await page.goto(`/admin/vacancies/${vacancyId}/edit`);
    await expect(page.getByTestId('profession-checkboxes')).toBeVisible({ timeout: 25_000 });
    await expect(page.getByTestId('required-sex-select')).toHaveValue('F');
    await expect(page.getByTestId('required-sex-select')).toBeDisabled();
  });

  test('2. alt — PUT com required_sex em vaga com serviço → 422 com locked_fields ⊇ required_sex; banco não muda', async ({ request }) => {
    const { vacancyId } = await semearVagaComServico(request);
    const get = async () => (await (await request.get(`${BACKEND_URL}/api/admin/vacancies/${vacancyId}`, { headers: AUTH_HEADERS })).json()).data;
    const antes = await get();
    expect(antes.locked_fields).toEqual(expect.arrayContaining(['required_sex', 'required_professions', 'required_experience', 'work_schedule', 'payment_day']));

    const put = await request.put(`${BACKEND_URL}/api/admin/vacancies/${vacancyId}`, { headers: AUTH_HEADERS, data: { required_sex: 'M' } });
    expect(put.status()).toBe(422);
    expect((await put.json()).locked_fields).toEqual(expect.arrayContaining(['required_sex']));

    expect((await get()).required_sex).toBe(antes.required_sex);
    expect(antes.required_sex).toBe('BOTH');
  });

  test('3. alt — vaga SEM serviço: 3 campos habilitados, sem links, e salvar required_sex pela tela persiste', async ({ page }) => {
    const { patientId, addressId } = semearPaciente('CamposManual');
    const caseNumber = 970_000 + Math.floor(Math.random() * 9999);
    runSQL(`UPDATE patients SET case_number = ${caseNumber} WHERE id = '${patientId}'`);
    const vacancyId = insertBaseVacancy({ patientId, patientAddressId: addressId, caseNumber, status: 'PENDING_ACTIVATION', isDraft: true });
    vagas.push(vacancyId);
    runSQL(`UPDATE job_postings SET schedule = '[{"dayOfWeek": 1, "startTime": "08:00", "endTime": "12:00"}]'::jsonb WHERE id = '${vacancyId}'`);

    await loginComoStaffMock(page, STAFF, 'E2E Campos Manual');
    await page.goto(`/admin/vacancies/${vacancyId}/edit`);
    await expect(page.getByTestId('profession-checkboxes')).toBeVisible({ timeout: 25_000 });

    await expect(page.getByTestId('required-sex-select')).toBeEnabled();
    await expect(page.getByTestId('payment-day-input')).toBeEnabled();
    await expect(page.getByTestId('profession-checkbox-AT')).toBeEnabled();
    for (const id of ['sex', 'professions', 'payment-day']) {
      await expect(page.getByTestId(`locked-field-link-${id}`)).toHaveCount(0);
    }

    await page.getByTestId('required-sex-select').selectOption('F');
    const meetInput = page.getByTestId('meet-link-0');
    await meetInput.click();
    await page.keyboard.type('meet.google.com/abc-defg-hij');
    await meetInput.blur();

    const saveBtn = page.getByTestId('create-vacancy-save-btn');
    await expect(saveBtn).toBeEnabled({ timeout: 10_000 });
    const put = page.waitForResponse((r) => r.request().method() === 'PUT' && new RegExp(`/vacancies/${vacancyId}$`).test(r.url()));
    await saveBtn.click();
    expect((await put).status()).toBe(200);
    expect(runSQL(`SELECT required_sex FROM job_postings WHERE id = '${vacancyId}'`).split('\n').map((l) => l.trim())).toContain('F');
  });
});
