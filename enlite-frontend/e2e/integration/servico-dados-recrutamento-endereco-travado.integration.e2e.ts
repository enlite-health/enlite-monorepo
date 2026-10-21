/**
 * servico-dados-recrutamento-endereco-travado.integration.e2e.ts @integration — 058b/B2 (T249): REGRA-05, o endereço do serviço
 * contratado trava com vaga viva ou alocação vigente. Exercitado por um HUMANO contra o stack REAL (frontend + API + Postgres),
 * sem interceptar rota e sem mock de dado de negócio — só a auth é o mock do stack (`loginComoStaffMock`). Dado sintético.
 *
 * Canal real: NENHUM. Mapa do outbound: o PATCH do serviço só escreve em Postgres; a ativação de recrutamento (usada por API só
 * como semente) grava 1 rascunho em `job_postings`, 1 movimento de status e 1 linha de auditoria — não emite `vacancy.created`,
 * não chama Talentum, Gemini nem WhatsApp (mapa do molde `servico-dados-recrutamento.integration.e2e.ts`).
 *
 * Os testes (o nome do arquivo casa o `--grep servico-dados-recrutamento` do `pr-gate.yml`):
 *   1. FELIZ — serviço sem vaga viva nem alocação: a troca de endereço grava;
 */
import { test, expect, type Page, type APIRequestContext } from '@playwright/test';
import { insertTestPatient, cleanupTestPatient } from '../helpers/db-test-helper';
import { sqlComVars } from '../helpers/sql-com-vars';
import { loginComoStaffMock } from '../helpers/login-mock-staff';
import { tokenFor, type MockUser } from '../helpers/abac-stack-helper';
import { RECRUITMENT_FIELDS_E2E } from '../helpers/recruitment-fields-e2e';
import { seedDerivablePatient, selectedWorker, allocateWorker } from '../helpers/derivacao-e2e-helper';
import { insertSecondAddress } from '../helpers/itinerario-escrita-e2e-helper';

const BACKEND_URL = process.env.E2E_BACKEND_URL ?? process.env.API_BASE_URL ?? 'http://localhost:8080';
const STAFF: MockUser = { uid: `e2e-endereco-travado-${Date.now()}`, email: `e2e.endereco-travado.${Date.now()}@enlite.health`, role: 'admin', country: 'AR' };
const AUTH_HEADERS = { Authorization: `Bearer ${tokenFor(STAFF)}`, 'Content-Type': 'application/json' };
const ABA_SERVICO = 'Servicio Contratado';

test.describe('servico-dados-recrutamento-endereco-travado — REGRA-05 pela tela @integration', () => {
  test.setTimeout(150_000);
  const pacientes: string[] = [];
  test.afterAll(() => { pacientes.forEach((id) => cleanupTestPatient(id)); });

  /** Paciente + serviço (endereço e horário) criados pela API; `extra` são campos que já nascem preenchidos. */
  async function semear(request: APIRequestContext, extra: Record<string, unknown> = {}) {
    const seeded = insertTestPatient({
      status: 'PENDING_ADMISSION', firstName: 'EnderecoTravado', lastName: `Patient${Date.now()}${pacientes.length}`,
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
    return { patientId: seeded.patientId, addressId: seeded.addressId as string, serviceId: (await svc.json()).data.id as string };
  }

  async function abrirCardDoServico(page: Page, patientId: string, serviceId: string): Promise<void> {
    await page.goto(`/admin/patients/${patientId}`);
    await page.getByTestId('patient-profile-tabs').getByRole('button', { name: ABA_SERVICO }).click();
    await expect(page.getByTestId(`contracted-service-row-${serviceId}`)).toBeVisible({ timeout: 20_000 });
  }

  const ehPatchDoServico = (serviceId: string) => (r: { method(): string; url(): string }): boolean =>
    r.method() === 'PATCH' && r.url().endsWith(`/contracted-services/${serviceId}`);

  const enderecoDoServico = (serviceId: string): string =>
    sqlComVars("SELECT address_id FROM patient_contracted_services WHERE id = :'id'::uuid", { id: serviceId });

  test('FELIZ: serviço sem vaga viva nem alocação — a troca de endereço grava', async ({ page, request }) => {
    const { patientId, serviceId } = await semear(request);
    const segundo = insertSecondAddress(patientId);
    await loginComoStaffMock(page, STAFF, 'E2E Endereco Travado');
    await abrirCardDoServico(page, patientId, serviceId);
    await page.getByTestId(`contracted-service-edit-${serviceId}`).click();
    await expect(page.getByTestId(`contracted-service-form-${serviceId}`)).toBeVisible({ timeout: 15_000 });

    await page.getByTestId('svc-addressId-1').selectOption(segundo);
    const [patch] = await Promise.all([
      page.waitForResponse((r) => ehPatchDoServico(serviceId)(r.request())),
      page.getByTestId(`contracted-service-save-${serviceId}`).click(),
    ]);
    expect(patch.status()).toBe(200);
    expect(enderecoDoServico(serviceId)).toBe(segundo);
    await expect(page.getByTestId('svc-address-locked-1')).toHaveCount(0);
  });

  test('ALTERNATIVO 1 (servidor recusa): vaga viva → 422 SERVICE_ADDRESS_LOCKED (LIVE_VACANCY) com mensagem na linha do Guardar e select de volta ao endereço salvo; address_id inalterado', async ({ page, request }) => {
    const { patientId, addressId, serviceId } = await semear(request, { ...RECRUITMENT_FIELDS_E2E });
    // A vaga viva nasce por API (o outbound da ativação está mapeado no cabeçalho): a tela só tenta trocar o endereço.
    const ativou = await request.post(`${BACKEND_URL}/api/admin/patients/${patientId}/contracted-services/${serviceId}/activate-recruitment`, { headers: AUTH_HEADERS });
    expect(ativou.status(), `activate-recruitment ${ativou.status()} ${await ativou.text()}`).toBe(201);
    const segundo = insertSecondAddress(patientId);
    await loginComoStaffMock(page, STAFF, 'E2E Endereco Travado');
    await abrirCardDoServico(page, patientId, serviceId);
    await page.getByTestId(`contracted-service-edit-${serviceId}`).click();
    await expect(page.getByTestId(`contracted-service-form-${serviceId}`)).toBeVisible({ timeout: 15_000 });

    await page.getByTestId('svc-addressId-1').selectOption(segundo);
    const [patch] = await Promise.all([
      page.waitForResponse((r) => ehPatchDoServico(serviceId)(r.request())),
      page.getByTestId(`contracted-service-save-${serviceId}`).click(),
    ]);
    expect(patch.status()).toBe(422);
    const corpo = (await patch.json()) as { code?: string; details?: { reason?: string } };
    expect(corpo.code).toBe('SERVICE_ADDRESS_LOCKED');
    expect(corpo.details?.reason).toBe('LIVE_VACANCY');
    // Régua humana (058b/fix-422): o que a PESSOA vê — a mensagem está na tela (na viewport, ao lado do Guardar que ela acabou de clicar) e o select NÃO fica
    // mostrando o endereço que a API recusou. `toContainText` sozinho passava com a mensagem fora da tela (lá em cima, sob o select, num drawer que rola).
    const aviso = page.getByTestId('svc-address-locked-1');
    await expect(aviso).toContainText('el servicio tiene una vacante activa');
    await expect(aviso).toBeInViewport();
    await expect(page.getByTestId('svc-addressId-1')).toHaveValue(addressId);
    await expect(page.getByTestId(`contracted-service-error-${serviceId}`)).toHaveCount(0); // não cai no erro genérico
    expect(enderecoDoServico(serviceId)).toBe(addressId);
  });

  test('ALTERNATIVO 2 (servidor recusa): só alocação vigente (sem vaga viva) → 422 SERVICE_ADDRESS_LOCKED (ALLOCATION) com mensagem', async ({ page, request }) => {
    const seed = await seedDerivablePatient(request, { status: 'SEARCHING', services: [{ schedule: [{ dayOfWeek: 1, startTime: '08:00', durationMinutes: 240 }] }] });
    try {
      const [svc] = seed.services;
      const worker = selectedWorker(seed, svc.vacancyId);
      const aloc = await allocateWorker(request, seed.patientId, svc.serviceId, svc.slotIds[0], worker);
      expect(aloc.status, `allocate ${aloc.status} ${aloc.code ?? ''}`).toBe(201);
      // Isola o motivo: a vaga é apagada por SQL (como dono); a alocação vigente continua.
      sqlComVars("UPDATE job_postings SET deleted_at = now(), status = 'CLOSED' WHERE id = :'id'::uuid", { id: svc.vacancyId });
      const original = enderecoDoServico(svc.serviceId);
      const segundo = insertSecondAddress(seed.patientId);

      await loginComoStaffMock(page, STAFF, 'E2E Endereco Travado');
      await abrirCardDoServico(page, seed.patientId, svc.serviceId);
      await page.getByTestId(`contracted-service-edit-${svc.serviceId}`).click();
      await expect(page.getByTestId(`contracted-service-form-${svc.serviceId}`)).toBeVisible({ timeout: 15_000 });
      await page.getByTestId('svc-addressId-1').selectOption(segundo);
      const [patch] = await Promise.all([
        page.waitForResponse((r) => ehPatchDoServico(svc.serviceId)(r.request())),
        page.getByTestId(`contracted-service-save-${svc.serviceId}`).click(),
      ]);
      expect(patch.status()).toBe(422);
      const corpo = (await patch.json()) as { code?: string; details?: { reason?: string } };
      expect(corpo.code).toBe('SERVICE_ADDRESS_LOCKED');
      expect(corpo.details?.reason).toBe('ALLOCATION');
      const aviso = page.getByTestId('svc-address-locked-1');
      await expect(aviso).toContainText('ya tiene prestadores asignados');
      await expect(aviso).toBeInViewport();
      await expect(page.getByTestId('svc-addressId-1')).toHaveValue(original);
      expect(enderecoDoServico(svc.serviceId)).toBe(original);
      expect(sqlComVars("SELECT status FROM patient_itinerary_assignment WHERE id = :'id'::uuid", { id: aloc.allocationId! })).toBe('ACTIVE');
    } finally {
      seed.cleanup();
    }
  });
});
