/**
 * talentumDescriptionHelpers.test.ts
 *
 * Locks the behaviour of `formatZoneForPrompt`. The function is the single
 * point that prevents "Córdoba capital" hallucinations (bug detected on
 * vacancy 776, 2026-05-27): when patient_addresses.city == patient_addresses.state
 * the LLM used to receive `Zona: Córdoba, Córdoba` and infer the provincial
 * capital. Deduplicating before serialization breaks the pattern.
 *
 * If any of these tests fail, the regression returned.
 */

import { describe, it, expect } from '@jest/globals';
import { formatZoneForPrompt } from '../talentumDescriptionHelpers';

describe('formatZoneForPrompt', () => {
  describe('happy paths', () => {
    it('joins neighborhood + city + state when all distinct', () => {
      expect(
        formatZoneForPrompt({
          neighborhood: 'Palermo',
          city: 'CABA',
          state: 'Buenos Aires',
        }),
      ).toBe('Palermo, CABA, Buenos Aires');
    });

    it('joins city + state when neighborhood missing', () => {
      expect(
        formatZoneForPrompt({ city: 'Bell Ville', state: 'Córdoba' }),
      ).toBe('Bell Ville, Córdoba');
    });

    it('returns the single available level when only one is present', () => {
      expect(formatZoneForPrompt({ state: 'Córdoba' })).toBe('Córdoba');
      expect(formatZoneForPrompt({ city: 'Bell Ville' })).toBe('Bell Ville');
      expect(formatZoneForPrompt({ neighborhood: 'Palermo' })).toBe('Palermo');
    });
  });

  describe('regression — vacancy 776 (Bell Ville miscoded as Córdoba)', () => {
    // DB state observed in prod 2026-05-27 (mapper antigo ainda em uso):
    //   neighborhood = "BELL VILLE"
    //   city         = "Córdoba"   ← wrong (came from the patient-level
    //                                 "Provincia del Paciente" legacy field)
    //   state        = "Córdoba"
    //   address_formatted = "Blvd. Ascasubi 653, X2550 Bell Ville, Córdoba, Argentina"
    //
    // Old prompt produced: "Zona: Córdoba, Córdoba" → Gemini wrote
    // "ciudad de Córdoba, Capital" in the published vacancy.
    it('with corrupted data (city == state, neighborhood preserved) does NOT duplicate "Córdoba"', () => {
      const zone = formatZoneForPrompt({
        neighborhood: 'BELL VILLE',
        city: 'Córdoba',
        state: 'Córdoba',
      });
      expect(zone).toBe('BELL VILLE, Córdoba');
      // Hard assertion that the "X, X" pattern is gone — this is what the LLM
      // used to interpret as "capital".
      expect(zone).not.toMatch(/Córdoba,\s*Córdoba/i);
    });

    it('with the same data minus neighborhood still does NOT duplicate the state', () => {
      const zone = formatZoneForPrompt({
        city: 'Córdoba',
        state: 'Córdoba',
      });
      expect(zone).toBe('Córdoba');
      expect(zone).not.toMatch(/Córdoba,\s*Córdoba/i);
    });

    it('with the post-F9 corrected data ("Bell Ville" as city) produces the expected zone', () => {
      // After re-syncing patients with the new mapper (F9 of the vacancy
      // creation plan), the same patient's row should look like this.
      const zone = formatZoneForPrompt({
        city: 'Bell Ville',
        state: 'Córdoba',
      });
      expect(zone).toBe('Bell Ville, Córdoba');
    });
  });

  describe('deduplication', () => {
    it('drops neighborhood when it equals city (case-insensitive)', () => {
      expect(
        formatZoneForPrompt({
          neighborhood: 'Bell Ville',
          city: 'BELL VILLE',
          state: 'Córdoba',
        }),
      ).toBe('Bell Ville, Córdoba');
    });

    it('drops city when it equals state (case-insensitive)', () => {
      expect(
        formatZoneForPrompt({ city: 'córdoba', state: 'Córdoba' }),
      ).toBe('córdoba');
    });

    it('trims whitespace before comparing', () => {
      expect(
        formatZoneForPrompt({ city: '  Córdoba  ', state: 'Córdoba' }),
      ).toBe('Córdoba');
    });

    it('keeps the first occurrence and drops every later duplicate', () => {
      expect(
        formatZoneForPrompt({
          neighborhood: 'X',
          city: 'X',
          state: 'X',
        }),
      ).toBe('X');
    });
  });

  describe('empty / invalid input', () => {
    it('returns "No especificado" when every field is missing/empty', () => {
      expect(formatZoneForPrompt({})).toBe('No especificado');
      expect(formatZoneForPrompt({ city: '', state: '' })).toBe('No especificado');
      expect(formatZoneForPrompt({ neighborhood: '   ' })).toBe('No especificado');
    });

    it('treats null and undefined identically (defensive against pg)', () => {
      expect(
        formatZoneForPrompt({
          neighborhood: null,
          city: undefined,
          state: 'Córdoba',
        }),
      ).toBe('Córdoba');
    });

    it('skips non-string falsy values without throwing', () => {
      expect(
        formatZoneForPrompt({
          city: null,
          state: null,
        }),
      ).toBe('No especificado');
    });
  });

  describe('integration shape — embedded in the prompt line', () => {
    // Belt-and-suspenders check: any future refactor that wraps the helper
    // must keep this exact substring contract because the LLM prompt is
    // pinned to "- Zona: …".
    it('produces a value that fits directly after "- Zona: " without trailing punctuation', () => {
      const zone = formatZoneForPrompt({
        neighborhood: 'BELL VILLE',
        city: 'Córdoba',
        state: 'Córdoba',
      });
      const promptLine = `- Zona: ${zone}`;
      expect(promptLine).toBe('- Zona: BELL VILLE, Córdoba');
      expect(promptLine).not.toMatch(/Córdoba,\s*Córdoba/i);
      expect(promptLine).not.toMatch(/capital/i);
    });
  });
});
