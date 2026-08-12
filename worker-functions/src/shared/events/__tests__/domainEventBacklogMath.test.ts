import { computeOldestRecentAgeMinutes, isStuck } from '../domainEventBacklogMath';

describe('domainEventBacklogMath', () => {
  describe('computeOldestRecentAgeMinutes', () => {
    it('returns 0 when there is no recent pending (null)', () => {
      expect(computeOldestRecentAgeMinutes(null, new Date('2026-01-01T12:00:00Z'))).toBe(0);
    });

    it('computes age in whole minutes from now', () => {
      const oldest = new Date('2026-01-01T11:42:00Z');
      const now = new Date('2026-01-01T12:00:00Z');
      expect(computeOldestRecentAgeMinutes(oldest, now)).toBe(18);
    });

    it('floors partial minutes down', () => {
      const oldest = new Date('2026-01-01T11:59:30Z'); // 30s ago
      const now = new Date('2026-01-01T12:00:00Z');
      expect(computeOldestRecentAgeMinutes(oldest, now)).toBe(0);
    });

    it('never returns negative age (clock skew guard)', () => {
      const oldest = new Date('2026-01-01T12:05:00Z'); // "future" relative to now
      const now = new Date('2026-01-01T12:00:00Z');
      expect(computeOldestRecentAgeMinutes(oldest, now)).toBe(0);
    });
  });

  describe('isStuck', () => {
    it('is false when age equals the threshold (strictly greater required)', () => {
      expect(isStuck(15, 15)).toBe(false);
    });

    it('is true when age exceeds the threshold', () => {
      expect(isStuck(16, 15)).toBe(true);
    });

    it('is false for 0 age', () => {
      expect(isStuck(0, 15)).toBe(false);
    });
  });
});
