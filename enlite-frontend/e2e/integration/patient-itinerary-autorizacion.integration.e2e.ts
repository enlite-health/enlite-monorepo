/**
 * patient-itinerary-autorizacion.integration.e2e.ts @integration — spec 056 (Horas com dono único): o
 * bloco "Autorización" do serviço contratado (`svc-auth-*`), exercitado por um HUMANO contra o stack REAL
 * (frontend + API + Postgres), sem mock de dado de negócio — só a auth é o mock do stack (`loginAs`).
 * Régua humana: clique + `keyboard.type`, valores lidos da TELA; nada de preenchimento programático.
 *
 * Por que este nome: o `--grep` do job padrão do `pr-gate.yml` cobre `patient-itinerary`; os specs
 * `admission-c-*` NÃO rodam ali (fazem login real no emulador do Firebase, que o job não tem) — um caso
 * novo dentro deles nasceria sem execução. O fluxo FELIZ do bloco já vive em
 * `admission-c-servico-contratado-humano`.
 *
 * Side-effect outbound mapeado: POST/supersede de autorização só escrevem em Postgres (sem vaga, sem
 * Talentum/Twilio/Periskope/e-mail).
 *
 * Os 3 testes (alternativos do bloco):
 *   1. 409 AUTHORIZATION_OVERLAPS na tela — já existe uma autorização FUTURA (POST pela API); digitar um
 *      período que a cruza → `svc-auth-error-1` com o texto de `authorization.overlaps`;
 *   2. supersede troca a vigente — vigente de 20 h; digitar 30 h → `svc-auth-current-1` mostra "30 h" e
 *      `GET …/authorizations` tem 2 linhas, a antiga com `supersededAt`.
 *   3. serviço com valor LEGADO (pcs.authorized_hours) e sem autorização vigente — o bloco diz "sin autorización" e NÃO
 *      mostra o valor antigo (058 B, P7). O feliz do bloco (criar → aparece como corrente) vive em
 *      admission-c-servico-contratado-humano e, para o supersede, no teste 2.
 *
 * Datas digitadas com dia = mês (06/06, 07/07, 01/01, 12/12): o teclado vale em qualquer ordem de
 * segmentos do locale e o valor lido da tela é ISO.
 */
import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import {
  mockAdminUserFor, useLancamentoStaff, LANCAMENTO_VIEWPORT_ES_AR, backendUrl, postContractedServiceViaApi,
} from '../helpers/lancamento-e2e-helper';
import { loginAs, tokenFor } from '../helpers/abac-stack-helper';
import { insertTestPatient } from '../helpers/db-test-helper';
import { cleanupPatientDeep } from '../helpers/patient-detail-a-helper';
import { sqlComVars } from '../helpers/sql-com-vars';

const STAFF = mockAdminUserFor('autorizacion');

interface AuthorizationRow { id: string; hours: number; validFrom: string; validTo: string; supersededAt: string | null }

async function seedServico(request: APIRequestContext): Promise<{ patientId: string; serviceId: string }> {
  const { patientId, addressId } = insertTestPatient({ status: 'SEARCHING', withAddress: true, hasConsent: true, insuranceInformed: 'OSDE' });
  if (!addressId) throw new Error('patient-itinerary-autorizacion: insertTestPatient sem addressId');
  try {
    const serviceId = await postContractedServiceViaApi(request, tokenFor(STAFF), patientId, {
      serviceCode: 'AT', providersNeeded: 1, careLocation: 'HOME', addressId,
    });
    return { patientId, serviceId };
  } catch (err) {
    cleanupPatientDeep(patientId);
    throw err;
  }
}

/** `POST …/authorizations` real — a autorização nasce pela API, a tela só a LÊ. */
async function criarAutorizacaoViaApi(
  request: APIRequestContext, patientId: string, serviceId: string, body: { hours: number; validFrom: string; validTo: string },
): Promise<void> {
  const res = await request.post(`${backendUrl()}/api/admin/patients/${patientId}/contracted-services/${serviceId}/authorizations`, {
    headers: { Authorization: `Bearer ${tokenFor(STAFF)}`, 'Content-Type': 'application/json' },
    data: body,
  });
  expect(res.status(), await res.text()).toBe(201);
}

async function lerAutorizacoes(request: APIRequestContext, patientId: string, serviceId: string): Promise<AuthorizationRow[]> {
  const res = await request.get(`${backendUrl()}/api/admin/patients/${patientId}/contracted-services/${serviceId}/authorizations`, {
    headers: { Authorization: `Bearer ${tokenFor(STAFF)}` },
  });
  expect(res.status()).toBe(200);
  return ((await res.json()) as { data: { authorizations: AuthorizationRow[] } }).data.authorizations;
}

async function abrirDrawerDoServico(page: Page, patientId: string, serviceId: string): Promise<void> {
  await page.goto(`/admin/patients/${patientId}`);
  await page.getByTestId('patient-profile-tabs').getByRole('button', { name: 'Servicio Contratado' }).click();
  await page.getByTestId(`contracted-service-edit-${serviceId}`).click();
  await expect(page.getByRole('dialog', { name: 'Editar servicio contratado' })).toBeVisible();
  await expect(page.getByTestId('svc-auth-block-1')).toBeVisible();
}

/** Clica no campo como um humano, digita, e devolve o que a TELA mostra depois. */
async function digitar(page: Page, testId: string, texto: string): Promise<string> {
  const campo = page.getByTestId(testId);
  await campo.click();
  await expect(campo).toBeFocused();
  await page.keyboard.type(texto);
  return campo.inputValue();
}

test.describe('patient-itinerary-autorizacion: bloco Autorización do serviço @integration', () => {
  test.use({ ...LANCAMENTO_VIEWPORT_ES_AR, deviceScaleFactor: 1 });
  test.setTimeout(120_000);
  useLancamentoStaff(STAFF, 'E2E Autorizacion');

  test('409 AUTHORIZATION_OVERLAPS aparece na tela e nada é gravado', async ({ page, request }) => {
    const { patientId, serviceId } = await seedServico(request);
    try {
      // Autorização FUTURA (2099): não é a vigente de hoje, então a tela cria (não substitui) — e o período digitado a cruza.
      await criarAutorizacaoViaApi(request, patientId, serviceId, { hours: 20, validFrom: '2099-01-01', validTo: '2099-12-12' });
      await loginAs(page, STAFF);
      await abrirDrawerDoServico(page, patientId, serviceId);
      await expect(page.getByTestId('svc-auth-none-1')).toBeVisible();

      expect(await digitar(page, 'svc-auth-hours-1', '30')).toBe('30');
      expect(await digitar(page, 'svc-auth-from-1', '06062099')).toBe('2099-06-06');
      expect(await digitar(page, 'svc-auth-to-1', '07072099')).toBe('2099-07-07');
      const [resp] = await Promise.all([
        page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith('/authorizations')),
        page.getByTestId('svc-auth-save-1').click(),
      ]);
      expect(resp.status()).toBe(409);
      const erro = page.getByTestId('svc-auth-error-1');
      await expect(erro).toBeVisible();
      await expect(erro).toContainText('Ya hay una autorización vigente que se superpone con ese período.');

      expect((await lerAutorizacoes(request, patientId, serviceId)).map((a) => a.hours)).toEqual([20]); // só a da semente
    } finally {
      cleanupPatientDeep(patientId);
    }
  });

  test('supersede troca a vigente: 20 h → 30 h, com a antiga marcada como substituída', async ({ page, request }) => {
    const { patientId, serviceId } = await seedServico(request);
    try {
      await criarAutorizacaoViaApi(request, patientId, serviceId, { hours: 20, validFrom: '2020-01-01', validTo: '2099-12-12' });
      await loginAs(page, STAFF);
      await abrirDrawerDoServico(page, patientId, serviceId);
      await expect(page.getByTestId('svc-auth-current-1')).toContainText('20 h');

      expect(await digitar(page, 'svc-auth-hours-1', '30')).toBe('30');
      expect(await digitar(page, 'svc-auth-from-1', '01012020')).toBe('2020-01-01');
      expect(await digitar(page, 'svc-auth-to-1', '12122099')).toBe('2099-12-12');
      const [resp] = await Promise.all([
        page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith('/supersede')),
        page.getByTestId('svc-auth-save-1').click(),
      ]);
      expect(resp.status()).toBe(201);
      await expect(page.getByTestId('svc-auth-current-1')).toContainText('30 h');
      await expect(page.getByTestId('svc-auth-error-1')).toHaveCount(0);

      const linhas = await lerAutorizacoes(request, patientId, serviceId);
      expect(linhas).toHaveLength(2);
      expect(linhas.find((a) => a.hours === 20)?.supersededAt).not.toBeNull();
      expect(linhas.find((a) => a.hours === 30)?.supersededAt).toBeNull();
    } finally {
      cleanupPatientDeep(patientId);
    }
  });

  test('serviço com authorized_hours LEGADO e sem autorização: o bloco diz "sin autorización" e NÃO mostra o valor antigo', async ({ page, request }) => {
    const { patientId, serviceId } = await seedServico(request);
    try {
      sqlComVars(`UPDATE patient_contracted_services SET authorized_hours = 20 WHERE id = :'sid'`, { sid: serviceId });
      await loginAs(page, STAFF);
      await abrirDrawerDoServico(page, patientId, serviceId);
      await expect(page.getByTestId('svc-auth-none-1')).toBeVisible();
      await expect(page.getByTestId('svc-auth-none-1')).toContainText('Sin autorización vigente');
      await expect(page.getByTestId('svc-auth-legacy-1')).toHaveCount(0);
      await expect(page.getByTestId('svc-auth-block-1')).not.toContainText('Valor anterior');
      expect(sqlComVars(`SELECT coalesce(authorized_hours::text, '<null>') FROM patient_contracted_services WHERE id = :'sid'`, { sid: serviceId })).toBe('20'); // a coluna segue lá (snapshot): é a TELA que não a mostra
    } finally {
      cleanupPatientDeep(patientId);
    }
  });
});
