/**
 * admissao-diagnostico-obrigatorio.integration.e2e.ts @integration — pedido do Javier (operação),
 * decisão do Gabriel: o diagnóstico CID-11 é OBRIGATÓRIO na SAÍDA da admissão.
 *
 * O paciente continua nascendo em ADMISSION sem diagnóstico; o que ele não faz sem ≥1 diagnóstico
 * ATIVO é sair de ADMISSION — aqui, pelo caminho que o operador usa na ficha: o foguete
 * "Activar reclutamiento" (cria a vaga e move o paciente para Búsqueda). A trava é do SERVIDOR; a
 * tela só a antecipa (checklist, asterisco `required`, foguete desabilitado com o motivo).
 *
 * API e Postgres reais (stack docker), login pelo emulador. Dado 100% sintético: o título do
 * diagnóstico semeado/escolhido nunca é clínico real, e o VALOR nunca aparece em erro/log.
 *
 *  T1 FELIZ         ADMISSION COM diagnóstico → o foguete cria a vaga e o paciente sai para Búsqueda.
 *  T2 ALTERNATIVO 1 ADMISSION SEM diagnóstico → checklist acusa "Diagnóstico" (bloqueante), o rótulo do
 *                   card leva `*`, o foguete fica desabilitado nomeando o item, e a API recusa (422).
 *  T3 ALTERNATIVO 2 o mesmo paciente: o operador ADICIONA o diagnóstico pelo drawer (busca CID-11, clique)
 *                   → o item some do checklist, o foguete libera e o paciente sai para Búsqueda.
 */
import { test, expect, type Page } from '@playwright/test';
import {
  seedLaunchablePatient,
  clickFoguete,
  backendUrl,
  mockAdminUserFor,
  useLancamentoStaff,
} from '../helpers/lancamento-e2e-helper';
import { readPatientStatusApi } from '../helpers/lancamento-leituras-helper';
import { loginAs, tokenFor } from '../helpers/abac-stack-helper';
import { runSQL } from '../helpers/patient-detail-a-helper';
import { setCatalogPromoted, isCatalogPromoted, readPatientDiagnoses } from '../helpers/terminology-diagnosis-helper';

const MOCK_ADMIN_USER = mockAdminUserFor('diagnostico-obrigatorio');

async function abrirFicha(page: Page, patientId: string): Promise<void> {
  const isDetail = new RegExp(`/api/admin/patients/${patientId}(\\?|$)`);
  const detail = page.waitForResponse((r) => r.request().method() === 'GET' && isDetail.test(r.url()), { timeout: 20_000 });
  await page.goto(`/admin/patients/${patientId}`);
  await detail;
  await expect(page.getByTestId('patient-profile-tabs')).toBeVisible({ timeout: 15_000 });
}

test.describe('Diagnóstico obrigatório na saída da admissão @integration', () => {
  test.use({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(180_000);

  useLancamentoStaff(MOCK_ADMIN_USER, 'E2E Diagnostico Obrigatorio');

  const catalogoJaPromovido = isCatalogPromoted();
  test.beforeAll(() => { setCatalogPromoted(true); }); // sem release corrente a busca CID-11 devolve 503 (T3)
  test.afterAll(() => { setCatalogPromoted(catalogoJaPromovido); });

  test('T1 feliz — ADMISSION COM diagnóstico: o foguete cria a vaga e o paciente sai da admissão', async ({ page, request }) => {
    const token = tokenFor(MOCK_ADMIN_USER);
    const patient = await seedLaunchablePatient(request, { status: 'ADMISSION', lat: -54.31, lng: -67.41 }); // com diagnóstico (default)
    try {
      await loginAs(page, MOCK_ADMIN_USER);
      await abrirFicha(page, patient.patientId);

      // O checklist NÃO acusa diagnóstico e o rótulo continua marcado como obrigatório (segue em ADMISSION).
      await expect(page.getByTestId('completeness-item').filter({ hasText: 'Diagnóstico' })).toHaveCount(0);
      await expect(page.getByTestId('diagnostico-card-required-label')).toBeVisible();

      expect(await readPatientStatusApi(request, backendUrl(), token, patient.patientId), 'antes do foguete').toBe('ADMISSION');
      const vacancyId = await clickFoguete(page, patient.patientId, patient.serviceId);
      expect(vacancyId).toBeTruthy();
      expect(await readPatientStatusApi(request, backendUrl(), token, patient.patientId), 'depois do foguete').toBe('SEARCHING');
    } finally {
      patient.cleanup();
    }
  });

  test('T2 alternativo 1 — ADMISSION SEM diagnóstico: checklist acusa, asterisco no card, foguete desabilitado nomeando o item, API recusa (422)', async ({ page, request }) => {
    const token = tokenFor(MOCK_ADMIN_USER);
    const patient = await seedLaunchablePatient(request, { status: 'ADMISSION', lat: -54.32, lng: -67.42, withDiagnosis: false });
    try {
      expect(readPatientDiagnoses(patient.patientId), 'pré-condição: nenhum diagnóstico').toHaveLength(0);
      await loginAs(page, MOCK_ADMIN_USER);
      await abrirFicha(page, patient.patientId);

      // 1. Checklist: "Diagnóstico" é BLOQUEANTE ("Para activar falta:"), clicável, sem código cru.
      await expect(page.getByText('Para activar falta:')).toBeVisible();
      const item = page.getByTestId('completeness-item').filter({ hasText: 'Diagnóstico' });
      await expect(item).toBeVisible();
      await expect(page.getByText('DIAGNOSIS', { exact: true })).toHaveCount(0);

      // 2. Card: o rótulo leva o asterisco (padrão `required` do Label) e a dica de obrigatório.
      const rotulo = page.getByTestId('diagnostico-card-required-label');
      await expect(rotulo).toBeVisible();
      await expect(rotulo.locator('span.text-red-500')).toHaveText('*');
      await expect(page.getByTestId('diagnostico-card-patologias-empty')).toContainText('obligatorio');

      // 3. O foguete do serviço está desabilitado e o motivo nomeia o diagnóstico.
      await page.getByTestId('patient-profile-tabs').getByRole('button', { name: 'Servicio Contratado' }).click();
      const foguete = page.getByTestId(`contracted-service-activate-recruitment-${patient.serviceId}`);
      await expect(foguete).toBeVisible();
      await expect(foguete).toBeDisabled();
      await expect(foguete).toHaveAttribute('title', /Diagnóstico/);

      // 4. A trava é do SERVIDOR: pular a tela não escapa dela.
      const res = await request.put(`${backendUrl()}/api/admin/patients/${patient.patientId}/status`, {
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        data: { status: 'SEARCHING', changeSource: 'kanban' },
      });
      expect(res.status()).toBe(422);
      const corpo = (await res.json()) as { code: string; details: { missing: string[] } };
      expect(corpo.code).toBe('PATIENT_STATUS_NOT_READY');
      expect(corpo.details.missing).toContain('DIAGNOSIS');
      expect(runSQL(`SELECT status FROM patients WHERE id = '${patient.patientId}'`).trim()).toBe('ADMISSION');
    } finally {
      patient.cleanup();
    }
  });

  test('T3 alternativo 2 — o operador adiciona o diagnóstico pelo drawer: o item some, o foguete libera e o paciente sai da admissão', async ({ page, request }) => {
    const token = tokenFor(MOCK_ADMIN_USER);
    const patient = await seedLaunchablePatient(request, { status: 'ADMISSION', lat: -54.33, lng: -67.43, withDiagnosis: false });
    try {
      await loginAs(page, MOCK_ADMIN_USER);
      await abrirFicha(page, patient.patientId);

      // Clicar no item do checklist abre o drawer clínico (onde mora a busca CID-11).
      await page.getByTestId('completeness-item').filter({ hasText: 'Diagnóstico' }).click();
      const drawer = page.getByTestId('patient-clinical-edit-drawer');
      await expect(drawer).toBeVisible();

      // Busca e escolha COMO HUMANO: clique no campo, digitação, clique na opção (nada de fill).
      const busca = page.getByTestId('icd-search-input');
      await busca.click();
      const respostaBusca = page.waitForResponse((r) => r.request().method() === 'GET' && /\/api\/admin\/terminology\/search/.test(r.url()));
      await busca.pressSequentially('esquizofrenia', { delay: 30 });
      expect((await respostaBusca).status()).toBe(200);
      const opcao = page.getByTestId('icd-search-option-0');
      await expect(opcao).toBeVisible({ timeout: 10_000 });
      const criou = page.waitForResponse((r) => r.request().method() === 'POST' && /\/diagnoses$/.test(r.url()));
      await opcao.click();
      expect((await criou).status()).toBe(201);
      await expect(page.getByTestId('diagnosis-chips')).toContainText('Esquizofrenia', { timeout: 10_000 });
      await drawer.getByRole('button', { name: 'Cerrar' }).click();
      await expect(drawer).toHaveCount(0, { timeout: 15_000 });

      // Liberou: o item sumiu do checklist e a patología aparece no card.
      await expect(page.getByTestId('completeness-item').filter({ hasText: 'Diagnóstico' })).toHaveCount(0, { timeout: 20_000 });
      await expect(page.getByTestId('diagnostico-card-patologias')).toContainText('Esquizofrenia');
      expect(readPatientDiagnoses(patient.patientId).filter((d) => d.active)).toHaveLength(1);

      // E o foguete agora cria a vaga e tira o paciente da admissão.
      const vacancyId = await clickFoguete(page, patient.patientId, patient.serviceId);
      expect(vacancyId).toBeTruthy();
      expect(await readPatientStatusApi(request, backendUrl(), token, patient.patientId)).toBe('SEARCHING');
    } finally {
      patient.cleanup();
    }
  });
});
