import { CalendarCreateFailedError, createEventWithRetry } from '../../application/admissionCalendarCreate';
import { FAKE_CREATE_FAILURE_EMAIL_PREFIX, FakeAdmissionCalendar } from '../doubles/FakeAdmissionCalendar';
import { UnavailableAdmissionCalendar } from '../doubles/UnavailableAdmissionCalendar';

const P = { calendarId: 'c', impersonateEmail: 'e', summary: 's', startISO: '2026-10-20T10:00:00-03:00', endISO: '2026-10-20T11:00:00-03:00' };

describe('FakeAdmissionCalendar — falha determinística e troca de convidados (spec 052)', () => {
  it('coHostEmail com prefixo "falha." → createEventWithMeet rejeita e nada é registrado', async () => {
    const cal = new FakeAdmissionCalendar();
    await expect(cal.createEventWithMeet({ ...P, coHostEmail: `${FAKE_CREATE_FAILURE_EMAIL_PREFIX}ana@example.test` })).rejects.toThrow(/falha/);
    expect(cal.created).toHaveLength(0);
  });

  it('outros e-mails (inclusive "falha" no meio) seguem criando', async () => {
    const cal = new FakeAdmissionCalendar();
    await cal.createEventWithMeet({ ...P, coHostEmail: 'a.host.falha.x@example.test' });
    expect(cal.created).toHaveLength(1);
  });

  it('createEventWithRetry com a entrevistadora "falha." termina em CalendarCreateFailedError (3 tentativas, nada criado)', async () => {
    const cal = new FakeAdmissionCalendar();
    const spy = jest.spyOn(cal, 'createEventWithMeet');
    await expect(
      createEventWithRetry(cal, { ...P, coHostEmail: 'falha.ana@example.test' }, '11111111-2222-3333-4444-555555555555', [0, 0]),
    ).rejects.toBeInstanceOf(CalendarCreateFailedError);
    expect(spy).toHaveBeenCalledTimes(3);
    expect(cal.created).toHaveLength(0);
  });

  it('setEventAttendees registra em attendeeUpdates; o Unavailable rejeita', async () => {
    const cal = new FakeAdmissionCalendar();
    await cal.setEventAttendees('cal', 'evt', 'imp', ['a@example.test']);
    expect(cal.attendeeUpdates).toEqual([{ calendarId: 'cal', eventId: 'evt', attendeeEmails: ['a@example.test'] }]);
    await expect(new UnavailableAdmissionCalendar().setEventAttendees()).rejects.toThrow(/inacessível/);
  });
});
