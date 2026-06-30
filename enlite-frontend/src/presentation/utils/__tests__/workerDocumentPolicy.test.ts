import { describe, it, expect } from 'vitest';
import { isATProfession, requiredDocTypesFor } from '../workerDocumentPolicy';

describe('workerDocumentPolicy (frontend SSOT — mirrors SQL gate)', () => {
  describe('isATProfession', () => {
    it('treats AT as AT', () => {
      expect(isATProfession('AT')).toBe(true);
    });

    it('treats NULL / undefined / empty as AT (SQL gate three-valued logic)', () => {
      expect(isATProfession(null)).toBe(true);
      expect(isATProfession(undefined)).toBe(true);
      expect(isATProfession('')).toBe(true);
    });

    it('treats other professions as NOT AT', () => {
      for (const p of ['CAREGIVER', 'NURSE', 'KINESIOLOGIST', 'PSYCHOLOGIST']) {
        expect(isATProfession(p)).toBe(false);
      }
    });
  });

  describe('requiredDocTypesFor', () => {
    it('AT requires identity + criminal + resume_cv + at_certificate', () => {
      expect(requiredDocTypesFor('AT')).toEqual([
        'identity_document',
        'criminal_record',
        'resume_cv',
        'at_certificate',
      ]);
    });

    it('NULL profession requires the AT set (gate treats NULL as AT)', () => {
      expect(requiredDocTypesFor(null)).toEqual([
        'identity_document',
        'criminal_record',
        'resume_cv',
        'at_certificate',
      ]);
    });

    it('CAREGIVER requires only identity + criminal', () => {
      expect(requiredDocTypesFor('CAREGIVER')).toEqual(['identity_document', 'criminal_record']);
    });

    it('does NOT include the optional AT slots (apto / analitico)', () => {
      const at = requiredDocTypesFor('AT');
      expect(at).not.toContain('apto_psicofisico');
      expect(at).not.toContain('analitico_universitario');
    });
  });
});
