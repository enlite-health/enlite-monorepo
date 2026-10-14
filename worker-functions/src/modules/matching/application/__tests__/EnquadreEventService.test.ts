/**
 * EnquadreEventService — leitura e criação do evento de enquadre (spec 052, T-30b). Sem banco: o `client` é um registrador de
 * queries (prova de COMMIT/ROLLBACK pelo registro) e o Calendar é o `FakeAdmissionCalendar` REAL (não mock), que guarda o que
 * foi pedido ao Google. Nomes "Ficticio NN"; e-mails `@example.test`.
 */
jest.mock('@shared/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  loggingAls: { getStore: () => undefined },
  reportError: jest.fn(),
}));

import { FakeAdmissionCalendar, FAKE_BUSY_EMAIL_PREFIX } from '../../infrastructure/doubles/FakeAdmissionCalendar';
import { EnquadreEventService, type EnquadreEventServiceDeps } from '../EnquadreEventService';
import { CalendarCreateFailedError } from '../admissionCalendarCreate';
import { TactiqLinkRequiredError, type TactiqLinkState } from '../ports/TactiqPorts';
import { EnquadreConfigError } from '../../domain/enquadreCalendarConfig';
import {
  EnquadreWorkerEmailInvalidError,
  EnquadreWorkerNotAvailableError,
} from '../EnquadreEventErrors';
import { titleHasExactCode } from '../../domain/admissionImport';

const VACANCY_ID = '11111111-1111-4111-8111-111111111111';
const HOST_ID = '22222222-2222-4222-8222-222222222222';
const EVENT_ID = '33333333-3333-4333-8333-333333333333';
const W1 = '44444444-4444-4444-8444-444444444441';
const W2 = '44444444-4444-4444-8444-444444444442';
const HOST_EMAIL = 'anfitriona.ficticia@example.test';

interface Script {
  available: Array<{ id: string; first: string; last: string; email: string | null }>;
  /** Falha o INSERT das participações (a trava do banco). */
  participantsError?: unknown;
  /** Falha o COMMIT. */
  commitError?: unknown;
  /** Falha o 1º INSERT do evento (colisão do código). */
  firstEventInsertError?: unknown;
  eventRow?: Record<string, unknown> | null;
  participantRows?: Array<Record<string, unknown>>;
  allEventRows?: Array<Record<string, unknown>>;
}

function fakeDb(script: Script) {
  const log: Array<{ sql: string; params: unknown[] }> = [];
  let eventInserts = 0;
  const client = {
    release: jest.fn(),
    query: jest.fn(async (sql: string, params: unknown[] = []) => {
      const text = sql.trim().replace(/\s+/g, ' ');
      log.push({ sql: text, params });
      if (text === 'COMMIT' && script.commitError) throw script.commitError;
      if (text.startsWith('FROM job_postings') || text.includes('FROM job_postings jp')) {
        return { rows: [{ id: VACANCY_ID, country: 'AR', case_number: 321, patient_last_name: 'Sobrenome Ficticio' }] };
      }
      if (text.includes('FROM worker_job_applications wja JOIN workers w')) {
        const only = params[2] as string[] | null;
        const rows = script.available
          .filter((w) => !only || only.includes(w.id))
          .map((w) => ({ id: w.id, first_name_encrypted: w.first, last_name_encrypted: w.last, email: w.email }));
        return { rows };
      }
      if (text.startsWith('INSERT INTO enquadre_events ')) {
        eventInserts += 1;
        if (eventInserts === 1 && script.firstEventInsertError) throw script.firstEventInsertError;
        return { rows: [{ id: EVENT_ID }] };
      }
      if (text.startsWith('INSERT INTO enquadre_event_participants') && script.participantsError) throw script.participantsError;
      if (text.includes('FROM enquadre_event_participants p JOIN workers')) return { rows: script.participantRows ?? [] };
      if (text.includes('FROM enquadre_events WHERE job_posting_id = $1 AND id = $2')) {
        return { rows: script.eventRow === null ? [] : [script.eventRow ?? openEventRow()] };
      }
      if (text.includes('FROM enquadre_events WHERE job_posting_id = $1')) return { rows: script.allEventRows ?? [] };
      return { rows: [] };
    }),
  };
  const pool = { connect: jest.fn(async () => client), query: jest.fn() };
  const statements = () => log.map((l) => l.sql);
  return { pool, client, log, statements };
}

function openEventRow(over: Record<string, unknown> = {}) {
  return {
    id: EVENT_ID,
    country: 'AR',
    host_display_name: 'Entrevistadora Ficticia A',
    starts_at: new Date('2026-10-16T17:00:00.000Z'),
    ends_at: new Date('2026-10-16T18:00:00.000Z'),
    status: 'open',
    meet_link: 'https://meet.google.com/fak-e049-abc',
    import_status: null,
    blocked_reason: null,
    has_summary: false,
    ...over,
  };
}

const PARTICIPANT = (n: string, over: Record<string, unknown> = {}) => ({
  id: `p-${n}`,
  event_id: EVENT_ID,
  worker_id: `w-${n}`,
  release_kind: null,
  outcome: null,
  first_name_encrypted: 'Ficticio',
  last_name_encrypted: n,
  stage: 'COMPLETED',
  occupation_raw: 'AT',
  rejection_reason_category: null,
  ...over,
});

function build(script: Script, opts: { tactiq?: TactiqLinkState; env?: Record<string, string | undefined>; hostEmail?: string; now?: Date } = {}) {
  const db = fakeDb(script);
  const calendar = new FakeAdmissionCalendar();
  const hostEmail = opts.hostEmail ?? HOST_EMAIL;
  const tactiqState = opts.tactiq ?? 'linked';
  const deps: EnquadreEventServiceDeps = {
    db: db.pool as never,
    calendar,
    hosts: { listActiveWithIdByCountry: async () => [{ id: HOST_ID, email: hostEmail, displayName: 'Entrevistadora Ficticia A' }] },
    tactiq: { statesFor: async (emails: string[]) => new Map(emails.map((e) => [e.toLowerCase(), tactiqState])) },
    decryptor: { decrypt: async (c) => c ?? '' },
    env: opts.env ?? { ENQUADRE_CALENDAR_ID_AR: 'cal-ar@group.example.test', ENQUADRE_GUEST_POLICY: 'all' },
    impersonateEmail: 'operacao@example.test',
    now: () => opts.now ?? new Date('2026-10-14T12:00:00.000Z'),
    calendarRetryDelaysMs: [],
  };
  return { service: new EnquadreEventService(deps), calendar, db };
}

const INPUT = { hostId: HOST_ID, startsAt: '2026-10-16T14:00', durationMinutes: 60, workerIds: [W1, W2] };
const TWO_WORKERS = [
  { id: W1, first: 'Ficticio', last: '01', email: 'prestador.um@example.test' },
  { id: W2, first: 'Ficticia', last: '02', email: 'prestador.dois@example.test' },
];
const ACTOR = { uid: 'staff-uid-1', cells: null };

describe('createEvent — o que sai para o Google', () => {
  it('(1) convidados = entrevistadora + TODOS os escolhidos; os três guestsCan* são false', async () => {
    const { service, calendar } = build({ available: TWO_WORKERS });
    await service.createEvent(VACANCY_ID, INPUT, ACTOR);

    expect(calendar.created).toHaveLength(1);
    const sent = calendar.created[0];
    const guests = [sent.coHostEmail, ...(sent.extraAttendeeEmails ?? [])].sort();
    expect(guests).toEqual([HOST_EMAIL, 'prestador.dois@example.test', 'prestador.um@example.test'].sort());
    expect(sent.guestsCanModify).toBe(false);
    expect(sent.guestsCanSeeOtherGuests).toBe(false);
    expect(sent.guestsCanInviteOthers).toBe(false);
    expect(sent.description).toBe('');
    expect(sent.calendarId).toBe('cal-ar@group.example.test');
    // 14:00 de parede em Buenos Aires (-03:00) -> a hora de parede é interpretada no fuso do país da vaga
    expect(sent.startISO).toBe('2026-10-16T14:00:00.000-03:00');
    expect(sent.endISO).toBe('2026-10-16T15:00:00.000-03:00');
  });

  it('(2) o título casa titleHasExactCode com o código gravado e leva nº do caso e sobrenome', async () => {
    const { service, calendar, db } = build({ available: TWO_WORKERS });
    await service.createEvent(VACANCY_ID, INPUT, ACTOR);

    const insert = db.log.find((l) => l.sql.startsWith('INSERT INTO enquadre_events '));
    const code = insert?.params[5] as string;
    expect(code).toMatch(/^ENC-[0-9A-Z]{6}$/);
    const title = calendar.created[0].summary;
    expect(titleHasExactCode(title, code)).toBe(true);
    expect(title).toContain('Caso 321');
    expect(title).toContain('Sobrenome Ficticio');
  });

  it('o evento sai com id fixo derivado do id do evento e a transação TERMINA em COMMIT, depois de gravar id e link', async () => {
    const { service, calendar, db } = build({ available: TWO_WORKERS });
    const detail = await service.createEvent(VACANCY_ID, INPUT, ACTOR);

    expect(calendar.created[0].eventId).toBe(`${EVENT_ID.replace(/-/g, '')}g`);
    const s = db.statements();
    const iInsert = s.findIndex((x) => x.startsWith('INSERT INTO enquadre_events '));
    const iUpdate = s.findIndex((x) => x.startsWith('UPDATE enquadre_events SET calendar_event_id'));
    const iCommit = s.indexOf('COMMIT');
    expect(iInsert).toBeGreaterThan(-1);
    expect(iUpdate).toBeGreaterThan(iInsert);
    expect(iCommit).toBeGreaterThan(iUpdate);
    expect(s).not.toContain('ROLLBACK');
    expect(detail.id).toBe(EVENT_ID);
  });

  it('(3) Google falhou: o erro sobe, houve ROLLBACK e NENHUM COMMIT', async () => {
    const { service, calendar, db } = build({ available: TWO_WORKERS }, { hostEmail: 'falha.anfitriona@example.test' });
    await expect(service.createEvent(VACANCY_ID, INPUT, ACTOR)).rejects.toBeInstanceOf(CalendarCreateFailedError);

    const s = db.statements();
    expect(s.some((x) => x.startsWith('INSERT INTO enquadre_events '))).toBe(true); // gravou DENTRO da transação...
    expect(s).toContain('ROLLBACK'); // ...e desfez
    expect(s).not.toContain('COMMIT');
    expect(calendar.created).toHaveLength(0);
  });

  it('(4) entrevistadora sem vínculo no Tactiq: 409 da admissão e ZERO chamadas ao Calendar', async () => {
    const { service, calendar, db } = build({ available: TWO_WORKERS }, { tactiq: 'missing' });
    const err = await service.createEvent(VACANCY_ID, INPUT, ACTOR).catch((e) => e);
    expect(err).toBeInstanceOf(TactiqLinkRequiredError);
    expect(err.code).toBe('TACTIQ_LINK_REQUIRED');
    expect(calendar.created).toHaveLength(0);
    expect(calendar.deleted).toHaveLength(0);
    expect(db.statements().some((x) => x.startsWith('INSERT INTO enquadre_events'))).toBe(false);
  });

  it('(5) prestador sem e-mail válido: 422 e ZERO chamadas ao Calendar (só a quantidade na mensagem)', async () => {
    const { service, calendar } = build({ available: [TWO_WORKERS[0], { ...TWO_WORKERS[1], email: 'isto-nao-e-email' }] });
    const err = await service.createEvent(VACANCY_ID, INPUT, ACTOR).catch((e) => e);
    expect(err).toBeInstanceOf(EnquadreWorkerEmailInvalidError);
    expect(err.code).toBe('ENQUADRE_WORKER_EMAIL_INVALID');
    expect(err.message).not.toContain('isto-nao-e-email');
    expect(calendar.created).toHaveLength(0);

    const semEmail = build({ available: [TWO_WORKERS[0], { ...TWO_WORKERS[1], email: null }] });
    await expect(semEmail.service.createEvent(VACANCY_ID, INPUT, ACTOR)).rejects.toBeInstanceOf(EnquadreWorkerEmailInvalidError);
    expect(semEmail.calendar.created).toHaveLength(0);
  });

  it('(6) política de convidados ausente: erro e ZERO chamadas ao Calendar (fail-closed)', async () => {
    const { service, calendar, db } = build({ available: TWO_WORKERS }, { env: { ENQUADRE_CALENDAR_ID_AR: 'cal-ar@group.example.test' } });
    await expect(service.createEvent(VACANCY_ID, INPUT, ACTOR)).rejects.toBeInstanceOf(EnquadreConfigError);
    expect(calendar.created).toHaveLength(0);
    expect(db.statements().some((x) => x.startsWith('INSERT INTO enquadre_events'))).toBe(false);
  });

  it('política allowlist recusa convidado de fora do domínio de teste (ZERO chamadas)', async () => {
    const { service, calendar } = build(
      { available: TWO_WORKERS },
      { env: { ENQUADRE_CALENDAR_ID_AR: 'cal-ar@group.example.test', ENQUADRE_GUEST_POLICY: 'allowlist:outro.example.test' } },
    );
    const err = await service.createEvent(VACANCY_ID, INPUT, ACTOR).catch((e) => e);
    expect(err.code).toBe('ENQUADRE_GUEST_NOT_ALLOWED');
    expect(calendar.created).toHaveLength(0);
  });

  it('(7) violação do índice da trava: 409 ENQUADRE_WORKER_NOT_AVAILABLE e ZERO chamadas ao Calendar', async () => {
    const { service, calendar, db } = build({
      available: TWO_WORKERS,
      participantsError: Object.assign(new Error('dup'), { code: '23505', constraint: 'uq_enquadre_participant_um_aberto' }),
    });
    const err = await service.createEvent(VACANCY_ID, INPUT, ACTOR).catch((e) => e);
    expect(err).toBeInstanceOf(EnquadreWorkerNotAvailableError);
    expect(err.code).toBe('ENQUADRE_WORKER_NOT_AVAILABLE');
    expect(calendar.created).toHaveLength(0);
    expect(db.statements()).toContain('ROLLBACK');
    expect(db.statements()).not.toContain('COMMIT');
  });

  it('escolhido fora de Completado / já em evento aberto (a consulta não o devolve): 409 sem gravar nada', async () => {
    const { service, calendar, db } = build({ available: [TWO_WORKERS[0]] });
    await expect(service.createEvent(VACANCY_ID, INPUT, ACTOR)).rejects.toBeInstanceOf(EnquadreWorkerNotAvailableError);
    expect(calendar.created).toHaveLength(0);
    expect(db.statements().some((x) => x.startsWith('INSERT INTO enquadre_events'))).toBe(false);
  });

  it('COMMIT falhou com o Google já criado: apaga o evento pelo id fixo e o erro sobe', async () => {
    const { service, calendar } = build({ available: TWO_WORKERS, commitError: new Error('commit perdido') });
    await expect(service.createEvent(VACANCY_ID, INPUT, ACTOR)).rejects.toThrow('commit perdido');
    expect(calendar.created).toHaveLength(1);
    expect(calendar.deleted).toHaveLength(1);
    expect(calendar.deleted[0].calendarId).toBe('cal-ar@group.example.test');
  });

  it('colisão do código ENC: sorteia outro dentro de um SAVEPOINT e segue', async () => {
    const { service, db } = build({
      available: TWO_WORKERS,
      firstEventInsertError: Object.assign(new Error('dup'), { code: '23505', constraint: 'uq_enquadre_events_code' }),
    });
    await service.createEvent(VACANCY_ID, INPUT, ACTOR);
    const s = db.statements();
    expect(s.filter((x) => x.startsWith('INSERT INTO enquadre_events '))).toHaveLength(2);
    expect(s).toContain('ROLLBACK TO SAVEPOINT enquadre_code');
    expect(s).toContain('COMMIT');
  });

  it('data/hora de parede inválida: 400 INVALID_SLOT, ZERO chamadas', async () => {
    const { service, calendar } = build({ available: TWO_WORKERS });
    const err = await service.createEvent(VACANCY_ID, { ...INPUT, startsAt: '2026-13-45T99:99' }, ACTOR).catch((e) => e);
    expect(err.code).toBe('INVALID_SLOT');
    expect(calendar.created).toHaveLength(0);
  });

  it('entrevistadora de outro país / inexistente: HOST_NOT_IN_ROSTER, ZERO chamadas', async () => {
    const { service, calendar } = build({ available: TWO_WORKERS });
    const err = await service.createEvent(VACANCY_ID, { ...INPUT, hostId: '99999999-9999-4999-8999-999999999999' }, ACTOR).catch((e) => e);
    expect(err.code).toBe('HOST_NOT_IN_ROSTER');
    expect(calendar.created).toHaveLength(0);
  });
});

describe('leitura', () => {
  it('getEvent devolve a forma do contrato: pipeline null enquanto import_status é nulo, meetLink do evento aberto, colunas pelo estágio vigente', async () => {
    const { service } = build({
      available: [],
      participantRows: [PARTICIPANT('01', { stage: 'SELECTED' }), PARTICIPANT('02'), PARTICIPANT('03', { stage: 'REJECTED', rejection_reason_category: 'WORKER_DECLINED' })],
    });
    const d = await service.getEvent(VACANCY_ID, EVENT_ID);
    expect(d).toMatchObject({
      id: EVENT_ID,
      startsAt: '2026-10-16T14:00:00-03:00',
      endsAt: '2026-10-16T15:00:00-03:00',
      hostName: 'Entrevistadora Ficticia A',
      country: 'AR',
      phase: 'scheduled',
      convokedCount: 3,
      markedCount: 2,
      unmarkedCount: 1,
      outcome: { selected: 0, quickResponse: 0, rejected: 0, returned: 0 },
      meetLink: 'https://meet.google.com/fak-e049-abc',
      pipeline: null,
    });
    expect(d.participants.map((p) => [p.workerName, p.column, p.rejectionReasonCategory])).toEqual([
      ['Ficticio 01', 'SELECTED', null],
      ['Ficticio 02', 'CONVOKED', null],
      ['Ficticio 03', 'REJECTED', 'WORKER_DECLINED'],
    ]);
    expect(Object.keys(d.participants[0]).sort()).toEqual(['column', 'id', 'occupation', 'outcome', 'rejectionReasonCategory', 'workerId', 'workerName']);
  });

  it('passou do fim e aberto = pending_close; encerrado = closed sem meetLink e coluna pelo CARIMBO', async () => {
    const pending = build({ available: [] }, { now: new Date('2026-10-16T18:00:00.000Z') });
    expect((await pending.service.getEvent(VACANCY_ID, EVENT_ID)).phase).toBe('pending_close');

    const closed = build({
      available: [],
      eventRow: openEventRow({ status: 'closed', import_status: 'waiting' }),
      participantRows: [
        PARTICIPANT('01', { release_kind: 'closed', outcome: 'selected', stage: 'REJECTED' }),
        PARTICIPANT('02', { release_kind: 'closed', outcome: 'returned', stage: 'SELECTED' }),
      ],
    });
    const d = await closed.service.getEvent(VACANCY_ID, EVENT_ID);
    expect(d.phase).toBe('closed');
    expect(d.meetLink).toBeNull();
    expect(d.participants.map((p) => p.column)).toEqual(['SELECTED', 'CONVOKED']);
    expect(d.outcome).toEqual({ selected: 1, quickResponse: 0, rejected: 0, returned: 1 });
    expect(d.pipeline).toEqual({ importStatus: 'waiting', summary: 'waiting', blockedReason: null, unidentifiedCount: 0 });
  });

  it('esteira REAL (T-36c): o selo do resumo vem do documento gravado, o motivo do bloqueio da coluna, os não identificados da presença — e sem a quinta célula a chave `summary` NÃO existe', async () => {
    const done = build({
      available: [],
      eventRow: openEventRow({ status: 'closed', import_status: 'done', has_summary: true }),
      participantRows: [PARTICIPANT('01', { attendance: 'present' }), PARTICIPANT('02', { attendance: 'unidentified' }), PARTICIPANT('03', { attendance: 'unidentified' })],
    });
    expect((await done.service.getEvent(VACANCY_ID, EVENT_ID)).pipeline).toEqual({ importStatus: 'done', summary: 'ready', blockedReason: null, unidentifiedCount: 2 });
    expect((await done.service.getEvent(VACANCY_ID, EVENT_ID, { cells: ['enquadre_summary:read'] })).pipeline?.summary).toBe('ready');
    const semCelula = (await done.service.getEvent(VACANCY_ID, EVENT_ID, { cells: ['enquadre_event:read'] })).pipeline;
    expect(semCelula).toEqual({ importStatus: 'done', blockedReason: null, unidentifiedCount: 2 });
    expect(Object.keys(semCelula as object)).not.toContain('summary');

    const blocked = build({ available: [], eventRow: openEventRow({ status: 'closed', import_status: 'blocked', blocked_reason: 'no_link' }) });
    expect((await blocked.service.getEvent(VACANCY_ID, EVENT_ID)).pipeline).toMatchObject({ importStatus: 'blocked', blockedReason: 'no_link', summary: 'waiting' });

    const semDoc = build({ available: [], eventRow: openEventRow({ status: 'closed', import_status: 'done', has_summary: false }) });
    expect((await semDoc.service.getEvent(VACANCY_ID, EVENT_ID)).pipeline?.summary).toBe('unavailable');
  });

  it('a LISTA aplica a mesma regra da quinta célula (o selo do resumo some de todas as linhas)', async () => {
    const lista = build({ available: [], allEventRows: [openEventRow({ status: 'closed', import_status: 'done', has_summary: true })] });
    expect((await lista.service.listEvents(VACANCY_ID, { cells: [] }))[0].pipeline).not.toHaveProperty('summary');
    expect((await lista.service.listEvents(VACANCY_ID, { cells: ['enquadre_summary:read'] }))[0].pipeline?.summary).toBe('ready');
  });

  it('evento de outra vaga / inexistente: ENQUADRE_EVENT_NOT_FOUND', async () => {
    const { service } = build({ available: [], eventRow: null });
    const err = await service.getEvent(VACANCY_ID, EVENT_ID).catch((e) => e);
    expect(err.code).toBe('ENQUADRE_EVENT_NOT_FOUND');
  });

  it('listEvents: próximos em cima (início crescente), encerrados e cancelados embaixo (mais recente primeiro); sem participantes na lista', async () => {
    const mk = (id: string, status: string, startsAt: string) =>
      openEventRow({ id, status, starts_at: new Date(startsAt), ends_at: new Date(new Date(startsAt).getTime() + 3600_000), meet_link: status === 'open' ? 'https://meet.example.test/x' : null });
    const { service } = build({
      available: [],
      allEventRows: [
        mk('closed-old', 'closed', '2026-10-06T18:00:00.000Z'),
        mk('open-late', 'open', '2026-10-17T13:00:00.000Z'),
        mk('cancelled', 'cancelled', '2026-10-09T13:00:00.000Z'),
        mk('open-soon', 'open', '2026-10-16T17:00:00.000Z'),
      ],
      participantRows: [],
    });
    const items = await service.listEvents(VACANCY_ID);
    expect(items.map((i) => i.id)).toEqual(['open-soon', 'open-late', 'cancelled', 'closed-old']);
    expect(items.map((i) => i.phase)).toEqual(['scheduled', 'scheduled', 'cancelled', 'closed']);
    expect(items.map((i) => i.country)).toEqual(['AR', 'AR', 'AR', 'AR']);
    expect(items[0]).not.toHaveProperty('participants');
    expect(items[0]).not.toHaveProperty('unmarkedCount');
  });

  it('listAvailableWorkers: hasValidEmail por z.email(); o ENDEREÇO nunca sai; count bate', async () => {
    const { service } = build({
      available: [
        { id: W1, first: 'Ficticio', last: '01', email: 'prestador.um@example.test' },
        { id: W2, first: 'Ficticia', last: '02', email: 'sem-arroba' },
        { id: 'w-3', first: 'Ficticio', last: '03', email: null },
      ],
    });
    const out = await service.listAvailableWorkers(VACANCY_ID);
    expect(out.count).toBe(3);
    expect(out.workers.map((w) => [w.name, w.hasValidEmail])).toEqual([
      ['Ficticia 02', false],
      ['Ficticio 01', true],
      ['Ficticio 03', false],
    ]);
    expect(JSON.stringify(out)).not.toMatch(/@|example\.test|sem-arroba/);
  });

  it('listHosts: linked só quando apto; senão unlinked; id estável; sem e-mail na resposta', async () => {
    const linked = await build({ available: [] }).service.listHosts(VACANCY_ID);
    expect(linked).toEqual([{ id: HOST_ID, name: 'Entrevistadora Ficticia A', linkState: 'linked' }]);
    const broken = await build({ available: [] }, { tactiq: 'broken' }).service.listHosts(VACANCY_ID);
    expect(broken[0].linkState).toBe('unlinked');
    expect(JSON.stringify(linked)).not.toContain('@');
  });

  it('listHostFreeSlots: horas de parede do dia pedido, na duração pedida; agenda ocupada = vazio', async () => {
    const free = await build({ available: [] }).service.listHostFreeSlots(VACANCY_ID, HOST_ID, '2026-10-15', 60);
    expect(free.length).toBeGreaterThan(0);
    expect(free.every((s) => /^\d{2}:\d{2}$/.test(s))).toBe(true);
    expect(free).toContain('09:00');

    const busy = build({ available: [] }, { hostEmail: `${FAKE_BUSY_EMAIL_PREFIX}anfitriona@example.test` });
    expect(await busy.service.listHostFreeSlots(VACANCY_ID, HOST_ID, '2026-10-15', 60)).toEqual([]);

    // sábado: sem expediente, e a grade NÃO "empurra" para a segunda-feira
    expect(await build({ available: [] }).service.listHostFreeSlots(VACANCY_ID, HOST_ID, '2026-10-17', 60)).toEqual([]);
    // passado: vazio
    expect(await build({ available: [] }).service.listHostFreeSlots(VACANCY_ID, HOST_ID, '2026-10-01', 60)).toEqual([]);
  });
});

describe('createEvent — início no passado (T-30c)', () => {
  it('startsAt anterior ao agora: ENQUADRE_SLOT_IN_PAST e NADA gravado nem enviado ao Google', async () => {
    const { service, calendar, db } = build({ available: TWO_WORKERS });
    await expect(service.createEvent(VACANCY_ID, { ...INPUT, startsAt: '2026-10-13T10:00' }, ACTOR)).rejects.toMatchObject({
      code: 'ENQUADRE_SLOT_IN_PAST',
    });
    expect(calendar.created).toHaveLength(0);
    expect(db.statements().some((s) => s.startsWith('INSERT INTO enquadre_'))).toBe(false);
    expect(db.statements()).not.toContain('COMMIT');
  });
});
