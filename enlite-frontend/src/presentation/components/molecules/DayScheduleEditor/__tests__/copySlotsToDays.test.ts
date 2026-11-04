import { describe, it, expect } from 'vitest';
import { copySlotsToDays, isValidRange } from '../copySlotsToDays';

const mon = { dayOfWeek: 1, startTime: '09:00', endTime: '17:00' };

describe('copySlotsToDays', () => {
  it('copiar segunda para lun-vie gera 5 dias (segunda + 4)', () => {
    const { next, conflictDays } = copySlotsToDays([mon], 1, [2, 3, 4, 5]);
    expect(new Set(next.map((s) => s.dayOfWeek))).toEqual(new Set([1, 2, 3, 4, 5]));
    expect(next).toHaveLength(5);
    expect(conflictDays).toEqual([]);
  });

  it('não duplica faixa idêntica já existente no destino (e não avisa)', () => {
    const { next, conflictDays } = copySlotsToDays([mon, { ...mon, dayOfWeek: 2 }], 1, [2]);
    expect(next).toHaveLength(2);
    expect(conflictDays).toEqual([]);
  });

  it('faixa sobreposta no destino: mantém a existente e avisa o dia', () => {
    const existing = { dayOfWeek: 2, startTime: '08:00', endTime: '12:00' };
    const { next, conflictDays } = copySlotsToDays([mon, existing], 1, [2, 3]);
    expect(next.filter((s) => s.dayOfWeek === 2)).toEqual([existing]);
    expect(next.filter((s) => s.dayOfWeek === 3)).toHaveLength(1);
    expect(conflictDays).toEqual([2]);
  });

  it('copia todas as faixas do dia de origem e ignora o próprio dia nos destinos', () => {
    const tarde = { dayOfWeek: 1, startTime: '18:00', endTime: '20:00' };
    const { next } = copySlotsToDays([mon, tarde], 1, [1, 3]);
    expect(next.filter((s) => s.dayOfWeek === 3)).toHaveLength(2);
    expect(next.filter((s) => s.dayOfWeek === 1)).toHaveLength(2);
  });
});

describe('isValidRange', () => {
  it('fim > início', () => {
    expect(isValidRange({ startTime: '09:00', endTime: '17:00' })).toBe(true);
    expect(isValidRange({ startTime: '17:00', endTime: '17:00' })).toBe(false);
    expect(isValidRange({ startTime: '18:00', endTime: '09:00' })).toBe(false);
  });
});
