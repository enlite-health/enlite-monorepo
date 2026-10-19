import { shiftsToSlotKeys, InvalidScheduleEntryError, type ShiftEntry } from '../ItinerarySchedule';

describe('shiftsToSlotKeys', () => {
  it('null / undefined / [] → []', () => {
    expect(shiftsToSlotKeys(null)).toEqual([]);
    expect(shiftsToSlotKeys(undefined)).toEqual([]);
    expect(shiftsToSlotKeys([])).toEqual([]);
  });

  it('aceita 720 e 1440', () => {
    expect(shiftsToSlotKeys([{ dayOfWeek: 1, startTime: '20:00', durationMinutes: 720 }])).toEqual([
      { weekday: 1, startTime: '20:00', durationMinutes: 720 },
    ]);
    expect(shiftsToSlotKeys([{ dayOfWeek: 0, startTime: '00:00', durationMinutes: 1440 }])).toEqual([
      { weekday: 0, startTime: '00:00', durationMinutes: 1440 },
    ]);
  });

  it("recusa 0, 1441, dia 7, '24:00'", () => {
    const base: ShiftEntry = { dayOfWeek: 1, startTime: '08:00', durationMinutes: 240 };
    for (const bad of [
      { ...base, durationMinutes: 0 },
      { ...base, durationMinutes: 1441 },
      { ...base, durationMinutes: 90.5 },
      { ...base, dayOfWeek: 7 },
      { ...base, dayOfWeek: -1 },
      { ...base, startTime: '24:00' },
      { ...base, startTime: '8:00' },
    ]) {
      expect(() => shiftsToSlotKeys([bad])).toThrow(InvalidScheduleEntryError);
    }
  });

  it('deduplica chave igual', () => {
    const e: ShiftEntry = { dayOfWeek: 2, startTime: '08:00', durationMinutes: 240 };
    expect(shiftsToSlotKeys([e, { ...e }, { ...e }])).toHaveLength(1);
  });

  it('mesmo dia/início com durações distintas são chaves distintas; ordena por dia, início, duração', () => {
    const r = shiftsToSlotKeys([
      { dayOfWeek: 3, startTime: '14:00', durationMinutes: 240 },
      { dayOfWeek: 1, startTime: '08:00', durationMinutes: 300 },
      { dayOfWeek: 1, startTime: '08:00', durationMinutes: 240 },
    ]);
    expect(r.map((k) => `${k.weekday}|${k.startTime}|${k.durationMinutes}`)).toEqual([
      '1|08:00|240',
      '1|08:00|300',
      '3|14:00|240',
    ]);
  });

  it('uma entrada inválida lança mesmo entre válidas (nada parcial)', () => {
    expect(() =>
      shiftsToSlotKeys([
        { dayOfWeek: 1, startTime: '08:00', durationMinutes: 240 },
        { dayOfWeek: 9, startTime: '08:00', durationMinutes: 240 },
      ]),
    ).toThrow(InvalidScheduleEntryError);
  });
});
