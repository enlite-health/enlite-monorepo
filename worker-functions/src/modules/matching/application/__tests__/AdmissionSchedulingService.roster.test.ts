/**
 * AdmissionSchedulingService.roster.test.ts
 *
 * O modo novo (`ADMISSION_HOST_ROSTER_ENABLED=true`): disponibilidade pela
 * UNIÃO das agendas das atendentes, atribuição para a de semana mais leve, e a
 * atendente como participante do evento.
 *
 * Duas coisas aqui não são detalhe de implementação e sim requisito:
 *   · com a flag ausente, o comportamento tem que ser IDÊNTICO ao de hoje —
 *     é o que permite mergear numa branch que deploya produção sozinha;
 *   · o paciente nunca pode receber o nome nem o e-mail da atendente (CM1 do
 *     veredito do `lex`), em nenhuma das saídas: retorno do `book`, dado que
 *     vai para a confirmação por WhatsApp, ou título do evento.
 */

const mockQuery = jest.fn();

jest.mock('@shared/database/DatabaseConnection', () => ({
  DatabaseConnection: {
    getInstance: jest.fn().mockReturnValue({
      getPool: jest.fn().mockReturnValue({ query: mockQuery }),
    }),
  },
}));

jest.mock('@shared/logging', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn() },
}));

import { DateTime } from 'luxon';
import { logger } from '@shared/logging';
import { KMSEncryptionService } from '@shared/security/KMSEncryptionService';
import {
  ADMISSION_COUNTRIES,
  AdmissionSchedulingService,
  PatientNotFoundError,
  SlotTakenError,
} from '../AdmissionSchedulingService';
import {
  AR_ZONE,
  BusyInterval,
  CalendarBusyResult,
} from '../../infrastructure/AdmissionCalendarService';
import type { AdmissionCalendarService } from '../../infrastructure/AdmissionCalendarService';
import type {
  InterviewHost,
  InterviewHostRepository,
} from '../../infrastructure/InterviewHostRepository';
import type { AdmissionNotifier } from '../AdmissionNotifier';

const IMPERSONATE = 'enlite@enlite.health';
const CAL_AR = 'admission-ar@group.calendar.google.com';
const TEAM_AR = 'Equipo de Admisión EnLite';
const PATIENT_ID = '11111111-1111-1111-1111-111111111111';

const ANA: InterviewHost = { email: 'ana@enlite.health', displayName: 'Ana Joulie' };
const MARI: InterviewHost = { email: 'mari@enlite.health', displayName: 'Mari' };

/** Segunda 2026-08-03 14:00 AR — bem depois das 4h de antecedência de "agora". */
const SLOT_ISO = '2026-08-03T14:00:00-03:00';
/** "Agora" fixo: segunda 2026-08-03 06:00 AR. */
const NOW = DateTime.fromISO('2026-08-03T06:00', { zone: AR_ZONE }).toJSDate();

function busy(fromISO: string, toISO: string): BusyInterval {
  return {
    start: DateTime.fromISO(fromISO, { zone: AR_ZONE }).toJSDate(),
    end: DateTime.fromISO(toISO, { zone: AR_ZONE }).toJSDate(),
  };
}

interface Fixture {
  hosts?: InterviewHost[];
  /** Ocupação por e-mail de atendente; `null` = agenda ilegível (erro). */
  busyByHost?: Record<string, BusyInterval[] | null>;
  /** Ocupação da agenda do país (modo antigo). */
  countryBusy?: BusyInterval[];
  insertThrowsOnce?: { code: string } | null;
  /**
   * Ocupação devolvida SÓ no re-check (leitura de uma agenda só). Serve para
   * simular a agenda mudando entre o ranking e a hora de reservar.
   */
  busyOnRecheck?: Record<string, BusyInterval[]>;
  /** O que o KMS devolve ao decifrar o e-mail do paciente. */
  decryptsTo?: string;
  /** Fuso devolvido pela agenda; `null` = ilegível (cai no default do país). */
  calendarTimezone?: string | null;
}

function makeService(fx: Fixture) {
  let insertThrows = fx.insertThrowsOnce ?? null;
  const inserted: Record<string, unknown>[] = [];

  mockQuery.mockImplementation(async (sql: string, params?: unknown[]) => {
    if (sql.includes('FROM patients')) {
      return { rows: [{ id: PATIENT_ID, country: 'AR', contact_email_encrypted: 'cipher' }] };
    }
    if (sql.includes('INSERT INTO admission_appointments')) {
      if (insertThrows) {
        insertThrows = null; // falha só a primeira vez
        throw { code: '23505' };
      }
      inserted.push({ hostEmail: params?.[2], hostDisplayName: params?.[3] });
      return { rows: [{ id: `appt-${inserted.length}` }] };
    }
    return { rows: [] };
  });

  const getFreeBusyByCalendar = jest.fn(
    async (ids: string[]): Promise<CalendarBusyResult[]> =>
      ids.map((calendarId) => {
        const isRecheck = ids.length === 1 && fx.busyOnRecheck !== undefined;
        if (isRecheck) return { calendarId, busy: fx.busyOnRecheck?.[calendarId] ?? [] };
        const entry = fx.busyByHost?.[calendarId];
        if (entry === null) return { calendarId, busy: [], error: 'notFound' };
        return { calendarId, busy: entry ?? [] };
      }),
  );

  const calendar = {
    getCalendarTimezone: jest.fn(async () =>
      fx.calendarTimezone === undefined ? AR_ZONE : fx.calendarTimezone,
    ),
    getBusyIntervals: jest.fn(async () => fx.countryBusy ?? []),
    getFreeBusyByCalendar,
    createEventWithMeet: jest.fn(async () => ({
      eventId: 'evt-1',
      meetLink: 'https://meet.google.com/abc-defg-hij',
    })),
  } as unknown as jest.Mocked<AdmissionCalendarService>;

  const notifier = { onBooked: jest.fn(async () => undefined) } as unknown as jest.Mocked<AdmissionNotifier>;
  const encryption = {
    decrypt: jest.fn(async () => fx.decryptsTo ?? 'paciente@example.com'),
  } as unknown as KMSEncryptionService;
  const hosts = {
    listActiveByCountry: jest.fn(async () => fx.hosts ?? []),
  } as unknown as jest.Mocked<InterviewHostRepository>;

  const service = new AdmissionSchedulingService(
    calendar,
    notifier,
    encryption,
    IMPERSONATE,
    hosts,
  );

  return { service, calendar, notifier, hosts, inserted };
}

describe('AdmissionSchedulingService — roster', () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    jest.clearAllMocks();
    for (const k of ['ADMISSION_HOST_ROSTER_ENABLED', 'ADMISSION_CALENDAR_ID_AR']) {
      savedEnv[k] = process.env[k];
    }
    process.env.ADMISSION_CALENDAR_ID_AR = CAL_AR;
    process.env.ADMISSION_HOST_ROSTER_ENABLED = 'true';
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('constrói com as dependências padrão (é assim que o singleton nasce em produção)', () => {
    expect(new AdmissionSchedulingService()).toBeInstanceOf(AdmissionSchedulingService);
  });

  it('re-exporta a config de países para quem monta o wiring por env', () => {
    expect(Object.keys(ADMISSION_COUNTRIES).sort()).toEqual(['AR', 'BR']);
  });

  // ── Flag desligada: produção não pode sentir o merge ──────────────────────

  describe('flag ausente = comportamento de hoje', () => {
    it('lê a agenda do PAÍS e não toca em interview_hosts nem no freeBusy', async () => {
      delete process.env.ADMISSION_HOST_ROSTER_ENABLED;
      const { service, calendar, hosts } = makeService({ countryBusy: [] });

      const slots = await service.getAvailableSlots('AR', NOW);

      expect(calendar.getBusyIntervals).toHaveBeenCalledWith(
        CAL_AR,
        IMPERSONATE,
        expect.any(String),
        expect.any(String),
        AR_ZONE,
      );
      expect(calendar.getFreeBusyByCalendar).not.toHaveBeenCalled();
      expect(hosts.listActiveByCountry).not.toHaveBeenCalled();
      expect(slots.length).toBeGreaterThan(0);
    });

    it('mantém a grade de 45min e 2h de antecedência (primeiro slot às 08:00 + 2h)', async () => {
      delete process.env.ADMISSION_HOST_ROSTER_ENABLED;
      const { service } = makeService({ countryBusy: [] });

      const slots = await service.getAvailableSlots('AR', NOW);
      const firstMonday = slots.find((s) => s.startISO.startsWith('2026-08-03'));

      // 06:00 + 2h = 08:00 → o primeiro do expediente (09:00) segue oferecido.
      expect(DateTime.fromISO(firstMonday!.startISO).setZone(AR_ZONE).hour).toBe(9);
    });

    it('book segue reservando na agenda do país, sem participante nenhum', async () => {
      delete process.env.ADMISSION_HOST_ROSTER_ENABLED;
      const { service, calendar, inserted } = makeService({ countryBusy: [] });

      const out = await service.book({ patientId: PATIENT_ID, slotStartISO: SLOT_ISO, country: 'AR' }, NOW);

      expect(inserted[0].hostEmail).toBe(CAL_AR);
      const arg = calendar.createEventWithMeet.mock.calls[0][0];
      expect(arg).not.toHaveProperty('coHostEmail'); // ninguém atrelado, como hoje
      expect(arg.endISO).toContain('14:45'); // e a entrevista segue com 45min
      expect(out.hostDisplayName).toBe(TEAM_AR);
    });

    it('corrida perdida na trava → SLOT_TAKEN (no modo antigo não há próxima)', async () => {
      delete process.env.ADMISSION_HOST_ROSTER_ENABLED;
      const { service, calendar } = makeService({
        countryBusy: [],
        insertThrowsOnce: { code: '23505' },
      });

      await expect(
        service.book({ patientId: PATIENT_ID, slotStartISO: SLOT_ISO, country: 'AR' }, NOW),
      ).rejects.toBeInstanceOf(SlotTakenError);
      expect(calendar.createEventWithMeet).not.toHaveBeenCalled();
    });

    it('erro de banco que não é violação de unicidade sobe (modo antigo)', async () => {
      delete process.env.ADMISSION_HOST_ROSTER_ENABLED;
      const { service } = makeService({ countryBusy: [] });
      mockQuery.mockImplementation(async (sql: string) => {
        if (sql.includes('FROM patients')) {
          return { rows: [{ id: PATIENT_ID, country: 'AR', contact_email_encrypted: null }] };
        }
        if (sql.includes('INSERT INTO')) throw new Error('disco cheio');
        return { rows: [] };
      });

      await expect(
        service.book({ patientId: PATIENT_ID, slotStartISO: SLOT_ISO, country: 'AR' }, NOW),
      ).rejects.toThrow('disco cheio');
    });

    it('agenda do país ocupada no horário → SLOT_TAKEN', async () => {
      delete process.env.ADMISSION_HOST_ROSTER_ENABLED;
      const { service, calendar } = makeService({
        countryBusy: [busy('2026-08-03T14:00', '2026-08-03T15:00')],
      });

      await expect(
        service.book({ patientId: PATIENT_ID, slotStartISO: SLOT_ISO, country: 'AR' }, NOW),
      ).rejects.toBeInstanceOf(SlotTakenError);
      expect(calendar.createEventWithMeet).not.toHaveBeenCalled();
    });
  });

  describe('entradas e estados de borda', () => {
    it('paciente inexistente → PATIENT_NOT_FOUND com a mensagem padrão', async () => {
      const { service } = makeService({ hosts: [ANA], busyByHost: {} });
      mockQuery.mockImplementation(async () => ({ rows: [] }));

      await expect(
        service.book({ patientId: PATIENT_ID, slotStartISO: SLOT_ISO, country: 'AR' }, NOW),
      ).rejects.toMatchObject({ code: 'PATIENT_NOT_FOUND', message: 'Patient not found' });
      expect(new PatientNotFoundError()).toBeInstanceOf(Error);
    });

    it('horário ilegível no pedido → erro explícito, não SLOT_TAKEN mudo', async () => {
      const { service } = makeService({ hosts: [ANA], busyByHost: {} });
      await expect(
        service.book({ patientId: PATIENT_ID, slotStartISO: 'não-é-data', country: 'AR' }, NOW),
      ).rejects.toThrow(/Invalid slotStartISO/);
    });

    it('e-mail do paciente em branco não vira convidado vazio no evento', async () => {
      const { service, calendar } = makeService({
        hosts: [ANA],
        busyByHost: {},
        decryptsTo: '   ',
      });

      await service.book({ patientId: PATIENT_ID, slotStartISO: SLOT_ISO, country: 'AR' }, NOW);

      expect(calendar.createEventWithMeet.mock.calls[0][0].patientEmail).toBeUndefined();
    });

    it('re-check que não devolve resposta nenhuma não reserva', async () => {
      const { service, calendar } = makeService({
        hosts: [ANA, MARI],
        busyByHost: { [ANA.email]: [], [MARI.email]: [] },
      });
      (calendar.getFreeBusyByCalendar as jest.Mock).mockImplementation(async (ids: string[]) =>
        ids.length === 1 ? [] : ids.map((calendarId) => ({ calendarId, busy: [] })),
      );

      await expect(
        service.book({ patientId: PATIENT_ID, slotStartISO: SLOT_ISO, country: 'AR' }, NOW),
      ).rejects.toBeInstanceOf(SlotTakenError);
      expect(calendar.createEventWithMeet).not.toHaveBeenCalled();
    });

    it('getAvailableSlots sem "agora" explícito usa o relógio do processo', async () => {
      const { service } = makeService({ hosts: [ANA], busyByHost: {} });
      await expect(service.getAvailableSlots('AR')).resolves.toEqual(expect.any(Array));
    });
  });

  describe('configuração incompleta', () => {
    it('sem a env da agenda do país, o BOOK falha alto em vez de agendar no vazio', async () => {
      delete process.env.ADMISSION_CALENDAR_ID_AR;
      const { service } = makeService({ hosts: [ANA], busyByHost: {} });
      await expect(
        service.book({ patientId: PATIENT_ID, slotStartISO: SLOT_ISO, country: 'AR' }, NOW),
      ).rejects.toThrow(/missing env ADMISSION_CALENDAR_ID_AR/);
    });

    it('sem a env da agenda E sem atendente, a LISTAGEM devolve vazio — não 500', async () => {
      // A tela pública é de paciente: país ainda sem configurar tem que dizer
      // "não há horários", não explodir. O e2e completo pegou isto.
      delete process.env.ADMISSION_CALENDAR_ID_AR;
      const { service } = makeService({ hosts: [] });
      await expect(service.getAvailableSlots('AR', NOW)).resolves.toEqual([]);
    });
  });

  // ── Disponibilidade pela união das agendas ────────────────────────────────

  describe('getAvailableSlots', () => {
    it('lê as agendas das atendentes ativas do país numa requisição só', async () => {
      const { service, calendar, hosts } = makeService({ hosts: [ANA, MARI], busyByHost: {} });

      await service.getAvailableSlots('AR', NOW);

      expect(hosts.listActiveByCountry).toHaveBeenCalledWith('AR');
      expect(calendar.getFreeBusyByCalendar).toHaveBeenCalledTimes(1);
      expect(calendar.getFreeBusyByCalendar).toHaveBeenCalledWith(
        [ANA.email, MARI.email],
        IMPERSONATE,
        expect.any(String),
        expect.any(String),
        AR_ZONE,
      );
      expect(calendar.getBusyIntervals).not.toHaveBeenCalled();
    });

    it('nenhuma atendente ativa → zero horários, sem erro', async () => {
      const { service } = makeService({ hosts: [] });
      await expect(service.getAvailableSlots('AR', NOW)).resolves.toEqual([]);
      expect(logger.warn).toHaveBeenCalled();
    });

    it('agenda ilegível fica FORA do cálculo (fail-closed) e o erro é registrado', async () => {
      const { service } = makeService({
        hosts: [ANA, MARI],
        busyByHost: {
          [ANA.email]: null, // ilegível
          [MARI.email]: [busy('2026-08-03T14:00', '2026-08-03T15:00')],
        },
      });

      const slots = await service.getAvailableSlots('AR', NOW);
      const at14 = slots.filter((s) => s.startISO.startsWith('2026-08-03T14:'));

      // Se a agenda ilegível tivesse virado "livre", as 14:00 apareceriam.
      expect(at14).toEqual([]);
      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({ calendarId: ANA.email, reason: 'notFound' }),
        expect.stringContaining('fail-closed'),
      );
    });

    it('todas as agendas ilegíveis → zero horários, sem erro', async () => {
      const { service } = makeService({
        hosts: [ANA, MARI],
        busyByHost: { [ANA.email]: null, [MARI.email]: null },
      });
      await expect(service.getAvailableSlots('AR', NOW)).resolves.toEqual([]);
    });

    it('devolve só horário e rótulo — nunca quem está livre', async () => {
      const { service } = makeService({ hosts: [ANA, MARI], busyByHost: {} });
      const slots = await service.getAvailableSlots('AR', NOW);
      expect(Object.keys(slots[0]).sort()).toEqual(['label', 'startISO']);
      expect(JSON.stringify(slots)).not.toContain('ana@');
      expect(JSON.stringify(slots)).not.toContain('Ana');
    });
  });

  // ── Atribuição ────────────────────────────────────────────────────────────

  describe('book — atribuição', () => {
    it('entre duas livres, escolhe a de semana mais leve', async () => {
      const { service, inserted } = makeService({
        hosts: [ANA, MARI],
        busyByHost: {
          // Ana: 6h de expediente ocupadas na semana.
          [ANA.email]: [busy('2026-08-05T09:00', '2026-08-05T15:00')],
          // Mari: 2h.
          [MARI.email]: [busy('2026-08-05T09:00', '2026-08-05T11:00')],
        },
      });

      await service.book({ patientId: PATIENT_ID, slotStartISO: SLOT_ISO, country: 'AR' }, NOW);

      expect(inserted[0].hostEmail).toBe(MARI.email);
    });

    it('empate resolve por e-mail ascendente, e repete a mesma escolha', async () => {
      for (let i = 0; i < 3; i += 1) {
        const { service, inserted } = makeService({
          hosts: [MARI, ANA], // ordem invertida de propósito
          busyByHost: {
            [ANA.email]: [busy('2026-08-05T09:00', '2026-08-05T11:00')],
            [MARI.email]: [busy('2026-08-06T09:00', '2026-08-06T11:00')],
          },
        });
        await service.book({ patientId: PATIENT_ID, slotStartISO: SLOT_ISO, country: 'AR' }, NOW);
        expect(inserted[0].hostEmail).toBe(ANA.email); // ana@ < mari@
      }
    });

    it('quem está ocupada no horário não é candidata, mesmo com a semana vazia', async () => {
      const { service, inserted } = makeService({
        hosts: [ANA, MARI],
        busyByHost: {
          [ANA.email]: [busy('2026-08-03T14:00', '2026-08-03T15:00')], // ocupada no slot
          [MARI.email]: [busy('2026-08-05T09:00', '2026-08-05T17:00')], // semana cheia, livre no slot
        },
      });

      await service.book({ patientId: PATIENT_ID, slotStartISO: SLOT_ISO, country: 'AR' }, NOW);

      expect(inserted[0].hostEmail).toBe(MARI.email);
    });

    it('todas ocupadas no horário → SLOT_TAKEN e nenhum evento criado', async () => {
      const { service, calendar } = makeService({
        hosts: [ANA, MARI],
        busyByHost: {
          [ANA.email]: [busy('2026-08-03T14:00', '2026-08-03T15:00')],
          [MARI.email]: [busy('2026-08-03T14:00', '2026-08-03T15:00')],
        },
      });

      await expect(
        service.book({ patientId: PATIENT_ID, slotStartISO: SLOT_ISO, country: 'AR' }, NOW),
      ).rejects.toBeInstanceOf(SlotTakenError);
      expect(calendar.createEventWithMeet).not.toHaveBeenCalled();
    });

    it('roster vazio → SLOT_TAKEN, sem evento', async () => {
      const { service, calendar } = makeService({ hosts: [] });
      await expect(
        service.book({ patientId: PATIENT_ID, slotStartISO: SLOT_ISO, country: 'AR' }, NOW),
      ).rejects.toBeInstanceOf(SlotTakenError);
      expect(calendar.createEventWithMeet).not.toHaveBeenCalled();
    });

    it('corrida perdida na trava do banco → tenta a próxima candidata', async () => {
      const { service, calendar, inserted } = makeService({
        hosts: [ANA, MARI],
        busyByHost: {
          [ANA.email]: [busy('2026-08-05T09:00', '2026-08-05T11:00')], // mais leve → tentada 1º
          [MARI.email]: [busy('2026-08-05T09:00', '2026-08-05T15:00')],
        },
        insertThrowsOnce: { code: '23505' },
      });

      await service.book({ patientId: PATIENT_ID, slotStartISO: SLOT_ISO, country: 'AR' }, NOW);

      expect(inserted[0].hostEmail).toBe(MARI.email);
      expect(calendar.createEventWithMeet).toHaveBeenCalledTimes(1);
    });

    it('candidata que ficou ocupada entre o ranking e a reserva é pulada', async () => {
      const { service, inserted } = makeService({
        hosts: [ANA, MARI],
        busyByHost: {
          [ANA.email]: [busy('2026-08-05T09:00', '2026-08-05T11:00')], // mais leve → 1ª
          [MARI.email]: [busy('2026-08-05T09:00', '2026-08-05T15:00')],
        },
        // No re-check, a agenda da Ana já tem o horário ocupado.
        busyOnRecheck: { [ANA.email]: [busy('2026-08-03T14:00', '2026-08-03T15:00')] },
      });

      await service.book({ patientId: PATIENT_ID, slotStartISO: SLOT_ISO, country: 'AR' }, NOW);

      expect(inserted[0].hostEmail).toBe(MARI.email);
    });

    it('todas ficaram ocupadas no re-check → SLOT_TAKEN, sem evento', async () => {
      const ocupada = [busy('2026-08-03T14:00', '2026-08-03T15:00')];
      const { service, calendar } = makeService({
        hosts: [ANA, MARI],
        busyByHost: { [ANA.email]: [], [MARI.email]: [] },
        busyOnRecheck: { [ANA.email]: ocupada, [MARI.email]: ocupada },
      });

      await expect(
        service.book({ patientId: PATIENT_ID, slotStartISO: SLOT_ISO, country: 'AR' }, NOW),
      ).rejects.toBeInstanceOf(SlotTakenError);
      expect(calendar.createEventWithMeet).not.toHaveBeenCalled();
    });

    it('agenda que fica ilegível no re-check não é reservada', async () => {
      const { service, calendar } = makeService({ hosts: [ANA], busyByHost: { [ANA.email]: [] } });
      (calendar.getFreeBusyByCalendar as jest.Mock).mockImplementation(async (ids: string[]) =>
        ids.map((calendarId) => ({
          calendarId,
          busy: [],
          ...(ids.length === 1 ? { error: 'notFound' } : {}),
        })),
      );

      await expect(
        service.book({ patientId: PATIENT_ID, slotStartISO: SLOT_ISO, country: 'AR' }, NOW),
      ).rejects.toBeInstanceOf(SlotTakenError);
      expect(calendar.createEventWithMeet).not.toHaveBeenCalled();
    });

    it('erro de banco que não é violação de unicidade sobe', async () => {
      const { service } = makeService({ hosts: [ANA], busyByHost: {}, insertThrowsOnce: null });
      mockQuery.mockImplementation(async (sql: string) => {
        if (sql.includes('FROM patients')) {
          return { rows: [{ id: PATIENT_ID, country: 'AR', contact_email_encrypted: null }] };
        }
        if (sql.includes('INSERT INTO')) throw new Error('connection reset');
        return { rows: [] };
      });

      await expect(
        service.book({ patientId: PATIENT_ID, slotStartISO: SLOT_ISO, country: 'AR' }, NOW),
      ).rejects.toThrow('connection reset');
    });
  });

  // ── Antecedência mínima na ESCRITA ────────────────────────────────────────

  describe('book — antecedência de 4h', () => {
    it('pedido dentro da janela é recusado, sem tocar em agenda nem em banco', async () => {
      const { service, calendar, inserted } = makeService({ hosts: [ANA], busyByHost: {} });
      const emDuasHoras = DateTime.fromJSDate(NOW, { zone: AR_ZONE })
        .plus({ hours: 2 })
        .toISO() as string;

      await expect(
        service.book({ patientId: PATIENT_ID, slotStartISO: emDuasHoras, country: 'AR' }, NOW),
      ).rejects.toBeInstanceOf(SlotTakenError);

      expect(calendar.createEventWithMeet).not.toHaveBeenCalled();
      expect(inserted).toHaveLength(0);
    });

    it('pedido fora da janela passa', async () => {
      const { service } = makeService({ hosts: [ANA], busyByHost: {} });
      const emSeisHoras = DateTime.fromJSDate(NOW, { zone: AR_ZONE })
        .plus({ hours: 6 })
        .toISO() as string;

      await expect(
        service.book({ patientId: PATIENT_ID, slotStartISO: emSeisHoras, country: 'AR' }, NOW),
      ).resolves.toMatchObject({ hostDisplayName: TEAM_AR });
    });
  });

  // ── CM1: a identidade da atendente não sai daqui ──────────────────────────

  describe('a atendente entra no compromisso, mas o paciente não a vê', () => {
    it('vai como participante do evento, com a lista de convidados escondida', async () => {
      const { service, calendar } = makeService({ hosts: [ANA], busyByHost: {} });

      await service.book({ patientId: PATIENT_ID, slotStartISO: SLOT_ISO, country: 'AR' }, NOW);

      expect(calendar.createEventWithMeet).toHaveBeenCalledWith(
        expect.objectContaining({
          calendarId: CAL_AR,
          impersonateEmail: IMPERSONATE,
          coHostEmail: ANA.email,
          patientEmail: 'paciente@example.com',
          // O título nomeia a LINHA (Care/Clinic), nunca a pessoa.
          summary: 'Entrevista de admisión — EnLite Care',
        }),
      );
    });

    it('o retorno do book e o aviso ao paciente nomeiam a EQUIPE, nunca a pessoa', async () => {
      const { service, notifier, inserted } = makeService({ hosts: [ANA], busyByHost: {} });

      const out = await service.book(
        { patientId: PATIENT_ID, slotStartISO: SLOT_ISO, country: 'AR' },
        NOW,
      );

      // O que volta para o endpoint público.
      expect(out.hostDisplayName).toBe(TEAM_AR);
      expect(JSON.stringify(out)).not.toContain('Ana');
      expect(JSON.stringify(out)).not.toContain('ana@');

      // O que alimenta a variável {{2}} do template de WhatsApp.
      const payload = notifier.onBooked.mock.calls[0][0];
      expect(payload.hostDisplayName).toBe(TEAM_AR);

      // ...e o que fica gravado como nome no banco.
      expect(inserted[0].hostDisplayName).toBe(TEAM_AR);
      // O e-mail da atendente fica só no host_email, que é interno.
      expect(inserted[0].hostEmail).toBe(ANA.email);
    });
  });
});

// ── Fuso vem da agenda do Google, não de constante no código ────────────────

describe('AdmissionSchedulingService — fuso da agenda', () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    jest.clearAllMocks();
    for (const k of ['ADMISSION_HOST_ROSTER_ENABLED', 'ADMISSION_CALENDAR_ID_AR', 'ADMISSION_CALENDAR_ID_BR']) {
      savedEnv[k] = process.env[k];
    }
    process.env.ADMISSION_CALENDAR_ID_AR = CAL_AR;
    process.env.ADMISSION_CALENDAR_ID_BR = 'admission-br@group.calendar.google.com';
    process.env.ADMISSION_HOST_ROSTER_ENABLED = 'true';
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('pergunta o fuso para a agenda do país, impersonando o dono', async () => {
    const { service, calendar } = makeService({ hosts: [ANA], busyByHost: {} });

    await service.getAvailableSlots('AR', NOW);

    expect(calendar.getCalendarTimezone).toHaveBeenCalledWith(CAL_AR, IMPERSONATE);
  });

  it('a grade segue o fuso da AGENDA, não a constante do país', async () => {
    // Agenda do Brasil configurada em Manaus (UTC-4) em vez de São Paulo (-03).
    const { service } = makeService({
      hosts: [ANA],
      busyByHost: {},
      calendarTimezone: 'America/Manaus',
    });

    const slots = await service.getAvailableSlots('BR', NOW);

    // Os horários saem com o offset de Manaus; se viesse da constante do país
    // (America/Sao_Paulo) seria -03:00.
    expect(slots[0].startISO).toContain('-04:00');
  });

  it('fuso ilegível cai no default do país e AVISA — não derruba a página', async () => {
    const { service } = makeService({
      hosts: [ANA],
      busyByHost: {},
      calendarTimezone: null,
    });

    const slots = await service.getAvailableSlots('AR', NOW);

    expect(slots[0].startISO).toContain('-03:00'); // Buenos Aires, o default
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ country: 'AR', fallback: AR_ZONE }),
      expect.stringContaining('fuso'),
    );
  });

  it('erro ao ler o fuso também cai no default, sem propagar', async () => {
    const { service, calendar } = makeService({ hosts: [ANA], busyByHost: {} });
    (calendar.getCalendarTimezone as jest.Mock).mockRejectedValue(new Error('rede caiu'));

    await expect(service.getAvailableSlots('AR', NOW)).resolves.toEqual(expect.any(Array));
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ erro: 'rede caiu' }),
      expect.stringContaining('fuso'),
    );
  });
});

// ── Título do evento distingue as duas frentes ───────────────────────────────

describe('AdmissionSchedulingService — título do evento', () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    jest.clearAllMocks();
    for (const k of ['ADMISSION_HOST_ROSTER_ENABLED', 'ADMISSION_CALENDAR_ID_AR']) {
      savedEnv[k] = process.env[k];
    }
    process.env.ADMISSION_CALENDAR_ID_AR = CAL_AR;
    process.env.ADMISSION_HOST_ROSTER_ENABLED = 'true';
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('AR sai como Care no título, e o paciente segue lendo o nome da EQUIPE', async () => {
    const { service, calendar, notifier } = makeService({ hosts: [ANA], busyByHost: {} });

    const out = await service.book(
      { patientId: PATIENT_ID, slotStartISO: SLOT_ISO, country: 'AR' },
      NOW,
    );

    expect(calendar.createEventWithMeet.mock.calls[0][0].summary).toBe(
      'Entrevista de admisión — EnLite Care',
    );
    // A linha NÃO vaza para a confirmação do paciente, que é por equipe.
    expect(out.hostDisplayName).toBe(TEAM_AR);
    expect(notifier.onBooked.mock.calls[0][0].hostDisplayName).toBe(TEAM_AR);
    // ...e continua sem nome de pessoa.
    expect(calendar.createEventWithMeet.mock.calls[0][0].summary).not.toContain('Ana');
  });

  it('o modo antigo também ganha a linha no título', async () => {
    delete process.env.ADMISSION_HOST_ROSTER_ENABLED;
    const { service, calendar } = makeService({ countryBusy: [] });

    await service.book({ patientId: PATIENT_ID, slotStartISO: SLOT_ISO, country: 'AR' }, NOW);

    expect(calendar.createEventWithMeet.mock.calls[0][0].summary).toBe(
      'Entrevista de admisión — EnLite Care',
    );
  });
});

// ── Trilha de auditoria da atribuição ────────────────────────────────────────

describe('AdmissionSchedulingService — log de auditoria', () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    jest.clearAllMocks();
    for (const k of ['ADMISSION_HOST_ROSTER_ENABLED', 'ADMISSION_CALENDAR_ID_AR']) {
      savedEnv[k] = process.env[k];
    }
    process.env.ADMISSION_CALENDAR_ID_AR = CAL_AR;
    process.env.ADMISSION_HOST_ROSTER_ENABLED = 'true';
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('registra a REGRA, o modo e quantas candidatas — costurado por appointmentId', async () => {
    const { service } = makeService({
      hosts: [ANA, MARI],
      busyByHost: {
        [ANA.email]: [busy('2026-08-05T09:00', '2026-08-05T11:00')],
        [MARI.email]: [busy('2026-08-05T09:00', '2026-08-05T15:00')],
      },
    });

    await service.book({ patientId: PATIENT_ID, slotStartISO: SLOT_ISO, country: 'AR' }, NOW);

    expect(logger.info).toHaveBeenCalledWith(
      {
        country: 'AR',
        appointmentId: 'appt-1',
        mode: 'roster',
        candidatesConsidered: 2,
        attemptsBeforeSuccess: 0,
        rule: 'least_busy_week_then_email_asc',
      },
      '[admission] entrevista atribuída',
    );
  });

  it('NÃO registra e-mail de atendente nem carga — auditoria, não monitoramento', async () => {
    const { service } = makeService({
      hosts: [ANA, MARI],
      busyByHost: { [ANA.email]: [busy('2026-08-05T09:00', '2026-08-05T15:00')], [MARI.email]: [] },
    });

    await service.book({ patientId: PATIENT_ID, slotStartISO: SLOT_ISO, country: 'AR' }, NOW);

    const registrado = JSON.stringify((logger.info as jest.Mock).mock.calls);
    expect(registrado).not.toContain('@enlite.health');
    expect(registrado).not.toContain('busyMinutes');
    expect(registrado).not.toMatch(/\b360\b/); // 6h em minutos
  });

  it('conta a tentativa quando a primeira candidata perde a corrida', async () => {
    const { service } = makeService({
      hosts: [ANA, MARI],
      busyByHost: {
        [ANA.email]: [busy('2026-08-05T09:00', '2026-08-05T11:00')],
        [MARI.email]: [busy('2026-08-05T09:00', '2026-08-05T15:00')],
      },
      insertThrowsOnce: { code: '23505' },
    });

    await service.book({ patientId: PATIENT_ID, slotStartISO: SLOT_ISO, country: 'AR' }, NOW);

    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ attemptsBeforeSuccess: 1, candidatesConsidered: 2 }),
      '[admission] entrevista atribuída',
    );
  });

  it('o modo antigo também deixa trilha, com a regra dele', async () => {
    delete process.env.ADMISSION_HOST_ROSTER_ENABLED;
    const { service } = makeService({ countryBusy: [] });

    await service.book({ patientId: PATIENT_ID, slotStartISO: SLOT_ISO, country: 'AR' }, NOW);

    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'country_calendar', rule: 'single_country_calendar' }),
      '[admission] entrevista atribuída',
    );
  });
});
