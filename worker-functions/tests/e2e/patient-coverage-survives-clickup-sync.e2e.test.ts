/**
 * patient-coverage-survives-clickup-sync.e2e.test.ts — spec 011 A3, reescrito na spec 058 (Parte A, T073).
 *
 * Spec 058: `insurance_informed` e `affiliate_id` são os DONOS da cobertura informada e do nº de afiliado
 * (`health_insurance_*` saiu do código). O painel grava neles; o sync do ClickUp é FILL-ONLY: só preenche
 * quando o dono está vazio, nunca sobrescreve valor existente, e o literal "null" que o ClickUp devolve
 * para campo vazio é normalizado para NULL no mapper (senão o fill-only recriaria o lixo).
 *
 * Prova contra Postgres REAL, com o MOTOR real do sync (`SyncPatientFromClickUpTaskUseCase.execute`):
 *   1. dono não é sobrescrito: o painel grava a cobertura; o sync traz outro valor → o cru continua o do painel;
 *   2. fill-only preenche o vazio: o dono NULL recebe o valor do sync (e só ele);
 *   3. literal "null" do ClickUp não vira texto "null" no dono.
 * Sabotagem (T073): voltar a `= EXCLUDED.insurance_informed` no `PatientIdentityRepository` deixa o teste 1 vermelho.
 *
 * ── 11/09/2026 — decisão de remoção do sync automático ClickUp ──────────────
 * Chamava `ClickUpPatientWebhookController.handle()` via supertest. O webhook foi removido — a plataforma é a
 * fonte, carga do ClickUp só pontual/manual. Este teste chama `SyncPatientFromClickUpTaskUseCase.execute()`
 * diretamente: MESMO motor, sem o transporte HTTP/HMAC que só o webhook precisava.
 */

jest.mock('firebase-functions', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import { Pool } from 'pg';
import { SyncPatientFromClickUpTaskUseCase, type SyncPatientResult } from '../../src/modules/integration/application/SyncPatientFromClickUpTaskUseCase';
import type { ClickUpTask } from '../../src/modules/integration/infrastructure/clickup/ClickUpTask';
import { PatientQueryRepository } from '../../src/modules/case/infrastructure/PatientQueryRepository';
import { PatientService } from '../../src/modules/case';
import { makeUseCase, syncTask } from './helpers/clickupSyncEngine';

const PATIENT_LIST_ID = '901304883903';
const DATABASE_URL    = process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';
if (!process.env.DATABASE_URL) process.env.DATABASE_URL = DATABASE_URL;

const TASK_ID  = 'cu-e2e-a3-coverage-survives';
const COVERAGE = 'OSDE 210 (e2e A3)';

function makeClickUpTask(taskId: string, caso: number, cobertura?: string, afiliado?: string): ClickUpTask {
  return {
    id: taskId,
    name: 'Cobertura, Sobrevive E2E',
    status: { status: 'activo', color: '#00c800', type: 'custom' },
    parent: null,
    url: `https://app.clickup.com/t/${taskId}`,
    date_created: '1700000000000',
    date_updated: '1700100000000',
    list: { id: PATIENT_LIST_ID, name: 'Estado de Pacientes' },
    custom_fields: [
      { id: 'cf-nombre',   name: 'Nombre de Paciente',    type: 'text',   value: 'Sobrevive' },
      { id: 'cf-apellido', name: 'Apellido del Paciente', type: 'text',   value: 'Cobertura E2E' },
      { id: 'cf-caso',     name: 'Caso Número',           type: 'number', value: caso },
      ...(cobertura !== undefined ? [{ id: 'cf-cobertura', name: 'Cobertura Informada', type: 'text', value: cobertura }] : []),
      ...(afiliado !== undefined ? [{ id: 'cf-afiliado', name: 'Número ID Afiliado Paciente', type: 'text', value: afiliado }] : []),
    ],
  } as unknown as ClickUpTask;
}

async function runSync(useCase: SyncPatientFromClickUpTaskUseCase, task: ClickUpTask): Promise<SyncPatientResult> {
  const result = await syncTask(useCase, task);
  expect(['CREATED', 'UPDATED']).toContain(result.kind);
  return result;
}

describe('A3/058 — o dono da cobertura sobrevive ao sync do ClickUp (fill-only, Postgres real)', () => {
  let pool: Pool;
  let useCase: SyncPatientFromClickUpTaskUseCase;
  const ids = [`${TASK_ID}-1`, `${TASK_ID}-2`, `${TASK_ID}-3`];

  beforeAll(async () => {
    pool    = new Pool({ connectionString: DATABASE_URL });
    useCase = makeUseCase();
    await pool.query('DELETE FROM patients WHERE clickup_task_id = ANY($1)', [ids]);
  });

  afterAll(async () => {
    await pool.query('DELETE FROM patients WHERE clickup_task_id = ANY($1)', [ids]).catch(() => {});
    await pool.end();
  });

  const idOf = async (task: string) =>
    (await pool.query<{ id: string }>('SELECT id FROM patients WHERE clickup_task_id = $1', [task])).rows[0].id;
  const dono = async (patientId: string) =>
    (await pool.query<{ ii: string | null; af: string | null }>(
      'SELECT insurance_informed AS ii, affiliate_id AS af FROM patients WHERE id = $1', [patientId])).rows[0];

  it('dono não é sobrescrito: o painel grava a cobertura e o afiliado → o sync traz outros valores → o cru e a ficha continuam os do painel', async () => {
    const t1 = (c?: string, a?: string) => makeClickUpTask(ids[0], 9311, c, a);
    expect((await runSync(useCase, t1())).kind).toBe('CREATED');
    const patientId = await idOf(ids[0]);

    // O painel grava no DONO (a chave de fio `healthInsuranceName` grava em `insurance_informed`).
    await new PatientService().updatePatientSection(patientId, 'general', { healthInsuranceName: COVERAGE, affiliateId: 'AF-PAINEL' });
    expect(await dono(patientId)).toEqual({ ii: COVERAGE, af: 'AF-PAINEL' });
    const repo = new PatientQueryRepository();
    expect((await repo.findDetailById(patientId))?.insuranceInformed).toBe(COVERAGE);

    // O sync roda de novo trazendo OUTROS valores: nem a cobertura nem o afiliado do painel são sobrescritos.
    expect((await runSync(useCase, t1('COBERTURA DO CLICKUP', 'AF-CLICKUP'))).kind).toBe('UPDATED');
    expect(await dono(patientId)).toEqual({ ii: COVERAGE, af: 'AF-PAINEL' });
    expect((await repo.findDetailById(patientId))?.insuranceInformed).toBe(COVERAGE);

    // Nem o vazio do ClickUp apaga o dono (campo ausente do card).
    expect((await runSync(useCase, t1())).kind).toBe('UPDATED');
    expect(await dono(patientId)).toEqual({ ii: COVERAGE, af: 'AF-PAINEL' });
  });

  it('fill-only preenche o vazio: dono NULL recebe o valor do sync, e a partir daí ele não muda mais', async () => {
    expect((await runSync(useCase, makeClickUpTask(ids[1], 9312))).kind).toBe('CREATED');
    const patientId = await idOf(ids[1]);
    expect(await dono(patientId)).toEqual({ ii: null, af: null });

    await runSync(useCase, makeClickUpTask(ids[1], 9312, 'GALENO (e2e)', 'AF-1'));
    expect(await dono(patientId)).toEqual({ ii: 'GALENO (e2e)', af: 'AF-1' });

    await runSync(useCase, makeClickUpTask(ids[1], 9312, 'OUTRA', 'AF-2'));
    expect(await dono(patientId)).toEqual({ ii: 'GALENO (e2e)', af: 'AF-1' });
  });

  it('literal "null" do ClickUp vira NULL no dono (não vira o texto "null"), e um valor real depois ainda preenche', async () => {
    expect((await runSync(useCase, makeClickUpTask(ids[2], 9313, 'null', 'NULL'))).kind).toBe('CREATED');
    const patientId = await idOf(ids[2]);
    expect(await dono(patientId)).toEqual({ ii: null, af: null });

    await runSync(useCase, makeClickUpTask(ids[2], 9313, 'SWISS MEDICAL (e2e)', 'AF-9'));
    expect(await dono(patientId)).toEqual({ ii: 'SWISS MEDICAL (e2e)', af: 'AF-9' });
  });
});
