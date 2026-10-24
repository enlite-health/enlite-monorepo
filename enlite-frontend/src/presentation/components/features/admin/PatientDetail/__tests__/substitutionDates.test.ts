import { describe, it, expect, vi, afterEach } from 'vitest';
import { nextDatesOfWeekday } from '../substitutionDates';
import { weekdayName } from '../substitutionDates';

describe('nextDatesOfWeekday — as datas oferecidas para "Sustituir un día" (Fase 13, DX-13.13)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('asOf numa segunda, weekday=1 (segunda) → começa pelo próprio asOf', () => {
    expect(nextDatesOfWeekday('2026-09-28', 1, 1)).toEqual(['2026-09-28']);
  });

  it('asOf num domingo, weekday=1 (segunda) → o dia seguinte', () => {
    expect(nextDatesOfWeekday('2026-09-27', 1, 1)).toEqual(['2026-09-28']);
  });

  it('virada de mês: janeiro → fevereiro', () => {
    expect(nextDatesOfWeekday('2026-01-26', 1, 2)).toEqual(['2026-01-26', '2026-02-02']);
  });

  it('virada de ano: dezembro → janeiro', () => {
    expect(nextDatesOfWeekday('2025-12-29', 1, 2)).toEqual(['2025-12-29', '2026-01-05']);
  });

  it('count=8 → 8 datas espaçadas de 7 dias', () => {
    const dates = nextDatesOfWeekday('2026-09-28', 1, 8);
    expect(dates).toEqual([
      '2026-09-28',
      '2026-10-05',
      '2026-10-12',
      '2026-10-19',
      '2026-10-26',
      '2026-11-02',
      '2026-11-09',
      '2026-11-16',
    ]);
  });

  it('sanidade: nenhuma chamada a Date.now — a conta é 100% pela string do asOf, nunca o relógio do processo', () => {
    const nowSpy = vi.spyOn(Date, 'now');
    nextDatesOfWeekday('2026-09-28', 1, 8);
    expect(nowSpy).toHaveBeenCalledTimes(0);
  });
});

describe('weekdayName — nome do dia da semana, fonte única (Fase 12, DX-12.12 (i))', () => {
  it('0 em es → domingo', () => {
    expect(weekdayName(0, 'es')).toBe('domingo');
  });

  it('1 em pt-BR → segunda-feira', () => {
    expect(weekdayName(1, 'pt-BR')).toBe('segunda-feira');
  });

  it('6 em es → sábado', () => {
    expect(weekdayName(6, 'es')).toBe('sábado');
  });
});
