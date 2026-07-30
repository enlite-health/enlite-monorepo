/**
 * AdmissionSchedulingService.test.ts
 *
 * Cobertura (availability = a agenda de admissão do país, capacidade 1):
 *  - book: cria evento na agenda dedicada certa, impersonando enlite@, SEM co-host,
 *    com host_display_name = nome genérico da equipe e o e-mail do paciente
 *  - anti-corrida: evento na agenda no re-check → SLOT_TAKEN (sem criar evento)
 *  - anti-corrida: INSERT viola UNIQUE(country, slot_start) (23505) → SLOT_TAKEN
 *  - paciente inexistente / de outro país → PATIENT_NOT_FOUND
 */

const mockQuery = jest.fn();

jest.mock('@shared/database/DatabaseConnection', () => ({
  DatabaseConnection: {
    getInstance: jest.fn().mockReturnValue({
      getPool: jest.fn().mockReturnValue({ query: mockQuery }),
    }),
  },
}));

import { KMSEncryptionService } from '@shared/security/KMSEncryptionService';
import {
  AdmissionSchedulingService,
  PatientNotFoundError,
  SlotTakenError,
} from '../AdmissionSchedulingService';
import type { AdmissionCalendarService } from '../../infrastructure/AdmissionCalendarService';
import type { AdmissionNotifier } from '../AdmissionNotifier';

const IMPERSONATE = 'enlite@enlite.health';
const CAL_AR = 'admission-ar@group.calendar.google.com';
const TEAM_AR = 'Equipo de Admisión EnLite';

// Slot AR: segunda 2026-08-03 10:00 (-03:00).
const SLOT_ISO = '2026-08-03T10:00:00-03:00';
const PATIENT_ID = '11111111-1111-1111-1111-111111111111';

type CalMock = jest.Mocked<Pick<AdmissionCalendarService, 'getBusyIntervals' | 'createEventWithMeet'>>;

interface Fixture {
  patientRow: { id: string; country: string; contact_email_encrypted: string | null } | null;
  /** Busy intervals returned for the country admission calendar (capacity 1). */
  calendarBusy: { start: Date; end: Date }[];
  insertThrows?: { code: string } | null;
}

function makeService(fx: Fixture): {
  service: AdmissionSchedulingService;
  calendar: CalMock;
  notifier: jest.Mocked<AdmissionNotifier>;
} {
  mockQuery.mockImplementation(async (sql: string) => {
    if (sql.includes('FROM patients')) return { rows: fx.patientRow ? [fx.patientRow] : [] };
    if (sql.includes('INSERT INTO admission_appointments')) {
      if (fx.insertThrows) throw fx.insertThrows;
      return { rows: [{ id: 'appt-001' }] };
    }
    if (sql.includes('UPDATE admission_appointments')) return { rows: [] };
    return { rows: [] };
  });

  const calendar = {
    getBusyIntervals: jest.fn(async () => fx.calendarBusy),
    createEventWithMeet: jest.fn(async () => ({ eventId: 'evt-1', meetLink: 'https://meet.google.com/abc-defg-hij' })),
  } as unknown as CalMock;

  const notifier = { onBooked: jest.fn(async () => undefined) } as unknown as jest.Mocked<AdmissionNotifier>;

  // Fake encryption: inject a deterministic decrypt.
  const encryption = {
    decrypt: jest.fn(async (c: string | null | undefined) => (c ? 'paciente@example.com' : '')),
  } as unknown as KMSEncryptionService;

  const service = new AdmissionSchedulingService(
    calendar as unknown as AdmissionCalendarService,
    notifier,
    encryption,
    IMPERSONATE,
  );
  return { service, calendar, notifier };
}

describe('AdmissionSchedulingService.book', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.ADMISSION_CALENDAR_ID_AR = CAL_AR;
    delete process.env.ADMISSION_TEAM_NAME_AR;
  });

  it('cria o evento na AGENDA DEDICADA do país, impersonando enlite@, SEM co-host, nomeando a EQUIPE', async () => {
    const { service, calendar, notifier } = makeService({
      patientRow: { id: PATIENT_ID, country: 'AR', contact_email_encrypted: 'ZW5j' },
      calendarBusy: [], // agenda livre no slot
    });

    const result = await service.book({ patientId: PATIENT_ID, slotStartISO: SLOT_ISO, country: 'AR' });

    // Evento na agenda do país, impersonando enlite@, com o paciente — e SEM coHost.
    expect(calendar.createEventWithMeet).toHaveBeenCalledTimes(1);
    const arg = calendar.createEventWithMeet.mock.calls[0][0];
    expect(arg).toMatchObject({
      calendarId: CAL_AR,
      impersonateEmail: IMPERSONATE,
      patientEmail: 'paciente@example.com',
      timezone: 'America/Argentina/Buenos_Aires',
    });
    expect(arg.coHostEmail).toBeUndefined();

    // host_display_name gravado = nome genérico da equipe; host_email = calendarId.
    const insertCall = mockQuery.mock.calls.find((c) => String(c[0]).includes('INSERT INTO admission_appointments'));
    expect(insertCall?.[1]).toEqual(
      expect.arrayContaining([PATIENT_ID, 'AR', CAL_AR, TEAM_AR]),
    );

    expect(result.hostDisplayName).toBe(TEAM_AR);
    expect(result.meetLink).toBe('https://meet.google.com/abc-defg-hij');
    expect(notifier.onBooked).toHaveBeenCalledTimes(1);
    expect(notifier.onBooked.mock.calls[0][0]).toMatchObject({ hostDisplayName: TEAM_AR });
  });

  it('respeita override de nome da equipe por env (ADMISSION_TEAM_NAME_AR)', async () => {
    process.env.ADMISSION_TEAM_NAME_AR = 'Equipo Custom';
    const { service } = makeService({
      patientRow: { id: PATIENT_ID, country: 'AR', contact_email_encrypted: null },
      calendarBusy: [],
    });

    const result = await service.book({ patientId: PATIENT_ID, slotStartISO: SLOT_ISO, country: 'AR' });
    expect(result.hostDisplayName).toBe('Equipo Custom');
  });

  it('anti-corrida: agenda ficou ocupada no re-check → SLOT_TAKEN, sem criar evento nem inserir', async () => {
    // Evento 13:00–13:45 UTC = 10:00–10:45 AR → sobrepõe o slot pedido.
    const busySlot = [{ start: new Date('2026-08-03T13:00:00Z'), end: new Date('2026-08-03T13:45:00Z') }];
    const { service, calendar } = makeService({
      patientRow: { id: PATIENT_ID, country: 'AR', contact_email_encrypted: null },
      calendarBusy: busySlot,
    });

    await expect(
      service.book({ patientId: PATIENT_ID, slotStartISO: SLOT_ISO, country: 'AR' }),
    ).rejects.toBeInstanceOf(SlotTakenError);
    expect(calendar.createEventWithMeet).not.toHaveBeenCalled();
    const insertCall = mockQuery.mock.calls.find((c) => String(c[0]).includes('INSERT INTO admission_appointments'));
    expect(insertCall).toBeUndefined();
  });

  it('anti-corrida: INSERT viola UNIQUE(country, slot_start) (23505) → SLOT_TAKEN, sem criar evento', async () => {
    const { service, calendar } = makeService({
      patientRow: { id: PATIENT_ID, country: 'AR', contact_email_encrypted: null },
      calendarBusy: [], // passa o re-check…
      insertThrows: { code: '23505' }, // …mas o INSERT colide
    });

    await expect(
      service.book({ patientId: PATIENT_ID, slotStartISO: SLOT_ISO, country: 'AR' }),
    ).rejects.toBeInstanceOf(SlotTakenError);
    expect(calendar.createEventWithMeet).not.toHaveBeenCalled();
  });

  it('paciente de outro país → PATIENT_NOT_FOUND', async () => {
    const { service } = makeService({
      patientRow: { id: PATIENT_ID, country: 'BR', contact_email_encrypted: null },
      calendarBusy: [],
    });

    await expect(
      service.book({ patientId: PATIENT_ID, slotStartISO: SLOT_ISO, country: 'AR' }),
    ).rejects.toBeInstanceOf(PatientNotFoundError);
  });
});
