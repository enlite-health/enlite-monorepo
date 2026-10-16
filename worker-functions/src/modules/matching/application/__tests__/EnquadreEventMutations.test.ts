/**
 * EnquadreEventMutations — acrescentar/tirar, cancelar, mover e encerrar o evento de enquadre (spec 052, T-30c). Sem banco: o
 * `client` registra as queries (COMMIT/ROLLBACK e escritas provados pelo registro); o Calendar é o `FakeAdmissionCalendar` REAL
 * (ou o `UnavailableAdmissionCalendar`, que falha de propósito); o miolo do estágio é espiado. Nomes "Ficticio NN", `@example.test`.
 */
jest.mock('@shared/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  loggingAls: { getStore: () => undefined },
  reportError: jest.fn(),
}));
jest.mock('../moveApplicationStage', () => ({ moveApplicationStage: jest.fn() }));

import { FakeAdmissionCalendar } from '../../infrastructure/doubles/FakeAdmissionCalendar';
import { UnavailableAdmissionCalendar } from '../../infrastructure/doubles/UnavailableAdmissionCalendar';
import { EnquadreEventMutations } from '../EnquadreEventMutations';
import { moveApplicationStage } from '../moveApplicationStage';
import { ENQUADRE_SYSTEM_NOTE_AUTHOR } from '../../infrastructure/ContactNoteRepository';
import type { AdmissionCalendarPort } from '../ports/AdmissionCalendarPort';

const mockMove = moveApplicationStage as jest.Mock;

const VACANCY = '11111111-1111-4111-8111-111111111111';
const EVENT = '33333333-3333-4333-8333-333333333333';
const HOST_EMAIL = 'anfitriona.ficticia@example.test';
const CAL_EVENT = 'fake-evt-1';
const ACTOR = { uid: 'staff-uid-1', cells: null };
const ENDS = new Date('2026-10-16T18:00:00.000Z');

interface Script {
  status?: 'open' | 'closed' | 'cancelled';
  active?: Array<Record<string, unknown>>;
  /** Leituras sucessivas dos ativos (a 2ª já sem quem foi tirado). */
  activeSeq?: Array<Array<Record<string, unknown>>>;
  available?: Array<{ id: string; email: string | null }>;
  noEvent?: boolean;
}

const P = (n: string, stage: string | null = 'COMPLETED', over: Record<string, unknown> = {}) => ({
  id: `p-${n}`, worker_id: `w-${n}`, email: `prestador.${n}@example.test`, stage, encuadre_id: `enc-${n}`, ...over,
});

function build(script: Script, opts: { calendar?: AdmissionCalendarPort; now?: Date } = {}) {
  const log: Array<{ sql: string; params: unknown[] }> = [];
  const client = {
    release: jest.fn(),
    query: jest.fn(async (sql: string, params: unknown[] = []) => {
      const text = sql.trim().replace(/\s+/g, ' ');
      log.push({ sql: text, params });
      if (text.includes('FROM job_postings jp')) return { rows: [{ id: VACANCY, country: 'AR', case_number: 321, patient_last_name: 'Ficticio' }] };
      if (text.includes('FOR UPDATE')) {
        if (script.noEvent) return { rows: [] };
        return { rows: [{
          id: EVENT, country: 'AR', host_display_name: 'Entrevistadora Ficticia', host_email: HOST_EMAIL, calendar_event_id: CAL_EVENT,
          starts_at: new Date('2026-10-16T17:00:00.000Z'), ends_at: ENDS, status: script.status ?? 'open', meet_link: null, import_status: null,
        }] };
      }
      if (text.includes('AS encuadre_id')) return { rows: script.activeSeq ? (script.activeSeq.shift() ?? []) : (script.active ?? []) };
      if (text.includes('FROM worker_job_applications wja JOIN workers w')) {
        const only = params[2] as string[] | null;
        return { rows: (script.available ?? []).filter((w) => !only || only.includes(w.id)).map((w) => ({ ...w, first_name_encrypted: 'x', last_name_encrypted: 'y' })) };
      }
      return { rows: [] };
    }),
  };
  const pool = { connect: jest.fn(async () => client), query: jest.fn(async () => ({ rows: [{ status: 'REGISTERED' }] })) };
  const calendar = opts.calendar ?? new FakeAdmissionCalendar();
  const readEvent = jest.fn(async () => ({ id: EVENT }) as never);
  const pubsub = { publish: jest.fn(async (_t: string, _m: unknown): Promise<string | null> => null) };
  const mutations = new EnquadreEventMutations({
    db: pool as never,
    calendar,
    env: { ENQUADRE_CALENDAR_ID_AR: 'cal-ar@group.example.test', ENQUADRE_GUEST_POLICY: 'all' },
    impersonateEmail: 'operacao@example.test',
    readEvent,
    pubsub,
    now: () => opts.now ?? new Date('2026-10-16T19:00:00.000Z'),
  });
  const sqls = () => log.map((l) => l.sql);
  const has = (needle: string) => sqls().some((s) => s.includes(needle));
  const notes = () => log.filter((l) => l.sql.startsWith('INSERT INTO wja_contact_notes'));
  return { mutations, calendar, readEvent, pubsub, log, sqls, has, notes };
}

const expectRolledBack = (t: ReturnType<typeof build>) => {
  expect(t.sqls()).toContain('ROLLBACK');
  expect(t.sqls()).not.toContain('COMMIT');
};

beforeEach(() => mockMove.mockReset());

describe('addParticipants / removeParticipant', () => {
  it('(1) acrescentar: o Google recebe entrevistadora + TODOS os ativos depois do acréscimo', async () => {
    const t = build({
      active: [P('01'), P('02')],
      available: [{ id: 'w-02', email: 'prestador.02@example.test' }],
    });
    await t.mutations.addParticipants(VACANCY, EVENT, ['w-02'], ACTOR);
    const cal = t.calendar as FakeAdmissionCalendar;
    expect(cal.attendeeUpdates).toEqual([{
      calendarId: 'cal-ar@group.example.test',
      eventId: CAL_EVENT,
      attendeeEmails: [HOST_EMAIL, 'prestador.01@example.test', 'prestador.02@example.test'],
    }]);
    expect(t.sqls()).toContain('COMMIT');
  });

  it('(2) acrescentar quem já está em evento aberto: 409 e ZERO chamadas ao Calendar', async () => {
    const t = build({ active: [P('01')], available: [] });
    await expect(t.mutations.addParticipants(VACANCY, EVENT, ['w-01'], ACTOR)).rejects.toMatchObject({ code: 'ENQUADRE_WORKER_NOT_AVAILABLE' });
    const cal = t.calendar as FakeAdmissionCalendar;
    expect(cal.attendeeUpdates).toHaveLength(0);
    expectRolledBack(t);
  });

  it('acrescentar prestador sem e-mail válido: ENQUADRE_WORKER_EMAIL_INVALID e nada vai ao Calendar', async () => {
    const t = build({ available: [{ id: 'w-03', email: 'sem-arroba' }] });
    await expect(t.mutations.addParticipants(VACANCY, EVENT, ['w-03'], ACTOR)).rejects.toMatchObject({ code: 'ENQUADRE_WORKER_EMAIL_INVALID' });
    expect((t.calendar as FakeAdmissionCalendar).attendeeUpdates).toHaveLength(0);
  });

  it('(10) acrescentar com o Google fora do ar: ROLLBACK, nenhum COMMIT e erro 502 CALENDAR_UPDATE_FAILED', async () => {
    const t = build(
      { active: [P('02')], available: [{ id: 'w-02', email: 'prestador.02@example.test' }] },
      { calendar: new UnavailableAdmissionCalendar() },
    );
    await expect(t.mutations.addParticipants(VACANCY, EVENT, ['w-02'], ACTOR)).rejects.toMatchObject({ code: 'CALENDAR_UPDATE_FAILED' });
    expectRolledBack(t);
  });

  it('(3) tirar: a lista enviada ao Google não tem o convocado tirado', async () => {
    const t = build({ activeSeq: [[P('01'), P('02')], [P('02')]] });
    await t.mutations.removeParticipant(VACANCY, EVENT, 'p-01', ACTOR);
    expect((t.calendar as FakeAdmissionCalendar).attendeeUpdates[0].attendeeEmails).toEqual([HOST_EMAIL, 'prestador.02@example.test']);
    expect(t.has("release_kind = 'removed'")).toBe(true);
    expect(t.sqls()).toContain('COMMIT');
  });

  it('(3b) tirar quem já foi marcado: 409 ENQUADRE_PARTICIPANT_ALREADY_MARKED, nada gravado nem enviado', async () => {
    const t = build({ active: [P('01', 'SELECTED')] });
    await expect(t.mutations.removeParticipant(VACANCY, EVENT, 'p-01', ACTOR)).rejects.toMatchObject({ code: 'ENQUADRE_PARTICIPANT_ALREADY_MARKED' });
    expect(t.has("release_kind = 'removed'")).toBe(false);
    expect((t.calendar as FakeAdmissionCalendar).attendeeUpdates).toHaveLength(0);
  });
});

describe('cancelEvent', () => {
  it('(4) apaga no Google, libera todos como cancelled, 1 anotação por liberado e NENHUMA chamada ao miolo de estágio', async () => {
    const t = build({ active: [P('01'), P('02', 'SELECTED')] });
    await t.mutations.cancelEvent(VACANCY, EVENT, ACTOR);
    expect((t.calendar as FakeAdmissionCalendar).deleted).toEqual([{ calendarId: 'cal-ar@group.example.test', eventId: CAL_EVENT }]);
    expect(t.has("SET status = 'cancelled'")).toBe(true);
    expect(t.has("release_kind = 'cancelled'")).toBe(true);
    expect(t.notes()).toHaveLength(2);
    expect(t.notes()[0].params).toEqual(['w-01', VACANCY, 'El encuadre del 16/10 14:00 fue cancelado', ENQUADRE_SYSTEM_NOTE_AUTHOR.id, 'Sistema']);
    expect(mockMove).not.toHaveBeenCalled();
    expect(t.sqls()).toContain('COMMIT');
  });

  it('cancelar com o Google fora do ar: ROLLBACK, nenhum COMMIT', async () => {
    const t = build({ active: [P('01')] }, { calendar: new UnavailableAdmissionCalendar() });
    await expect(t.mutations.cancelEvent(VACANCY, EVENT, ACTOR)).rejects.toMatchObject({ code: 'CALENDAR_UPDATE_FAILED' });
    expectRolledBack(t);
  });

  it('cancelar com o evento já inexistente no Google conta como sucesso', async () => {
    const gone = Object.assign(new Error('x'), { code: 'EVENT_NOT_FOUND' });
    const cal = new FakeAdmissionCalendar();
    cal.deleteEvent = async () => { throw gone; };
    const t = build({ active: [P('01')] }, { calendar: cal });
    await t.mutations.cancelEvent(VACANCY, EVENT, ACTOR);
    expect(t.sqls()).toContain('COMMIT');
  });
});

describe('moveParticipant', () => {
  it('(5) SELECTED chama o miolo com skipJumpReason e eventSource kanban; CONVOKED usa enquadre e COMPLETED', async () => {
    mockMove.mockResolvedValue({ moved: true, previousStage: 'COMPLETED', eventId: 'stage-evt-1' });
    const t = build({ active: [P('01')] });
    await t.mutations.moveParticipant(VACANCY, EVENT, 'p-01', 'SELECTED', undefined, ACTOR);
    expect(mockMove.mock.calls[0][1]).toMatchObject({ workerId: 'w-01', jobPostingId: VACANCY, encuadreId: 'enc-01', targetStage: 'SELECTED', actorUid: 'staff-uid-1' });
    expect(mockMove.mock.calls[0][2]).toEqual({ skipJumpReason: true, eventSource: 'kanban' });
    expect(t.pubsub.publish).toHaveBeenCalledWith('talentum-prescreening-qualified', { eventId: 'stage-evt-1' });

    mockMove.mockClear();
    const back = build({ active: [P('01', 'SELECTED')] });
    await back.mutations.moveParticipant(VACANCY, EVENT, 'p-01', 'CONVOKED', undefined, ACTOR);
    expect(mockMove.mock.calls[0][1]).toMatchObject({ targetStage: 'COMPLETED' });
    expect(mockMove.mock.calls[0][2]).toEqual({ skipJumpReason: true, eventSource: 'enquadre' });
  });

  it('mesma coluna de origem e destino: no-op, sem miolo e sem erro', async () => {
    const t = build({ active: [P('01', 'IN_DOUBT')] });
    await t.mutations.moveParticipant(VACANCY, EVENT, 'p-01', 'CONVOKED', undefined, ACTOR);
    expect(mockMove).not.toHaveBeenCalled();
    expect(t.sqls()).toContain('COMMIT');
  });

  it('(6) REJECTED sem motivo: 422 com o MESMO corpo do funil (MOVE_REASON_REQUIRED / ENTER_REJECTED) e ROLLBACK', async () => {
    mockMove.mockResolvedValue({ moved: false, code: 'MOVE_REASON_REQUIRED', reason: 'ENTER_REJECTED' });
    const t = build({ active: [P('01')] });
    await expect(t.mutations.moveParticipant(VACANCY, EVENT, 'p-01', 'REJECTED', undefined, ACTOR)).rejects.toMatchObject({
      status: 422,
      body: { success: false, error: 'move_reason_required', code: 'MOVE_REASON_REQUIRED', reason: 'ENTER_REJECTED' },
    });
    expectRolledBack(t);
    expect(t.pubsub.publish).not.toHaveBeenCalled();
  });
});

describe('estado do evento', () => {
  it.each(['closed', 'cancelled'] as const)('(7) mutação em evento %s: 409 ENQUADRE_EVENT_NOT_OPEN, nada gravado', async (status) => {
    const calls: Array<() => Promise<unknown>> = [];
    const t = build({ status, active: [P('01')], available: [{ id: 'w-09', email: 'p9@example.test' }] });
    calls.push(
      () => t.mutations.addParticipants(VACANCY, EVENT, ['w-09'], ACTOR),
      () => t.mutations.removeParticipant(VACANCY, EVENT, 'p-01', ACTOR),
      () => t.mutations.cancelEvent(VACANCY, EVENT, ACTOR),
      () => t.mutations.moveParticipant(VACANCY, EVENT, 'p-01', 'SELECTED', undefined, ACTOR),
      () => t.mutations.closeEvent(VACANCY, EVENT, ACTOR),
    );
    for (const call of calls) await expect(call()).rejects.toMatchObject({ code: 'ENQUADRE_EVENT_NOT_OPEN' });
    expect(t.sqls().filter((s) => /^(INSERT|UPDATE)/.test(s))).toHaveLength(0);
    expect(mockMove).not.toHaveBeenCalled();
    expect((t.calendar as FakeAdmissionCalendar).attendeeUpdates).toHaveLength(0);
  });

  it('evento de outra vaga / inexistente: 404 ENQUADRE_EVENT_NOT_FOUND', async () => {
    const t = build({ noEvent: true });
    await expect(t.mutations.cancelEvent(VACANCY, EVENT, ACTOR)).rejects.toMatchObject({ code: 'ENQUADRE_EVENT_NOT_FOUND' });
  });
});

describe('closeEvent', () => {
  it('(8) antes do fim: 409 ENQUADRE_EVENT_NOT_ENDED e NADA gravado', async () => {
    const t = build({ active: [P('01')] }, { now: new Date('2026-10-16T17:30:00.000Z') });
    await expect(t.mutations.closeEvent(VACANCY, EVENT, ACTOR)).rejects.toMatchObject({ code: 'ENQUADRE_EVENT_NOT_ENDED' });
    expect(t.sqls().filter((s) => /^(INSERT|UPDATE)/.test(s))).toHaveLength(0);
    expectRolledBack(t);
  });

  it('(9) 1 selecionado + 1 rechazado + 1 sem marca: carimbos, 1 anotação do sem marca, evento closed, zero Calendar e zero miolo', async () => {
    const t = build({ active: [P('01', 'SELECTED'), P('02', 'REJECTED'), P('03', 'COMPLETED')] });
    await t.mutations.closeEvent(VACANCY, EVENT, ACTOR);
    const stamps = t.log.filter((l) => l.sql.includes("release_kind = 'closed'")).map((l) => [l.params[0], l.params[1]]);
    expect(stamps).toEqual([['p-01', 'selected'], ['p-02', 'rejected'], ['p-03', 'returned']]);
    expect(t.notes()).toHaveLength(1);
    expect(t.notes()[0].params).toEqual(['w-03', VACANCY, 'No fue marcado en el encuadre del 16/10 14:00', 'system:enquadre', 'Sistema']);
    expect(t.has("SET status = 'closed'")).toBe(true);
    const cal = t.calendar as FakeAdmissionCalendar;
    expect(cal.attendeeUpdates).toHaveLength(0);
    expect(cal.deleted).toHaveLength(0);
    expect(mockMove).not.toHaveBeenCalled();
    expect(t.sqls()).toContain('COMMIT');
  });
});
