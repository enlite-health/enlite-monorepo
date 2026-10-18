import { describe, it, expect } from 'vitest';
import { shiftMinutes, weeklyHoursOf } from '../scheduleHours';

describe('shiftMinutes (regra única de horas, spec 056)', () => {
  it('20:00 → 08:00 atravessa a meia-noite: 720', () => expect(shiftMinutes('20:00', '08:00')).toBe(720));
  it('Fin = Inicio: 24 h (1440)', () => expect(shiftMinutes('08:00', '08:00')).toBe(1440));
  it('08:00 → 12:00 no mesmo dia: 240', () => expect(shiftMinutes('08:00', '12:00')).toBe(240));
  it('HH:MM inválido: null', () => {
    expect(shiftMinutes('25:00', '08:00')).toBeNull();
    expect(shiftMinutes('08:00', '8:60')).toBeNull();
    expect(shiftMinutes('', '08:00')).toBeNull();
  });
});

describe('weeklyHoursOf', () => {
  it('soma endTime e durationMinutes, ignora inválidas, arredonda a 2 casas', () => {
    expect(weeklyHoursOf([
      { startTime: '20:00', endTime: '08:00' },
      { startTime: '08:00', durationMinutes: 100 },
      { startTime: '99:00', endTime: '08:00' },
      { startTime: '08:00' },
    ])).toBe(13.67);
  });
  it('vazio: 0', () => expect(weeklyHoursOf([])).toBe(0));
});
