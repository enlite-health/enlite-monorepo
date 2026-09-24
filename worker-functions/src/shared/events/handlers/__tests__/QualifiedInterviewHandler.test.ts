/**
 * QualifiedInterviewHandler.test.ts — o handler do evento funnel_stage.qualified (D211.4).
 *
 * Régua: as queries e a ordem delas (mocks puros). Cenários:
 *  - oferta = fixos futuros ∪ recorrente, no FUSO da vaga (11:30Z → 08:30 AR)
 *  - cada pulo grava UMA linha em interview_invite_skips com o motivo (lex C1-C3)
 *  - idempotência de 7 dias (ALREADY_INVITED), opt-out (mesmo predicado), DISABLED
 *  - <3 opções repetem a última; case_number null → '—'; pubsub + interview_response
 */
jest.mock('../../../logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), child: jest.fn() },
  reportError: jest.fn(),
  loggingAls: { run: jest.fn((_: unknown, fn: () => unknown) => fn()), getStore: jest.fn() },
}));

import {
  createQualifiedInterviewHandler,
  INVITE_IDEMPOTENCY_WINDOW,
  qualifiedSourceOf,
} from '../QualifiedInterviewHandler';
import type { DomainEventHandler } from '../../DomainEventProcessor';
import { logger } from '../../../logging';

const AR = 'America/Argentina/Buenos_Aires';
// Datas FUTURAS fixas (2099): o handler descarta slot no passado.
const DT_1 = '2099-08-10T11:30:00Z'; // segunda 08:30 AR
const DT_2 = '2099-08-11T13:00:00Z'; // terça 10:00 AR
const DT_3 = '2099-08-12T20:00:00Z'; // quarta 17:00 AR

// O id do evento NÃO vai no payload: o processador entrega `{ eventId }` como 2º argumento (A1 do gate 30/08).
const payload = { workerId: 'worker-1', jobPostingId: 'job-1' };
const META = { eventId: 'evt-1' };

const vacancyRow = {
  case_number: 42, country: 'AR', timezone: AR,
  meet_link_1: 'https://meet.google.com/aaa-aaaa-aaa', meet_datetime_1: DT_1,
  meet_link_2: 'https://meet.google.com/bbb-bbbb-bbb', meet_datetime_2: DT_2,
  meet_link_3: 'https://meet.google.com/ccc-cccc-ccc', meet_datetime_3: DT_3,
  meet_recurring_weekday: null, meet_recurring_time: null, meet_recurring_link: null,
};
const workerRow = { id: 'worker-1', status: 'REGISTERED', country: 'AR', opted_out: false };

type Q = jest.Mock;

/** Programa as respostas na ordem em que o handler consulta: vaga, worker, dup, outbox insert, wja update. */
function program(mockQuery: Q, opts: { vacancy?: unknown[]; worker?: unknown[]; dup?: unknown[] } = {}): void {
  mockQuery.mockImplementation(async (sql: string) => {
    if (sql.includes('FROM job_postings')) return { rows: opts.vacancy ?? [vacancyRow] };
    if (sql.includes('FROM workers')) return { rows: opts.worker ?? [workerRow] };
    if (sql.includes('FROM messaging_outbox')) return { rows: opts.dup ?? [] };
    if (sql.includes('INSERT INTO messaging_outbox')) return { rows: [{ id: 'outbox-1' }] };
    if (sql.includes('INSERT INTO interview_invite_skips')) return { rows: [] };
    if (sql.includes('UPDATE worker_job_applications')) return { rows: [] };
    throw new Error(`query inesperada: ${sql.slice(0, 60)}`);
  });
}

const callsTo = (mockQuery: Q, needle: string) => mockQuery.mock.calls.filter((c) => (c[0] as string).includes(needle));
const outboxInsert = (mockQuery: Q) => callsTo(mockQuery, 'INSERT INTO messaging_outbox')[0];
const skipInsert = (mockQuery: Q) => callsTo(mockQuery, 'INSERT INTO interview_invite_skips')[0];
const variablesOf = (mockQuery: Q) => JSON.parse(outboxInsert(mockQuery)[1][2] as string);

describe('QualifiedInterviewHandler', () => {
  let mockQuery: Q;
  let mockPubsub: { publish: jest.Mock };
  let rawHandler: DomainEventHandler;
  /** Chama o handler como o DomainEventProcessor chama: payload + meta com o id da linha. */
  const handler = (p: Record<string, unknown>, meta = META): Promise<void> => rawHandler(p, meta);

  beforeEach(() => {
    mockQuery = jest.fn();
    mockPubsub = { publish: jest.fn().mockResolvedValue(null) };
    rawHandler = createQualifiedInterviewHandler({ query: mockQuery } as never, mockPubsub as never, { generate: jest.fn() } as never);
  });
  afterEach(() => jest.clearAllMocks());

  it('enfileira qualified_worker_request com os 3 slots no FUSO da vaga, case_number e job_posting_id; sem links', async () => {
    program(mockQuery);
    await handler(payload);
    const [sql, params] = outboxInsert(mockQuery);
    expect(sql).toContain("'qualified_worker_request'");
    expect(sql).toContain("'pending', 0");
    expect(params[0]).toBe('worker-1');
    expect(params[1]).toBe('job-1');
    expect(variablesOf(mockQuery)).toEqual({
      slot_1: 'Lun 10/08 08:30',
      slot_2: 'Mar 11/08 10:00',
      slot_3: 'Mié 12/08 17:00',
      case_number: '42',
      job_posting_id: 'job-1',
    });
    expect(JSON.stringify(variablesOf(mockQuery))).not.toContain('meet.google.com');
    expect(skipInsert(mockQuery)).toBeUndefined();
  });

  it('consulta vaga (com recorrente + fuso + país) e worker (status + opt-out pelo predicado único)', async () => {
    program(mockQuery);
    await handler(payload);
    const vacancySql = callsTo(mockQuery, 'FROM job_postings')[0][0] as string;
    expect(vacancySql).toMatch(/meet_recurring_weekday, meet_recurring_time, meet_recurring_link/);
    expect(vacancySql).toMatch(/timezone/);
    expect(vacancySql).toMatch(/country/);
    const workerSql = callsTo(mockQuery, 'FROM workers')[0][0] as string;
    expect(workerSql).toMatch(/w\.status/);
    expect(workerSql).toMatch(/messaging_opt_out moo/);
    expect(workerSql).toMatch(/moo\.opted_in_at IS NULL/);
  });

  it('só recorrente (segundas 08:30 AR, sem fixos): oferece as 2 próximas ocorrências e repete a última no slot 3', async () => {
    program(mockQuery, { vacancy: [{ ...vacancyRow, meet_link_1: null, meet_datetime_1: null, meet_link_2: null, meet_datetime_2: null, meet_link_3: null, meet_datetime_3: null, meet_recurring_weekday: 1, meet_recurring_time: '08:30:00', meet_recurring_link: 'https://meet.google.com/rrr-rrrr-rrr' }] });
    await handler(payload);
    const v = variablesOf(mockQuery);
    expect(v.slot_1).toMatch(/^Lun \d{2}\/\d{2} 08:30$/);
    expect(v.slot_2).toMatch(/^Lun \d{2}\/\d{2} 08:30$/);
    expect(v.slot_2).not.toBe(v.slot_1);
    expect(v.slot_3).toBe(v.slot_2);
    expect(skipInsert(mockQuery)).toBeUndefined();
  });

  it('fixo + recorrente: união ordenada (o recorrente entra entre os fixos)', async () => {
    program(mockQuery, { vacancy: [{ ...vacancyRow, meet_link_2: null, meet_datetime_2: null, meet_link_3: null, meet_datetime_3: null, meet_recurring_weekday: 3, meet_recurring_time: '10:00', meet_recurring_link: 'https://meet.google.com/rrr-rrrr-rrr' }] });
    await handler(payload);
    const v = variablesOf(mockQuery);
    // recorrente é "próxima quarta" (2026), muito antes do fixo em 2099
    expect(v.slot_1).toMatch(/^Mié \d{2}\/\d{2} 10:00$/);
    expect(v.slot_2).toMatch(/^Mié \d{2}\/\d{2} 10:00$/);
    expect(v.slot_3).toBe('Lun 10/08 08:30');
  });

  describe('pulos contáveis (interview_invite_skips)', () => {
    it('vaga não encontrada → VACANCY_NOT_FOUND com país do worker; sem outbox', async () => {
      program(mockQuery, { vacancy: [] });
      await handler(payload);
      const [sql, params] = skipInsert(mockQuery);
      expect(sql).toContain('INSERT INTO interview_invite_skips');
      expect(params).toEqual(['worker-1', null, 'evt-1', 'AR', 'VACANCY_NOT_FOUND']);
      expect(outboxInsert(mockQuery)).toBeUndefined();
      expect(mockPubsub.publish).not.toHaveBeenCalled();
    });

    it('vaga E worker desconhecidos → só log, nenhuma linha (país indeterminado, NOT NULL sem default)', async () => {
      program(mockQuery, { vacancy: [], worker: [] });
      await handler(payload);
      expect(skipInsert(mockQuery)).toBeUndefined();
      expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ msg: 'interview_invite.skipped', reason: 'VACANCY_NOT_FOUND' }));
    });

    it.each([
      ['todos null', { meet_link_1: null, meet_datetime_1: null, meet_link_2: null, meet_datetime_2: null, meet_link_3: null, meet_datetime_3: null }],
      ['link sem datetime', { meet_datetime_1: null, meet_link_2: null, meet_datetime_2: null, meet_link_3: null, meet_datetime_3: null }],
      ['datetime sem link', { meet_link_1: null, meet_link_2: null, meet_datetime_2: null, meet_link_3: null, meet_datetime_3: null }],
      ['todos no PASSADO', { meet_datetime_1: '2020-01-01T10:00:00Z', meet_datetime_2: '2020-01-02T10:00:00Z', meet_datetime_3: '2020-01-03T10:00:00Z' }],
      ['recorrente incompleto (sem sala)', { meet_link_1: null, meet_datetime_1: null, meet_link_2: null, meet_datetime_2: null, meet_link_3: null, meet_datetime_3: null, meet_recurring_weekday: 1, meet_recurring_time: '08:30' }],
    ])('sem slot futuro (%s) → NO_FUTURE_SLOT', async (_label, over) => {
      program(mockQuery, { vacancy: [{ ...vacancyRow, ...over }] });
      await handler(payload);
      expect(skipInsert(mockQuery)[1]).toEqual(['worker-1', 'job-1', 'evt-1', 'AR', 'NO_FUTURE_SLOT']);
      expect(outboxInsert(mockQuery)).toBeUndefined();
    });

    it('slot no passado é descartado, os futuros seguem (repete o último)', async () => {
      program(mockQuery, { vacancy: [{ ...vacancyRow, meet_datetime_1: '2020-01-01T10:00:00Z' }] });
      await handler(payload);
      expect(variablesOf(mockQuery)).toMatchObject({ slot_1: 'Mar 11/08 10:00', slot_2: 'Mié 12/08 17:00', slot_3: 'Mié 12/08 17:00' });
    });

    it('worker não encontrado → WORKER_NOT_FOUND com país da vaga, worker_id null', async () => {
      program(mockQuery, { worker: [] });
      await handler(payload);
      expect(skipInsert(mockQuery)[1]).toEqual([null, 'job-1', 'evt-1', 'AR', 'WORKER_NOT_FOUND']);
      expect(outboxInsert(mockQuery)).toBeUndefined();
    });

    it('worker DISABLED → WORKER_DISABLED, sem outbox (lex C3)', async () => {
      program(mockQuery, { worker: [{ ...workerRow, status: 'DISABLED' }] });
      await handler(payload);
      expect(skipInsert(mockQuery)[1]).toEqual(['worker-1', 'job-1', 'evt-1', 'AR', 'WORKER_DISABLED']);
      expect(outboxInsert(mockQuery)).toBeUndefined();
    });

    it('worker em opt-out → OPT_OUT, sem outbox (lex C2 — pré-check aditivo)', async () => {
      program(mockQuery, { worker: [{ ...workerRow, opted_out: true }] });
      await handler(payload);
      expect(skipInsert(mockQuery)[1]).toEqual(['worker-1', 'job-1', 'evt-1', 'AR', 'OPT_OUT']);
      expect(outboxInsert(mockQuery)).toBeUndefined();
    });

    it('já convidado nos últimos 7 dias → ALREADY_INVITED, sem 2ª outbox (lex C1)', async () => {
      program(mockQuery, { dup: [{ id: 'outbox-old' }] });
      await handler(payload);
      const dupSql = callsTo(mockQuery, 'FROM messaging_outbox')[0][0] as string;
      expect(dupSql).toContain(`INTERVAL '${INVITE_IDEMPOTENCY_WINDOW}'`);
      expect(dupSql).toContain("template_slug = 'qualified_worker_request'");
      expect(skipInsert(mockQuery)[1]).toEqual(['worker-1', 'job-1', 'evt-1', 'AR', 'ALREADY_INVITED']);
      expect(outboxInsert(mockQuery)).toBeUndefined();
      expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ reason: 'ALREADY_INVITED', outboxId: 'outbox-old' }));
    });

    it('país cai no do worker quando a vaga não tem', async () => {
      program(mockQuery, { vacancy: [{ ...vacancyRow, country: null }], worker: [{ ...workerRow, country: 'BR', status: 'DISABLED' }] });
      await handler(payload);
      expect(skipInsert(mockQuery)[1][3]).toBe('BR');
    });
  });

  it('publica outbox-enqueued com o id da outbox e marca interview_response = pending', async () => {
    program(mockQuery);
    await handler(payload);
    expect(mockPubsub.publish).toHaveBeenCalledWith('outbox-enqueued', { outboxId: 'outbox-1' });
    const [sql, params] = callsTo(mockQuery, 'UPDATE worker_job_applications')[0];
    expect(sql).toContain("interview_response = 'pending'");
    expect(params).toEqual(['worker-1', 'job-1']);
    expect(logger.info).toHaveBeenCalledWith(expect.objectContaining({ msg: 'interview_invite.queued', slots: ['fixed', 'fixed', 'fixed'] }));
  });

  it('com 2 fixos, slot_3 repete o último; com 1, slots 2 e 3 repetem o 1', async () => {
    program(mockQuery, { vacancy: [{ ...vacancyRow, meet_link_3: null, meet_datetime_3: null }] });
    await handler(payload);
    expect(variablesOf(mockQuery)).toMatchObject({ slot_1: 'Lun 10/08 08:30', slot_2: 'Mar 11/08 10:00', slot_3: 'Mar 11/08 10:00' });
    mockQuery.mockReset();
    program(mockQuery, { vacancy: [{ ...vacancyRow, meet_link_2: null, meet_datetime_2: null, meet_link_3: null, meet_datetime_3: null }] });
    await handler(payload);
    expect(variablesOf(mockQuery)).toMatchObject({ slot_1: 'Lun 10/08 08:30', slot_2: 'Lun 10/08 08:30', slot_3: 'Lun 10/08 08:30' });
  });

  it('case_number nativo (>=1000, migration 459) → placeholder "EN{n}" (formatCaseNumber)', async () => {
    program(mockQuery, { vacancy: [{ ...vacancyRow, case_number: 1000 }] });
    await handler(payload);
    expect(variablesOf(mockQuery)).toMatchObject({ case_number: 'EN1000' });
  });

  it('case_number null produz "—"; fuso de São Paulo formata na hora dele; timezone null cai no default', async () => {
    program(mockQuery, { vacancy: [{ ...vacancyRow, case_number: null, timezone: 'America/Sao_Paulo' }] });
    await handler(payload);
    expect(variablesOf(mockQuery)).toMatchObject({ case_number: '—', slot_1: 'Lun 10/08 08:30' });
    mockQuery.mockReset();
    program(mockQuery, { vacancy: [{ ...vacancyRow, timezone: null }] });
    await handler(payload);
    expect(variablesOf(mockQuery).slot_1).toBe('Lun 10/08 08:30');
  });
});

describe('origem do evento (B1 do gate 30/08 — medir, não decidir)', () => {
  it('qualifiedSourceOf: kanban → human_drag, talentum → talentum, ausente/outro → unknown', () => {
    expect(qualifiedSourceOf({ source: 'kanban' })).toBe('human_drag');
    expect(qualifiedSourceOf({ source: 'talentum' })).toBe('talentum');
    expect(qualifiedSourceOf({})).toBe('unknown');
    expect(qualifiedSourceOf({ source: 'system' })).toBe('unknown');
  });

  it('o log do convite enfileirado E do pulo levam source + domainEventId da linha (não do payload)', async () => {
    const mockQuery = jest.fn();
    const rawHandler = createQualifiedInterviewHandler({ query: mockQuery } as never, { publish: jest.fn().mockResolvedValue(null) } as never, { generate: jest.fn() } as never);
    program(mockQuery);
    await rawHandler({ ...payload, source: 'kanban', eventId: 'NAO-E-ESTE' }, { eventId: 'evt-da-linha' });
    expect(logger.info).toHaveBeenCalledWith(expect.objectContaining({ msg: 'interview_invite.queued', source: 'human_drag', domainEventId: 'evt-da-linha' }));
    mockQuery.mockReset();
    program(mockQuery, { vacancy: [] });
    await rawHandler({ ...payload, source: 'talentum' }, { eventId: 'evt-2' });
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ msg: 'interview_invite.skipped', source: 'talentum', domainEventId: 'evt-2' }));
    expect(skipInsert(mockQuery)[1][2]).toBe('evt-2');
  });
});
