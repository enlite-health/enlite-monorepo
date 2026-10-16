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
import {
  authorizeVacancyUpdate,
  buildInsertParams,
  FULL_ALLOWED_UPDATE_FIELDS,
  SOURCE_LOCKED_FIELDS,
  withEffectiveFields,
} from '../vacancyCrudHelpers';

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

  it('vaga COM contracted_service_id → body só com campo LIVRE (salary_text) → segue (kind=ok), não é 422', async () => {
    const db = makeDb({ contracted_service_id: 'svc-1', is_draft: true });
    const result = await authorizeVacancyUpdate(db, 'jp-1', { salary_text: 'A convenir' });
    expect(result.kind).toBe('ok');
  });

  it('057/D523: PUT com required_sex em vaga COM serviço → 422 + locked_fields=[required_sex]; SEM serviço → aceita', async () => {
    const com = await authorizeVacancyUpdate(makeDb({ contracted_service_id: 'svc-1', is_draft: true }), 'jp-1', { required_sex: 'F' });
    expect(com).toMatchObject({ kind: 'error', status: 422, lockedFields: ['required_sex'] });
    const sem = await authorizeVacancyUpdate(makeDb({ contracted_service_id: null, is_draft: true }), 'jp-1', { required_sex: 'F' });
    expect(sem.kind).toBe('ok');
  });

  it('vaga COM contracted_service_id, PUBLICADA (is_draft=false) → campo travado AINDA 422 (a origem não muda de dono ao publicar)', async () => {
    const db = makeDb({ contracted_service_id: 'svc-1', is_draft: false });
    const result = await authorizeVacancyUpdate(db, 'jp-1', { schedule: [] });
    expect(result).toMatchObject({ kind: 'error', status: 422, lockedFields: ['schedule'] });
  });

  it('todos os 13 campos de SOURCE_LOCKED_FIELDS, um de cada vez, disparam 422 quando há contracted_service_id', async () => {
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

// 057/D523 (substitui a T035 da spec 027): os 5 campos de recrutamento agora moram no serviço — a vaga COM serviço os recusa (422);
// a vaga SEM serviço (manual) continua editando-os. Continuam em FULL_ALLOWED_UPDATE_FIELDS (a vaga manual os grava).
describe('SOURCE_LOCKED_FIELDS — os 5 campos de recrutamento (057/D523)', () => {
  const RECRUITMENT = ['required_professions', 'required_sex', 'required_experience', 'work_schedule', 'payment_day'] as const;

  it('os 5 estão em SOURCE_LOCKED_FIELDS (13 no total)', () => {
    for (const f of RECRUITMENT) expect(SOURCE_LOCKED_FIELDS as readonly string[]).toContain(f);
    expect(SOURCE_LOCKED_FIELDS).toHaveLength(13);
  });

  it('PUT com CADA uma das 5 chaves: vaga COM serviço → 422; vaga manual (sem serviço) → autoriza', async () => {
    for (const field of RECRUITMENT) {
      const value = field === 'required_professions' ? ['AT'] : 'novo-valor';
      const com = await authorizeVacancyUpdate(makeDb({ contracted_service_id: 'svc-1', is_draft: true }), 'jp-1', { [field]: value });
      expect(com).toMatchObject({ kind: 'error', status: 422, lockedFields: [field] });
      const sem = await authorizeVacancyUpdate(makeDb({ contracted_service_id: null, is_draft: true }), 'jp-1', { [field]: value });
      expect({ field, kind: sem.kind }).toEqual({ field, kind: 'ok' });
    }
  });

  it('as 5 chaves seguem em FULL_ALLOWED_UPDATE_FIELDS (a vaga manual as grava)', () => {
    for (const f of RECRUITMENT) expect(FULL_ALLOWED_UPDATE_FIELDS as readonly string[]).toContain(f);
  });
});

describe('buildInsertParams — F2/F5 (vaga-le-do-servico-contratado): vaga com serviço não grava horário nem quantidade', () => {
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
  // `providers_needed` = 14º placeholder (índice 13).
  const PROVIDERS_IDX = 13;

  it('COM contracted_service_id: schedule e providers_needed viram NULL no INSERT mesmo que o chamador os passe; a faixa etária também (F6)', () => {
    const params = buildInsertParams({ ...base, schedule: SLOT, contracted_service_id: 'svc-1' });
    expect(params[SCHEDULE_IDX]).toBeNull();
    expect(params[6]).toBeNull(); // age_range_min (F6: derivada da banda do serviço)
    expect(params[7]).toBeNull(); // age_range_max
    expect(params[PROVIDERS_IDX]).toBeNull();
  });

  it('057/D523 — COM contracted_service_id: os 5 de recrutamento viram NULL no INSERT (required_professions null, não [])', () => {
    const params = buildInsertParams({
      ...base, schedule: SLOT, contracted_service_id: 'svc-1',
      required_professions: ['AT'], required_sex: 'F', required_experience: 'x', work_schedule: 'full-time', payment_day: 'dia 10',
    });
    for (const idx of [4, 5, 9, 12, 15]) expect(params[idx]).toBeNull();
  });

  it('057/D523 — SEM contracted_service_id (vaga manual): os 5 seguem gravando os próprios; required_professions ausente vira []', () => {
    const params = buildInsertParams({
      ...base, schedule: SLOT, contracted_service_id: null,
      required_professions: ['AT'], required_sex: 'F', required_experience: 'x', work_schedule: 'full-time', payment_day: 'dia 10',
    });
    expect([params[4], params[5], params[9], params[12], params[15]]).toEqual([['AT'], 'F', 'x', 'full-time', 'dia 10']);
    expect(buildInsertParams({ ...base, schedule: SLOT, contracted_service_id: null })[4]).toEqual([]);
  });

  it('SEM contracted_service_id (vaga manual): a faixa etária segue gravando a própria (F6)', () => {
    const params = buildInsertParams({ ...base, schedule: SLOT, contracted_service_id: null });
    expect(params[6]).toBe(20);
    expect(params[7]).toBe(29);
  });

  it('SEM contracted_service_id (vaga manual): providers_needed segue gravando o próprio valor', () => {
    const params = buildInsertParams({ ...base, schedule: SLOT, contracted_service_id: null });
    expect(params[PROVIDERS_IDX]).toBe(2);
  });

  it('SEM contracted_service_id (vaga manual): schedule continua gravado como JSON', () => {
    const params = buildInsertParams({ ...base, schedule: SLOT, contracted_service_id: null });
    expect(JSON.parse(params[SCHEDULE_IDX] as string)).toEqual(SLOT);
  });
});

describe('withEffectiveFields — F5: a resposta traz horário e quantidade EFETIVOS, lidos pela peça', () => {
  it('troca schedule e providers_needed crus pelos efetivos; lê por db.query com a peça (cast só lá)', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [{ schedule: [{ dayOfWeek: 1 }], providers_needed: '3' }] });
    const out = await withEffectiveFields({ query } as unknown as Pool, { id: 'jp-1', schedule: null, providers_needed: null, title: 'T' });
    expect(out).toEqual({ id: 'jp-1', schedule: [{ dayOfWeek: 1 }], providers_needed: '3', title: 'T' });
    const sql = String(query.mock.calls[0][0]);
    expect(sql).toContain('pcs_eff.providers_needed::text');
    expect(sql).toContain('LEFT JOIN patient_contracted_services');
    expect(query.mock.calls[0][1]).toEqual(['jp-1']);
  });

  it('F6: a faixa etária efetiva vem da banda do serviço (mapeamento em TS) e a coluna auxiliar não vaza', async () => {
    const query = jest.fn().mockResolvedValue({
      rows: [{ schedule: null, providers_needed: null, age_range_min: null, age_range_max: null, effective_provider_age_band: 'AGE_30_45' }],
    });
    const out = await withEffectiveFields({ query } as unknown as Pool, { id: 'jp-1', age_range_min: 99, age_range_max: 99 });
    expect(out).toEqual({ id: 'jp-1', schedule: null, providers_needed: null, age_range_min: 30, age_range_max: 44 });
    expect(out).not.toHaveProperty('effective_provider_age_band');
    expect(String(query.mock.calls[0][0])).toContain('pcs_eff.provider_age_band');
  });

  it('vaga que a sessão não enxerga (0 linhas) → devolve a linha como veio', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [] });
    const row = { id: 'jp-2', schedule: 'cru', providers_needed: '9' };
    expect(await withEffectiveFields({ query } as unknown as Pool, row)).toBe(row);
  });
});
