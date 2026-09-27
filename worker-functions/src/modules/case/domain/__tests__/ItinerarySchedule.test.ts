import { scheduleToSlots, slotMinutes, InvalidScheduleEntryError, type ScheduleEntry } from '../ItinerarySchedule';

describe('scheduleToSlots', () => {
  it('null/undefined/[] → []', () => {
    expect(scheduleToSlots(null)).toEqual([]);
    expect(scheduleToSlots(undefined)).toEqual([]);
    expect(scheduleToSlots([])).toEqual([]);
  });

  it('3 faixas idênticas (o schedule real da stage, passo-0.md:709) → 1 slot', () => {
    const schedule: ScheduleEntry[] = [
      { dayOfWeek: 1, startTime: '08:00', endTime: '12:00' },
      { dayOfWeek: 1, startTime: '08:00', endTime: '12:00' },
      { dayOfWeek: 1, startTime: '08:00', endTime: '12:00' },
    ];
    expect(scheduleToSlots(schedule)).toEqual([{ weekday: 1, startTime: '08:00', endTime: '12:00' }]);
  });

  it('ordem estável (weekday, startTime, endTime) mesmo com entrada embaralhada', () => {
    const schedule: ScheduleEntry[] = [
      { dayOfWeek: 3, startTime: '14:00', endTime: '18:00' },
      { dayOfWeek: 1, startTime: '10:00', endTime: '12:00' },
      { dayOfWeek: 1, startTime: '08:00', endTime: '09:00' },
      { dayOfWeek: 0, startTime: '08:00', endTime: '10:00' },
    ];
    expect(scheduleToSlots(schedule)).toEqual([
      { weekday: 0, startTime: '08:00', endTime: '10:00' },
      { weekday: 1, startTime: '08:00', endTime: '09:00' },
      { weekday: 1, startTime: '10:00', endTime: '12:00' },
      { weekday: 3, startTime: '14:00', endTime: '18:00' },
    ]);
  });

  it('faixas sobrepostas e distintas do mesmo serviço (08-12 e 10-14) NÃO se fundem — 2 slots (Q-7.4)', () => {
    const schedule: ScheduleEntry[] = [
      { dayOfWeek: 1, startTime: '08:00', endTime: '12:00' },
      { dayOfWeek: 1, startTime: '10:00', endTime: '14:00' },
    ];
    expect(scheduleToSlots(schedule)).toEqual([
      { weekday: 1, startTime: '08:00', endTime: '12:00' },
      { weekday: 1, startTime: '10:00', endTime: '14:00' },
    ]);
  });

  it('endTime <= startTime → InvalidScheduleEntryError', () => {
    expect(() =>
      scheduleToSlots([{ dayOfWeek: 1, startTime: '12:00', endTime: '12:00' }]),
    ).toThrow(InvalidScheduleEntryError);
    expect(() =>
      scheduleToSlots([{ dayOfWeek: 1, startTime: '12:00', endTime: '08:00' }]),
    ).toThrow(InvalidScheduleEntryError);
  });

  it('dia fora de 0-6 → InvalidScheduleEntryError', () => {
    expect(() =>
      scheduleToSlots([{ dayOfWeek: 7, startTime: '08:00', endTime: '12:00' }]),
    ).toThrow(InvalidScheduleEntryError);
  });

  it("'HH:MM' sem zero à esquerda ('8:00') → InvalidScheduleEntryError", () => {
    expect(() =>
      scheduleToSlots([{ dayOfWeek: 1, startTime: '8:00', endTime: '12:00' }]),
    ).toThrow(InvalidScheduleEntryError);
  });
});

describe('slotMinutes', () => {
  it("('08:00', '12:30') → 270", () => {
    expect(slotMinutes('08:00', '12:30')).toBe(270);
  });
});
