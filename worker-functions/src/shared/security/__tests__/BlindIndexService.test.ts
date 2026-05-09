/**
 * BlindIndexService unit tests.
 * All cases run in testMode (NODE_ENV=test → fixed HMAC key, no Secret Manager calls).
 */

import { BlindIndexService } from '../BlindIndexService';

// Ensure testMode is active — jest sets NODE_ENV=test by default.
// Explicit guard in case config changes.
beforeAll(() => {
  process.env.NODE_ENV = 'test';
});

describe('BlindIndexService', () => {
  let svc: BlindIndexService;

  beforeEach(() => {
    svc = new BlindIndexService();
  });

  // ── generateNameTrigramBidx ─────────────────────────────────────

  describe('generateNameTrigramBidx', () => {
    it('returns a non-empty, deduplicated, sorted array for a normal name', async () => {
      const result = await svc.generateNameTrigramBidx('Gabriel', 'Stein');

      expect(result.length).toBeGreaterThan(0);

      // All elements are 8-byte Buffers
      for (const buf of result) {
        expect(Buffer.isBuffer(buf)).toBe(true);
        expect(buf.length).toBe(8);
      }

      // Deduplicated: no hex duplicate
      const hexes = result.map((b) => b.toString('hex'));
      expect(new Set(hexes).size).toBe(hexes.length);

      // Sorted lexicographically by hex
      for (let i = 1; i < hexes.length; i++) {
        expect(hexes[i].localeCompare(hexes[i - 1])).toBeGreaterThanOrEqual(0);
      }
    });

    it('is deterministic: same input always produces the same output', async () => {
      const a = await svc.generateNameTrigramBidx('Gabriel', 'Stein');
      const b = await svc.generateNameTrigramBidx('Gabriel', 'Stein');

      expect(a.map((x) => x.toString('hex'))).toEqual(b.map((x) => x.toString('hex')));
    });

    it('normalises accents: José da Silva == jose da silva trigrams', async () => {
      const withAccent = await svc.generateNameTrigramBidx('José', 'da Silva');
      const withoutAccent = await svc.generateNameTrigramBidx('Jose', 'da Silva');

      expect(withAccent.map((b) => b.toString('hex'))).toEqual(
        withoutAccent.map((b) => b.toString('hex')),
      );
    });

    it('returns [] for null/null', async () => {
      const result = await svc.generateNameTrigramBidx(null, null);
      expect(result).toEqual([]);
    });

    it('returns [] for empty strings', async () => {
      const result = await svc.generateNameTrigramBidx('', '');
      expect(result).toEqual([]);
    });

    it('handles very short names gracefully (combined < 3 chars → [])', async () => {
      // "Al Li" normalises to "al li" (5 chars) — long enough
      const result = await svc.generateNameTrigramBidx('Al', 'Li');
      expect(result.length).toBeGreaterThan(0);

      // Single very short name
      const tiny = await svc.generateNameTrigramBidx('Al', '');
      // "al" has 2 chars — should return []
      expect(tiny).toEqual([]);
    });
  });

  // ── generateSearchTrigramBidx ────────────────────────────────────

  describe('generateSearchTrigramBidx', () => {
    it('returns trigrams that are a SUBSET of the name index (core semantic test)', async () => {
      const nameBidx = await svc.generateNameTrigramBidx('Gabriel', 'Stein');
      const searchBidx = await svc.generateSearchTrigramBidx('Gabriel Ste');

      const nameHexSet = new Set(nameBidx.map((b) => b.toString('hex')));

      for (const buf of searchBidx) {
        const hex = buf.toString('hex');
        expect(nameHexSet.has(hex)).toBe(true);
      }
    });

    it('throws for single-char term', async () => {
      await expect(svc.generateSearchTrigramBidx('a')).rejects.toThrow(
        'Search term must have at least 3 characters',
      );
    });

    it('ignores short tokens (<3 chars) and uses only valid ones', async () => {
      // "Gabriel S" — "S" is 1 char, should be ignored; result == "Gabriel" alone
      const withShortToken = await svc.generateSearchTrigramBidx('Gabriel S');
      const onlyLong = await svc.generateSearchTrigramBidx('Gabriel');

      expect(withShortToken.map((b) => b.toString('hex'))).toEqual(
        onlyLong.map((b) => b.toString('hex')),
      );
    });

    it('throws for whitespace-only input', async () => {
      await expect(svc.generateSearchTrigramBidx('   ')).rejects.toThrow(
        'Search term must have at least 3 characters',
      );
    });

    it('returns deduplicated sorted array', async () => {
      const result = await svc.generateSearchTrigramBidx('Gabriel Stein');

      const hexes = result.map((b) => b.toString('hex'));
      expect(new Set(hexes).size).toBe(hexes.length);
      for (let i = 1; i < hexes.length; i++) {
        expect(hexes[i].localeCompare(hexes[i - 1])).toBeGreaterThanOrEqual(0);
      }
    });
  });

  // ── serializeForPg ───────────────────────────────────────────────

  describe('serializeForPg', () => {
    it('returns null for empty array', () => {
      expect(svc.serializeForPg([])).toBeNull();
    });

    it('serialises a single buffer to Postgres bytea[] literal', () => {
      const buf = Buffer.from([0x01, 0x02]);
      const result = svc.serializeForPg([buf]);
      // Expected: {"\\x0102"}
      expect(result).toBe('{"\\\\x0102"}');
    });

    it('serialises multiple buffers', () => {
      const buf1 = Buffer.from([0x01, 0x02]);
      const buf2 = Buffer.from([0x03, 0x04]);
      const result = svc.serializeForPg([buf1, buf2]);
      expect(result).toBe('{"\\\\x0102","\\\\x0304"}');
    });
  });

  // ── Round-trip / @> semantic ─────────────────────────────────────

  describe('round-trip @> semantic', () => {
    it('all search trigrams are present in name array (Set difference is empty)', async () => {
      const nameBidx = await svc.generateNameTrigramBidx('Gabriel', 'Stein');
      const searchBidx = await svc.generateSearchTrigramBidx('Gabriel Ste');

      const nameHexSet = new Set(nameBidx.map((b) => b.toString('hex')));
      const missingInName = searchBidx
        .map((b) => b.toString('hex'))
        .filter((hex) => !nameHexSet.has(hex));

      expect(missingInName).toEqual([]);
    });

    it('partial first name search is still a subset', async () => {
      const nameBidx = await svc.generateNameTrigramBidx('Mariana', 'Souza');
      const searchBidx = await svc.generateSearchTrigramBidx('Mari');

      const nameHexSet = new Set(nameBidx.map((b) => b.toString('hex')));
      for (const buf of searchBidx) {
        expect(nameHexSet.has(buf.toString('hex'))).toBe(true);
      }
    });

    it('substring in middle of token is a subset (e.g. "ari" finds "Maria")', async () => {
      const nameBidx = await svc.generateNameTrigramBidx('Maria', 'Souza');
      const searchBidx = await svc.generateSearchTrigramBidx('ari');

      const nameHexSet = new Set(nameBidx.map((b) => b.toString('hex')));
      for (const buf of searchBidx) {
        expect(nameHexSet.has(buf.toString('hex'))).toBe(true);
      }
    });

    it('suffix of token is a subset (e.g. "ein" finds "Stein")', async () => {
      const nameBidx = await svc.generateNameTrigramBidx('Gabriel', 'Stein');
      const searchBidx = await svc.generateSearchTrigramBidx('ein');

      const nameHexSet = new Set(nameBidx.map((b) => b.toString('hex')));
      for (const buf of searchBidx) {
        expect(nameHexSet.has(buf.toString('hex'))).toBe(true);
      }
    });

    it('multi-char suffix is a subset (e.g. "tein" finds "Stein")', async () => {
      const nameBidx = await svc.generateNameTrigramBidx('Gabriel', 'Stein');
      const searchBidx = await svc.generateSearchTrigramBidx('tein');

      const nameHexSet = new Set(nameBidx.map((b) => b.toString('hex')));
      for (const buf of searchBidx) {
        expect(nameHexSet.has(buf.toString('hex'))).toBe(true);
      }
    });
  });
});
