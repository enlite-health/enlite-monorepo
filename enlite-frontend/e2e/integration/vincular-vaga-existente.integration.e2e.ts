/**
 * vincular-vaga-existente.integration.e2e.ts @integration — spec 079 §8.3 (T039): botão "Vincular vacante existente" na linha do serviço.
 *
 * E2E DE TELA, sem mock de dado: frontend + API + Postgres reais, engine ABAC LIGADO, staff REAL em grupo com as 2 células do foguete
 * (`patient_services:update` + `vacancy:update`) mais as de leitura da ficha. O único `page.route` é o do login do stack de CI
 * (`installAuthInterceptors`: Identity Toolkit forjado + troca do header Authorization por `mock_*`); a resposta da API é a real.
 * Gestos de humano: click + keyboard.type + `escolherNoCombo`. Dados 100% sintéticos (sobrenome " QA"); o seed é por SQL (não passa
 * pela API), então nenhum canal real (WhatsApp/Talentum/Calendar) é tocado.
 *
 *  feliz  — serviço com faixa, vaga legada com os campos + 1 candidatura + 1 encuadre: prévia, print do modal, confirma; o Kanban da
 *           vaga fica IGUAL (mesmo id, mesmas contagens), a vaga aponta ao serviço, o serviço recebe os campos, os 2 botões somem.
 *  alt 1  — endereço da vaga != endereço do serviço: bloqueio de endereço, confirmar desabilitado, nada gravado.
 *  alt 2  — serviço sem faixa vigente: bloqueio listando o horário que falta, confirmar desabilitado, nada gravado.
 *  foguete — serviço PRONTO + vaga legada ABERTA: abre o modal com as duas saídas e não cria vaga; "Criar vaga nova" cria com o sinal e audita;
 *            só vaga ENCERRADA: cria direto, sem modal; 2 candidatas + vincular: pergunta se exclui a outra (Sí exclui, No não).
 */
import { test, expect, type Page } from '@playwright/test';
import { seedActivatablePatient } from '../helpers/patient-detail-c-helper';
import {
  safeSql, seedStaffInGroup, cleanupStaffAndGroup, grantCell, installAuthInterceptors, ABAC_TENANT,
} from '../helpers/abac-stack-helper';
import { escolherNoCombo } from '../helpers/combobox';
import { RECRUITMENT_FIELDS_E2E, RECRUITMENT_SQL_COLUMNS, RECRUITMENT_SQL_VALUES } from '../helpers/recruitment-fields-e2e';
import {
  runSQL, seedContractedService, seedServiceWithoutSchedule, seedLegacyVacancy, createPatientAddress,
  readVacancyKanbanFingerprint, readVacancyServiceFields, readServiceRecruitmentFields, cleanupVincularVaga,
  type LegacyVacancySeed,
} from '../helpers/vincular-vaga-e2e-helper';
import { formatVacancyCase } from '../../src/domain/value-objects/caseNumberFormat';

/** Valor que o serviço JÁ tem (≠ do da vaga, 'experiencia e2e'): a única linha que a prévia deve listar. */
const EXPERIENCIA_DO_SERVICO = 'experiencia del servicio e2e';

const RUN_ID = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
const uid = `e2e-079-staff-${RUN_ID}`;
const staff = { uid, email: `${uid}@e2e.test`, role: 'admin', country: 'AR' };

/** Rótulo que a pessoa lê na lista: "<caso>#<ordinal> · <título> · <status>" (LinkExistingVacancyModal). */
const rotuloDaVaga = (v: LegacyVacancySeed): string =>
  `${formatVacancyCase(v.caseNumber, v.caseOrdinal)} · CASO ${v.caseNumber} vaga legada QA · En búsqueda`;

/** Login como uma pessoa faz (clique + teclado), sem `waitForTimeout`: a asserção é o destino real. */
async function login(page: Page): Promise<void> {
  await installAuthInterceptors(page, staff);
  await page.addInitScript(() => localStorage.setItem('i18nextLng', 'es'));
  await page.goto('/admin/login');
  const email = page.locator('input[type="email"]');
  await email.click();
  await expect(email).toBeFocused();
  await page.keyboard.type(staff.email);
  const password = page.locator('input[type="password"]');
  await password.click();
  await expect(password).toBeFocused();
  await page.keyboard.type('TestAdmin123!');
  await page.getByRole('button', { name: /Iniciar sesi/i }).click();
  await expect(page).toHaveURL(/\/admin\/dashboard\/?$/, { timeout: 30_000 });
}

async function abrirModal(page: Page, patientId: string, serviceId: string, vaga: LegacyVacancySeed): Promise<void> {
  await page.goto(`/admin/patients/${patientId}`);
  await expect(page.getByTestId(`contracted-service-row-${serviceId}`)).toBeVisible({ timeout: 30_000 });
  await page.getByTestId(`contracted-service-link-existing-vacancy-${serviceId}`).click();
  await expect(page.getByTestId('link-existing-vacancy-modal')).toBeVisible();
  await escolherNoCombo(page, page.getByTestId('link-existing-vacancy-combo'), rotuloDaVaga(vaga));
}

test.use({ viewport: { width: 1600, height: 1000 }, video: 'on' });

test.describe('spec 079 — vincular vaga existente ao serviço contratado @integration', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(180_000);

  let groupId = '';
  const patients: string[] = [];
  const workers: string[] = [];

  test.beforeAll(() => {
    groupId = seedStaffInGroup({ uid, email: staff.email, groupName: `Vincular079 ${RUN_ID}`, country: 'AR' }).groupId;
    for (const [r, a] of [
      ['patient', 'read'], ['patient_identity', 'read'], ['patient_address', 'read'],
      ['patient_services', 'read'], ['patient_services', 'update'], ['vacancy', 'read'], ['vacancy', 'update'], ['vacancy', 'delete'],
    ]) grantCell(groupId, r, a);
  });

  test.afterAll(() => {
    for (const p of patients) cleanupVincularVaga({ patientId: p });
    cleanupVincularVaga({ workerIds: workers });
    cleanupStaffAndGroup(uid, groupId);
    safeSql(`DELETE FROM iam.permission_groups WHERE tenant_id = '${ABAC_TENANT}' AND name = 'Vincular079 ${RUN_ID}'`);
  });

  test('feliz: escolhe a vaga, vê a prévia, confirma — Kanban intacto, serviço alimentado, os 2 botões somem', async ({ page }) => {
    const seed = seedActivatablePatient(761000);
    patients.push(seed.patientId);
    const { serviceId } = seedContractedService(seed.patientId, {
      addressId: seed.addressId, withSchedule: true, requiredExperience: EXPERIENCIA_DO_SERVICO,
    });
    const vaga = seedLegacyVacancy(seed.patientId, { addressId: seed.addressId });
    workers.push(vaga.workerId);

    const antes = readVacancyKanbanFingerprint(vaga.vacancyId);
    expect(antes).toMatchObject({ id: vaga.vacancyId, applications: 1, encuadres: 1 });
    expect(readServiceRecruitmentFields(serviceId).required_sex).toBeNull();

    await login(page);
    await abrirModal(page, seed.patientId, serviceId, vaga);

    const previa = page.getByTestId('link-existing-vacancy-preview');
    await expect(previa).toBeVisible();
    // Prévia só do que MUDA: a vaga entrega o resto com o mesmo valor, então só `required_experience` (valor do serviço ≠ da vaga).
    const linhas = previa.locator('tbody tr');
    await expect(linhas).toHaveCount(1);
    const celulas = linhas.first().locator('td');
    await expect(celulas.nth(0)).toHaveText('Experiencia requerida');
    await expect(celulas.nth(1)).toHaveText(RECRUITMENT_FIELDS_E2E.requiredExperience);
    await expect(celulas.nth(2)).toHaveText(EXPERIENCIA_DO_SERVICO);
    await expect(celulas.nth(3)).toHaveText('Servicio');
    await expect(previa).not.toContainText('Vacante → servicio');
    await expect(page.getByTestId('link-existing-vacancy-blockers')).toHaveCount(0);
    const confirmar = page.getByTestId('link-existing-vacancy-confirm');
    await expect(confirmar).toBeEnabled();

    // Medição (não olho): rótulos de Campo e Origen ocupam UMA linha.
    const qtdCelulas = await page.locator('[data-testid="link-preview-cell-field"], [data-testid="link-preview-cell-origin"]').count();
    expect(qtdCelulas, 'células de Campo/Origen medidas').toBeGreaterThan(0);
    for (const tid of ['link-preview-cell-field', 'link-preview-cell-origin']) {
      const cells = page.getByTestId(tid);
      const n = await cells.count();
      expect(n, `células ${tid}`).toBeGreaterThan(0);
      for (let i = 0; i < n; i++) {
        const cell = cells.nth(i);
        const m = await cell.locator('> *').first().evaluate((el) => ({
          h: el.getBoundingClientRect().height, lh: parseFloat(getComputedStyle(el).lineHeight),
        }));
        const texto = (await cell.innerText()).trim();
        expect(m.h, `rótulo "${texto}" quebrou linha (h=${m.h}, lh=${m.lh})`).toBeLessThanOrEqual(m.lh * 1.5);
      }
    }

    await expect(page.getByTestId('link-existing-vacancy-modal')).toHaveScreenshot('vincular-vaga-modal-previa.png', {
      mask: [page.getByTestId('link-existing-vacancy-combo')], // o rótulo traz o nº do caso (varia por execução)
      maxDiffPixelRatio: 0.02,
    });

    await confirmar.click();
    await expect(page.getByText('Vacante vinculada al servicio.')).toBeVisible();
    await expect(page.getByTestId('link-existing-vacancy-modal')).toHaveCount(0);
    await expect(page.getByTestId(`contracted-service-link-existing-vacancy-${serviceId}`)).toHaveCount(0);
    await expect(page.getByTestId(`contracted-service-activate-recruitment-${serviceId}`)).toHaveCount(0);

    expect(readVacancyKanbanFingerprint(vaga.vacancyId)).toEqual(antes);
    expect(readVacancyServiceFields(vaga.vacancyId).contracted_service_id).toBe(serviceId);
    const servico = readServiceRecruitmentFields(serviceId);
    // o serviço recebeu os campos que estavam vazios e MANTEVE o required_experience próprio (não foi sobrescrito pela vaga)
    expect(servico).toMatchObject({
      required_sex: RECRUITMENT_FIELDS_E2E.requiredSex,
      required_experience: EXPERIENCIA_DO_SERVICO,
      work_schedule: RECRUITMENT_FIELDS_E2E.workSchedule,
      payment_day: RECRUITMENT_FIELDS_E2E.paymentDay,
    });
  });

  test('alternativo 1: endereço da vaga diferente do serviço — bloqueio com mensagem, confirmar desabilitado, nada gravado', async ({ page }) => {
    const seed = seedActivatablePatient(762000);
    patients.push(seed.patientId);
    const outro = createPatientAddress(seed.patientId);
    const { serviceId } = seedContractedService(seed.patientId, { addressId: seed.addressId, withSchedule: true });
    const vaga = seedLegacyVacancy(seed.patientId, { addressId: outro });
    workers.push(vaga.workerId);
    const vagaAntes = readVacancyServiceFields(vaga.vacancyId);
    const servicoAntes = readServiceRecruitmentFields(serviceId);
    const kanbanAntes = readVacancyKanbanFingerprint(vaga.vacancyId);

    await login(page);
    await abrirModal(page, seed.patientId, serviceId, vaga);

    const bloqueio = page.getByTestId('link-existing-vacancy-blockers');
    await expect(bloqueio).toBeVisible();
    await expect(bloqueio).toContainText('La dirección de la vacante es distinta de la del servicio.');
    await expect(page.getByTestId('link-existing-vacancy-confirm')).toBeDisabled();

    expect(readVacancyServiceFields(vaga.vacancyId)).toEqual(vagaAntes);
    expect(readVacancyServiceFields(vaga.vacancyId).contracted_service_id).toBeNull();
    expect(readServiceRecruitmentFields(serviceId)).toEqual(servicoAntes);
    expect(readVacancyKanbanFingerprint(vaga.vacancyId)).toEqual(kanbanAntes);
  });

  test('alternativo 2: serviço sem faixa vigente — bloqueio lista o horário que falta, confirmar desabilitado, nada gravado', async ({ page }) => {
    const seed = seedActivatablePatient(763000);
    patients.push(seed.patientId);
    const { serviceId } = seedServiceWithoutSchedule(seed.patientId, seed.addressId);
    const vaga = seedLegacyVacancy(seed.patientId, { addressId: seed.addressId });
    workers.push(vaga.workerId);
    const vagaAntes = readVacancyServiceFields(vaga.vacancyId);
    const servicoAntes = readServiceRecruitmentFields(serviceId);
    const kanbanAntes = readVacancyKanbanFingerprint(vaga.vacancyId);

    await login(page);
    await abrirModal(page, seed.patientId, serviceId, vaga);

    const bloqueio = page.getByTestId('link-existing-vacancy-blockers');
    await expect(bloqueio).toBeVisible();
    await expect(bloqueio).toContainText('Todavía no se puede vincular');
    await expect(bloqueio).toContainText(/horario del servicio/i);
    await expect(page.getByTestId('link-existing-vacancy-confirm')).toBeDisabled();

    expect(readVacancyServiceFields(vaga.vacancyId)).toEqual(vagaAntes);
    expect(readVacancyServiceFields(vaga.vacancyId).contracted_service_id).toBeNull();
    expect(readServiceRecruitmentFields(serviceId)).toEqual(servicoAntes);
    expect(readVacancyKanbanFingerprint(vaga.vacancyId)).toEqual(kanbanAntes);
  });

  /** Paciente + serviço PRONTO para o foguete (5 campos do portão no serviço) + N vagas legadas (sem serviço). Foguete só habilita sem pendência. */
  function cenarioFoguete(seedBase: number, qtdVagas: number) {
    const seed = seedActivatablePatient(seedBase);
    patients.push(seed.patientId);
    const { serviceId } = seedContractedService(seed.patientId, { addressId: seed.addressId, withSchedule: true });
    runSQL(`UPDATE patient_contracted_services SET (${RECRUITMENT_SQL_COLUMNS}) = (${RECRUITMENT_SQL_VALUES}) WHERE id = '${serviceId}'`);
    const vagas: LegacyVacancySeed[] = [];
    for (let i = 0; i < qtdVagas; i++) {
      const v = seedLegacyVacancy(seed.patientId, { addressId: seed.addressId });
      workers.push(v.workerId);
      vagas.push(v);
    }
    const vagasVivas = (): number => Number(runSQL(`SELECT count(*) FROM job_postings WHERE patient_id = '${seed.patientId}' AND deleted_at IS NULL`));
    const vagasDoServico = (): number => Number(runSQL(`SELECT count(*) FROM job_postings WHERE contracted_service_id = '${serviceId}'`));
    return { seed, serviceId, vagas, vagasVivas, vagasDoServico };
  }

  async function clicarFoguete(page: Page, patientId: string, serviceId: string): Promise<void> {
    await login(page);
    await page.goto(`/admin/patients/${patientId}`);
    await expect(page.getByTestId(`contracted-service-row-${serviceId}`)).toBeVisible({ timeout: 30_000 });
    const foguete = page.getByTestId(`contracted-service-activate-recruitment-${serviceId}`);
    await expect(foguete).toBeEnabled();
    await foguete.click();
  }

  test('foguete com vaga legada ABERTA: abre o modal de vínculo com as duas saídas e NÃO cria vaga nova', async ({ page }) => {
    const { seed, serviceId, vagas, vagasVivas, vagasDoServico } = cenarioFoguete(764000, 1);
    expect(vagasVivas()).toBe(1);
    expect(vagasDoServico()).toBe(0);

    await clicarFoguete(page, seed.patientId, serviceId);

    await expect(page.getByTestId('link-existing-vacancy-modal')).toBeVisible();
    await expect(page.getByTestId('link-existing-vacancy-notice')).toContainText('ya tiene una vacante sin servicio');
    await expect(page.getByTestId('link-existing-vacancy-combo')).toBeVisible();
    await expect(page.getByTestId('link-existing-vacancy-create-new')).toHaveText('Crear vacante nueva');
    await expect(page.getByTestId('link-existing-vacancy-confirm')).toHaveText('Vincular a la existente');

    // Nenhuma vaga nova: a legada continua a única e continua sem serviço.
    expect(vagasVivas()).toBe(1);
    expect(vagasDoServico()).toBe(0);
    expect(readVacancyServiceFields(vagas[0].vacancyId).contracted_service_id).toBeNull();
  });

  test('foguete: "Criar vaga nova" cria a vaga do serviço (sinal explícito) e registra no audit a candidata recusada', async ({ page }) => {
    const { seed, serviceId, vagas, vagasVivas, vagasDoServico } = cenarioFoguete(765000, 1);
    await clicarFoguete(page, seed.patientId, serviceId);
    await expect(page.getByTestId('link-existing-vacancy-modal')).toBeVisible();
    await page.getByTestId('link-existing-vacancy-create-new').click();

    await expect(page.getByTestId('link-existing-vacancy-modal')).toHaveCount(0);
    await expect.poll(vagasDoServico, { timeout: 30_000 }).toBe(1);
    expect(vagasVivas()).toBe(2); // a legada segue viva e sem serviço; a nova é do serviço
    expect(readVacancyServiceFields(vagas[0].vacancyId).contracted_service_id).toBeNull();
    const novaId = runSQL(`SELECT id FROM job_postings WHERE contracted_service_id = '${serviceId}'`);
    const recusada = runSQL(`SELECT count(*) FROM job_posting_audit_log WHERE job_posting_id = '${novaId}' AND field_name = 'linkable_vacancies_declined'`);
    expect(Number(recusada)).toBe(1);
  });

  test('foguete: paciente só com vaga ENCERRADA — sem modal, cria a vaga direto', async ({ page }) => {
    const { seed, serviceId, vagas, vagasDoServico } = cenarioFoguete(766000, 1);
    runSQL(`UPDATE job_postings SET status = 'CLOSED' WHERE id = '${vagas[0].vacancyId}'`);

    await clicarFoguete(page, seed.patientId, serviceId);

    await expect.poll(vagasDoServico, { timeout: 30_000 }).toBe(1);
    await expect(page.getByTestId('link-existing-vacancy-modal')).toHaveCount(0);
    expect(readVacancyServiceFields(vagas[0].vacancyId).contracted_service_id).toBeNull();
  });

  /** 2 candidatas abertas: o foguete abre o modal, a pessoa vincula a PRIMEIRA e cai na pergunta de excluir a outra. */
  async function vincularComDuasCandidatas(page: Page, seedBase: number) {
    const c = cenarioFoguete(seedBase, 2);
    await clicarFoguete(page, c.seed.patientId, c.serviceId);
    await expect(page.getByTestId('link-existing-vacancy-modal')).toBeVisible();
    await escolherNoCombo(page, page.getByTestId('link-existing-vacancy-combo'), rotuloDaVaga(c.vagas[0]));
    const confirmar = page.getByTestId('link-existing-vacancy-confirm');
    await expect(confirmar).toBeEnabled();
    await confirmar.click();
    const lista = page.getByTestId('link-leftovers-list');
    await expect(lista).toBeVisible();
    // lista a OUTRA como <paciente>#<ordinal> + status, e só ela
    await expect(lista).toContainText(formatVacancyCase(c.vagas[1].caseNumber, c.vagas[1].caseOrdinal));
    await expect(lista.locator('li')).toHaveCount(1);
    expect(readVacancyServiceFields(c.vagas[0].vacancyId).contracted_service_id).toBe(c.serviceId); // vínculo já feito
    return c;
  }
  const deletada = (vacancyId: string): boolean => runSQL(`SELECT (deleted_at IS NOT NULL)::int FROM job_postings WHERE id = '${vacancyId}'`) === '1';

  test('foguete: vincula com 2 candidatas → pergunta; "Sí, eliminar" exclui só a outra pelo DELETE de vaga existente', async ({ page }) => {
    const c = await vincularComDuasCandidatas(page, 767000);
    await page.getByTestId('link-leftovers-yes').click();
    await expect(page.getByTestId('link-existing-vacancy-modal')).toHaveCount(0);
    expect(deletada(c.vagas[1].vacancyId)).toBe(true);
    expect(deletada(c.vagas[0].vacancyId)).toBe(false);
  });

  test('foguete: vincula com 2 candidatas → pergunta; "No" não exclui nada', async ({ page }) => {
    const c = await vincularComDuasCandidatas(page, 768000);
    await page.getByTestId('link-leftovers-no').click();
    await expect(page.getByTestId('link-existing-vacancy-modal')).toHaveCount(0);
    expect(deletada(c.vagas[1].vacancyId)).toBe(false);
    expect(deletada(c.vagas[0].vacancyId)).toBe(false);
  });
});
