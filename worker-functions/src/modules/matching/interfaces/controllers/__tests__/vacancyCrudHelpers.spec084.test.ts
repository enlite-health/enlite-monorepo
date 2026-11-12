/**
 * Spec 084 F5 (R4/R18) e F6 (R12/R16): pausar = ON_HOLD, encerrar vaga de serviço ATIVO é recusado pelo servidor,
 * e o número #NN vem da ordem do serviço (nunca MAX+1).
 */
import { authorizeVacancyUpdate, buildInsertQuery, buildInsertParams, CANONICAL_STATUSES } from '../vacancyCrudHelpers';

const dbCom = (row: Record<string, unknown>) => ({ query: jest.fn(async () => ({ rows: [row] })) }) as never;
const VAGA = { status: 'SEARCHING', is_draft: false, patient_id: 'p', contracted_service_id: null, service_active: null };

describe('F5 — pausar com "En espera" (ON_HOLD)', () => {
  it('o servidor aceita ON_HOLD (antes: 400 "Invalid status")', async () => {
    expect(CANONICAL_STATUSES.has('ON_HOLD')).toBe(true);
    expect(await authorizeVacancyUpdate(dbCom(VAGA), 'v', { status: 'ON_HOLD' })).toMatchObject({ kind: 'ok' });
  });

  it('encerrar (CLOSED) vaga de serviço ATIVO → 409 pelo SERVIDOR, com código e es/pt-BR (R4/P1)', async () => {
    const out = await authorizeVacancyUpdate(
      dbCom({ ...VAGA, contracted_service_id: 'svc-1', service_active: true }), 'v', { status: 'CLOSED' },
    );
    expect(out).toMatchObject({ kind: 'error', status: 409, code: 'CLOSE_ACTIVE_SERVICE_VACANCY_REFUSED' });
    const msg = (out as { messages: { es: string; 'pt-BR': string } }).messages;
    expect(msg.es).toMatch(/Pausar/);
    expect(msg['pt-BR']).toMatch(/Pausar/);
  });

  it('vaga de serviço ATIVO pode pausar e retomar (status operacional)', async () => {
    const ativo = { ...VAGA, contracted_service_id: 'svc-1', service_active: true };
    expect(await authorizeVacancyUpdate(dbCom(ativo), 'v', { status: 'ON_HOLD' })).toMatchObject({ kind: 'ok' });
    expect(await authorizeVacancyUpdate(dbCom({ ...ativo, status: 'ON_HOLD' }), 'v', { status: 'SEARCHING' })).toMatchObject({ kind: 'ok' });
  });

  it('vaga SEM serviço ainda encerra; vaga de serviço INATIVO também (alternativos da F5)', async () => {
    expect(await authorizeVacancyUpdate(dbCom(VAGA), 'v', { status: 'CLOSED' })).toMatchObject({ kind: 'ok' });
    expect(
      await authorizeVacancyUpdate(dbCom({ ...VAGA, contracted_service_id: 'svc-1', service_active: false }), 'v', { status: 'CLOSED' }),
    ).toMatchObject({ kind: 'ok' });
  });
});

describe('F6 — case_ordinal é a ORDEM DO SERVIÇO', () => {
  const sql = buildInsertQuery();

  it('o INSERT deriva o número do serviço ($23) e NÃO usa MAX(case_ordinal)+1', () => {
    expect(sql).not.toMatch(/MAX\(\s*jp2?\.case_ordinal/);
    expect(sql).toMatch(/CASE WHEN \$23::uuid IS NULL THEN NULL/);
    expect(sql).toMatch(/row_number\(\) OVER \(PARTITION BY patient_id ORDER BY created_at, id\)/);
    expect(sql).toMatch(/FROM patient_contracted_services/);
  });

  it('$23 é o contracted_service_id dos params: vaga sem serviço → NULL → sem número (R16)', () => {
    const base = {
      vacancyNumber: 1, case_number: 817, computedTitle: 't', patient_id: 'p', required_professions: [], required_sex: null,
      age_range_min: null, age_range_max: null, worker_profile_sought: null, required_experience: null, worker_attributes: null,
      schedule: null, work_schedule: null, providers_needed: null, salary_text: null, payment_day: null, daily_obs: null,
      patient_address_id: null,
    };
    const semServico = buildInsertParams({ ...base, contracted_service_id: null });
    const comServico = buildInsertParams({ ...base, contracted_service_id: 'svc-9' });
    expect(semServico[22]).toBeNull();
    expect(comServico[22]).toBe('svc-9');
  });
});
