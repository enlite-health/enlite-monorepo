/**
 * spec 050 F10 (R-36, R-37): cancelar com falha no Google é repetido pelo job, e reserva `booked` sem evento é compensada.
 *
 * Banco real com as migrations do HEAD; Google dublado (nunca o Calendar real); dados sintéticos. O job é exercitado pela classe
 * das varreduras (a rota HTTP e a lista de chaves do corpo estão em `admission-049-post-call.e2e.test.ts`).
 * A10-1 apagar falhando → o job apaga depois, 1 log por execução enquanto falha · A10-2 a lista da aba traz `calendarEventPending` ·
 * A10-3 `booked` sem evento há > 5 min → compensada em 1 execução (1 evento, 1 log); com evento ou < 5 min não é tocada ·
 * A10-4 paciente de teste segue as mesmas regras.
 */
import { Pool } from 'pg';
import { DateTime } from 'luxon';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import { logger } from '@shared/logging';
import { FakeAdmissionCalendar } from '../../src/modules/matching/infrastructure/doubles/FakeAdmissionCalendar';
import { AdmissionEventRepository } from '../../src/modules/matching/infrastructure/AdmissionEventRepository';
import { AdmissionPanelService } from '../../src/modules/matching/application/AdmissionPanelService';
import {
  AdmissionCalendarSweeps,
  CANCEL_CALENDAR_DELETED_EVENT,
  CANCEL_CALENDAR_FAILED_EVENT,
  CANCEL_EVENT_FAILED_LOG,
} from '../../src/modules/matching/application/admissionCalendarSweeps';
import { CALENDAR_CREATE_FAILED_LOG, calendarEventIdFor } from '../../src/modules/matching/application/admissionCalendarCreate';

const DATABASE_URL =
  process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';
const RUN = `t${Date.now().toString(36)}`;
const HOST = `host.varredura.${RUN}@example.test`;
const CAL_AR = `cal-ar-var-${RUN}@example.test`;
const AR_ZONE = 'America/Argentina/Buenos_Aires';

class EventNotFound extends Error {
  readonly code = 'EVENT_NOT_FOUND';
}

class DeletingCalendar extends FakeAdmissionCalendar {
  /** próximas N chamadas a `deleteEvent` lançam; `-1` = sempre */
  failDeletes = 0;
  attempts: string[] = [];
  /** o Google responde 404 (o evento não existe) em vez de falhar */
  notFound = false;
  override async deleteEvent(calendarId: string, eventId: string, impersonate?: string): Promise<void> {
    this.attempts.push(eventId);
    if (this.notFound) throw new EventNotFound('404');
    if (this.failDeletes !== 0) {
      if (this.failDeletes > 0) this.failDeletes -= 1;
      throw new Error('google fora');
    }
    return super.deleteEvent(calendarId, eventId, impersonate);
  }
}

describe('cancelar com falha no Google e reserva sem evento (spec 050 F10, R-36/R-37)', () => {
  let admin: Pool;
  let cal: DeletingCalendar;
  let panel: AdmissionPanelService;
  let sweeps: AdmissionCalendarSweeps;
  let logCalls: Array<{ level: string; obj: Record<string, unknown>; msg: string }>;
  let patientReal: string;
  let patientTest: string;
  let dayOffset = 30 + Math.floor(Math.random() * 300);
  const envAnterior: Record<string, string | undefined> = {};
  const created: string[] = [];

  const log = {
    info: (obj: Record<string, unknown>, msg: string) => void logCalls.push({ level: 'info', obj, msg }),
    warn: (obj: Record<string, unknown>, msg: string) => void logCalls.push({ level: 'warn', obj, msg }),
    error: (obj: Record<string, unknown>, msg: string) => void logCalls.push({ level: 'error', obj, msg }),
  };
  const nextSlot = (): string => {
    let d: DateTime;
    do {
      d = DateTime.now().setZone(AR_ZONE).plus({ days: ++dayOffset }).set({ hour: 11, minute: 0, second: 0, millisecond: 0 });
    } while (d.weekday > 5);
    return d.toISO() as string;
  };
  async function seed(patientId: string, opts: { eventId?: string | null; minutesOld?: number } = {}): Promise<string> {
    const slot = nextSlot();
    const r = await admin.query(
      `INSERT INTO admission_appointments (patient_id, country, host_email, slot_start, slot_end, status, calendar_event_id, meet_link, created_at)
       VALUES ($1,'AR',$2,$3::timestamptz,$3::timestamptz + interval '1 hour','booked',$4,$5, now() - make_interval(mins => $6))
       RETURNING id`,
      [patientId, HOST, slot, opts.eventId ?? null, opts.eventId ? 'https://meet.google.com/abc-defg-hij' : null, opts.minutesOld ?? 0],
    );
    created.push(r.rows[0].id);
    return r.rows[0].id;
  }
  const trail = async (id: string, kind: string): Promise<number> =>
    Number((await admin.query(`SELECT count(*) FROM admission_events WHERE appointment_id=$1 AND kind=$2`, [id, kind])).rows[0].count);
  const statusOf = async (id: string): Promise<string> => (await admin.query(`SELECT status FROM admission_appointments WHERE id=$1`, [id])).rows[0].status;
  const pendingInList = async (patientId: string, id: string): Promise<boolean> =>
    (await panel.list(patientId)).find((a) => a.id === id)!.calendarEventPending;
  const logsFor = (msg: string, id: string) =>
    logCalls.filter((l) => l.msg === msg && (l.obj.appointmentId === id || (l.obj.appointmentIds as string[] | undefined)?.includes(id)));

  beforeAll(async () => {
    admin = new Pool({ connectionString: DATABASE_URL });
    envAnterior.ADMISSION_CALENDAR_ID_AR = process.env.ADMISSION_CALENDAR_ID_AR;
    process.env.ADMISSION_CALENDAR_ID_AR = CAL_AR;
    const mk = async (isTest: boolean, tag: string): Promise<string> =>
      (await admin.query(
        `INSERT INTO patients (clickup_task_id, first_name, last_name, country, is_test, has_consent, contact_email_encrypted)
         VALUES ($1,'Vera','Sintetico','AR',$2,true,'cipher') RETURNING id`,
        [`e2e-050-f10-${tag}-${RUN}`, isTest],
      )).rows[0].id;
    patientReal = await mk(false, 'real');
    patientTest = await mk(true, 'test');
    const pool = DatabaseConnection.getInstance().getPool();
    cal = new DeletingCalendar();
    const events = new AdmissionEventRepository(pool);
    panel = new AdmissionPanelService({
      db: pool,
      calendar: cal,
      reminderTasks: { cancel: async () => undefined } as never,
      events,
      messaging: {} as never,
      hosts: { listActiveByCountry: async () => [] },
      tactiq: { statesFor: async () => new Map() } as never,
      impersonateEmail: 'enlite@enlite.health',
      log,
    });
    sweeps = new AdmissionCalendarSweeps({ db: pool, calendar: cal, events, impersonateEmail: 'enlite@enlite.health', log });
  });

  beforeEach(() => {
    cal.failDeletes = 0;
    cal.notFound = false;
    cal.attempts = [];
    cal.deleted.length = 0;
    logCalls = [];
  });

  afterAll(async () => {
    await admin.query(`DELETE FROM admission_appointments WHERE patient_id = ANY($1::uuid[])`, [[patientReal, patientTest]]);
    await admin.query(`DELETE FROM patients WHERE id = ANY($1::uuid[])`, [[patientReal, patientTest]]);
    await admin.end();
    await DatabaseConnection.getInstance().close();
    if (envAnterior.ADMISSION_CALENDAR_ID_AR === undefined) delete process.env.ADMISSION_CALENDAR_ID_AR;
    else process.env.ADMISSION_CALENDAR_ID_AR = envAnterior.ADMISSION_CALENDAR_ID_AR;
  });

  it('controle: a 1ª tentativa de apagar falha e a 2ª, na hora, funciona → nada pendente, nada na trilha de falha', async () => {
    const id = await seed(patientReal, { eventId: `evt-ctl-${RUN}` });
    cal.failDeletes = 1;
    const out = await panel.cancel({ patientId: patientReal, appointmentId: id, actorUid: 'staff-uid-1' });
    expect(out.calendarEventDeleted).toBe(true);
    expect(cal.attempts).toEqual([`evt-ctl-${RUN}`, `evt-ctl-${RUN}`]);
    expect(await trail(id, CANCEL_CALENDAR_FAILED_EVENT)).toBe(0);
    expect(await pendingInList(patientReal, id)).toBe(false);
    expect(logsFor(CANCEL_EVENT_FAILED_LOG, id)).toHaveLength(0);
  });

  it('404 ao apagar (o evento não existe mais): no clique conta como apagado (1 tentativa, sem selo); no job para de repetir (não_found na trilha, sem alarme)', async () => {
    // clique
    const clique = await seed(patientReal, { eventId: `evt-404c-${RUN}` });
    cal.notFound = true;
    const out = await panel.cancel({ patientId: patientReal, appointmentId: clique, actorUid: 'staff-uid-1' });
    expect(out.calendarEventDeleted).toBe(true);
    expect(cal.attempts).toEqual([`evt-404c-${RUN}`]); // 404 não repete
    expect(await trail(clique, CANCEL_CALENDAR_FAILED_EVENT)).toBe(0);
    expect(await trail(clique, CANCEL_CALENDAR_DELETED_EVENT)).toBe(1);
    expect(await pendingInList(patientReal, clique)).toBe(false);
    expect(logsFor(CANCEL_EVENT_FAILED_LOG, clique)).toHaveLength(0);

    // job: a falha de verdade deixa pendente; depois o Google passa a responder 404
    const job = await seed(patientReal, { eventId: `evt-404j-${RUN}` });
    cal.notFound = false;
    cal.failDeletes = -1;
    await panel.cancel({ patientId: patientReal, appointmentId: job, actorUid: 'staff-uid-1' });
    expect(await pendingInList(patientReal, job)).toBe(true);
    cal.failDeletes = 0;
    cal.notFound = true;
    logCalls = [];
    const s = await sweeps.run(new Date());
    expect(s.cancelEventDeleted).toBeGreaterThanOrEqual(1);
    expect(await trail(job, CANCEL_CALENDAR_DELETED_EVENT)).toBe(1);
    const reason = (await admin.query(`SELECT reason FROM admission_events WHERE appointment_id=$1 AND kind=$2`, [job, CANCEL_CALENDAR_DELETED_EVENT])).rows[0].reason;
    expect(reason).toBe('not_found');
    expect(await pendingInList(patientReal, job)).toBe(false);
    expect(logsFor(CANCEL_EVENT_FAILED_LOG, job)).toHaveLength(0);
    cal.attempts = [];
    await sweeps.run(new Date());
    expect(cal.attempts).not.toContain(`evt-404j-${RUN}`); // parou de repetir
  });

  it('404 ao apagar o evento de id fixo da órfã é o caso normal: compensa e NÃO gera warn de falha (controle: outro erro gera)', async () => {
    const orfa = await seed(patientReal, { minutesOld: 10 });
    cal.notFound = true;
    await sweeps.run(new Date());
    expect(await statusOf(orfa)).toBe('calendar_failed');
    expect(logsFor('admission.calendar_create_cleanup_failed', orfa)).toHaveLength(0);

    const orfa2 = await seed(patientReal, { minutesOld: 10 });
    cal.notFound = false;
    cal.failDeletes = -1;
    await sweeps.run(new Date());
    expect(await statusOf(orfa2)).toBe('calendar_failed');
    expect(logsFor('admission.calendar_create_cleanup_failed', orfa2)).toHaveLength(1);
  });

  it.each([
    ['paciente real', () => patientReal],
    ['A10-4 paciente de teste (mesmas regras)', () => patientTest],
  ])('A10-1/A10-2 %s: apagar persiste falhando → selo pendente, 1 log por execução; recuperou → o job apaga 1× e o selo some', async (_n, who) => {
    const patientId = who();
    const eventId = `evt-${RUN}-${patientId.slice(0, 4)}`;
    const id = await seed(patientId, { eventId });

    cal.failDeletes = -1;
    const out = await panel.cancel({ patientId, appointmentId: id, actorUid: 'staff-uid-1' });
    expect(out.calendarEventDeleted).toBe(false);
    expect(cal.attempts).toHaveLength(2); // a tentativa e UMA nova, na hora
    expect(await trail(id, CANCEL_CALENDAR_FAILED_EVENT)).toBe(1);
    expect(await pendingInList(patientId, id)).toBe(true);
    expect(logsFor(CANCEL_EVENT_FAILED_LOG, id)).toHaveLength(1); // o log do clique

    // o job, com o Google ainda fora: 1 log por execução (e um só, mesmo que houvesse várias reuniões pendentes)
    logCalls = [];
    cal.attempts = [];
    const s1 = await sweeps.run(new Date());
    expect(s1.cancelEventPending).toBeGreaterThanOrEqual(1);
    expect(s1.cancelEventDeleted).toBe(0);
    expect(cal.attempts).toContain(eventId);
    expect(logsFor(CANCEL_EVENT_FAILED_LOG, id)).toHaveLength(1);
    expect(logCalls.filter((l) => l.msg === CANCEL_EVENT_FAILED_LOG)).toHaveLength(1);
    expect(await pendingInList(patientId, id)).toBe(true);
    logCalls = [];
    await sweeps.run(new Date());
    expect(logsFor(CANCEL_EVENT_FAILED_LOG, id)).toHaveLength(1); // a próxima execução: de novo 1 (não 0, não 2)
    expect(await trail(id, CANCEL_CALENDAR_DELETED_EVENT)).toBe(0);

    // o Google volta: o job apaga e a reunião sai da fila
    cal.failDeletes = 0;
    cal.attempts = [];
    logCalls = [];
    const s2 = await sweeps.run(new Date());
    expect(s2.cancelEventDeleted).toBeGreaterThanOrEqual(1);
    expect(cal.deleted.filter((d) => d.eventId === eventId)).toEqual([{ calendarId: CAL_AR, eventId }]);
    expect(await trail(id, CANCEL_CALENDAR_DELETED_EVENT)).toBe(1);
    expect(logsFor(CANCEL_EVENT_FAILED_LOG, id)).toHaveLength(0);
    expect(await pendingInList(patientId, id)).toBe(false);

    // e não repete
    cal.attempts = [];
    await sweeps.run(new Date());
    expect(cal.attempts).not.toContain(eventId);
    expect(await trail(id, CANCEL_CALENDAR_DELETED_EVENT)).toBe(1);
  });

  it.each([
    ['paciente real', () => patientReal],
    ['A10-4 paciente de teste', () => patientTest],
  ])('A10-3 %s: booked sem evento há > 5 min → compensada em 1 execução (1 evento, 1 log); com evento e < 5 min não são tocadas', async (_n, who) => {
    const patientId = who();
    const orfa = await seed(patientId, { minutesOld: 10 });
    const comEvento = await seed(patientId, { eventId: `evt-vivo-${RUN}`, minutesOld: 10 });
    const recente = await seed(patientId, { minutesOld: 1 });
    const errorSpy = jest.spyOn(logger, 'error');

    const s = await sweeps.run(new Date());
    const alarmesDaOrfa = errorSpy.mock.calls.filter(([o, m]) => m === CALENDAR_CREATE_FAILED_LOG && (o as { appointmentId?: string }).appointmentId === orfa);
    errorSpy.mockRestore();

    expect(s.orphanReleased).toBeGreaterThanOrEqual(1);
    expect(await statusOf(orfa)).toBe('calendar_failed');
    expect(await trail(orfa, 'calendar_create_failed')).toBe(1);
    expect(alarmesDaOrfa).toHaveLength(1);
    expect(alarmesDaOrfa[0][0]).toMatchObject({ reason: 'booked_without_event' });
    expect(cal.deleted).toContainEqual({ calendarId: CAL_AR, eventId: calendarEventIdFor(orfa, 0) });
    // controles: a reserva com evento e a recente seguem `booked`, sem trilha
    expect(await statusOf(comEvento)).toBe('booked');
    expect(await trail(comEvento, 'calendar_create_failed')).toBe(0);
    expect(await statusOf(recente)).toBe('booked');
    expect(await trail(recente, 'calendar_create_failed')).toBe(0);
    expect(cal.deleted.map((d) => d.eventId)).not.toContain(calendarEventIdFor(comEvento, 0));

    // segunda execução: nada novo para a mesma reserva
    await sweeps.run(new Date());
    expect(await trail(orfa, 'calendar_create_failed')).toBe(1);
    // o horário da órfã voltou a ser reaproveitável (F8: linha fora de `booked` não segura)
    const slot = (await admin.query(`SELECT slot_start FROM admission_appointments WHERE id=$1`, [orfa])).rows[0].slot_start;
    const again = await admin.query(
      `INSERT INTO admission_appointments (patient_id, country, host_email, slot_start, slot_end, status)
       VALUES ($1,'AR',$2,$3,$3::timestamptz + interval '1 hour','booked') RETURNING id`,
      [patientId, HOST, slot],
    );
    created.push(again.rows[0].id);
    expect(again.rows).toHaveLength(1);
  });
});
