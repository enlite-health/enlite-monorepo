import { DateTime } from 'luxon';
import {
  computeFreeSlots,
  BusyInterval,
  AR_ZONE,
} from '../AdmissionCalendarService';
import { ADMISSION_COUNTRIES, BR_HOLIDAYS_2026 } from '../../domain/admissionCountries';

// ─── Helpers ───────────────────────────────────────────────────────────────

/** Instante AR (zona Buenos Aires) → Date. */
function ar(iso: string): Date {
  return DateTime.fromISO(iso, { zone: AR_ZONE }).toJSDate();
}

/** busy [from,to) em zona AR. */
function busy(fromISO: string, toISO: string): BusyInterval {
  return { start: ar(fromISO), end: ar(toISO) };
}

/** Extrai só os startISO da lista de slots. */
function startsOf(slots: { startISO: string }[]): string[] {
  return slots.map((s) => DateTime.fromISO(s.startISO).setZone(AR_ZONE).toFormat("yyyy-MM-dd'T'HH:mm"));
}

const HOST_A = 'a@enlite.health';
const HOST_B = 'b@enlite.health';

describe('computeFreeSlots', () => {
  // Segunda-feira 2026-08-03 06:00 AR — bem antes do expediente, sem feriado por perto.
  const MONDAY_EARLY = ar('2026-08-03T06:00');

  it('(a) respeita 09-18 seg-sex (slots começam 09..17, terminam ≤18)', () => {
    const slots = computeFreeSlots({
      busyIntervalsByHost: { [HOST_A]: [] },
      now: MONDAY_EARLY,
    });
    // Todos os slots do dia da segunda: horas 9..17.
    const mondaySlots = slots
      .filter((s) => s.startISO.startsWith('2026-08-03'))
      .map((s) => DateTime.fromISO(s.startISO).setZone(AR_ZONE).hour);
    expect(mondaySlots).toEqual([9, 10, 11, 12, 13, 14, 15, 16, 17]);
    // Nenhum slot fora de 09..17.
    for (const s of slots) {
      const h = DateTime.fromISO(s.startISO).setZone(AR_ZONE).hour;
      expect(h).toBeGreaterThanOrEqual(9);
      expect(h).toBeLessThanOrEqual(17);
    }
  });

  it('(b) pula fim de semana', () => {
    const slots = computeFreeSlots({
      busyIntervalsByHost: { [HOST_A]: [] },
      now: MONDAY_EARLY,
    });
    const weekdays = new Set(
      slots.map((s) => DateTime.fromISO(s.startISO).setZone(AR_ZONE).weekday),
    );
    // 6 (sáb) e 7 (dom) nunca aparecem.
    expect(weekdays.has(6)).toBe(false);
    expect(weekdays.has(7)).toBe(false);
  });

  it('(c) corte de 2h: slot antes de now+2h não aparece', () => {
    // Agora: segunda 10:10 → earliest = 12:10. Slots 09,10,11,12 (≤12:10 start) fora; 13+ dentro.
    const now = ar('2026-08-03T10:10');
    const slots = computeFreeSlots({
      busyIntervalsByHost: { [HOST_A]: [] },
      now,
    });
    const mondayHours = slots
      .filter((s) => s.startISO.startsWith('2026-08-03'))
      .map((s) => DateTime.fromISO(s.startISO).setZone(AR_ZONE).hour);
    // 12:00 < 12:10 → fora. Primeiro slot da segunda = 13:00.
    expect(mondayHours).toEqual([13, 14, 15, 16, 17]);
    expect(mondayHours).not.toContain(12);
  });

  it('(d) dedupe entre 2 hosts: ambos livres 10h → um slot 10h com 2 hostEmails', () => {
    const slots = computeFreeSlots({
      busyIntervalsByHost: { [HOST_A]: [], [HOST_B]: [] },
      now: MONDAY_EARLY,
    });
    const tenAm = slots.find((s) => s.startISO.startsWith('2026-08-03T10:00'));
    expect(tenAm).toBeDefined();
    expect(new Set(tenAm!.hostEmails)).toEqual(new Set([HOST_A, HOST_B]));
    // Só um slot para as 10h de segunda (dedupe).
    expect(slots.filter((s) => s.startISO.startsWith('2026-08-03T10:00'))).toHaveLength(1);
  });

  it('(e) union: A livre 10h (ocupado 11h), B livre 11h (ocupado 10h) → slots 10h e 11h', () => {
    const slots = computeFreeSlots({
      busyIntervalsByHost: {
        [HOST_A]: [busy('2026-08-03T11:00', '2026-08-03T11:45')],
        [HOST_B]: [busy('2026-08-03T10:00', '2026-08-03T10:45')],
      },
      now: MONDAY_EARLY,
    });
    const ten = slots.find((s) => s.startISO.startsWith('2026-08-03T10:00'));
    const eleven = slots.find((s) => s.startISO.startsWith('2026-08-03T11:00'));
    expect(ten).toBeDefined();
    expect(ten!.hostEmails).toEqual([HOST_A]); // B ocupado 10h
    expect(eleven).toBeDefined();
    expect(eleven!.hostEmails).toEqual([HOST_B]); // A ocupado 11h
  });

  it('(f) pula feriado AR (17/08/2026 = San Martín, segunda)', () => {
    // Agora: quinta 2026-08-13 06:00 → horizonte cruza o feriado de segunda 17/08.
    const now = ar('2026-08-13T06:00');
    const slots = computeFreeSlots({
      busyIntervalsByHost: { [HOST_A]: [] },
      now,
    });
    const onHoliday = slots.filter((s) => s.startISO.startsWith('2026-08-17'));
    expect(onHoliday).toHaveLength(0);
    // Sanidade: o dia útil seguinte (terça 18/08) tem slots.
    expect(slots.some((s) => s.startISO.startsWith('2026-08-18'))).toBe(true);
  });

  it('slots ordenados por horário', () => {
    const slots = computeFreeSlots({
      busyIntervalsByHost: { [HOST_A]: [] },
      now: MONDAY_EARLY,
    });
    const iso = startsOf(slots);
    const sorted = [...iso].sort();
    expect(iso).toEqual(sorted);
  });
});

// ─── Multi-país: config BR (tz Sao_Paulo + feriado BR) ───────────────────────

describe('computeFreeSlots — config BR', () => {
  const BR_ZONE = ADMISSION_COUNTRIES.BR.timezone;

  /** Instante BR (zona Sao Paulo) → Date. */
  function br(iso: string): Date {
    return DateTime.fromISO(iso, { zone: BR_ZONE }).toJSDate();
  }

  it('usa a zona BR: slots renderizam em America/Sao_Paulo, 09..17', () => {
    // Segunda 2026-08-10 06:00 BR (sem feriado por perto).
    const now = br('2026-08-10T06:00');
    const slots = computeFreeSlots({
      busyIntervalsByHost: { [HOST_A]: [] },
      now,
      timezone: BR_ZONE,
      holidays: BR_HOLIDAYS_2026,
      businessHours: ADMISSION_COUNTRIES.BR.businessHours,
    });
    const mondayHours = slots
      .filter((s) => s.startISO.startsWith('2026-08-10'))
      .map((s) => DateTime.fromISO(s.startISO).setZone(BR_ZONE).hour);
    expect(mondayHours).toEqual([9, 10, 11, 12, 13, 14, 15, 16, 17]);
    // Confirma que o offset é o de Sao Paulo (-03:00 em agosto), não o de AR.
    expect(slots[0].startISO).toContain('-03:00');
  });

  it('pula feriado BR (07/09/2026 = Independência, segunda) mas o mesmo dia é útil em AR', () => {
    // Agora: terça 2026-09-01 06:00 BR → horizonte cruza segunda 07/09.
    const now = br('2026-09-01T06:00');
    const brSlots = computeFreeSlots({
      busyIntervalsByHost: { [HOST_A]: [] },
      now,
      timezone: BR_ZONE,
      holidays: BR_HOLIDAYS_2026,
      businessHours: ADMISSION_COUNTRIES.BR.businessHours,
    });
    expect(brSlots.filter((s) => s.startISO.startsWith('2026-09-07'))).toHaveLength(0);
    // 07/09 NÃO é feriado AR → com a config default (AR) o dia tem slots.
    const arSlots = computeFreeSlots({
      busyIntervalsByHost: { [HOST_A]: [] },
      now: DateTime.fromISO('2026-09-01T06:00', { zone: AR_ZONE }).toJSDate(),
    });
    expect(arSlots.some((s) => s.startISO.startsWith('2026-09-07'))).toBe(true);
  });
});
