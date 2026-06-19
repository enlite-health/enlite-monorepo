/**
 * vacancyScheduleFilter.test.ts
 *
 * Unit tests for buildScheduleFilter, parseDaysCsv, parseTimeHHMM.
 * Pure functions — zero DB required.
 */

import {
  buildScheduleFilter,
  parseDaysCsv,
  parseTimeHHMM,
  ScheduleFilterInput,
} from '../vacancyScheduleFilter';

// ── parseDaysCsv ───────────────────────────────────────────────────────────────

describe('parseDaysCsv', () => {
  it('returns empty array for undefined', () => {
    expect(parseDaysCsv(undefined)).toEqual([]);
  });

  it('returns empty array for empty string', () => {
    expect(parseDaysCsv('')).toEqual([]);
  });

  it('returns empty array for whitespace string', () => {
    expect(parseDaysCsv('   ')).toEqual([]);
  });

  it('parses valid single day', () => {
    expect(parseDaysCsv('1')).toEqual([1]);
  });

  it('parses valid CSV "1,2,3"', () => {
    expect(parseDaysCsv('1,2,3')).toEqual([1, 2, 3]);
  });

  it('deduplicates repeated values', () => {
    expect(parseDaysCsv('1,1,2')).toEqual([1, 2]);
  });

  it('sorts values ascending', () => {
    expect(parseDaysCsv('5,1,3')).toEqual([1, 3, 5]);
  });

  it('discards values outside 0-6', () => {
    expect(parseDaysCsv('0,6,7,-1')).toEqual([0, 6]);
  });

  it('discards non-numeric tokens', () => {
    expect(parseDaysCsv('1,abc,3')).toEqual([1, 3]);
  });

  it('accepts 0 (Sunday) and 6 (Saturday)', () => {
    expect(parseDaysCsv('0,6')).toEqual([0, 6]);
  });

  it('trims whitespace around tokens', () => {
    expect(parseDaysCsv(' 1 , 2 , 3 ')).toEqual([1, 2, 3]);
  });

  it('returns empty array for non-string inputs', () => {
    expect(parseDaysCsv(42)).toEqual([]);
    expect(parseDaysCsv(['1', '2'])).toEqual([]);
    expect(parseDaysCsv(null)).toEqual([]);
  });
});

// ── parseTimeHHMM ──────────────────────────────────────────────────────────────

describe('parseTimeHHMM', () => {
  it('accepts "08:00"', () => {
    expect(parseTimeHHMM('08:00')).toBe('08:00');
  });

  it('accepts "23:59"', () => {
    expect(parseTimeHHMM('23:59')).toBe('23:59');
  });

  it('accepts "00:00"', () => {
    expect(parseTimeHHMM('00:00')).toBe('00:00');
  });

  it('rejects "24:00" (invalid hour)', () => {
    expect(parseTimeHHMM('24:00')).toBeUndefined();
  });

  it('rejects "8:00" (missing leading zero)', () => {
    expect(parseTimeHHMM('8:00')).toBeUndefined();
  });

  it('rejects "08:60" (invalid minutes)', () => {
    expect(parseTimeHHMM('08:60')).toBeUndefined();
  });

  it('rejects non-string input', () => {
    expect(parseTimeHHMM(800)).toBeUndefined();
    expect(parseTimeHHMM(null)).toBeUndefined();
    expect(parseTimeHHMM(undefined)).toBeUndefined();
  });

  it('rejects empty string', () => {
    expect(parseTimeHHMM('')).toBeUndefined();
  });
});

// ── buildScheduleFilter ────────────────────────────────────────────────────────

describe('buildScheduleFilter', () => {
  // ── nothing to filter ───────────────────────────────────────────────────────

  it('returns empty result when days=[] and no time', () => {
    const result = buildScheduleFilter({ days: [] }, 1);
    expect(result.sql).toBe('');
    expect(result.params).toEqual([]);
    expect(result.nextParamIndex).toBe(1);
  });

  it('returns empty result when days=[] and only one time is valid (partial)', () => {
    const result = buildScheduleFilter({ days: [], timeFrom: '09:00' }, 1);
    expect(result.sql).toBe('');
    expect(result.params).toEqual([]);
  });

  it('returns empty result when days=[] and both times are invalid', () => {
    const result = buildScheduleFilter({ days: [], timeFrom: 'bad', timeTo: 'bad' }, 3);
    expect(result.sql).toBe('');
    expect(result.params).toEqual([]);
    expect(result.nextParamIndex).toBe(3);
  });

  // ── days only (no time) ──────────────────────────────────────────────────────

  it('generates bool_and/unnest SQL for days=[1,2,3] without time', () => {
    const result = buildScheduleFilter({ days: [1, 2, 3] }, 1);
    expect(result.sql).not.toBe('');
    expect(result.sql).toContain('bool_and');
    expect(result.sql).toContain('unnest($1::int[])');
    expect(result.sql).toContain('dayOfWeek');
    expect(result.sql).not.toContain('startTime');
    expect(result.params).toEqual([[1, 2, 3]]);
    expect(result.nextParamIndex).toBe(2);
  });

  it('generates bool_and/unnest SQL for days=[5] (single day)', () => {
    const result = buildScheduleFilter({ days: [5] }, 4);
    expect(result.sql).toContain('unnest($4::int[])');
    expect(result.params).toEqual([[5]]);
    expect(result.nextParamIndex).toBe(5);
  });

  it('does NOT include time predicates when only days provided', () => {
    const result = buildScheduleFilter({ days: [1] }, 1);
    expect(result.sql).not.toContain('startTime');
    expect(result.sql).not.toContain('endTime');
  });

  // ── days + time ──────────────────────────────────────────────────────────────

  it('generates bool_and + time overlap SQL for days=[1] + timeFrom/timeTo', () => {
    const result = buildScheduleFilter({ days: [1], timeFrom: '08:00', timeTo: '12:00' }, 1);
    expect(result.sql).toContain('bool_and');
    expect(result.sql).toContain('startTime');
    expect(result.sql).toContain('endTime');
    // time params must reference correct $N placeholders
    expect(result.sql).toContain('$1::int[]');
    expect(result.sql).toContain('$2');
    expect(result.sql).toContain('$3');
    expect(result.params).toEqual([[1], '08:00', '12:00']);
    expect(result.nextParamIndex).toBe(4);
  });

  it('uses startIdx correctly when startIdx > 1', () => {
    const result = buildScheduleFilter({ days: [2, 4], timeFrom: '09:00', timeTo: '13:00' }, 5);
    expect(result.sql).toContain('$5::int[]');
    expect(result.sql).toContain('$6');
    expect(result.sql).toContain('$7');
    expect(result.params).toEqual([[2, 4], '09:00', '13:00']);
    expect(result.nextParamIndex).toBe(8);
  });

  it('ignores partial time (only timeFrom valid, no timeTo) — falls back to days-only', () => {
    const result = buildScheduleFilter({ days: [1], timeFrom: '08:00', timeTo: undefined }, 1);
    // Should behave as days-only (no startTime in SQL)
    expect(result.sql).toContain('dayOfWeek');
    expect(result.sql).not.toContain('startTime');
    expect(result.params).toEqual([[1]]);
    expect(result.nextParamIndex).toBe(2);
  });

  it('ignores partial time (only timeTo valid, no timeFrom) — falls back to days-only', () => {
    const result = buildScheduleFilter({ days: [1], timeFrom: undefined, timeTo: '18:00' }, 1);
    expect(result.sql).not.toContain('startTime');
    expect(result.params).toEqual([[1]]);
  });

  it('ignores invalid timeFrom format — falls back to days-only', () => {
    const result = buildScheduleFilter({ days: [1], timeFrom: '8:00', timeTo: '18:00' }, 1);
    expect(result.sql).not.toContain('startTime');
    expect(result.params).toEqual([[1]]);
  });

  // ── time only (no days) ──────────────────────────────────────────────────────

  it('generates EXISTS/time-overlap SQL when days=[] and both times valid', () => {
    const result = buildScheduleFilter({ days: [], timeFrom: '08:00', timeTo: '12:00' }, 1);
    expect(result.sql).toContain('EXISTS');
    expect(result.sql).toContain('startTime');
    expect(result.sql).toContain('endTime');
    expect(result.sql).not.toContain('bool_and');
    expect(result.params).toEqual(['08:00', '12:00']);
    expect(result.nextParamIndex).toBe(3);
  });

  it('uses startIdx for time-only params', () => {
    const result = buildScheduleFilter({ days: [], timeFrom: '07:30', timeTo: '11:30' }, 3);
    expect(result.sql).toContain('$3');
    expect(result.sql).toContain('$4');
    expect(result.params).toEqual(['07:30', '11:30']);
    expect(result.nextParamIndex).toBe(5);
  });

  it('time-only: does not include dayOfWeek predicate', () => {
    const result = buildScheduleFilter({ days: [], timeFrom: '09:00', timeTo: '17:00' }, 1);
    expect(result.sql).not.toContain('dayOfWeek');
  });

  // ── SQL starts with " AND" ────────────────────────────────────────────────────

  it('SQL always starts with " AND" when non-empty', () => {
    const cases: ScheduleFilterInput[] = [
      { days: [1] },
      { days: [1], timeFrom: '08:00', timeTo: '12:00' },
      { days: [], timeFrom: '08:00', timeTo: '12:00' },
    ];
    for (const input of cases) {
      const result = buildScheduleFilter(input, 1);
      expect(result.sql.trimStart()).toMatch(/^AND /i);
    }
  });
});
