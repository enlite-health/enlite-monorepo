/**
 * spec 050 F9 (R-34, R-35): criação do evento com novas tentativas. Calendar 100% dublê; esperas zeradas.
 */
import {
  CalendarCreateFailedError,
  calendarEventIdFor,
  createEventWithRetry,
} from '../admissionCalendarCreate';
import type { AdmissionCalendarPort } from '../ports/AdmissionCalendarPort';
import { logger } from '@shared/logging';

const APPT = '3f2b8c1e-9a4d-4e7b-8c11-0123456789ab';
const PARAMS = {
  calendarId: 'cal@example.test',
  impersonateEmail: 'enlite@example.test',
  summary: 's',
  startISO: '2026-12-01T10:00:00-03:00',
  endISO: '2026-12-01T11:00:00-03:00',
};
const OK = { eventId: 'evt-ok', meetLink: 'https://meet.google.com/abc-defg-hij' };
const NO_WAIT = [0, 0] as const;

function calendar(create: jest.Mock, del: jest.Mock = jest.fn(async (..._a: string[]) => undefined)): AdmissionCalendarPort {
  return { createEventWithMeet: create, deleteEvent: del } as unknown as AdmissionCalendarPort;
}

describe('calendarEventIdFor', () => {
  it('é base32hex (0-9 a-v), de 5 a 1024 caracteres, estável por geração e distinto entre gerações', () => {
    const ids = [0, 1, 2].map((g) => calendarEventIdFor(APPT, g));
    for (const id of ids) {
      expect(id).toMatch(/^[0-9a-v]{5,1024}$/);
    }
    expect(new Set(ids).size).toBe(3);
    expect(calendarEventIdFor(APPT, 0)).toBe(ids[0]);
  });
});

describe('createEventWithRetry', () => {
  it('controle: sem falha → 1 chamada, devolve id e link', async () => {
    const create = jest.fn(async () => OK);
    await expect(createEventWithRetry(calendar(create), PARAMS, APPT, NO_WAIT)).resolves.toEqual(OK);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('falha 1× → 2ª tentativa dá certo, com o MESMO id de evento', async () => {
    const create = jest.fn().mockRejectedValueOnce(new Error('x')).mockResolvedValue(OK);
    await expect(createEventWithRetry(calendar(create), PARAMS, APPT, NO_WAIT)).resolves.toEqual(OK);
    expect(create).toHaveBeenCalledTimes(2);
    const ids = create.mock.calls.map((c) => c[0].eventId);
    expect(ids[0]).toBe(calendarEventIdFor(APPT, 0));
    expect(ids[1]).toBe(ids[0]);
  });

  it('falha sempre → 3 tentativas (1 + 2 novas), CalendarCreateFailedError(create_error) e apaga o que possa ter sido criado', async () => {
    const create = jest.fn().mockRejectedValue(new Error('x'));
    const del = jest.fn(async (..._a: string[]) => undefined);
    await expect(createEventWithRetry(calendar(create, del), PARAMS, APPT, NO_WAIT)).rejects.toMatchObject({
      name: 'CalendarCreateFailedError',
      reason: 'create_error',
    });
    expect(create).toHaveBeenCalledTimes(3);
    expect(del).toHaveBeenCalledWith(PARAMS.calendarId, calendarEventIdFor(APPT, 0), PARAMS.impersonateEmail);
  });

  it('R-35: link vazio → apaga o evento e a tentativa seguinte usa OUTRO id; sempre vazio → falha, 3 apagados distintos', async () => {
    const create = jest.fn(async (p: { eventId: string }) => ({ eventId: p.eventId, meetLink: '' }));
    const del = jest.fn(async (..._a: string[]) => undefined);
    await expect(createEventWithRetry(calendar(create, del), PARAMS, APPT, NO_WAIT)).rejects.toMatchObject({ reason: 'empty_event_or_link' });
    expect(create).toHaveBeenCalledTimes(3);
    expect(del).toHaveBeenCalledTimes(3);
    expect(new Set(del.mock.calls.map((c) => c[1])).size).toBe(3);
  });

  it('R-35: id vazio na resposta também é falha (nada a apagar)', async () => {
    const create = jest.fn(async () => ({ eventId: '', meetLink: 'https://meet.google.com/abc-defg-hij' }));
    const del = jest.fn(async (..._a: string[]) => undefined);
    await expect(createEventWithRetry(calendar(create, del), PARAMS, APPT, NO_WAIT)).rejects.toBeInstanceOf(CalendarCreateFailedError);
    expect(del).not.toHaveBeenCalled();
  });

  it('falha ao apagar não esconde a causa: continua CalendarCreateFailedError', async () => {
    const create = jest.fn().mockRejectedValue(new Error('x'));
    const del = jest.fn().mockRejectedValue(new Error('404'));
    await expect(createEventWithRetry(calendar(create, del), PARAMS, APPT, NO_WAIT)).rejects.toBeInstanceOf(CalendarCreateFailedError);
  });
});

describe('C1-4: o log de falha do Calendar carrega o status HTTP numérico e nenhum corpo/PII', () => {
  const CORPO = 'CORPO-DA-RESPOSTA-SINTETICO operadora.sintetica@example.test evento-id-de-pessoa';
  const retryLogs = (spy: jest.SpyInstance) => spy.mock.calls.filter((c) => c[1] === 'admission.calendar_create_retry').map((c) => c[0] as Record<string, unknown>);

  it('erro com status 503 → cada tentativa registra status=503 (número), e o log inteiro não contém o corpo, o e-mail nem o id do evento', async () => {
    const spy = jest.spyOn(logger, 'warn').mockImplementation(() => logger);
    try {
      const erro = Object.assign(new Error(`[AdmissionCalendarService] createEvent 503 on cal@example.test: ${CORPO}`), { status: 503 });
      const create = jest.fn().mockRejectedValue(erro);
      await expect(createEventWithRetry(calendar(create), PARAMS, APPT, NO_WAIT)).rejects.toBeInstanceOf(CalendarCreateFailedError);
      const logs = retryLogs(spy);
      expect(logs).toHaveLength(3);
      for (const l of logs) {
        expect(l.status).toBe(503);
        expect(typeof l.status).toBe('number');
        expect(Object.keys(l).sort()).toEqual(['appointmentId', 'attempt', 'reason', 'status']);
      }
      const tudo = JSON.stringify(spy.mock.calls);
      expect(tudo).not.toContain('CORPO-DA-RESPOSTA');
      expect(tudo).not.toContain('example.test');
      expect(tudo).not.toContain(calendarEventIdFor(APPT, 0));
    } finally {
      spy.mockRestore();
    }
  });

  it('controle: erro SEM status (rede) → status=null, e link vazio zera o status da tentativa anterior', async () => {
    const spy = jest.spyOn(logger, 'warn').mockImplementation(() => logger);
    try {
      const create = jest
        .fn()
        .mockRejectedValueOnce(Object.assign(new Error('x'), { status: 500 }))
        .mockRejectedValueOnce(new Error('ECONNRESET'))
        .mockResolvedValueOnce({ eventId: 'evt-x', meetLink: '' });
      await expect(createEventWithRetry(calendar(create), PARAMS, APPT, NO_WAIT)).rejects.toBeInstanceOf(CalendarCreateFailedError);
      expect(retryLogs(spy).map((l) => [l.reason, l.status])).toEqual([
        ['create_error', 500],
        ['create_error', null],
        ['empty_event_or_link', null],
      ]);
    } finally {
      spy.mockRestore();
    }
  });
});
