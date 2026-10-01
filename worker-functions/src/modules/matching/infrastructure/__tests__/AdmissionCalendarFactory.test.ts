/**
 * AdmissionCalendarFactory.test.ts
 *
 * `ADMISSION_CALENDAR_SOURCE` escolhe a agenda de admissão (mesmo padrão do
 * `ANACARE_HOURS_SOURCE`): ausente/`real` = Google de hoje; `fake` = nenhuma
 * chamada a googleapis/oauth2/iam; valor desconhecido = fail-closed.
 */
const mockQuery = jest.fn();
jest.mock('@shared/database/DatabaseConnection', () => ({
  DatabaseConnection: {
    getInstance: jest.fn().mockReturnValue({
      getPool: jest.fn().mockReturnValue({ query: mockQuery }),
    }),
  },
}));
jest.mock('../GoogleCalendarEventFinder', () => ({
  getAccessToken: jest.fn(async () => 'tok'),
}));

import { getAccessToken } from '../GoogleCalendarEventFinder';
import { AdmissionCalendarService } from '../AdmissionCalendarService';
import { FakeAdmissionCalendar } from '../FakeAdmissionCalendar';
import { createAdmissionCalendar } from '../AdmissionCalendarFactory';
import { AdmissionSchedulingService } from '../../application/AdmissionSchedulingService';
import type { KMSEncryptionService } from '@shared/security/KMSEncryptionService';

const CAL_AR = 'admission-ar@group.calendar.google.com';
const PATIENT_ID = '11111111-1111-1111-1111-111111111111';
const NOW = new Date('2026-08-03T12:00:00-03:00'); // segunda
const SLOT_ISO = '2026-08-04T10:00:00-03:00';

describe('createAdmissionCalendar', () => {
  it('env ausente → agenda real (prod não muda)', () => {
    expect(createAdmissionCalendar({})).toBeInstanceOf(AdmissionCalendarService);
  });
  it('`real` → agenda real', () => {
    expect(createAdmissionCalendar({ ADMISSION_CALENDAR_SOURCE: 'real' })).toBeInstanceOf(AdmissionCalendarService);
  });
  it('`fake` → agenda fake', () => {
    expect(createAdmissionCalendar({ ADMISSION_CALENDAR_SOURCE: 'fake' })).toBeInstanceOf(FakeAdmissionCalendar);
  });
  it('valor desconhecido → fail-closed: nem real nem fake, e toda chamada rejeita sem rede', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch');
    const cal = createAdmissionCalendar({ ADMISSION_CALENDAR_SOURCE: 'tipo' });
    expect(cal).not.toBeInstanceOf(AdmissionCalendarService);
    expect(cal).not.toBeInstanceOf(FakeAdmissionCalendar);
    await expect(cal.getBusyIntervals(CAL_AR, 'x@y.z', 'a', 'b')).rejects.toThrow(/ADMISSION_CALENDAR_SOURCE/);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(getAccessToken).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});

describe('agenda real (env ausente) — comportamento de hoje', () => {
  it('chama getAccessToken e fetch', async () => {
    jest.clearAllMocks();
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ items: [] }), { status: 200 }),
    );
    const cal = createAdmissionCalendar({});
    await cal.getBusyIntervals(CAL_AR, 'enlite@enlite.health', '2026-08-03T00:00:00Z', '2026-08-04T00:00:00Z');
    expect(getAccessToken).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    fetchSpy.mockRestore();
  });
});

describe('agenda fake — fluxo de admissão sem terceiro', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.ADMISSION_CALENDAR_ID_AR = CAL_AR;
    mockQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM patients')) {
        return { rows: [{ id: PATIENT_ID, country: 'AR', contact_email_encrypted: 'ZW5j' }] };
      }
      if (sql.includes('INSERT INTO admission_appointments')) return { rows: [{ id: 'appt-001' }] };
      return { rows: [] };
    });
  });

  function build() {
    const encryption = { decrypt: jest.fn(async () => 'paciente@example.com') } as unknown as KMSEncryptionService;
    const notifier = { onBooked: jest.fn(async () => undefined) };
    const service = new AdmissionSchedulingService(
      createAdmissionCalendar({ ADMISSION_CALENDAR_SOURCE: 'fake' }),
      notifier,
      encryption,
      'enlite@enlite.health',
    );
    return { service, notifier };
  }

  it('slots não vazios, zero fetch, zero getAccessToken', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch');
    const { service } = build();
    const slots = await service.getAvailableSlots('AR', NOW);
    expect(slots.length).toBeGreaterThan(0);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(getAccessToken).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('book devolve appointment e link falso (.invalid), zero fetch, zero getAccessToken', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch');
    const { service, notifier } = build();
    const out = await service.book({ patientId: PATIENT_ID, country: 'AR', slotStartISO: SLOT_ISO }, NOW);
    expect(out.appointmentId).toBe('appt-001');
    expect(out.meetLink).toMatch(/^https:\/\/meet\.invalid\/fake-/);
    expect(notifier.onBooked).toHaveBeenCalledTimes(1);
    const upd = mockQuery.mock.calls.find(([sql]) => String(sql).includes('UPDATE admission_appointments'));
    expect(upd?.[1][1]).toMatch(/^fake-/);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(getAccessToken).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});

describe('FakeAdmissionCalendar — contrato da porta', () => {
  const cal = new FakeAdmissionCalendar();
  it('getFreeBusyByCalendar: um resultado livre por agenda, sem omitir nenhuma, sem duplicar', async () => {
    const r = await cal.getFreeBusyByCalendar(['a@x.z', 'b@x.z', 'a@x.z', ' '], 'i@x.z', 'f', 't');
    expect(r).toEqual([
      { calendarId: 'a@x.z', busy: [] },
      { calendarId: 'b@x.z', busy: [] },
    ]);
  });
  it('getCalendarTimezone: fuso do país dono da agenda; desconhecida → null', async () => {
    process.env.ADMISSION_CALENDAR_ID_AR = CAL_AR;
    expect(await cal.getCalendarTimezone(CAL_AR, 'i@x.z')).toBe('America/Argentina/Buenos_Aires');
    expect(await cal.getCalendarTimezone('outra', 'i@x.z')).toBeNull();
  });
  it('createEventWithMeet: id fake determinístico e link .invalid; deleteEvent no-op', async () => {
    const p = { calendarId: CAL_AR, impersonateEmail: 'i@x.z', summary: 's', startISO: SLOT_ISO, endISO: SLOT_ISO };
    const a = await cal.createEventWithMeet(p);
    expect(a).toEqual(await cal.createEventWithMeet(p));
    expect(a.eventId).toMatch(/^fake-[0-9a-f]{16}$/);
    expect(a.meetLink).toBe(`https://meet.invalid/${a.eventId}`);
    await expect(cal.deleteEvent(CAL_AR, a.eventId, 'i@x.z')).resolves.toBeUndefined();
  });
});
