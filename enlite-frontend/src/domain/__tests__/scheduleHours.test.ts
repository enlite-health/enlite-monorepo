import { describe, it, expect } from 'vitest';
import { shiftMinutes, weeklyHoursOf, copyShiftsToDays, type ServiceShiftFormValue } from '../scheduleHours';

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

describe('copyShiftsToDays (minutos da semana)', () => {
  const sh = (dayOfWeek: number, startTime: string, endTime: string, allDay = false): ServiceShiftFormValue => ({ dayOfWeek, startTime, endTime, allDay });

  it('copyShiftsToDays: copia segunda 09:00–17:00 para terça–sexta e acrescenta sem substituir', () => {
    const r = copyShiftsToDays([sh(1, '09:00', '17:00')], 1, [2, 3, 4, 5]);
    expect(r.conflictDays).toEqual([]);
    expect(r.next).toHaveLength(5);
    expect(r.next[0]).toEqual(sh(1, '09:00', '17:00'));
    expect(r.next.slice(1).map((s) => s.dayOfWeek)).toEqual([2, 3, 4, 5]);
  });

  it('copyShiftsToDays: noturno 20:00→08:00 (720 min) copiado para o dia seguinte com "Todo el día" já existente → conflito, mantém o existente', () => {
    const existing = sh(2, '00:00', '00:00', true);
    const r = copyShiftsToDays([sh(1, '20:00', '08:00'), existing], 1, [2]);
    expect(r.conflictDays).toEqual([2]);
    expect(r.next).toHaveLength(2);
    expect(r.next).toContainEqual(existing);
  });

  it('copyShiftsToDays: Todo el día (1440) copiado para um dia com turno 10:00–12:00 → conflito', () => {
    const existing = sh(2, '10:00', '12:00');
    const r = copyShiftsToDays([sh(1, '00:00', '00:00', true), existing], 1, [2]);
    expect(r.conflictDays).toEqual([2]);
    expect(r.next).toHaveLength(2);
    expect(r.next).toContainEqual(existing);
  });

  it('copyShiftsToDays: turno idêntico já existente é ignorado, sem duplicar nem acusar conflito', () => {
    const r = copyShiftsToDays([sh(1, '09:00', '17:00'), sh(2, '09:00', '17:00')], 1, [2]);
    expect(r.conflictDays).toEqual([]);
    expect(r.next).toHaveLength(2);
  });

  it('copyShiftsToDays: o dia de origem entre os destinos é ignorado; sobreposição devolve conflictDays e mantém o existente', () => {
    const existing = sh(2, '16:00', '18:00');
    const r = copyShiftsToDays([sh(1, '09:00', '17:00'), existing], 1, [1, 2]);
    expect(r.conflictDays).toEqual([2]);
    expect(r.next).toHaveLength(2);
    expect(r.next).toContainEqual(existing);
  });
});
