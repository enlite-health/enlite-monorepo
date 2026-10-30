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
 */
import { test, expect, type Page } from '@playwright/test';
import { seedActivatablePatient } from '../helpers/patient-detail-c-helper';
import {
  psql, safeSql, seedStaffInGroup, cleanupStaffAndGroup, grantCell, installAuthInterceptors, ABAC_TENANT,
} from '../helpers/abac-stack-helper';
import { escolherNoCombo } from '../helpers/combobox';
import { RECRUITMENT_FIELDS_E2E } from '../helpers/recruitment-fields-e2e';
import {
  seedContractedService, seedServiceWithoutSchedule, seedLegacyVacancy, createPatientAddress, setServiceAddress,
  readVacancyKanbanFingerprint, readVacancyServiceFields, readServiceRecruitmentFields, cleanupVincularVaga,
  type LegacyVacancySeed,
} from '../helpers/vincular-vaga-e2e-helper';
import { formatVacancyCase } from '../../src/domain/value-objects/caseNumberFormat';

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
      ['patient_services', 'read'], ['patient_services', 'update'], ['vacancy', 'read'], ['vacancy', 'update'],
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
    const { serviceId } = seedContractedService(seed.patientId, { addressId: seed.addressId, withSchedule: true });
    const vaga = seedLegacyVacancy(seed.patientId, { addressId: seed.addressId });
    workers.push(vaga.workerId);

    const antes = readVacancyKanbanFingerprint(vaga.vacancyId);
    expect(antes).toMatchObject({ id: vaga.vacancyId, applications: 1, encuadres: 1 });
    expect(readServiceRecruitmentFields(serviceId).required_sex).toBeNull();

    await login(page);
    await abrirModal(page, seed.patientId, serviceId, vaga);

    const previa = page.getByTestId('link-existing-vacancy-preview');
    await expect(previa).toBeVisible();
    await expect(previa).toContainText('Vacante → servicio');
    await expect(page.getByTestId('link-existing-vacancy-blockers')).toHaveCount(0);
    const confirmar = page.getByTestId('link-existing-vacancy-confirm');
    await expect(confirmar).toBeEnabled();

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
    expect(servico).toMatchObject({
      required_sex: RECRUITMENT_FIELDS_E2E.requiredSex,
      required_experience: RECRUITMENT_FIELDS_E2E.requiredExperience,
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
});
