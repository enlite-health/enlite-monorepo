import { computeScheduleWeeklyHours, hasStructuredSchedule } from '../scheduleHours';

describe('computeScheduleWeeklyHours', () => {
  it('soma turnos simples (cada entry é 1 dia-turno, sem multiplicar)', () => {
    const schedule = [
      { dayOfWeek: 1, startTime: '08:00', endTime: '12:00' }, // 4h
      { dayOfWeek: 2, startTime: '14:00', endTime: '18:30' }, // 4.5h
    ];
    expect(computeScheduleWeeklyHours(schedule)).toBeCloseTo(8.5, 5);
  });

  it('trata virada de meia-noite (end <= start → 24 - start + end)', () => {
    const schedule = [
      { dayOfWeek: 5, startTime: '22:00', endTime: '06:00' }, // 8h overnight
    ];
    expect(computeScheduleWeeklyHours(schedule)).toBeCloseTo(8, 5);
  });

  it('end == start conta como 24h (regra literal end<=start)', () => {
    const schedule = [{ dayOfWeek: 0, startTime: '09:00', endTime: '09:00' }];
    expect(computeScheduleWeeklyHours(schedule)).toBeCloseTo(24, 5);
  });

  it('aceita segundos em HH:MM:SS', () => {
    const schedule = [{ dayOfWeek: 1, startTime: '08:00:00', endTime: '08:30:00' }];
    expect(computeScheduleWeeklyHours(schedule)).toBeCloseTo(0.5, 5);
  });

  it('ignora entradas inválidas sem quebrar o total', () => {
    const schedule = [
      { dayOfWeek: 1, startTime: '08:00', endTime: '10:00' }, // 2h
      { dayOfWeek: 2, startTime: 'xx', endTime: '10:00' }, // inválido
      { dayOfWeek: 3, startTime: '08:00' }, // sem endTime
      null,
      42,
    ];
    expect(computeScheduleWeeklyHours(schedule)).toBeCloseTo(2, 5);
  });

  it('retorna 0 para não-array / vazio / null', () => {
    expect(computeScheduleWeeklyHours(null)).toBe(0);
    expect(computeScheduleWeeklyHours(undefined)).toBe(0);
    expect(computeScheduleWeeklyHours([])).toBe(0);
    expect(computeScheduleWeeklyHours({ lunes: [{ start: '08:00', end: '12:00' }] })).toBe(0);
  });
});

describe('hasStructuredSchedule', () => {
  it('true só para array não-vazio', () => {
    expect(hasStructuredSchedule([{ dayOfWeek: 1, startTime: '08:00', endTime: '12:00' }])).toBe(true);
    expect(hasStructuredSchedule([])).toBe(false);
    expect(hasStructuredSchedule(null)).toBe(false);
    expect(hasStructuredSchedule({ lunes: [] })).toBe(false);
  });
});
