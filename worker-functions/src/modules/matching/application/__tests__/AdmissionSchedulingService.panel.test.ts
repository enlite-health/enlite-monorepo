/**
 * AdmissionSchedulingService.panel.test.ts — spec 049 F3: `bookForHost` (agenda pelo PAINEL) e o código ADM nos DOIS fluxos.
 * O banco é um script por SQL (como no teste do roster); o Google é um dublê. Nada sai da máquina; dados sintéticos.
 */
const mockQuery = jest.fn();

jest.mock('@shared/database/DatabaseConnection', () => ({
  DatabaseConnection: { getInstance: jest.fn().mockReturnValue({ getPool: jest.fn().mockReturnValue({ query: mockQuery }) }) },
}));
jest.mock('@shared/logging', () => ({ logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn() } }));

import { DateTime } from 'luxon';
import type { KMSEncryptionService } from '@shared/security/KMSEncryptionService';
import {
  AdmissionSchedulingService,
  HostNotInRosterError,
  InvalidSlotError,
  PatientNotFoundError,
  SlotInPastError,
  SlotTakenError,
} from '../AdmissionSchedulingService';
import { AR_ZONE } from '../../infrastructure/AdmissionCalendarService';
import { FakeAdmissionCalendar } from '../../infrastructure/doubles/FakeAdmissionCalendar';
import type { InterviewHostRepository } from '../../infrastructure/InterviewHostRepository';
import type { AdmissionNotifier } from '../AdmissionNotifier';
import { TactiqLinkRequiredError, type TactiqLinkGate, type TactiqLinkState } from '../ports/TactiqPorts';

const CAL_AR = 'admission-ar@group.calendar.google.com';
const PATIENT_ID = '11111111-1111-1111-1111-111111111111';
const ACTOR = 'staff-uid-1';
const HOST = 'ana@example.test';
const NOW = DateTime.fromISO('2026-08-03T10:00', { zone: AR_ZONE }).toJSDate();
/** 1 h depois de "agora": o painel aceita (a antecedência de 4 h do site NÃO vale aqui). */
const SOON = '2026-08-03T11:00:00-03:00';

interface Fx {
  patientCountry?: string | null; // null = paciente inexistente
  hosts?: string[];
  insertThrows?: Array<{ code: string; constraint?: string }>;
}

function setup(fx: Fx = {}) {
  const inserts: unknown[][] = [];
  const throws = [...(fx.insertThrows ?? [])];
  mockQuery.mockImplementation(async (sql: string, params?: unknown[]) => {
    if (sql.includes('FROM patients')) {
      if (fx.patientCountry === null) return { rows: [] };
      return { rows: [{ id: PATIENT_ID, country: fx.patientCountry ?? 'AR', contact_email_encrypted: 'cipher', responsible_email_encrypted: null }] };
    }
    if (sql.includes('INSERT INTO admission_appointments')) {
      const next = throws.shift();
      if (next) throw next;
      inserts.push(params ?? []);
      return { rows: [{ id: `appt-${inserts.length}` }] };
    }
    return { rows: [] };
  });
  const calendar = new FakeAdmissionCalendar();
  const notifier = { onBooked: jest.fn(async () => undefined) } as unknown as jest.Mocked<AdmissionNotifier>;
  const encryption = { decrypt: jest.fn(async () => 'paciente@example.test') } as unknown as KMSEncryptionService;
  const hosts = { listActiveByCountry: jest.fn(async () => (fx.hosts ?? [HOST]).map((email) => ({ email, displayName: 'Ana' }))) } as unknown as InterviewHostRepository;
  const tactiqStates = new Map<string, TactiqLinkState>();
  const gate: TactiqLinkGate = {
    statesFor: jest.fn(async (emails: string[]) => new Map(emails.map((e) => [e.toLowerCase(), tactiqStates.get(e.toLowerCase()) ?? 'linked'] as const))),
  };
  const service = new AdmissionSchedulingService(calendar, notifier, encryption, 'enlite@enlite.health', hosts, gate);
  return { service, calendar, notifier, inserts, hosts, tactiqStates, gate, serviceWithoutGate: new AdmissionSchedulingService(calendar, notifier, encryption, 'enlite@enlite.health', hosts) };
}

const params = (over: Partial<{ hostEmail: string; slotStartISO: string }> = {}) => ({
  patientId: PATIENT_ID, hostEmail: HOST, slotStartISO: SOON, actorUid: ACTOR, ...over,
});

describe('AdmissionSchedulingService.bookForHost (painel)', () => {
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    jest.clearAllMocks();
    for (const k of ['ADMISSION_HOST_ROSTER_ENABLED', 'ADMISSION_CALENDAR_ID_AR']) saved[k] = process.env[k];
    process.env.ADMISSION_CALENDAR_ID_AR = CAL_AR;
    process.env.ADMISSION_HOST_ROSTER_ENABLED = 'true';
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  });

  it('A3-9: o título do evento do PAINEL termina em " · ADM-XXXXXX" e não leva dado do paciente', async () => {
    const { service, calendar } = setup();
    const out = await service.bookForHost(params(), NOW);

    const summary = calendar.created[0].summary;
    expect(summary).toMatch(/^Entrevista de admisión — EnLite Care · ADM-[0-9A-Z]{6}$/);
    expect(summary).not.toContain('Paciente');
    expect(calendar.created[0].description).not.toContain('Paciente');
    expect(summary.endsWith(out.admissionCode)).toBe(true);
  });

  it('grava created_via=panel e created_by_uid, o código no INSERT e convida responsável + família', async () => {
    const { service, calendar, inserts, notifier } = setup();
    const out = await service.bookForHost(params(), NOW);

    // $7 código, $8 created_via, $9 created_by_uid
    expect(inserts[0][6]).toBe(out.admissionCode);
    expect(inserts[0][7]).toBe('panel');
    expect(inserts[0][8]).toBe(ACTOR);
    expect(inserts[0][2]).toBe(HOST);
    expect(calendar.created[0]).toMatchObject({ calendarId: CAL_AR, coHostEmail: HOST, patientEmail: 'paciente@example.test' });
    expect(notifier.onBooked).toHaveBeenCalledTimes(1);
    expect(notifier.onBooked.mock.calls[0][0]).toMatchObject({ appointmentId: out.appointmentId, hostEmail: HOST });
  });

  it.each(['missing', 'broken', 'wrong_account', 'revoked'] as const)('A4-3: responsável com vínculo %s → TactiqLinkRequiredError, 0 INSERT, 0 evento, 0 envio', async (state) => {
    const { service, calendar, notifier, inserts, tactiqStates } = setup();
    tactiqStates.set(HOST, state);
    await expect(service.bookForHost(params(), NOW)).rejects.toBeInstanceOf(TactiqLinkRequiredError);
    expect(inserts).toHaveLength(0);
    expect(calendar.created).toHaveLength(0);
    expect(notifier.onBooked).not.toHaveBeenCalled();
  });

  it('A4-3: responsável SEM LINHA no gate (nunca vinculou) vale como missing → recusa', async () => {
    const { service, gate, inserts } = setup();
    (gate.statesFor as jest.Mock).mockResolvedValueOnce(new Map());
    await expect(service.bookForHost(params(), NOW)).rejects.toMatchObject({ code: 'TACTIQ_LINK_REQUIRED', reason: 'missing' });
    expect(inserts).toHaveLength(0);
  });

  it('sem o gate configurado o painel RECUSA (falha alta, nunca trava desligada em silêncio)', async () => {
    const { serviceWithoutGate, inserts } = setup();
    await expect(serviceWithoutGate.bookForHost(params(), NOW)).rejects.toThrow(/gate do vínculo do Tactiq/);
    expect(inserts).toHaveLength(0);
  });

  it('horário FUTURO basta: 1 h à frente passa (sem a antecedência de 4 h do site)', async () => {
    const { service } = setup();
    await expect(service.bookForHost(params(), NOW)).resolves.toMatchObject({ appointmentId: 'appt-1' });
  });

  it('horário passado → SlotInPastError, sem INSERT e sem evento', async () => {
    const { service, calendar, inserts } = setup();
    await expect(service.bookForHost(params({ slotStartISO: '2026-08-03T09:00:00-03:00' }), NOW)).rejects.toBeInstanceOf(SlotInPastError);
    expect(inserts).toHaveLength(0);
    expect(calendar.created).toHaveLength(0);
  });

  it('data inválida → InvalidSlotError', async () => {
    const { service } = setup();
    await expect(service.bookForHost(params({ slotStartISO: 'amanhã' }), NOW)).rejects.toBeInstanceOf(InvalidSlotError);
  });

  it('responsável FORA do roster ativo do país → HostNotInRosterError, nada criado', async () => {
    const { service, calendar, inserts } = setup({ hosts: ['outra@example.test'] });
    await expect(service.bookForHost(params(), NOW)).rejects.toBeInstanceOf(HostNotInRosterError);
    expect(inserts).toHaveLength(0);
    expect(calendar.created).toHaveLength(0);
  });

  it('o e-mail do responsável casa sem diferenciar caixa e grava o e-mail do roster', async () => {
    const { service, inserts } = setup();
    await service.bookForHost(params({ hostEmail: ' ANA@Example.test ' }), NOW);
    expect(inserts[0][2]).toBe(HOST);
  });

  it('A3-2: responsável OCUPADO na agenda ao vivo → SlotTakenError, 0 INSERT, 0 evento, 0 envio', async () => {
    const { service, calendar, inserts, notifier } = setup({ hosts: ['ocupado.ana@example.test'] });
    await expect(service.bookForHost(params({ hostEmail: 'ocupado.ana@example.test' }), NOW)).rejects.toBeInstanceOf(SlotTakenError);
    expect(inserts).toHaveLength(0);
    expect(calendar.created).toHaveLength(0);
    expect(notifier.onBooked).not.toHaveBeenCalled();
  });

  it('perdeu a corrida da trava UNIQUE(host_email, slot_start) → SlotTakenError, sem evento', async () => {
    const { service, calendar, notifier } = setup({ insertThrows: [{ code: '23505', constraint: 'uq_admission_appointments_host_slot_booked' }] });
    await expect(service.bookForHost(params(), NOW)).rejects.toBeInstanceOf(SlotTakenError);
    expect(calendar.created).toHaveLength(0);
    expect(notifier.onBooked).not.toHaveBeenCalled();
  });

  it('colisão do CÓDIGO ADM gera outro código e segue — não é horário perdido', async () => {
    const { service, calendar, inserts } = setup({ insertThrows: [{ code: '23505', constraint: 'uq_admission_appointments_code' }] });
    const out = await service.bookForHost(params(), NOW);
    expect(inserts).toHaveLength(1);
    expect(calendar.created).toHaveLength(1);
    expect(calendar.created[0].summary.endsWith(out.admissionCode)).toBe(true);
  });

  it('paciente inexistente (ou de outro país, escondido pela RLS) → PatientNotFoundError', async () => {
    const { service } = setup({ patientCountry: null });
    await expect(service.bookForHost(params(), NOW)).rejects.toBeInstanceOf(PatientNotFoundError);
  });

  it('país do PACIENTE manda: paciente BR usa o roster e a agenda do BR', async () => {
    process.env.ADMISSION_CALENDAR_ID_BR = 'admission-br@group.calendar.google.com';
    try {
      const { service, calendar, hosts } = setup({ patientCountry: 'BR' });
      await service.bookForHost(params({ slotStartISO: '2026-08-03T11:00:00-03:00' }), NOW);
      expect(hosts.listActiveByCountry).toHaveBeenCalledWith('BR');
      expect(calendar.created[0].calendarId).toBe('admission-br@group.calendar.google.com');
      expect(calendar.created[0].summary).toContain('Clinic');
    } finally {
      delete process.env.ADMISSION_CALENDAR_ID_BR;
    }
  });
});

describe('A3-9 — o fluxo do SITE usa o mesmo núcleo e põe o mesmo código no título', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.ADMISSION_CALENDAR_ID_AR = CAL_AR;
    process.env.ADMISSION_HOST_ROSTER_ENABLED = 'true';
  });
  afterEach(() => { delete process.env.ADMISSION_HOST_ROSTER_ENABLED; });

  it('book() (roster) → " · ADM-XXXXXX" e created_via=site sem created_by_uid', async () => {
    const { service, calendar, inserts } = setup();
    const SITE_SLOT = '2026-08-03T16:00:00-03:00'; // ≥ 4 h depois de NOW
    await service.book({ patientId: PATIENT_ID, slotStartISO: SITE_SLOT, country: 'AR' }, NOW);
    expect(calendar.created[0].summary).toMatch(/ · ADM-[0-9A-Z]{6}$/);
    expect(inserts[0][7]).toBe('site');
    expect(inserts[0][8]).toBeNull();
  });

  it('book() com a flag DESLIGADA (agenda do país) → também leva o código', async () => {
    delete process.env.ADMISSION_HOST_ROSTER_ENABLED;
    const { service, calendar, inserts } = setup();
    await service.book({ patientId: PATIENT_ID, slotStartISO: '2026-08-03T16:00:00-03:00', country: 'AR' }, NOW);
    expect(calendar.created[0].summary).toMatch(/ · ADM-[0-9A-Z]{6}$/);
    expect(calendar.created[0].coHostEmail).toBeUndefined();
    expect(inserts[0][7]).toBe('site');
  });
});
