import {
  canonicalLocation,
  resolveLocationFilter,
  isJunkLocation,
  recognizedZoneLabel,
  canonicalProvince,
} from '../normalizeLocationValue';
import { normalizeProvince } from '../argentinaLocationNormalizer';

describe('normalizeLocationValue', () => {
  // ── isJunkLocation ──────────────────────────────────────────────────────────
  describe('isJunkLocation', () => {
    it.each(['AEJ', 'AOO', 'ARP', 'BSI', 'GTJ'])(
      'flags a 3-uppercase-letter CPA postal suffix "%s" as junk',
      (v) => {
        expect(isJunkLocation(v)).toBe(true);
      },
    );

    it('flags a full Argentine CPA code (letter+4 digits+3 letters) as junk', () => {
      expect(isJunkLocation('B1748 AEJ')).toBe(true);
      expect(isJunkLocation('C1426BSI')).toBe(true);
    });

    it('flags empty / whitespace-only / pure-numeric as junk', () => {
      expect(isJunkLocation('')).toBe(true);
      expect(isJunkLocation('   ')).toBe(true);
      expect(isJunkLocation('1748')).toBe(true);
    });

    it('does NOT flag real localities as junk (incl. short mixed-case town names)', () => {
      expect(isJunkLocation('Buenos Aires')).toBe(false);
      expect(isJunkLocation('Lanús')).toBe(false);
      expect(isJunkLocation('José C. Paz')).toBe(false);
      expect(isJunkLocation('CABA')).toBe(false); // recognized alias, not junk
      expect(isJunkLocation('Glew')).toBe(false); // 4 letters, mixed case → real town
      expect(isJunkLocation('Wilde')).toBe(false);
    });
  });

  // ── canonicalLocation (dropdown) ────────────────────────────────────────────
  describe('canonicalLocation', () => {
    it('returns null for junk CPA suffix codes', () => {
      expect(canonicalLocation('AEJ')).toBeNull();
      expect(canonicalLocation('BSI')).toBeNull();
      expect(canonicalLocation('B1748 AEJ')).toBeNull();
    });

    it('returns null for empty / whitespace', () => {
      expect(canonicalLocation('')).toBeNull();
      expect(canonicalLocation('   ')).toBeNull();
      expect(canonicalLocation(null)).toBeNull();
      expect(canonicalLocation(undefined)).toBeNull();
    });

    it('maps CABA aliases to canonical "CABA"', () => {
      for (const alias of ['CABA', 'caba', 'Capital Federal', 'capital', 'Ciudad de Buenos Aires']) {
        expect(canonicalLocation(alias)).toBe('CABA');
      }
    });

    it('preserves a clean locality, trimming and collapsing whitespace', () => {
      expect(canonicalLocation('  Buenos   Aires ')).toBe('Buenos Aires');
      expect(canonicalLocation('Lanús')).toBe('Lanús');
      expect(canonicalLocation('José C. Paz')).toBe('José C. Paz');
    });

    it('returns null for free-text zone sentences (commas / long)', () => {
      expect(canonicalLocation('Paternal,Villa Crespo,Chacarita')).toBeNull();
      expect(
        canonicalLocation('En CABA no tengo problemas, en provincia me manejo en José C Paz'),
      ).toBeNull();
      // long (>40 chars) even without a comma is a sentence, not a locality
      expect(canonicalLocation('Zona sur y alrededores del gran conurbano bonaerense')).toBeNull();
    });
  });

  // ── recognizedZoneLabel (surface CABA from work_zone) ───────────────────────
  describe('recognizedZoneLabel', () => {
    it('returns the canonical label for a recognized zone alias', () => {
      expect(recognizedZoneLabel('CABA')).toBe('CABA');
      expect(recognizedZoneLabel('Capital Federal')).toBe('CABA');
    });

    it('returns null for non-alias free text and empty input', () => {
      expect(recognizedZoneLabel('Paternal, Villa Crespo')).toBeNull();
      expect(recognizedZoneLabel('Zona Norte')).toBeNull();
      expect(recognizedZoneLabel('')).toBeNull();
      expect(recognizedZoneLabel(null)).toBeNull();
    });
  });

  // ── resolveLocationFilter (filter builder) ──────────────────────────────────
  describe('resolveLocationFilter', () => {
    it('returns empty match for empty/whitespace input', () => {
      expect(resolveLocationFilter('')).toEqual({ exactKeys: [], containsPatterns: [] });
      expect(resolveLocationFilter('   ')).toEqual({ exactKeys: [], containsPatterns: [] });
    });

    it('for a plain locality returns a single lowercased exact key and no contains', () => {
      expect(resolveLocationFilter('Buenos Aires')).toEqual({
        exactKeys: ['buenos aires'],
        containsPatterns: [],
      });
      expect(resolveLocationFilter('Lanús')).toEqual({
        exactKeys: ['lanús'],
        containsPatterns: [],
      });
    });

    it('for CABA (any alias / canonical label) returns the full alias key set + contains patterns', () => {
      const fromCanonical = resolveLocationFilter('Ciudad Autónoma de Buenos Aires');
      const fromAlias = resolveLocationFilter('CABA');
      expect(fromCanonical).toEqual(fromAlias);
      expect(fromCanonical.exactKeys).toEqual(expect.arrayContaining(['caba', 'capital federal', 'capital']));
      expect(fromCanonical.exactKeys).toEqual(
        expect.arrayContaining(['ciudad autónoma de buenos aires']),
      );
      // free-text zone signal so interest_zone sentences ("En CABA...") match too
      expect(fromCanonical.containsPatterns).toEqual(
        expect.arrayContaining(['caba', 'capital fed']),
      );
    });

    it('exact keys are all lowercased', () => {
      const { exactKeys } = resolveLocationFilter('CABA');
      expect(exactKeys.every((k) => k === k.toLowerCase())).toBe(true);
    });
  });
});

// ── Consistência cruzada worker (normalizeLocationValue) ↔ paciente (argentinaLocationNormalizer) ──
// Prova de não-recorrência da divergência de label de CABA (worker usava a forma longa; paciente,
// a sigla 'CABA'). Se alguém mexer num dos SSOTs sem alinhar o outro, este teste quebra.
describe('cross-SSOT province canonical consistency', () => {
  it('o label de CABA é idêntico nos dois normalizadores (e é a sigla "CABA")', () => {
    for (const alias of ['CABA', 'Capital Federal', 'Ciudad Autónoma de Buenos Aires']) {
      expect(canonicalProvince(alias)).toBe('CABA');
      expect(canonicalProvince(alias)).toBe(normalizeProvince(alias));
    }
  });

  it('o label de PBA é idêntico nos dois normalizadores', () => {
    for (const alias of ['Provincia de Buenos Aires', 'Buenos Aires Province']) {
      expect(canonicalProvince(alias)).toBe('Provincia de Buenos Aires');
      expect(canonicalProvince(alias)).toBe(normalizeProvince(alias));
    }
  });
});
