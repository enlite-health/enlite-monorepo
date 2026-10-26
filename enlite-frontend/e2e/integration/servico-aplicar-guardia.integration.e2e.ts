/**
 * servico-aplicar-guardia.integration.e2e.ts @integration — spec 074: aplicar uma guardia predefinida aos dias do
 * serviço contratado, exercitado por um HUMANO contra o stack REAL (frontend + API + Postgres), sem mock de dado de
 * negócio — só a auth é o mock do stack (`loginAs`). Régua humana (memória `e2e-humano-nao-e-fill`): clique real no
 * select de guardia, nos botões de dia e em "Aplicar"; a hora do turno extra é escolhida no TimeSelect; o que o
 * servidor gravou é lido de volta pela API (`GET …/contracted-services`) na MESMA execução.
 *
 * Side-effect outbound mapeado ANTES: o PATCH do serviço só escreve em Postgres (sem vaga ativa neste paciente,
 * nada de Talentum/Twilio/Periskope/e-mail). O serviço nasce SEM horário (POST pela API real); as guardias são as
 * sementes da migration 550 (não são alteradas) e UMA guardia "QA 074 …" criada e desativada pela API, só para provar
 * que a desativada não é oferecida (removida no afterAll: itens primeiro, depois a guardia).
 *
 * Job padrão `integration` (engine OFF, token `role: 'admin'`).
 */
import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import {
  mockAdminUserFor, useLancamentoStaff, LANCAMENTO_VIEWPORT_ES_AR, backendUrl, postContractedServiceViaApi,
} from '../helpers/lancamento-e2e-helper';
import { loginAs, tokenFor } from '../helpers/abac-stack-helper';
import { insertTestPatient } from '../helpers/db-test-helper';
import { cleanupPatientDeep, runSQL } from '../helpers/patient-detail-a-helper';

const STAFF = mockAdminUserFor('servico-aplicar-guardia');
const STAMP = Date.now().toString(36);
const LABEL_DESATIVADA = `QA 074 desativada ${STAMP}`;

type Faixa = { dayOfWeek: number; startTime: string; durationMinutes: number; endTime: string };

const rotuloDaSemente = (code: string): string => runSQL(`SELECT label FROM service_shift_templates WHERE code = '${code}'`);
const seedGuardias = (): string => rotuloDaSemente('GUARDIAS_8_14_20');
const seed24h = (): string => rotuloDaSemente('GUARDIA_24H');

/** Paciente com endereço + 1 serviço AT SEM horário (POST real); a tela monta o resto. */
async function seedServicoSemHorario(request: APIRequestContext): Promise<{ patientId: string; serviceId: string }> {
  const { patientId, addressId } = insertTestPatient({ status: 'SEARCHING', withAddress: true, hasConsent: true, insuranceInformed: 'OSDE' });
  if (!addressId) throw new Error('servico-aplicar-guardia: insertTestPatient sem addressId');
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

/** Ficha → aba "Servicio Contratado" → lápis da linha → drawer de edição aberto. */
async function abrirEditor(page: Page, patientId: string, serviceId: string): Promise<void> {
  await page.goto(`/admin/patients/${patientId}`);
  await page.getByTestId('patient-profile-tabs').getByRole('button', { name: 'Servicio Contratado' }).click();
  await page.getByTestId(`contracted-service-edit-${serviceId}`).click();
  await expect(page.getByRole('dialog', { name: 'Editar servicio contratado' })).toBeVisible();
  await expect(page.getByTestId('svc-shift-template-select-1')).toBeVisible(); // o controle de guardia chegou (índice visual 1)
}

/** Escolhe a hora no TimeSelect como um humano: abre a lista e clica na opção. */
async function escolherHora(page: Page, testId: string, hora: string): Promise<void> {
  await page.getByTestId(testId).click();
  await page.getByTestId(`${testId}-option-${hora}`).click();
  await expect(page.getByTestId(testId)).toContainText(hora);
}

/** Abre a lista do select de guardia (Combobox): o gatilho é um `combobox`, as opções são `option` do `listbox` aberto. */
async function abrirListaDeGuardias(page: Page): Promise<void> {
  await page.getByTestId('svc-shift-template-select-1').click();
  await expect(page.getByRole('listbox')).toBeVisible();
}

async function escolherGuardia(page: Page, rotulo: string): Promise<void> {
  await abrirListaDeGuardias(page);
  await page.getByRole('listbox').getByRole('option', { name: rotulo, exact: true }).click();
  await expect(page.getByTestId('svc-shift-template-select-1')).toContainText(rotulo);
}

/** Marca os dias (0 = domingo) e clica "Aplicar". */
async function aplicarNosDias(page: Page, dias: number[]): Promise<void> {
  for (const d of dias) await page.getByTestId(`svc-shift-template-day-1-${d}`).click();
  await page.getByTestId('svc-shift-template-apply-1').click();
}

/** `GET …/contracted-services` real — o schedule do serviço como a API o devolve. */
async function lerSchedule(request: APIRequestContext, patientId: string, serviceId: string): Promise<Faixa[]> {
  const res = await request.get(`${backendUrl()}/api/admin/patients/${patientId}/contracted-services`, {
    headers: { Authorization: `Bearer ${tokenFor(STAFF)}` },
  });
  expect(res.status()).toBe(200);
  const json = (await res.json()) as { data?: { services: Array<{ id: string; schedule: Faixa[] | null }> }; services?: Array<{ id: string; schedule: Faixa[] | null }> };
  const svc = (json.data?.services ?? json.services ?? []).find((s) => s.id === serviceId);
  if (!svc) throw new Error('servico-aplicar-guardia: serviço ausente no GET');
  return svc.schedule ?? [];
}

const doDia = (faixas: Faixa[], dia: number): Faixa[] => faixas.filter((f) => f.dayOfWeek === dia).sort((a, b) => a.startTime.localeCompare(b.startTime));

const ehPatchDoServico = (serviceId: string) => (r: { method(): string; url(): string }): boolean =>
  r.method() === 'PATCH' && r.url().endsWith(`/contracted-services/${serviceId}`);

async function guardar(page: Page, serviceId: string): Promise<void> {
  const [patch] = await Promise.all([
    page.waitForResponse((r) => ehPatchDoServico(serviceId)(r.request())),
    page.getByTestId(`contracted-service-save-${serviceId}`).click(),
  ]);
  expect(patch.status()).toBe(200);
}

test.describe('servico-aplicar-guardia: aplicar uma guardia predefinida aos dias do serviço @integration', () => {
  test.use({ ...LANCAMENTO_VIEWPORT_ES_AR, deviceScaleFactor: 1 });
  test.setTimeout(150_000);
  useLancamentoStaff(STAFF, 'E2E Servico Aplicar Guardia');

  test.afterAll(() => {
    const ids = `SELECT id FROM service_shift_templates WHERE label LIKE 'QA 074 %${STAMP}'`;
    runSQL(`DELETE FROM service_shift_template_items WHERE template_id IN (${ids})`);
    runSQL(`DELETE FROM service_shift_templates WHERE label LIKE 'QA 074 %${STAMP}'`);
  });

  test('feliz: Guardias 8–14 · 14–20 · 20–8 em seg-sex, Guardar, o GET do itinerário traz 15 faixas', async ({ page, request }) => {
    const { patientId, serviceId } = await seedServicoSemHorario(request);
    try {
      await loginAs(page, STAFF);
      await abrirEditor(page, patientId, serviceId);
      await escolherGuardia(page, seedGuardias());
      await aplicarNosDias(page, [1, 2, 3, 4, 5]);

      // Lido da TELA: 3 turnos por dia útil, 15 no total, e o turno das 20:00 aparece uma vez no dia.
      for (const dia of [1, 2, 3, 4, 5]) await expect(page.locator(`[data-testid^="svc-shift-start-1-${dia}-"]`)).toHaveCount(3);
      await expect(page.locator('[data-testid^="svc-shift-start-1-"]')).toHaveCount(15);
      await expect(page.locator('[data-testid^="svc-shift-start-1-1-"]').filter({ hasText: '20:00' })).toHaveCount(1);

      await guardar(page, serviceId);
      const faixas = await lerSchedule(request, patientId, serviceId);
      expect(faixas).toHaveLength(15);
      for (const dia of [1, 2, 3, 4, 5]) {
        const doDiaX = doDia(faixas, dia);
        expect(doDiaX.map((f) => f.startTime), `dia ${dia}: inícios`).toEqual(['08:00', '14:00', '20:00']);
        expect(doDiaX.map((f) => f.durationMinutes), `dia ${dia}: durações`).toEqual([360, 360, 720]);
      }
      expect(faixas.filter((f) => f.dayOfWeek === 0 || f.dayOfWeek === 6), 'sábado e domingo ficam sem faixa').toHaveLength(0);
    } finally {
      cleanupPatientDeep(patientId);
    }
  });

  test('alternativo: dia com turno sobreposto mantém o existente e avisa o dia', async ({ page, request }) => {
    const { patientId, serviceId } = await seedServicoSemHorario(request);
    try {
      await loginAs(page, STAFF);
      await abrirEditor(page, patientId, serviceId);
      // Antes: segunda 09:00–17:00 montada pela tela (cruza 08–14 e 14–20 da guardia, não cruza 20–08).
      await page.getByTestId('svc-shift-add-1-1').click();
      await expect(page.getByTestId('svc-shift-start-1-1-0')).toBeVisible();
      await escolherHora(page, 'svc-shift-start-1-1-0', '09:00');
      await escolherHora(page, 'svc-shift-end-1-1-0', '17:00');

      await escolherGuardia(page, seedGuardias());
      await aplicarNosDias(page, [1]);
      const aviso = page.getByTestId('svc-shift-copy-conflict-1-1');
      await expect(aviso).toBeVisible();
      await expect(aviso).toContainText('La franja ya existente se mantuvo en');
      await expect(page.locator('[data-testid^="svc-shift-start-1-1-"]')).toHaveCount(2); // 09:00 (mantido) + 20:00

      await guardar(page, serviceId);
      const segunda = doDia(await lerSchedule(request, patientId, serviceId), 1);
      expect(segunda.map((f) => `${f.startTime}/${f.durationMinutes}`)).toEqual(['09:00/480', '20:00/720']);
      expect(segunda.map((f) => f.startTime), 'nem 08:00 nem 14:00').not.toContain('08:00');
      expect(segunda.map((f) => f.startTime)).not.toContain('14:00');
    } finally {
      cleanupPatientDeep(patientId);
    }
  });

  test('alternativo: guardia 24 h gera Todo el día e guardia desativada não aparece', async ({ page, request }) => {
    // A guardia "QA 074 desativada" nasce e é desativada ANTES de abrir o editor (a lista de opções é lida ao montar).
    const criada = await request.post(`${backendUrl()}/api/admin/therapeutic-catalogs/service-shift-templates`, {
      headers: { Authorization: `Bearer ${tokenFor(STAFF)}`, 'Content-Type': 'application/json' },
      data: { label: LABEL_DESATIVADA, items: [{ startTime: '06:00', durationMinutes: 120 }] },
    });
    expect(criada.status()).toBe(201);
    const desativadaId = ((await criada.json()) as { data: { id: string } }).data.id;
    const desativou = await request.patch(`${backendUrl()}/api/admin/therapeutic-catalogs/service-shift-templates/${desativadaId}`, {
      headers: { Authorization: `Bearer ${tokenFor(STAFF)}`, 'Content-Type': 'application/json' },
      data: { active: false },
    });
    expect(desativou.status()).toBe(200);
    expect(runSQL(`SELECT active::text FROM service_shift_templates WHERE id = '${desativadaId}'`)).toBe('false');

    const { patientId, serviceId } = await seedServicoSemHorario(request);
    try {
      await loginAs(page, STAFF);
      await abrirEditor(page, patientId, serviceId);
      await abrirListaDeGuardias(page);
      const lista = page.getByRole('listbox');
      // Controle positivo ANTES do "não aparece": a lista renderizou e traz as 2 sementes.
      await expect(lista.getByRole('option', { name: seedGuardias(), exact: true })).toBeVisible();
      await expect(lista.getByRole('option', { name: seed24h(), exact: true })).toBeVisible();
      await expect(lista.getByRole('option', { name: LABEL_DESATIVADA, exact: true })).toHaveCount(0);

      await lista.getByRole('option', { name: seed24h(), exact: true }).click();
      await expect(page.getByTestId('svc-shift-template-select-1')).toContainText(seed24h());
      await aplicarNosDias(page, [2]); // terça-feira
      await expect(page.locator('[data-testid^="svc-shift-start-1-2-"]')).toHaveCount(1);
      await expect(page.getByTestId('svc-shift-allday-1-2-0')).toBeChecked();
      await expect(page.getByTestId('svc-shift-duration-1-2-0')).toContainText('24 h');

      await guardar(page, serviceId);
      expect((await lerSchedule(request, patientId, serviceId)).map((f) => `${f.dayOfWeek}/${f.startTime}/${f.durationMinutes}`)).toEqual(['2/08:00/1440']);
    } finally {
      cleanupPatientDeep(patientId);
    }
  });
});
