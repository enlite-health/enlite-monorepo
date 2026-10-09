import { FAKE_BUSY_EMAIL_PREFIX, FakeAdmissionCalendar } from '../doubles/FakeAdmissionCalendar';

describe('FakeAdmissionCalendar — o dublê do Calendar da stack e2e (spec 049 F3)', () => {
  const FROM = '2026-10-12T14:00:00-03:00';
  const TO = '2026-10-12T14:45:00-03:00';

  it('e-mail que começa com "ocupado." responde ocupado em TODA a janela; os demais, livres', async () => {
    const cal = new FakeAdmissionCalendar();
    const [busy, free] = await cal.getFreeBusyByCalendar([`${FAKE_BUSY_EMAIL_PREFIX}ana@example.test`, 'mari@example.test'], 'x', FROM, TO);
    expect(busy.busy).toEqual([{ start: new Date(FROM), end: new Date(TO) }]);
    expect(free.busy).toEqual([]);
  });

  it('createEventWithMeet devolve meet.google.com/fak-e049-xxx, guarda os parâmetros e gera ids distintos', async () => {
    const cal = new FakeAdmissionCalendar();
    const p = { calendarId: 'c', impersonateEmail: 'e', summary: 's', startISO: FROM, endISO: TO };
    const a = await cal.createEventWithMeet(p);
    const b = await cal.createEventWithMeet(p);
    expect(a.meetLink).toMatch(/^https:\/\/meet\.google\.com\/fak-e049-[0-9a-f]{3}$/);
    expect(a.eventId).not.toBe(b.eventId);
    expect(cal.created).toHaveLength(2);
  });

  it('deleteEvent só registra; fuso e agenda do país não existem (null / [])', async () => {
    const cal = new FakeAdmissionCalendar();
    await cal.deleteEvent('c', 'evt', 'e');
    expect(cal.deleted).toEqual([{ calendarId: 'c', eventId: 'evt' }]);
    expect(await cal.getCalendarTimezone()).toBeNull();
    expect(await cal.getBusyIntervals()).toEqual([]);
  });
});
