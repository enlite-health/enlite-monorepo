/**
 * AdmissionCalendarService.enquadre.test.ts — o CORPO do evento do enquadre (spec 052, Fase 2, T-29) e a troca de convidados.
 * Arquivo novo ao lado do `.io.test.ts` (que prova o corpo da admissão e não é editado). `fetch` interceptado: nada sai da máquina.
 */

jest.mock('../GoogleCalendarEventFinder', () => ({
  getAccessToken: jest.fn(async () => 'fake-token'),
}));

import { getAccessToken } from '../GoogleCalendarEventFinder';
import { AdmissionCalendarService, AR_ZONE } from '../AdmissionCalendarService';

const CAL_ENC = 'enquadre-ar@group.calendar.google.com';
const IMPERSONATE = 'enlite@enlite.health';
const HOST = 'entrevistadora@enlite.health';

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body, text: async () => JSON.stringify(body) } as unknown as Response;
}

function lastCall(): { url: string; init: RequestInit; body: Record<string, unknown> } {
  const calls = (global.fetch as jest.Mock).mock.calls;
  const [url, init] = calls[calls.length - 1] as [string, RequestInit];
  return { url, init, body: init?.body ? JSON.parse(init.body as string) : {} };
}

describe('AdmissionCalendarService — evento do enquadre', () => {
  let service: AdmissionCalendarService;
  const baseParams = {
    calendarId: CAL_ENC,
    impersonateEmail: IMPERSONATE,
    summary: 'Encuadre terapéutico — Caso 1234 · ENC-ABC234',
    startISO: '2026-10-20T10:00:00-03:00',
    endISO: '2026-10-20T11:00:00-03:00',
    timezone: AR_ZONE,
  };

  beforeEach(() => {
    jest.clearAllMocks();
    (getAccessToken as jest.Mock).mockResolvedValue('fake-token');
    global.fetch = jest.fn().mockResolvedValue(jsonResponse({ id: 'evt-1', hangoutLink: 'https://meet.google.com/abc-defg-hij' }));
    service = new AdmissionCalendarService({ NODE_ENV: 'production' });
  });

  describe('createEventWithMeet com os campos do enquadre', () => {
    it('manda os três `false`, entrevistadora + N convidados sem duplicata (sem diferenciar maiúsculas) e sendUpdates=all', async () => {
      await service.createEventWithMeet({
        ...baseParams,
        coHostEmail: HOST,
        extraAttendeeEmails: ['prestador1@example.test', 'Prestador1@Example.test', HOST.toUpperCase(), 'prestador2@example.test'],
        guestsCanModify: false,
        guestsCanSeeOtherGuests: false,
        guestsCanInviteOthers: false,
      });
      const { url, init, body } = lastCall();
      expect(body.guestsCanModify).toBe(false);
      expect(body.guestsCanSeeOtherGuests).toBe(false);
      expect(body.guestsCanInviteOthers).toBe(false);
      expect(body.attendees).toEqual([{ email: HOST }, { email: 'prestador1@example.test' }, { email: 'prestador2@example.test' }]);
      expect(url).toContain('sendUpdates=all');
      expect(url).toContain('conferenceDataVersion=1');
      expect(init.method).toBe('POST');
    });

    it('os extras entram DEPOIS de coHostEmail e patientEmail', async () => {
      await service.createEventWithMeet({ ...baseParams, coHostEmail: HOST, patientEmail: 'p@example.test', extraAttendeeEmails: ['x@example.test'] });
      expect(lastCall().body.attendees).toEqual([{ email: HOST }, { email: 'p@example.test' }, { email: 'x@example.test' }]);
    });
  });

  describe('sem os campos novos o evento é exatamente o de sempre (admissão intocada)', () => {
    it('corpo completo e URL idênticos aos de hoje', async () => {
      await service.createEventWithMeet({ ...baseParams, description: 'Entrevista de admisión Enlite (AR).', coHostEmail: HOST, patientEmail: 'p@example.test', eventId: 'abcde12345' });
      const { url, body } = lastCall();
      expect(body).toEqual({
        id: 'abcde12345',
        summary: baseParams.summary,
        description: 'Entrevista de admisión Enlite (AR).',
        start: { dateTime: baseParams.startISO, timeZone: AR_ZONE },
        end: { dateTime: baseParams.endISO, timeZone: AR_ZONE },
        attendees: [{ email: HOST }, { email: 'p@example.test' }],
        guestsCanModify: true,
        conferenceData: { createRequest: { requestId: expect.any(String), conferenceSolutionKey: { type: 'hangoutsMeet' } } },
      });
      expect(url).toBe(
        `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(CAL_ENC)}/events?conferenceDataVersion=1&sendUpdates=all`,
      );
    });
  });

  describe('setEventAttendees', () => {
    it('PATCH no evento pelo id, na agenda dedicada, com a lista completa e sendUpdates=all', async () => {
      (global.fetch as jest.Mock).mockResolvedValue(jsonResponse({}));
      await service.setEventAttendees(CAL_ENC, 'evt-1', IMPERSONATE, [HOST, 'a@example.test']);
      const { url, init, body } = lastCall();
      expect(url).toBe(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(CAL_ENC)}/events/evt-1?sendUpdates=all`);
      expect(init.method).toBe('PATCH');
      expect((init.headers as Record<string, string>).Authorization).toBe('Bearer fake-token');
      expect(body).toEqual({ attendees: [{ email: HOST }, { email: 'a@example.test' }] });
    });

    it('sem token DWD → erro explícito; resposta não-ok → erro com o status', async () => {
      (getAccessToken as jest.Mock).mockResolvedValue(null);
      await expect(service.setEventAttendees(CAL_ENC, 'e', IMPERSONATE, [])).rejects.toThrow(/no DWD token/);
      (getAccessToken as jest.Mock).mockResolvedValue('fake-token');
      (global.fetch as jest.Mock).mockResolvedValue(jsonResponse({}, false, 500));
      await expect(service.setEventAttendees(CAL_ENC, 'e', IMPERSONATE, [])).rejects.toThrow(/setEventAttendees 500/);
    });
  });
});
