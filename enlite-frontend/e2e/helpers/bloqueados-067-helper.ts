/**
 * bloqueados-067-helper.ts — massa e gestos de humano dos e2e de TELA da spec 067 fora do Kanban da vaga
 * (Gestão à Vista, lista de vagas, ficha do prestador, home).
 *
 * Só SQL para MONTAR o cenário (paciente, vaga, candidatura) e cliques de quem valida o documento na ficha. O prestador vem de
 * `insertAptoWorker` (eligibility-worker-helper). Nada aqui toca canal real.
 */
import { expect, type Locator, type Page } from '@playwright/test';
import { insertTestPatient, insertBaseVacancy, cleanupTestPatient, cleanupTestWorker } from './db-test-helper';
import { cleanupEligibilityWorkerChildren } from './eligibility-worker-helper';
import { runSQL } from './patient-detail-a-helper';

export const caseNumber067 = (): number => 960_000 + Math.floor(Math.random() * 30_000);

export interface Massa067 {
  patientIds: string[];
  vacancyIds: string[];
  workerIds: string[];
}

export const novaMassa = (): Massa067 => ({ patientIds: [], vacancyIds: [], workerIds: [] });

/** Paciente fictício com endereço + N vagas publicadas (SEARCHING). `marca` entra no título para a BUSCA da lista isolar a massa. */
export function criarVagas(massa: Massa067, n: number, marca?: string): string[] {
  const { patientId, addressId } = insertTestPatient({ withAddress: true, firstName: 'Ficticia', lastName: `B067${Date.now().toString(36)}` });
  massa.patientIds.push(patientId);
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const id = insertBaseVacancy({ patientId, patientAddressId: addressId!, caseNumber: caseNumber067(), status: 'SEARCHING', isDraft: false });
    if (marca) runSQL(`UPDATE job_postings SET title = '${marca}-${i}' WHERE id = '${id}'`);
    massa.vacancyIds.push(id);
    ids.push(id);
  }
  return ids;
}

export function candidatar(workerId: string, vacancyId: string, stage: string): void {
  runSQL(
    `INSERT INTO worker_job_applications (worker_id, job_posting_id, application_funnel_stage, source) ` +
      `VALUES ('${workerId}', '${vacancyId}', '${stage}', 'talentum') ON CONFLICT (worker_id, job_posting_id) DO NOTHING`,
  );
}

export function limparMassa(massa: Massa067): void {
  for (const v of massa.vacancyIds) {
    runSQL(`DELETE FROM worker_blocked_applications WHERE job_posting_id = '${v}'`);
    runSQL(`DELETE FROM encuadres WHERE job_posting_id = '${v}'`);
    runSQL(`DELETE FROM worker_job_applications WHERE job_posting_id = '${v}'`);
  }
  for (const w of massa.workerIds) {
    try { cleanupEligibilityWorkerChildren(w); cleanupTestWorker(w); } catch (e) { console.error('[cleanup] prestador', e); }
  }
  for (const v of massa.vacancyIds) runSQL(`DELETE FROM job_postings WHERE id = '${v}'`);
  for (const p of massa.patientIds) { try { cleanupTestPatient(p); } catch (e) { console.error('[cleanup] paciente', e); } }
}

/** A ficha do prestador: onde o admin valida / tira a validação do documento. */
export async function abrirFicha(page: Page, workerId: string): Promise<void> {
  await page.goto(`/admin/workers/${workerId}`);
  await expect(page.getByTestId('worker-documents-card')).toBeVisible({ timeout: 30_000 });
}

/** O clique de quem valida um documento (modal de confirmação incluído). */
export async function validarNaFicha(page: Page, docType: string): Promise<void> {
  const slot = page.getByTestId(`doc-slot-${docType}`);
  await slot.getByTestId(`validate-btn-${docType}`).click();
  await expect(page.getByTestId('confirm-validation-modal')).toBeVisible();
  await page.getByTestId('confirm-validation-btn').click();
  await expect(slot.getByTestId(`validation-badge-${docType}`)).toBeVisible({ timeout: 15_000 });
}

/** O clique de quem valida os dois documentos obrigatórios do prestador. */
export async function validarOsDoisDocumentos(page: Page, workerId: string): Promise<void> {
  await abrirFicha(page, workerId);
  await validarNaFicha(page, 'identity_document');
  await validarNaFicha(page, 'criminal_record');
}

// ── Staff com país concedido (a Gestão à Vista resolve o país no SERVIDOR, com o engine ABAC desligado também) ─────────────
// Mesmo seed de `seedStaffInGroup` (abac-stack-helper), por `runSQL` (docker exec no contêiner do Postgres): o `psql` do
// abac-stack-helper só tem banco no job do ABAC. Sem engine: nenhuma célula é necessária, só o ESCOPO de país (AR).
const TENANT_067 = '00000000-0000-0000-0000-000000000001';

export function seedStaffComPais(u: { uid: string; email: string }, nomeDoGrupo: string): string {
  runSQL(
    `INSERT INTO users (firebase_uid, email, display_name, role, is_active, account_type, status, tenant_id) ` +
      `VALUES ('${u.uid}', '${u.email}', 'E2E ${u.uid}', 'admin', true, 'staff', 'ACTIVE', '${TENANT_067}') ON CONFLICT (firebase_uid) DO NOTHING`,
  );
  const groupId = runSQL(
    `INSERT INTO iam.permission_groups (tenant_id, name, description) VALUES ('${TENANT_067}', '${nomeDoGrupo}', 'e2e 067 — nao mexer manual') RETURNING id`,
  ).split('\n')[0].trim();
  runSQL(`INSERT INTO iam.group_country_scopes (group_id, country, granted_by, reason) VALUES ('${groupId}', 'AR', '${u.uid}', 'e2e 067')`);
  runSQL(`INSERT INTO iam.user_groups (user_id, group_id, tenant_id) VALUES ('${u.uid}', '${groupId}', '${TENANT_067}')`);
  return groupId;
}

export function cleanupStaffComPais(uid: string, groupId: string): void {
  if (groupId) {
    runSQL(`DELETE FROM iam.permission_group_changes WHERE group_id = '${groupId}'`);
    runSQL(`DELETE FROM iam.user_groups WHERE group_id = '${groupId}'`);
    runSQL(`DELETE FROM iam.group_country_scopes WHERE group_id = '${groupId}'`);
    runSQL(`DELETE FROM iam.permission_groups WHERE id = '${groupId}'`);
  }
  runSQL(`DELETE FROM iam.permission_audit_log WHERE user_id = '${uid}'`);
  runSQL(`DELETE FROM users WHERE firebase_uid = '${uid}'`);
}

/** O card da vaga na home, achado pelo sufixo `-<vacancy_number>` do selo de código (único por vaga): a home lista TODA vaga pública do banco. */
export function cardDaVagaNaHome(page: Page, vacancyId: string): Locator {
  const vn = runSQL(`SELECT vacancy_number FROM job_postings WHERE id = '${vacancyId}'`);
  return page.getByTestId('job-card').filter({ has: page.getByTestId('job-code-badge').filter({ hasText: new RegExp(`-${vn}$`) }) });
}
