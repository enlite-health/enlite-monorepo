import { describe, it, expect } from 'vitest';
import { dateLocaleOf, formatWeekDate, mondayOf, shiftHours, weekdayOfDate, weekEndOf, weeksBetween } from '../weekRange';

describe('weekRange', () => {
  it('weekdayOfDate: 2026-11-02 é segunda (1) e 2026-11-08 é domingo (0)', () => {
    expect(weekdayOfDate('2026-11-02')).toBe(1);
    expect(weekdayOfDate('2026-11-08')).toBe(0);
  });

  it('mondayOf: segunda é ela mesma; domingo volta 6 dias; meio de semana volta à segunda', () => {
    expect(mondayOf('2026-11-02')).toBe('2026-11-02');
    expect(mondayOf('2026-11-08')).toBe('2026-11-02');
    expect(mondayOf('2026-11-05')).toBe('2026-11-02');
  });

  it('mondayOf atravessa mês e ano sem usar o relógio do navegador', () => {
    expect(mondayOf('2026-12-31')).toBe('2026-12-28');
    expect(mondayOf('2027-01-01')).toBe('2026-12-28');
  });

  it('weekEndOf: segunda + 6 dias', () => {
    expect(weekEndOf('2026-11-02')).toBe('2026-11-08');
    expect(weekEndOf('2026-12-28')).toBe('2027-01-03');
  });

  it('weeksBetween: 0, futuro, passado (20 semanas à frente)', () => {
    expect(weeksBetween('2026-11-02', '2026-11-02')).toBe(0);
    expect(weeksBetween('2026-10-19', '2026-11-02')).toBe(2);
    expect(weeksBetween('2026-11-02', '2026-10-26')).toBe(-1);
    expect(weeksBetween('2026-10-19', '2027-03-08')).toBe(20);
  });

  it('shiftHours: turno do dia, turno noturno (termina no dia seguinte) e meia hora', () => {
    expect(shiftHours('09:00', '17:00')).toEqual({ hours: 8, endsNextDay: false });
    expect(shiftHours('22:00', '06:00')).toEqual({ hours: 8, endsNextDay: true });
    expect(shiftHours('08:00', '12:30')).toEqual({ hours: 4.5, endsNextDay: false });
  });

  it('dateLocaleOf: pt* → pt-BR; o resto → es-AR', () => {
    expect(dateLocaleOf('pt-BR')).toBe('pt-BR');
    expect(dateLocaleOf('pt')).toBe('pt-BR');
    expect(dateLocaleOf('es')).toBe('es-AR');
  });

  it('formatWeekDate: data válida por extenso; string que não é data volta como veio (nunca em branco)', () => {
    expect(formatWeekDate('2026-11-02', { day: 'numeric', month: 'long' }, 'es-AR')).toBe('2 de noviembre');
    expect(formatWeekDate('não-é-data', { day: 'numeric' }, 'es-AR')).toBe('não-é-data');
  });
});
