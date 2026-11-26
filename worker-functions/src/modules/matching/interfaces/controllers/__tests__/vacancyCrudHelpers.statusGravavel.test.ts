/**
 * estado-automatico-do-paciente F2 (D3/E5/E10): o editor da vaga só grava o ciclo de vida.
 * Os 4 valores legados (que fingiam ser estado do paciente) são recusados com 400 `VACANCY_STATUS_NOT_LIFECYCLE`;
 * o default de criação (escrita de sistema) NÃO muda.
 */
import { authorizeVacancyUpdate, buildInsertParams, clientStatusRefusal } from '../vacancyCrudHelpers';

const dbCom = (row: Record<string, unknown>) => ({ query: jest.fn(async () => ({ rows: [row] })) }) as never;
const VAGA = { status: 'SEARCHING', is_draft: false, patient_id: 'p', contracted_service_id: null, service_active: null };
const BASE = {
  vacancyNumber: 1, case_number: 817, computedTitle: 't', patient_id: 'p', required_professions: [], required_sex: null,
  age_range_min: null, age_range_max: null, worker_profile_sought: null, required_experience: null, worker_attributes: null,
  schedule: null, work_schedule: null, providers_needed: null, salary_text: null, payment_day: null, daily_obs: null,
  patient_address_id: null, contracted_service_id: null,
};

describe('PUT: os 4 legados são recusados pelo servidor', () => {
  it.each(['SEARCHING_REPLACEMENT', 'RAPID_RESPONSE', 'ACTIVE', 'PENDING_ACTIVATION'])('%s → 400 VACANCY_STATUS_NOT_LIFECYCLE com es + pt-BR', async (legado) => {
    const out = await authorizeVacancyUpdate(dbCom(VAGA), 'v', { status: legado });
    expect(out).toMatchObject({ kind: 'error', status: 400, code: 'VACANCY_STATUS_NOT_LIFECYCLE' });
    const msg = (out as { messages: { es: string; 'pt-BR': string } }).messages;
    expect(msg.es).toMatch(/flujo automático/);
    expect(msg['pt-BR']).toMatch(/fluxo automático/);
    expect((out as { error: string }).error).toContain('Invalid status value');
  });

  it('DE_BAJA também não é gravável pelo cliente (R17 continua)', async () => {
    expect(await authorizeVacancyUpdate(dbCom(VAGA), 'v', { status: 'DE_BAJA' })).toMatchObject({ kind: 'error', status: 400 });
  });

  it('os 4 do ciclo de vida passam', async () => {
    for (const ok of ['SEARCHING', 'ON_HOLD', 'SUSPENDED', 'CLOSED']) {
      expect(await authorizeVacancyUpdate(dbCom(VAGA), 'v', { status: ok })).toMatchObject({ kind: 'ok' });
    }
  });

  it('sem status no corpo não há o que recusar', () => {
    expect(clientStatusRefusal(undefined)).toBeNull();
  });
});

describe('POST: mesma recusa; o default de criação é escrita de sistema e NÃO muda (E10)', () => {
  it('status legado vindo do cliente → recusa (o controller devolve 400 antes do INSERT)', () => {
    expect(clientStatusRefusal('SEARCHING_REPLACEMENT')).toMatchObject({ status: 400, code: 'VACANCY_STATUS_NOT_LIFECYCLE' });
  });

  it('sem status, a vaga nasce PENDING_ACTIVATION (foguete e POST sem status)', () => {
    const params = buildInsertParams({ ...BASE, status: undefined });
    expect(buildInsertParams({ ...BASE, status: 'SEARCHING' })).not.toContain('PENDING_ACTIVATION');
    expect(params.filter((x) => x === 'PENDING_ACTIVATION')).toHaveLength(1);
  });
});
