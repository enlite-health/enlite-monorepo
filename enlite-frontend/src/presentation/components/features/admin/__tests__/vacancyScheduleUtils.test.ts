import { describe, it, expect } from 'vitest';
import { computeWeeklyHours, findNextAvailableSlot } from '../vacancyScheduleUtils';

describe('computeWeeklyHours', () => {
  it('returns 0 for empty schedule', () => {
    expect(computeWeeklyHours([])).toBe(0);
  });

  it('returns 0 when entries are incomplete', () => {
    expect(
      computeWeeklyHours([
        { days: [], timeFrom: '09:00', timeTo: '17:00' },
        { days: ['lun'], timeFrom: '', timeTo: '' },
      ]),
    ).toBe(0);
  });

  it('multiplies hours per slot by number of days', () => {
    // 5 days × 8h = 40h
    expect(
      computeWeeklyHours([
        { days: ['lun', 'mar', 'mie', 'jue', 'vie'], timeFrom: '09:00', timeTo: '17:00' },
      ]),
    ).toBe(40);
  });

  it('sums multiple entries', () => {
    expect(
      computeWeeklyHours([
        { days: ['lun', 'mar'], timeFrom: '09:00', timeTo: '12:00' }, // 2 × 3 = 6
        { days: ['jue'], timeFrom: '14:00', timeTo: '18:00' }, //          1 × 4 = 4
      ]),
    ).toBe(10);
  });

  it('handles midnight-crossing slot (20:00 → 08:00 = 12h)', () => {
    expect(
      computeWeeklyHours([
        { days: ['vie', 'sab'], timeFrom: '20:00', timeTo: '08:00' },
      ]),
    ).toBe(24);
  });

  it('handles half-hour granularity', () => {
    expect(
      computeWeeklyHours([
        { days: ['lun'], timeFrom: '09:00', timeTo: '12:30' }, // 3.5h
      ]),
    ).toBe(3.5);
  });

  it('skips entries with malformed time', () => {
    expect(
      computeWeeklyHours([
        { days: ['lun'], timeFrom: '9am', timeTo: '17:00' },
        { days: ['mar'], timeFrom: '09:00', timeTo: '17:00' }, // 8h
      ]),
    ).toBe(8);
  });

  it('does not collapse to integer when total is fractional', () => {
    expect(
      computeWeeklyHours([
        { days: ['lun', 'mar', 'mie'], timeFrom: '09:00', timeTo: '11:30' }, // 3 × 2.5 = 7.5
      ]),
    ).toBe(7.5);
  });
});

describe('findNextAvailableSlot', () => {
  it('returns the canonical 09:00–17:00 default when there are no slots yet', () => {
    expect(findNextAvailableSlot([])).toEqual({
      startTime: '09:00',
      endTime: '17:00',
    });
  });

  it('places the next slot right after the last one and extends to 23:59 (canonical end-of-day)', () => {
    expect(
      findNextAvailableSlot([{ startTime: '09:00', endTime: '17:00' }]),
    ).toEqual({ startTime: '17:00', endTime: '23:59' });
  });

  it('does not duplicate the same default twice', () => {
    const after = findNextAvailableSlot([
      { startTime: '09:00', endTime: '17:00' },
    ]);
    expect(after).not.toEqual({ startTime: '09:00', endTime: '17:00' });
  });

  it('caps endTime at 23:59 — last canonical HH:mm of the day, no 24:00 hack', () => {
    const next = findNextAvailableSlot([
      { startTime: '09:00', endTime: '17:00' },
    ]);
    expect(next?.endTime).toBe('23:59');
  });

  it('falls back to the largest internal gap when nothing fits at the tail', () => {
    // 0–7 free (7h gap), 7–9 used, 9–17 used, 17–24 used (saturated). Largest gap = 0–07:00.
    const next = findNextAvailableSlot([
      { startTime: '07:00', endTime: '09:00' },
      { startTime: '09:00', endTime: '17:00' },
      { startTime: '17:00', endTime: '23:59' },
    ]);
    expect(next).toEqual({ startTime: '00:00', endTime: '07:00' });
  });

  it('returns null when the day is fully covered (no gap ≥ step)', () => {
    expect(
      findNextAvailableSlot([{ startTime: '00:00', endTime: '23:59' }]),
    ).toBeNull();
  });

  it('ignores invalid slots (missing or unparsable times)', () => {
    expect(
      findNextAvailableSlot([
        { startTime: '', endTime: '' },
        { startTime: '09:00', endTime: '17:00' },
      ]),
    ).toEqual({ startTime: '17:00', endTime: '23:59' });
  });

  it('handles unsorted input deterministically', () => {
    expect(
      findNextAvailableSlot([
        { startTime: '14:00', endTime: '18:00' },
        { startTime: '08:00', endTime: '12:00' },
      ]),
    ).toEqual({ startTime: '18:00', endTime: '23:59' });
  });

  it('treats an existing endTime=23:59 as covering the tail (suggests the head gap)', () => {
    // After a slot ending at 23:59 the tail can't fit anything else; the
    // function falls back to the largest internal gap (00:00–17:00 here).
    expect(
      findNextAvailableSlot([{ startTime: '17:00', endTime: '23:59' }]),
    ).toEqual({ startTime: '00:00', endTime: '17:00' });
  });
});
