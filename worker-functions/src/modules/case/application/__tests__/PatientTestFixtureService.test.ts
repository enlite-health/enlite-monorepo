import {
  PatientTestFixtureService,
  NotATestPatientError,
} from '../PatientTestFixtureService';

/**
 * O que estes testes protegem: um endpoint que APAGA paciente em produção.
 * A trava (`is_test = true`) é a única coisa entre ele e dado real de gente —
 * por isso ela é o primeiro e mais repetido caso aqui.
 */

interface QueryCall { sql: string; params?: unknown[] }

function makeDb(handlers: Array<(sql: string, params?: unknown[]) => unknown | undefined>) {
  const calls: QueryCall[] = [];
  const clientCalls: QueryCall[] = [];

  const client = {
    query: jest.fn(async (sql: string, params?: unknown[]) => {
      clientCalls.push({ sql, params });
      for (const h of handlers) {
        const r = h(sql, params);
        if (r !== undefined) return r;
      }
      return { rows: [], rowCount: 0 };
    }),
    release: jest.fn(),
  };

  const db = {
    query: jest.fn(async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params });
      for (const h of handlers) {
        const r = h(sql, params);
        if (r !== undefined) return r;
      }
      return { rows: [], rowCount: 0 };
    }),
    connect: jest.fn(async () => client),
  };

  return { db, client, calls, clientCalls };
}

const PATIENT_ID = '11111111-1111-1111-1111-111111111111';

/** Handler: SELECT is_test devolve o valor pedido. */
const selectIsTest = (isTest: boolean | null) => (sql: string) =>
  sql.includes('SELECT is_test FROM patients')
    ? { rows: isTest === null ? [] : [{ is_test: isTest }], rowCount: isTest === null ? 0 : 1 }
    : undefined;

const noAppointments = (sql: string) =>
  sql.includes('FROM admission_appointments') ? { rows: [], rowCount: 0 } : undefined;

function calendarSpy(behavior: 'ok' | 'fail' = 'ok') {
  return {
    deleteEvent: jest.fn(async () => {
      if (behavior === 'fail') throw new Error('calendar 404');
    }),
  };
}
type CalendarSpy = ReturnType<typeof calendarSpy>;

beforeEach(() => {
  process.env.ADMISSION_CALENDAR_ID_AR = 'admission-ar@enlite.health';
});

describe('PatientTestFixtureService.purge — a trava', () => {
  it('RECUSA purgar paciente real (is_test=false) e não toca em nada', async () => {
    const { db, calls } = makeDb([selectIsTest(false)]);
    const svc = new PatientTestFixtureService(db as never, calendarSpy() as never);

    await expect(svc.purge(PATIENT_ID)).rejects.toBeInstanceOf(NotATestPatientError);

    // Nenhum DELETE/UPDATE saiu — a recusa acontece ANTES de qualquer escrita.
    // (âncora no início do statement: /DELETE/i solto casa com "deleted_at")
    const escritas = calls.filter((c) => /^\s*(DELETE|UPDATE)\b/i.test(c.sql));
    expect(escritas).toHaveLength(0);
    expect(db.connect).not.toHaveBeenCalled();
  });

  it('devolve null (→404) quando o paciente não existe', async () => {
    const { db } = makeDb([selectIsTest(null)]);
    const svc = new PatientTestFixtureService(db as never, calendarSpy() as never);

    await expect(svc.purge(PATIENT_ID)).resolves.toBeNull();
  });

  it('erro traz o código NOT_A_TEST_PATIENT (o controller devolve 409)', async () => {
    const { db } = makeDb([selectIsTest(false)]);
    const svc = new PatientTestFixtureService(db as never, calendarSpy() as never);

    await expect(svc.purge(PATIENT_ID)).rejects.toMatchObject({
      code: 'NOT_A_TEST_PATIENT',
    });
  });
});

describe('PatientTestFixtureService.purge — limpeza de paciente sintético', () => {
  it('apaga o evento do Calendar, a entrevista, as vagas e o paciente', async () => {
    const calendar: CalendarSpy = calendarSpy();
    const { db, clientCalls } = makeDb([
      selectIsTest(true),
      (sql) =>
        sql.includes('FROM admission_appointments')
          ? {
              rows: [{ id: 'appt-1', country: 'AR', calendar_event_id: 'evt-1' }],
              rowCount: 1,
            }
          : undefined,
      (sql) => (sql.includes('DELETE FROM admission_appointments') ? { rows: [], rowCount: 1 } : undefined),
      (sql) => (sql.includes('UPDATE job_postings') ? { rows: [], rowCount: 2 } : undefined),
    ]);
    const svc = new PatientTestFixtureService(db as never, calendar as never);

    const result = await svc.purge(PATIENT_ID);

    expect(result).toEqual({
      patientId: PATIENT_ID,
      appointmentsCancelled: 1,
      calendarEventsDeleted: 1,
      calendarEventsFailed: 0,
      vacanciesDeleted: 2,
    });
    expect(calendar.deleteEvent).toHaveBeenCalledWith(
      'admission-ar@enlite.health',
      'evt-1',
      expect.any(String),
    );
    // soft-delete (deleted_at), nunca DELETE físico do paciente
    const patientWrite = clientCalls.find((c) => c.sql.includes('UPDATE patients'));
    expect(patientWrite?.sql).toContain('deleted_at = NOW()');
    expect(clientCalls.some((c) => /DELETE FROM patients/i.test(c.sql))).toBe(false);
  });

  it('falha no Calendar é CONTADA, não aborta a limpeza do banco', async () => {
    const { db, clientCalls } = makeDb([
      selectIsTest(true),
      (sql) =>
        sql.includes('FROM admission_appointments')
          ? { rows: [{ id: 'appt-1', country: 'AR', calendar_event_id: 'evt-1' }], rowCount: 1 }
          : undefined,
      (sql) => (sql.includes('DELETE FROM admission_appointments') ? { rows: [], rowCount: 1 } : undefined),
    ]);
    const svc = new PatientTestFixtureService(db as never, calendarSpy('fail') as never);

    const result = await svc.purge(PATIENT_ID);

    expect(result?.calendarEventsDeleted).toBe(0);
    expect(result?.calendarEventsFailed).toBe(1);
    expect(clientCalls.some((c) => c.sql.includes('UPDATE patients'))).toBe(true);
  });

  it('appointment sem evento no Calendar não chama a API do Google', async () => {
    const calendar: CalendarSpy = calendarSpy();
    const { db } = makeDb([
      selectIsTest(true),
      (sql) =>
        sql.includes('FROM admission_appointments')
          ? { rows: [{ id: 'appt-1', country: 'AR', calendar_event_id: null }], rowCount: 1 }
          : undefined,
    ]);
    const svc = new PatientTestFixtureService(db as never, calendar as never);

    const result = await svc.purge(PATIENT_ID);

    expect(calendar.deleteEvent).not.toHaveBeenCalled();
    expect(result?.calendarEventsDeleted).toBe(0);
    expect(result?.calendarEventsFailed).toBe(0);
  });

  it('faz rollback se a transação falhar no meio', async () => {
    const { db, client } = makeDb([
      selectIsTest(true),
      noAppointments,
      (sql) => {
        if (sql.includes('UPDATE job_postings')) throw new Error('boom');
        return undefined;
      },
    ]);
    const svc = new PatientTestFixtureService(db as never, calendarSpy() as never);

    await expect(svc.purge(PATIENT_ID)).rejects.toThrow('boom');
    expect(client.query).toHaveBeenCalledWith('ROLLBACK');
    expect(client.release).toHaveBeenCalled();
  });
});

describe('PatientTestFixtureService.setTestFlag', () => {
  it('grava a marca e devolve o valor persistido', async () => {
    const { db, calls } = makeDb([
      (sql) => (sql.includes('UPDATE patients') ? { rows: [{ is_test: true }], rowCount: 1 } : undefined),
    ]);
    const svc = new PatientTestFixtureService(db as never, calendarSpy() as never);

    await expect(svc.setTestFlag(PATIENT_ID, true)).resolves.toBe(true);
    expect(calls[0].params).toEqual([PATIENT_ID, true]);
  });

  it('devolve null (→404) quando o paciente não existe', async () => {
    const { db } = makeDb([]);
    const svc = new PatientTestFixtureService(db as never, calendarSpy() as never);

    await expect(svc.setTestFlag(PATIENT_ID, true)).resolves.toBeNull();
  });
});
