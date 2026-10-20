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
});
