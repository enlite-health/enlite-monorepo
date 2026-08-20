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

/**
 * Fonte ÚNICA de disponibilidade — é como o modo antigo (flag OFF) chama a
 * função: uma entrada só, a agenda de admissão do país. Estes testes seguem
 * valendo palavra por palavra depois da mudança para união justamente porque
 * união de um conjunto unitário é o mesmo que capacidade 1.
 */
const SOLE = 'agenda-admissao-do-pais';

/** Extrai só os startISO da lista de slots. */
function startsOf(slots: { startISO: string }[]): string[] {
  return slots.map((s) => DateTime.fromISO(s.startISO).setZone(AR_ZONE).toFormat("yyyy-MM-dd'T'HH:mm"));
}

describe('computeFreeSlots', () => {
  // Segunda-feira 2026-08-03 06:00 AR — bem antes do expediente, sem feriado por perto.
  const MONDAY_EARLY = ar('2026-08-03T06:00');

  it('(a) respeita 09-18 seg-sex (slots começam 09..17, terminam ≤18)', () => {
    const slots = computeFreeSlots({
      busyIntervalsByHost: { [SOLE]: [] },
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
      busyIntervalsByHost: { [SOLE]: [] },
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
      busyIntervalsByHost: { [SOLE]: [] },
      now,
    });
    const mondayHours = slots
      .filter((s) => s.startISO.startsWith('2026-08-03'))
      .map((s) => DateTime.fromISO(s.startISO).setZone(AR_ZONE).hour);
    // 12:00 < 12:10 → fora. Primeiro slot da segunda = 13:00.
    expect(mondayHours).toEqual([13, 14, 15, 16, 17]);
    expect(mondayHours).not.toContain(12);
  });

  it('(d) capacidade 1: um evento na agenda de admissão ocupa o slot correspondente', () => {
    // Um evento 10:00–10:45 → o slot das 10h some; os demais do dia continuam.
    const slots = computeFreeSlots({
      busyIntervalsByHost: { [SOLE]: [busy('2026-08-03T10:00', '2026-08-03T10:45')] },
      now: MONDAY_EARLY,
    });
    const mondayHours = slots
      .filter((s) => s.startISO.startsWith('2026-08-03'))
      .map((s) => DateTime.fromISO(s.startISO).setZone(AR_ZONE).hour);
    expect(mondayHours).not.toContain(10);
    expect(mondayHours).toEqual([9, 11, 12, 13, 14, 15, 16, 17]);
  });

  it('(e) vários eventos bloqueiam vários slots (só a agenda importa, sem roster)', () => {
    const slots = computeFreeSlots({
      busyIntervalsByHost: {
        [SOLE]: [
          busy('2026-08-03T10:00', '2026-08-03T10:45'),
          busy('2026-08-03T11:00', '2026-08-03T11:45'),
        ],
      },
      now: MONDAY_EARLY,
    });
    const mondayHours = slots
      .filter((s) => s.startISO.startsWith('2026-08-03'))
      .map((s) => DateTime.fromISO(s.startISO).setZone(AR_ZONE).hour);
    expect(mondayHours).not.toContain(10);
    expect(mondayHours).not.toContain(11);
    expect(mondayHours).toEqual([9, 12, 13, 14, 15, 16, 17]);
  });

  it('(f) pula feriado AR (17/08/2026 = San Martín, segunda)', () => {
    // Agora: quinta 2026-08-13 06:00 → horizonte cruza o feriado de segunda 17/08.
    const now = ar('2026-08-13T06:00');
    const slots = computeFreeSlots({
      busyIntervalsByHost: { [SOLE]: [] },
      now,
    });
    const onHoliday = slots.filter((s) => s.startISO.startsWith('2026-08-17'));
    expect(onHoliday).toHaveLength(0);
    // Sanidade: o dia útil seguinte (terça 18/08) tem slots.
    expect(slots.some((s) => s.startISO.startsWith('2026-08-18'))).toBe(true);
  });

  it('slots ordenados por horário', () => {
    const slots = computeFreeSlots({
      busyIntervalsByHost: { [SOLE]: [] },
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
      busyIntervalsByHost: { [SOLE]: [] },
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
      busyIntervalsByHost: { [SOLE]: [] },
      now,
      timezone: BR_ZONE,
      holidays: BR_HOLIDAYS_2026,
      businessHours: ADMISSION_COUNTRIES.BR.businessHours,
    });
    expect(brSlots.filter((s) => s.startISO.startsWith('2026-09-07'))).toHaveLength(0);
    // 07/09 NÃO é feriado AR → com a config default (AR) o dia tem slots.
    const arSlots = computeFreeSlots({
      busyIntervalsByHost: { [SOLE]: [] },
      now: DateTime.fromISO('2026-09-01T06:00', { zone: AR_ZONE }).toJSDate(),
    });
    expect(arSlots.some((s) => s.startISO.startsWith('2026-09-07'))).toBe(true);
  });
});

// ─── Roster: união das agendas + 60min / 4h (change agenda-admissao-atendentes) ──

describe('computeFreeSlots — união das agendas das atendentes', () => {
  const ANA = 'ana@enlite.health';
  const MARI = 'mari@enlite.health';

  // Segunda 2026-08-03 06:00 AR — antes do expediente, sem feriado por perto.
  const MONDAY_EARLY = ar('2026-08-03T06:00');
  const ROSTER = { slotMinutes: 60, minLeadMinutes: 240 };

  /** Horas dos slots oferecidos na segunda 03/08. */
  function mondayHours(slots: { startISO: string }[]): number[] {
    return slots
      .filter((s) => s.startISO.startsWith('2026-08-03'))
      .map((s) => DateTime.fromISO(s.startISO).setZone(AR_ZONE).hour);
  }

  it('horário ocupado na agenda da ÚNICA atendente não é oferecido', () => {
    const slots = computeFreeSlots({
      busyIntervalsByHost: { [ANA]: [busy('2026-08-03T10:00', '2026-08-03T11:00')] },
      now: MONDAY_EARLY,
      ...ROSTER,
    });
    expect(mondayHours(slots)).not.toContain(10);
    expect(mondayHours(slots)).toContain(11);
  });

  it('basta UMA livre: o horário aparece, uma vez só, sem dizer de quem é', () => {
    const slots = computeFreeSlots({
      busyIntervalsByHost: {
        [ANA]: [busy('2026-08-03T14:00', '2026-08-03T15:00')],
        [MARI]: [],
      },
      now: MONDAY_EARLY,
      ...ROSTER,
    });
    const at14 = slots.filter(
      (s) => DateTime.fromISO(s.startISO).setZone(AR_ZONE).toFormat('yyyy-MM-dd HH') === '2026-08-03 14',
    );
    expect(at14).toHaveLength(1);
    expect(Object.keys(at14[0])).toEqual(['startISO']); // nada de host vazando
  });

  it('TODAS ocupadas → o horário some', () => {
    const slots = computeFreeSlots({
      busyIntervalsByHost: {
        [ANA]: [busy('2026-08-03T14:00', '2026-08-03T15:00')],
        [MARI]: [busy('2026-08-03T14:00', '2026-08-03T15:00')],
      },
      now: MONDAY_EARLY,
      ...ROSTER,
    });
    expect(mondayHours(slots)).not.toContain(14);
  });

  it('agendas complementares se somam: a manhã de uma + a tarde da outra', () => {
    const slots = computeFreeSlots({
      busyIntervalsByHost: {
        [ANA]: [busy('2026-08-03T09:00', '2026-08-03T13:00')], // manhã cheia
        [MARI]: [busy('2026-08-03T13:00', '2026-08-03T18:00')], // tarde cheia
      },
      now: MONDAY_EARLY,
      ...ROSTER,
    });
    // Nenhuma hora agendável se perde: sempre há alguém livre. (09:00 não
    // entra porque a antecedência de 4h contada de 06:00 começa às 10:00.)
    expect(mondayHours(slots)).toEqual([10, 11, 12, 13, 14, 15, 16, 17]);
  });

  it('roster vazio → zero horários, sem erro', () => {
    expect(computeFreeSlots({ busyIntervalsByHost: {}, now: MONDAY_EARLY, ...ROSTER })).toEqual([]);
  });

  it('feriado nacional fecha o dia mesmo com todas livres', () => {
    const slots = computeFreeSlots({
      busyIntervalsByHost: { [ANA]: [], [MARI]: [] },
      now: ar('2026-08-14T06:00'), // sexta antes de 17/08 (San Martín)
      ...ROSTER,
    });
    expect(slots.filter((s) => s.startISO.startsWith('2026-08-17'))).toHaveLength(0);
  });

  describe('antecedência de 4h e duração de 60min', () => {
    it('às 14:00 não oferece as 17:00 — e o dia inteiro fecha, porque 18:00 já é fora do expediente', () => {
      const slots = computeFreeSlots({
        busyIntervalsByHost: { [ANA]: [] },
        now: ar('2026-08-03T14:00'),
        ...ROSTER,
      });
      // 14:00 + 4h = 18:00 é o primeiro instante agendável; como o expediente
      // termina às 18:00, não sobra nenhum início válido nesse dia.
      expect(mondayHours(slots)).toEqual([]);
      // ...e o primeiro horário oferecido é já no dia útil seguinte.
      expect(slots[0].startISO.startsWith('2026-08-04')).toBe(true);
    });

    it('às 09:00 o primeiro horário do dia é 13:00 (09+4h), não 12:00', () => {
      const slots = computeFreeSlots({
        busyIntervalsByHost: { [ANA]: [] },
        now: ar('2026-08-03T09:00'),
        ...ROSTER,
      });
      expect(mondayHours(slots)[0]).toBe(13);
    });

    it('o último início do dia é 17:00, e nada começa às 17:30', () => {
      const slots = computeFreeSlots({
        busyIntervalsByHost: { [ANA]: [] },
        now: MONDAY_EARLY,
        ...ROSTER,
      });
      const monday = mondayHours(slots);
      expect(monday[monday.length - 1]).toBe(17);
      const minutes = new Set(
        slots.map((s) => DateTime.fromISO(s.startISO).setZone(AR_ZONE).minute),
      );
      expect([...minutes]).toEqual([0]);
    });

    it('a entrevista de 60min faz um compromisso das 10:00 às 11:00 ocupar as duas pontas', () => {
      const slots = computeFreeSlots({
        busyIntervalsByHost: { [ANA]: [busy('2026-08-03T10:30', '2026-08-03T10:45')] },
        now: MONDAY_EARLY,
        ...ROSTER,
      });
      // Um compromisso de 15min às 10:30 derruba o slot das 10:00 (que vai até
      // 11:00) — com 45min o de 10:00 terminaria 10:45 e cairia igual, mas o de
      // 10:00 é justamente o primeiro agendável (06:00 + 4h), então o efeito da
      // duração aparece limpo aqui: o dia começa às 11:00.
      expect(mondayHours(slots)).not.toContain(10);
      expect(mondayHours(slots)[0]).toBe(11);
    });
  });
});

describe('computeFreeSlots — slot que estoura o expediente', () => {
  it('duração de 90min elimina o início das 17:00 (terminaria 18:30)', () => {
    const slots = computeFreeSlots({
      busyIntervalsByHost: { [SOLE]: [] },
      now: ar('2026-08-03T06:00'),
      slotMinutes: 90,
      minLeadMinutes: 0,
    });
    const hours = slots
      .filter((s) => s.startISO.startsWith('2026-08-03'))
      .map((s) => DateTime.fromISO(s.startISO).setZone(AR_ZONE).hour);
    expect(hours[hours.length - 1]).toBe(16); // 16:00→17:30 cabe; 17:00→18:30 não
  });
});

describe('computeFreeSlots — entradas degeneradas não derrubam a tela pública', () => {
  it('mapa ausente ou fonte sem lista → zero horários, sem lançar', () => {
    expect(
      computeFreeSlots({
        busyIntervalsByHost: undefined as unknown as Record<string, BusyInterval[]>,
        now: ar('2026-08-03T06:00'),
      }),
    ).toEqual([]);

    const slots = computeFreeSlots({
      busyIntervalsByHost: { [SOLE]: undefined as unknown as BusyInterval[] },
      now: ar('2026-08-03T06:00'),
    });
    expect(slots.length).toBeGreaterThan(0); // fonte sem intervalos = totalmente livre
  });
});
