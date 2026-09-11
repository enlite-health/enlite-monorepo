/**
 * patient-coverage-survives-clickup-sync.e2e.test.ts — spec 011, A3 (lex PARE → caminho a).
 *
 * A cobertura que o painel grava fica em `health_insurance_name` (fill-only no
 * upsert do ClickUp). A ficha lia `insurance_informed`, que o MESMO upsert
 * sobrescreve incondicionalmente com o que o mapper manda — e o mapper nunca a
 * seta. Resultado medido: cobertura gravada, invisível; e, se a escrita fosse
 * movida para `insurance_informed`, o próximo sync a apagaria.
 *
 * Prova exigida pelo lex, contra Postgres REAL, com o MOTOR real reexecutado:
 *   1. sync do ClickUp cria o paciente (clickup_task_id);
 *   2. o painel grava a cobertura (PATCH general → PatientService.updatePatientSection);
 *   3. a ficha mostra a cobertura;
 *   4. o sync roda DE NOVO → `insurance_informed` cru continua NULL
 *      (documenta a sobrescrita) e a ficha CONTINUA mostrando a cobertura.
 * Controle positivo (D157): remover o COALESCE do PatientDetailQueryHelper deixa
 * o passo 3 vermelho — colado no relatório da spec.
 *
 * ── 11/09/2026 — decisão de remoção do sync automático ClickUp ──────────────
 * Chamava `ClickUpPatientWebhookController.handle()` via supertest (molde:
 * clickup-patient-webhook.test.ts). O webhook foi removido — a plataforma é a
 * fonte, carga do ClickUp só pontual/manual. Este teste passou a chamar
 * `SyncPatientFromClickUpTaskUseCase.execute()` diretamente: MESMO motor,
 * mesma regra de overwrite incondicional do campo derivado, sem o transporte
 * HTTP/HMAC que só o webhook precisava.
 */

jest.mock('firebase-functions', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import { Pool } from 'pg';
import {
  PatientService,
  PatientSourceLabelRepository,
  PatientInsuranceVerifiedRepository,
  PatientDeviceTypeRepository,
} from '../../src/modules/case';
import { ClickUpFieldResolver } from '../../src/modules/integration/infrastructure/clickup/ClickUpFieldResolver';
import { ClickUpPatientMapper } from '../../src/modules/integration/infrastructure/clickup/ClickUpPatientMapper';
import { SyncPatientFromClickUpTaskUseCase, type SyncPatientResult } from '../../src/modules/integration/application/SyncPatientFromClickUpTaskUseCase';
import type { ClickUpTask } from '../../src/modules/integration/infrastructure/clickup/ClickUpTask';
import { PatientQueryRepository } from '../../src/modules/case/infrastructure/PatientQueryRepository';

const PATIENT_LIST_ID = '901304883903';
const DATABASE_URL    = process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';
if (!process.env.DATABASE_URL) process.env.DATABASE_URL = DATABASE_URL;

const TASK_ID  = 'cu-e2e-a3-coverage-survives';
const COVERAGE = 'OSDE 210 (e2e A3)';

function makeClickUpTask(taskId: string): ClickUpTask {
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
      { id: 'cf-caso',     name: 'Caso Número',           type: 'number', value: 9311 },
    ],
  } as unknown as ClickUpTask;
}

function makeStubResolver(): ClickUpFieldResolver {
  return {
    resolveDropdown: () => null, resolveLabel: () => null, resolveLabels: () => [],
    // Preflight 1.11 (migrations 304-310): `null` = campo renomeado/apagado → o mapper recusa
    // a task inteira de propósito. O stub diz que os campos EXISTEM.
    getFieldType: () => 'drop_down', dropdownFieldNames: [], labelsFieldNames: [],
    getDropdownOptions: () => ({}), getLabelsOptions: () => ({}),
  } as unknown as ClickUpFieldResolver;
}

/** Mesmas deps que `ClickUpPatientWebhookController.create()` montava — sem o
 *  refresher de catálogo (defesa específica de processo webhook de vida longa;
 *  este motor roda uma vez por chamada, catálogo sempre fresco). */
function makeUseCase(): SyncPatientFromClickUpTaskUseCase {
  const resolver = makeStubResolver();
  return new SyncPatientFromClickUpTaskUseCase({
    mapper:                 new ClickUpPatientMapper(resolver),
    patientService:         new PatientService(),
    sourceLabelRepository:  new PatientSourceLabelRepository(),
    insuranceRepository:    new PatientInsuranceVerifiedRepository(),
    deviceTypeRepository:   new PatientDeviceTypeRepository(),
  });
}

async function runSync(useCase: SyncPatientFromClickUpTaskUseCase): Promise<SyncPatientResult> {
  const result = await useCase.execute(makeClickUpTask(TASK_ID), { onMissingContact: 'flag' });
  expect(['CREATED', 'UPDATED']).toContain(result.kind);
  return result;
}

describe('A3 — a cobertura gravada pelo painel sobrevive ao sync do ClickUp (Postgres real)', () => {
  let pool: Pool;
  let useCase: SyncPatientFromClickUpTaskUseCase;

  beforeAll(async () => {
    pool    = new Pool({ connectionString: DATABASE_URL });
    useCase = makeUseCase();
    await pool.query('DELETE FROM patients WHERE clickup_task_id = $1', [TASK_ID]);
  });

  afterAll(async () => {
    await pool.query('DELETE FROM patients WHERE clickup_task_id = $1', [TASK_ID]).catch(() => {});
    await pool.end();
  });

  it('sync cria → painel grava cobertura → ficha mostra → sync de novo → ficha AINDA mostra', async () => {
    // 1. O paciente nasce pelo sync (é o caso dos ~382 importados).
    const created = await runSync(useCase);
    expect(created.kind).toBe('CREATED');
    const { rows } = await pool.query<{ id: string }>('SELECT id FROM patients WHERE clickup_task_id = $1', [TASK_ID]);
    expect(rows).toHaveLength(1);
    const patientId = rows[0].id;

    // 2. O painel grava a cobertura — na coluna protegida (fill-only), como hoje.
    await new PatientService().updatePatientSection(patientId, 'general', { healthInsuranceName: COVERAGE });

    // 3. A ficha mostra a cobertura (era NULL antes do COALESCE — este é o passo RED).
    const repo = new PatientQueryRepository();
    const before = await repo.findDetailById(patientId);
    expect(before?.insuranceInformed).toBe(COVERAGE);

    // 4. O sync roda de novo. `insurance_informed` cru fica NULL (o upsert sobrescreve
    //    com o que o mapper manda, e ele não manda) — e a ficha continua mostrando.
    const updated = await runSync(useCase);
    expect(updated.kind).toBe('UPDATED');
    const raw = await pool.query<{ ii: string | null; hin: string | null }>(
      'SELECT insurance_informed AS ii, health_insurance_name AS hin FROM patients WHERE id = $1', [patientId],
    );
    expect(raw.rows[0].ii).toBeNull();
    expect(raw.rows[0].hin).toBe(COVERAGE);

    const after = await repo.findDetailById(patientId);
    expect(after?.insuranceInformed).toBe(COVERAGE);
  });
});
