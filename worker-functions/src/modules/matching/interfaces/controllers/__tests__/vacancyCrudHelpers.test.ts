/**
 * vacancyCrudHelpers.test.ts — `authorizeVacancyUpdate` sob F3/fase-1
 * (`completar-vacante-em-rascunho`): o 422 de `SOURCE_LOCKED_FIELDS`.
 *
 * `VacancyCrudController.test.ts` mocka `authorizeVacancyUpdate` inteiro (só
 * prova que o controller REPASSA `locked_fields` no corpo) — este arquivo
 * prova a lógica de verdade: quando a vaga tem `contracted_service_id` e
 * quando não tem, com 0/1/2 campos travados no body e com campo livre.
 */
import type { Pool } from 'pg';
import { authorizeVacancyUpdate, buildInsertParams, SOURCE_LOCKED_FIELDS } from '../vacancyCrudHelpers';

function makeDb(row: {
  status?: string | null;
  is_draft?: boolean | null;
  patient_id?: string | null;
  contracted_service_id?: string | null;
} | null): Pool {
  const query = jest.fn().mockResolvedValue({
    rows: row ? [{ status: 'SEARCHING', is_draft: true, patient_id: 'p-1', contracted_service_id: null, ...row }] : [],
  });
  return { query } as unknown as Pool;
}

describe('authorizeVacancyUpdate — 422 de SOURCE_LOCKED_FIELDS (F3, fase 1)', () => {
  it('vaga SEM contracted_service_id → body com campo travado (schedule) segue normalmente (kind=ok)', async () => {
    const db = makeDb({ contracted_service_id: null });
    const result = await authorizeVacancyUpdate(db, 'jp-1', { schedule: [] });
    expect(result.kind).toBe('ok');
  });

  it('vaga COM contracted_service_id → body com 1 campo travado (patient_id) → 422, locked_fields=[patient_id]', async () => {
    const db = makeDb({ contracted_service_id: 'svc-1' });
    const result = await authorizeVacancyUpdate(db, 'jp-1', { patient_id: 'outro-paciente' });
    expect(result).toMatchObject({ kind: 'error', status: 422, lockedFields: ['patient_id'] });
  });

  it('vaga COM contracted_service_id → body com 2 campos travados (schedule + providers_needed) → 422, locked_fields com os 2, na ordem de SOURCE_LOCKED_FIELDS', async () => {
    const db = makeDb({ contracted_service_id: 'svc-1' });
    const result = await authorizeVacancyUpdate(db, 'jp-1', { providers_needed: 3, schedule: [] });
    expect(result).toMatchObject({ kind: 'error', status: 422 });
    if (result.kind === 'error') {
      // Ordem = a ordem de SOURCE_LOCKED_FIELDS (schedule vem antes de
      // providers_needed na constante), não a ordem das chaves do body.
      expect(result.lockedFields).toEqual(['schedule', 'providers_needed']);
    }
  });

  it('vaga COM contracted_service_id → body só com campo LIVRE (required_professions) → segue (kind=ok), não é 422', async () => {
    const db = makeDb({ contracted_service_id: 'svc-1', is_draft: true });
    const result = await authorizeVacancyUpdate(db, 'jp-1', { required_professions: ['AT'] });
    expect(result.kind).toBe('ok');
  });

  it('vaga COM contracted_service_id, PUBLICADA (is_draft=false) → campo travado AINDA 422 (a origem não muda de dono ao publicar)', async () => {
    const db = makeDb({ contracted_service_id: 'svc-1', is_draft: false });
    const result = await authorizeVacancyUpdate(db, 'jp-1', { schedule: [] });
    expect(result).toMatchObject({ kind: 'error', status: 422, lockedFields: ['schedule'] });
  });

  it('todos os 8 campos de SOURCE_LOCKED_FIELDS, um de cada vez, disparam 422 quando há contracted_service_id', async () => {
    for (const field of SOURCE_LOCKED_FIELDS) {
      const db = makeDb({ contracted_service_id: 'svc-1' });
      const result = await authorizeVacancyUpdate(db, 'jp-1', { [field]: 'qualquer valor' });
      expect(result).toMatchObject({ kind: 'error', status: 422, lockedFields: [field] });
    }
  });

  it('vaga não encontrada → 404, antes de qualquer checagem de campo travado', async () => {
    const db = makeDb(null);
    const result = await authorizeVacancyUpdate(db, 'jp-sumiu', { schedule: [] });
    expect(result).toEqual({ kind: 'error', status: 404, error: 'Vacancy not found' });
  });
});

describe('buildInsertParams — F2 (vaga-le-do-servico-contratado): vaga com serviço não grava o horário', () => {
  const SLOT = [{ dayOfWeek: 1, startTime: '08:00', endTime: '12:00' }];
  const base = {
    vacancyNumber: 1, case_number: 1000, computedTitle: 'CASO EN1000-1', patient_id: 'p-1',
    required_professions: null, required_sex: null, age_range_min: 20, age_range_max: 29,
    worker_profile_sought: null, required_experience: null, worker_attributes: null,
    work_schedule: null, providers_needed: 2, salary_text: null, payment_day: null, daily_obs: null,
    patient_address_id: 'a-1',
  };
  // Posição do `schedule` no array de params (12º placeholder do INSERT, índice 11).
  const SCHEDULE_IDX = 11;

  it('COM contracted_service_id: schedule vira NULL no INSERT mesmo que o chamador o passe; providers e faixa seguem copiados', () => {
    const params = buildInsertParams({ ...base, schedule: SLOT, contracted_service_id: 'svc-1' });
    expect(params[SCHEDULE_IDX]).toBeNull();
    expect(params[6]).toBe(20); // age_range_min
    expect(params[13]).toBe(2); // providers_needed
  });

  it('SEM contracted_service_id (vaga manual): schedule continua gravado como JSON', () => {
    const params = buildInsertParams({ ...base, schedule: SLOT, contracted_service_id: null });
    expect(JSON.parse(params[SCHEDULE_IDX] as string)).toEqual(SLOT);
  });
});
