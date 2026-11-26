import { occurrenceWindowOf } from '../occurrenceWindow';

describe('occurrenceWindowOf', () => {
  it('turno diurno em AR (-03): 08:00-16:00 → 11:00Z-19:00Z do mesmo dia', () => {
    expect(occurrenceWindowOf({ date: '2026-10-05', startTime: '08:00', endTime: '16:00', country: 'AR' })).toEqual({ startsAt: '2026-10-05T11:00:00Z', endsAt: '2026-10-05T19:00:00Z' });
  });
  it('turno que atravessa a meia-noite termina no dia seguinte; fim == início também (24 h)', () => {
    expect(occurrenceWindowOf({ date: '2026-10-05', startTime: '20:00', endTime: '08:00', country: 'AR' }).endsAt).toBe('2026-10-06T11:00:00Z');
    expect(occurrenceWindowOf({ date: '2026-10-05', startTime: '08:00', endTime: '08:00', country: 'AR' }).endsAt).toBe('2026-10-06T11:00:00Z');
  });
  it('país desconhecido cai em AR', () => {
    expect(occurrenceWindowOf({ date: '2026-10-05', startTime: '08:00', endTime: '16:00', country: 'XX' }).startsAt).toBe('2026-10-05T11:00:00Z');
  });
});
