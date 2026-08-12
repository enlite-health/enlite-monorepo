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

  // ── generateValueBidx ───────────────────────────────────────────

  describe('generateValueBidx', () => {
    it('returns an 8-byte Buffer for a non-empty value', async () => {
      const result = await svc.generateValueBidx('male');
      expect(result).not.toBeNull();
      expect(Buffer.isBuffer(result)).toBe(true);
      expect(result!.length).toBe(8);
    });

    it('is deterministic: same value always produces same HMAC', async () => {
      const a = await svc.generateValueBidx('female');
      const b = await svc.generateValueBidx('female');
      expect(a!.toString('hex')).toBe(b!.toString('hex'));
    });

    it('returns null for null input', async () => {
      const result = await svc.generateValueBidx(null);
      expect(result).toBeNull();
    });

    it('returns null for undefined input', async () => {
      const result = await svc.generateValueBidx(undefined);
      expect(result).toBeNull();
    });

    it('returns null for empty string', async () => {
      const result = await svc.generateValueBidx('');
      expect(result).toBeNull();
    });

    it('returns null for whitespace-only string', async () => {
      const result = await svc.generateValueBidx('   ');
      expect(result).toBeNull();
    });

    it('normalises value: "MALE" and "male" produce same HMAC', async () => {
      // normalizeSearch lowercases, so both should match
      const upper = await svc.generateValueBidx('MALE');
      const lower = await svc.generateValueBidx('male');
      expect(upper!.toString('hex')).toBe(lower!.toString('hex'));
    });

    it('produces different HMACs for different values', async () => {
      const male = await svc.generateValueBidx('male');
      const female = await svc.generateValueBidx('female');
      expect(male!.toString('hex')).not.toBe(female!.toString('hex'));
    });

    it('result is serialisable via serializeForPg (used in language filter)', async () => {
      const buf = await svc.generateValueBidx('es');
      expect(buf).not.toBeNull();
      const serialized = svc.serializeForPg([buf!]);
      expect(serialized).not.toBeNull();
      expect(typeof serialized).toBe('string');
      expect(serialized).toMatch(/^\{/);
    });
  });

  // ── generateValuesBidx ──────────────────────────────────────────

  describe('generateValuesBidx', () => {
    it('returns a non-empty array for a list of language codes', async () => {
      const result = await svc.generateValuesBidx(['es', 'pt', 'en']);
      expect(result.length).toBe(3);
      for (const buf of result) {
        expect(Buffer.isBuffer(buf)).toBe(true);
        expect(buf.length).toBe(8);
      }
    });

    it('is deterministic: same array always produces same output', async () => {
      const a = await svc.generateValuesBidx(['es', 'pt']);
      const b = await svc.generateValuesBidx(['es', 'pt']);
      expect(a.map((x) => x.toString('hex'))).toEqual(b.map((x) => x.toString('hex')));
    });

    it('deduplicates: same value twice yields single entry', async () => {
      const result = await svc.generateValuesBidx(['es', 'es']);
      expect(result.length).toBe(1);
    });

    it('returns sorted output for deterministic indexing', async () => {
      const result = await svc.generateValuesBidx(['pt', 'es', 'en']);
      const hexes = result.map((b) => b.toString('hex'));
      for (let i = 1; i < hexes.length; i++) {
        expect(hexes[i].localeCompare(hexes[i - 1])).toBeGreaterThanOrEqual(0);
      }
    });

    it('returns [] for null input', async () => {
      const result = await svc.generateValuesBidx(null);
      expect(result).toEqual([]);
    });

    it('returns [] for undefined input', async () => {
      const result = await svc.generateValuesBidx(undefined);
      expect(result).toEqual([]);
    });

    it('returns [] for empty array', async () => {
      const result = await svc.generateValuesBidx([]);
      expect(result).toEqual([]);
    });

    it('skips empty strings in array', async () => {
      const result = await svc.generateValuesBidx(['es', '', 'pt']);
      expect(result.length).toBe(2);
    });

    it('@> semantic: single language HMAC is included in multi-language array', async () => {
      const multi = await svc.generateValuesBidx(['es', 'pt', 'en']);
      const single = await svc.generateValueBidx('pt');
      const multiHexes = new Set(multi.map((b) => b.toString('hex')));
      expect(multiHexes.has(single!.toString('hex'))).toBe(true);
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
