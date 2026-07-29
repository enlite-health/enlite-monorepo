/**
 * AdmissionSchedulingService.test.ts
 *
 * Cobertura:
 *  - book: atribuição least-loaded (mock countEventsInWeek)
 *  - book: cria evento na agenda dedicada certa, impersonando enlite@, com
 *    a entrevistadora escolhida como co-host e o e-mail do paciente
 *  - anti-corrida: INSERT com UNIQUE(host_email, slot_start) → 23505 → SLOT_TAKEN
 *  - anti-corrida: host ficou ocupado no re-check → SLOT_TAKEN
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

const HOST_A = 'ana@enlite.health';
const HOST_B = 'bruna@enlite.health';
const IMPERSONATE = 'enlite@enlite.health';
const CAL_AR = 'admission-ar@group.calendar.google.com';

// Slot AR: segunda 2026-08-03 10:00 (-03:00).
const SLOT_ISO = '2026-08-03T10:00:00-03:00';
const PATIENT_ID = '11111111-1111-1111-1111-111111111111';

type CalMock = jest.Mocked<Pick<AdmissionCalendarService, 'getBusyIntervals' | 'countEventsInWeek' | 'createEventWithMeet'>>;

interface Fixture {
  hosts: { email: string; display_name: string | null }[];
  patientRow: { id: string; country: string; contact_email_encrypted: string | null } | null;
  loadByEmail: Record<string, number>;
  busyByEmail: Record<string, { start: Date; end: Date }[]>;
  insertThrows?: { code: string } | null;
}

function makeService(fx: Fixture): {
  service: AdmissionSchedulingService;
  calendar: CalMock;
  notifier: jest.Mocked<AdmissionNotifier>;
} {
  mockQuery.mockImplementation(async (sql: string) => {
    if (sql.includes('FROM interview_hosts')) return { rows: fx.hosts };
    if (sql.includes('FROM patients')) return { rows: fx.patientRow ? [fx.patientRow] : [] };
    if (sql.includes('INSERT INTO admission_appointments')) {
      if (fx.insertThrows) throw fx.insertThrows;
      return { rows: [{ id: 'appt-001' }] };
    }
    if (sql.includes('UPDATE admission_appointments')) return { rows: [] };
    return { rows: [] };
  });

  const calendar = {
    getBusyIntervals: jest.fn(async (email: string) => fx.busyByEmail[email] ?? []),
    countEventsInWeek: jest.fn(async (email: string) => fx.loadByEmail[email] ?? 0),
    createEventWithMeet: jest.fn(async () => ({ eventId: 'evt-1', meetLink: 'https://meet.google.com/abc-defg-hij' })),
  } as unknown as CalMock;

  const notifier = { onBooked: jest.fn(async () => undefined) } as unknown as jest.Mocked<AdmissionNotifier>;

  // Fake encryption: base64/testMode decrypt is fine, but inject a deterministic one.
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
  });

  it('atribui o host MENOS carregado (least-loaded) e o usa como co-host', async () => {
    const { service, calendar } = makeService({
      hosts: [
        { email: HOST_A, display_name: 'Ana' },
        { email: HOST_B, display_name: 'Bruna' },
      ],
      patientRow: { id: PATIENT_ID, country: 'AR', contact_email_encrypted: 'ZW5j' },
      loadByEmail: { [HOST_A]: 5, [HOST_B]: 2 }, // Bruna mais livre
      busyByEmail: {}, // ambos livres no slot
    });

    const result = await service.book({ patientId: PATIENT_ID, slotStartISO: SLOT_ISO, country: 'AR' });

    expect(result.hostDisplayName).toBe('Bruna');
    // INSERT foi para o host escolhido (Bruna).
    const insertCall = mockQuery.mock.calls.find((c) => String(c[0]).includes('INSERT INTO admission_appointments'));
    expect(insertCall?.[1]).toEqual(
      expect.arrayContaining([PATIENT_ID, 'AR', HOST_B, 'Bruna']),
    );
    // Evento criado com Bruna como co-host.
    expect(calendar.createEventWithMeet).toHaveBeenCalledTimes(1);
    expect(calendar.createEventWithMeet.mock.calls[0][0]).toMatchObject({ coHostEmail: HOST_B });
  });

  it('empate na carga → desempata por email asc', async () => {
    const { service } = makeService({
      hosts: [
        { email: HOST_B, display_name: 'Bruna' },
        { email: HOST_A, display_name: 'Ana' },
      ],
      patientRow: { id: PATIENT_ID, country: 'AR', contact_email_encrypted: null },
      loadByEmail: { [HOST_A]: 3, [HOST_B]: 3 },
      busyByEmail: {},
    });

    const result = await service.book({ patientId: PATIENT_ID, slotStartISO: SLOT_ISO, country: 'AR' });
    // ana@ < bruna@ → Ana.
    expect(result.hostDisplayName).toBe('Ana');
  });

  it('cria o evento na AGENDA DEDICADA certa, impersonando enlite@, com paciente como attendee', async () => {
    const { service, calendar, notifier } = makeService({
      hosts: [{ email: HOST_A, display_name: 'Ana' }],
      patientRow: { id: PATIENT_ID, country: 'AR', contact_email_encrypted: 'ZW5j' },
      loadByEmail: { [HOST_A]: 0 },
      busyByEmail: {},
    });

    const result = await service.book({ patientId: PATIENT_ID, slotStartISO: SLOT_ISO, country: 'AR' });

    expect(calendar.createEventWithMeet).toHaveBeenCalledTimes(1);
    const arg = calendar.createEventWithMeet.mock.calls[0][0];
    expect(arg).toMatchObject({
      calendarId: CAL_AR,
      impersonateEmail: IMPERSONATE,
      coHostEmail: HOST_A,
      patientEmail: 'paciente@example.com',
      timezone: 'America/Argentina/Buenos_Aires',
    });
    expect(result.meetLink).toBe('https://meet.google.com/abc-defg-hij');
    expect(notifier.onBooked).toHaveBeenCalledTimes(1);
  });

  it('anti-corrida: INSERT viola UNIQUE(host_email, slot_start) (23505) → SLOT_TAKEN, sem criar evento', async () => {
    const { service, calendar } = makeService({
      hosts: [{ email: HOST_A, display_name: 'Ana' }],
      patientRow: { id: PATIENT_ID, country: 'AR', contact_email_encrypted: null },
      loadByEmail: { [HOST_A]: 0 },
      busyByEmail: {},
      insertThrows: { code: '23505' },
    });

    await expect(
      service.book({ patientId: PATIENT_ID, slotStartISO: SLOT_ISO, country: 'AR' }),
    ).rejects.toBeInstanceOf(SlotTakenError);
    expect(calendar.createEventWithMeet).not.toHaveBeenCalled();
  });

  it('anti-corrida: host ficou ocupado no re-check → SLOT_TAKEN', async () => {
    const busySlot = [{ start: new Date('2026-08-03T13:00:00Z'), end: new Date('2026-08-03T13:45:00Z') }];
    const { service, calendar } = makeService({
      hosts: [{ email: HOST_A, display_name: 'Ana' }],
      patientRow: { id: PATIENT_ID, country: 'AR', contact_email_encrypted: null },
      loadByEmail: { [HOST_A]: 0 },
      busyByEmail: { [HOST_A]: busySlot }, // overlapa o slot das 10:00 AR (=13:00Z)
    });

    await expect(
      service.book({ patientId: PATIENT_ID, slotStartISO: SLOT_ISO, country: 'AR' }),
    ).rejects.toBeInstanceOf(SlotTakenError);
    expect(calendar.createEventWithMeet).not.toHaveBeenCalled();
  });

  it('paciente de outro país → PATIENT_NOT_FOUND', async () => {
    const { service } = makeService({
      hosts: [{ email: HOST_A, display_name: 'Ana' }],
      patientRow: { id: PATIENT_ID, country: 'BR', contact_email_encrypted: null },
      loadByEmail: {},
      busyByEmail: {},
    });

    await expect(
      service.book({ patientId: PATIENT_ID, slotStartISO: SLOT_ISO, country: 'AR' }),
    ).rejects.toBeInstanceOf(PatientNotFoundError);
  });
});
