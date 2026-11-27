/**
 * Spec 084 F5 (R4/R18) e F6 (R12/R16): pausar = ON_HOLD, encerrar vaga de serviço ATIVO é recusado pelo servidor,
 * e o número #NN vem da ordem do serviço (nunca MAX+1).
 */
import { authorizeVacancyUpdate, buildInsertQuery, buildInsertParams } from '../vacancyCrudHelpers';
import { BAJA_REFUSAL_MESSAGES } from '../../../domain/VacancyBajaPolicy';

const dbCom = (row: Record<string, unknown>) => ({ query: jest.fn(async () => ({ rows: [row] })) }) as never;
const VAGA = { status: 'SEARCHING', is_draft: false, patient_id: 'p', contracted_service_id: null, service_active: null };

describe('F5 — o estado da vaga não se edita (semaforo-da-vaga F4): ON_HOLD/CLOSED/SEARCHING → 400 do servidor', () => {
  it('ON_HOLD, CLOSED e SEARCHING no PUT → 400 VACANCY_STATUS_NOT_WRITABLE, mesmo em vaga de serviço ATIVO', async () => {
    const ativo = { ...VAGA, contracted_service_id: 'svc-1', service_active: true };
    for (const status of ['ON_HOLD', 'CLOSED', 'SEARCHING']) {
      expect(await authorizeVacancyUpdate(dbCom(VAGA), 'v', { status })).toMatchObject({ kind: 'error', status: 400, code: 'VACANCY_STATUS_NOT_WRITABLE' });
      expect(await authorizeVacancyUpdate(dbCom(ativo), 'v', { status })).toMatchObject({ kind: 'error', status: 400, code: 'VACANCY_STATUS_NOT_WRITABLE' });
    }
  });

  it('as mensagens de recusa (P8) apontam a ação do paciente ou o serviço, não mais "Pausar"', () => {
    for (const code of ['VACANCY_HAS_SERVICE', 'CLOSE_ACTIVE_SERVICE_VACANCY_REFUSED'] as const) {
      expect(BAJA_REFUSAL_MESSAGES[code].es).toMatch(/pausá o suspendé al paciente, o desactivá el servicio/);
      expect(BAJA_REFUSAL_MESSAGES[code]['pt-BR']).toMatch(/pause ou suspenda o paciente, ou desative o serviço/);
      expect(BAJA_REFUSAL_MESSAGES[code].es).not.toMatch(/Pausar/);
      expect(BAJA_REFUSAL_MESSAGES[code]['pt-BR']).not.toMatch(/Pausar/);
    }
  });

  it('sem `status` no corpo a edição de horário segue (nada a recusar)', async () => {
    expect(await authorizeVacancyUpdate(dbCom(VAGA), 'v', { schedule: [] })).toMatchObject({ kind: 'ok' });
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
