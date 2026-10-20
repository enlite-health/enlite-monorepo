/**
 * vacancy-locked-fields-providers-nulo.integration.e2e.ts @integration — spec 058 B §N
 * (a quantidade de prestadores não tem padrão "1": o serviço pode ter `providers_needed` NULL = nunca informada).
 *
 * Backend real + Postgres real + frontend real. Só o login é mock (stack de CI). Dado sintético.
 * O nome contém `vacancy-locked-fields`, token que o `grep:` do `pr-gate.yml` já roda no projeto
 * `integration` — o arquivo cai no CI sem tocar o workflow.
 *
 *  1. feliz: vaga ligada a serviço com quantidade NULL abre com o campo VAZIO e travado (não "1"); salvar os
 *     outros campos não leva `providers_needed` no PUT e o serviço segue NULL;
 *  2. alt (validação): vaga MANUAL com a quantidade vazia é recusada na tela e nenhum PUT sai;
 *  3. alt (estado muda por fora): o serviço ganha a quantidade depois de a vaga abrir; reabrir mostra o número
 *     efetivo, ainda travado.
 */
import { test, expect } from '@playwright/test';
import { RECRUITMENT_FIELDS_E2E } from '../helpers/recruitment-fields-e2e';
import { insertTestPatient, cleanupTestPatient, insertBaseVacancy, cleanupVacancies } from '../helpers/db-test-helper';
import { sqlComVars } from '../helpers/sql-com-vars';
import { loginComoStaffMock } from '../helpers/login-mock-staff';
import { tokenFor, type MockUser } from '../helpers/abac-stack-helper';

const BACKEND_URL = process.env.E2E_BACKEND_URL ?? process.env.API_BASE_URL ?? 'http://localhost:8080';
const STAFF: MockUser = { uid: `e2e-vaga-providers-nulo-${Date.now()}`, email: `e2e.vaga-providers-nulo.${Date.now()}@enlite.health`, role: 'admin', country: 'AR' };
const AUTH_HEADERS = { Authorization: `Bearer ${tokenFor(STAFF)}`, 'Content-Type': 'application/json' };

test.describe('vacancy-locked-fields — quantidade de prestadores sem padrão 1 (058 B §N) @integration', () => {
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

  /** Serviço com `providersNeeded: null` (nunca informado) + foguete → vaga rascunho ligada a ele. */
  async function semearVagaComServicoNulo(request: import('@playwright/test').APIRequestContext) {
    const { patientId, addressId } = semearPaciente('ProvidersNulo');
    const svc = await request.post(`${BACKEND_URL}/api/admin/patients/${patientId}/contracted-services`, {
      headers: AUTH_HEADERS,
      data: { serviceCode: 'AT', providersNeeded: null, careLocation: 'HOME', ...RECRUITMENT_FIELDS_E2E, addressId, schedule: [{ dayOfWeek: 1, startTime: '08:00', durationMinutes: 240 }] },
    });
    expect(svc.ok(), `POST contracted-services falhou: ${svc.status()} ${await svc.text()}`).toBe(true);
    const serviceId = (await svc.json()).data.id as string;
    const act = await request.post(`${BACKEND_URL}/api/admin/patients/${patientId}/contracted-services/${serviceId}/activate-recruitment`, { headers: AUTH_HEADERS });
    expect(act.ok(), `activate-recruitment falhou: ${act.status()} ${await act.text()}`).toBe(true);
    const vacancyId = (await act.json()).data.vacancyId as string;
    vagas.push(vacancyId);
    return { patientId, serviceId, vacancyId };
  }

  test('1. feliz — vaga ligada a serviço com quantidade NULL: campo vazio e travado (não "1"); salva os outros campos e a vaga segue sem quantidade', async ({ page, request }) => {
    const { serviceId, vacancyId } = await semearVagaComServicoNulo(request);
    await loginComoStaffMock(page, STAFF, 'E2E Providers Nulo');
    await page.goto(`/admin/vacancies/${vacancyId}/edit`);
    await expect(page.getByTestId('profession-checkboxes')).toBeVisible({ timeout: 25_000 });

    await expect(page.getByTestId('providers-needed-input')).toBeDisabled();
    await expect(page.getByTestId('providers-needed-input')).toHaveValue('');
    await expect(page.getByTestId('locked-field-link-providers')).toBeVisible();

    const meetInput = page.getByTestId('meet-link-0');
    await meetInput.click();
    await page.keyboard.type('meet.google.com/abc-defg-hij');
    await meetInput.blur();

    const saveBtn = page.getByTestId('create-vacancy-save-btn');
    await expect(saveBtn).toBeEnabled({ timeout: 10_000 });
    const [resp] = await Promise.all([
      page.waitForResponse((r) => r.request().method() === 'PUT' && new RegExp(`/vacancies/${vacancyId}$`).test(r.url())),
      saveBtn.click(),
    ]);
    expect(resp.status()).toBe(200);
    expect(JSON.parse(resp.request().postData() ?? '{}')).not.toHaveProperty('providers_needed');
    expect(sqlComVars(`SELECT coalesce(providers_needed::text, '<null>') FROM patient_contracted_services WHERE id = :'sid'`, { sid: serviceId })).toBe('<null>');
  });

  test('2. alt (validação, conta 1) — vaga MANUAL com a quantidade vazia: recusa com "Debe haber al menos 1 prestador" e nenhum PUT sai', async ({ page }) => {
    const { patientId, addressId } = semearPaciente('ProvidersManual');
    const caseNumber = 970_000 + Math.floor(Math.random() * 9999);
    sqlComVars(`UPDATE patients SET case_number = :'cn'::int WHERE id = :'pid'`, { cn: String(caseNumber), pid: patientId });
    const vacancyId = insertBaseVacancy({ patientId, patientAddressId: addressId, caseNumber, status: 'PENDING_ACTIVATION', isDraft: true });
    vagas.push(vacancyId);
    sqlComVars(`UPDATE job_postings SET providers_needed = NULL, schedule = '[{"dayOfWeek": 1, "startTime": "08:00", "endTime": "12:00"}]'::jsonb WHERE id = :'vid'`, { vid: vacancyId });
    const puts: string[] = [];
    page.on('request', (r) => { if (r.method() === 'PUT' && /\/vacancies\//.test(r.url())) puts.push(r.url()); });

    await loginComoStaffMock(page, STAFF, 'E2E Providers Manual');
    await page.goto(`/admin/vacancies/${vacancyId}/edit`);
    await expect(page.getByTestId('profession-checkboxes')).toBeVisible({ timeout: 25_000 });
    await expect(page.getByTestId('providers-needed-input')).toBeEnabled();
    await expect(page.getByTestId('providers-needed-input')).toHaveValue('');
    const meetInput = page.getByTestId('meet-link-0');
    await meetInput.click();
    await page.keyboard.type('meet.google.com/abc-defg-hij');
    await meetInput.blur();
    await page.getByTestId('create-vacancy-save-btn').click({ timeout: 5_000 }).catch(() => undefined); // desabilitado por validação também vale (conta 1)
    await expect(page.getByText('Debe haber al menos 1 prestador')).toBeVisible();
    expect(puts).toHaveLength(0);
  });

  test('3. alt (estado muda por fora) — o serviço ganha a quantidade depois de a vaga abrir: reabrir mostra o número efetivo, ainda travado', async ({ page, request }) => {
    const { patientId, serviceId, vacancyId } = await semearVagaComServicoNulo(request);
    await loginComoStaffMock(page, STAFF, 'E2E Providers Fora');
    await page.goto(`/admin/vacancies/${vacancyId}/edit`);
    await expect(page.getByTestId('profession-checkboxes')).toBeVisible({ timeout: 25_000 });
    await expect(page.getByTestId('providers-needed-input')).toHaveValue('');
    // por fora da tela (como a operação faria na ficha): o serviço passa a ter 2 prestadores
    const patch = await request.patch(`${BACKEND_URL}/api/admin/patients/${patientId}/contracted-services/${serviceId}`, { headers: AUTH_HEADERS, data: { providersNeeded: 2 } });
    expect(patch.ok(), `PATCH do serviço falhou: ${patch.status()} ${await patch.text()}`).toBe(true);
    await page.reload();
    await expect(page.getByTestId('profession-checkboxes')).toBeVisible({ timeout: 25_000 });
    await expect(page.getByTestId('providers-needed-input')).toHaveValue('2');
    await expect(page.getByTestId('providers-needed-input')).toBeDisabled();
  });
});
