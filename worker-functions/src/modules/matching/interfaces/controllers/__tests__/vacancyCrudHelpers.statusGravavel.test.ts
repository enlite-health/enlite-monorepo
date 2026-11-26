/**
 * semaforo-da-vaga F4 (D1): ninguém grava `status` pela API. Qualquer valor (inclusive os 4 do antigo ciclo de vida) é recusado com
 * 400 `VACANCY_STATUS_NOT_WRITABLE`, es + pt-BR; o default de criação (escrita de sistema) NÃO muda.
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

describe('PUT: qualquer status é recusado pelo servidor', () => {
  it.each(['SEARCHING', 'ON_HOLD', 'SUSPENDED', 'CLOSED', 'SEARCHING_REPLACEMENT', 'RAPID_RESPONSE', 'ACTIVE', 'PENDING_ACTIVATION', 'DE_BAJA'])(
    '%s → 400 VACANCY_STATUS_NOT_WRITABLE com es + pt-BR',
    async (valor) => {
      const out = await authorizeVacancyUpdate(dbCom(VAGA), 'v', { status: valor });
      expect(out).toMatchObject({ kind: 'error', status: 400, code: 'VACANCY_STATUS_NOT_WRITABLE' });
      const msg = (out as { messages: { es: string; 'pt-BR': string } }).messages;
      expect(msg.es).toMatch(/no se edita/);
      expect(msg['pt-BR']).toMatch(/não é editável/);
    },
  );

  it('status null também é recusado (a chave presente é o ato, não o valor)', async () => {
    expect(await authorizeVacancyUpdate(dbCom(VAGA), 'v', { status: null })).toMatchObject({ kind: 'error', status: 400, code: 'VACANCY_STATUS_NOT_WRITABLE' });
  });

  it('em vaga DE_BAJA o 409 de R17 vence o 400 (nenhum campo muda por aqui)', async () => {
    expect(await authorizeVacancyUpdate(dbCom({ ...VAGA, status: 'DE_BAJA' }), 'v', { status: 'SEARCHING' }))
      .toMatchObject({ kind: 'error', status: 409, code: 'VACANCY_DE_BAJA_NO_REACTIVATION' });
  });

  it('sem status no corpo não há o que recusar', async () => {
    expect(clientStatusRefusal(undefined)).toBeNull();
    expect(await authorizeVacancyUpdate(dbCom(VAGA), 'v', { schedule: [] })).toMatchObject({ kind: 'ok' });
  });
});

describe('POST: mesma recusa; o default de criação é escrita de sistema e NÃO muda (E10)', () => {
  it('status vindo do cliente → recusa (o controller devolve 400 antes do INSERT)', () => {
    expect(clientStatusRefusal('SEARCHING')).toMatchObject({ status: 400, code: 'VACANCY_STATUS_NOT_WRITABLE' });
    expect(clientStatusRefusal('')).toMatchObject({ status: 400, code: 'VACANCY_STATUS_NOT_WRITABLE' });
  });

  it('a vaga SEMPRE nasce PENDING_ACTIVATION (foguete e POST): o INSERT não lê status de ninguém', () => {
    expect(buildInsertParams(BASE).filter((x) => x === 'PENDING_ACTIVATION')).toHaveLength(1);
  });
});
