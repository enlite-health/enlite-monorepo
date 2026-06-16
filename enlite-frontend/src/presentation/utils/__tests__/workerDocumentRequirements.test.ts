import { describe, it, expect } from 'vitest';
import {
  classifyProfession,
  getRequiredDocFields,
  getRequiredDocSlugs,
  areAllRequiredDocsComplete,
} from '../workerDocumentRequirements';
import type { WorkerDocumentsResponse } from '@infrastructure/http/DocumentApiService';

// ── Factory ────────────────────────────────────────────────────────────────────

function makeDocuments(
  overrides: Partial<WorkerDocumentsResponse> = {},
): WorkerDocumentsResponse {
  return {
    id: 'docs-1',
    workerId: 'worker-1',
    resumeCvUrl: null,
    identityDocumentUrl: null,
    identityDocumentBackUrl: null,
    criminalRecordUrl: null,
    professionalRegistrationUrl: null,
    liabilityInsuranceUrl: null,
    monotributoCertificateUrl: null,
    atCertificateUrl: null,
    aptoPsicofisicoUrl: null,
    analiticoUniversitarioUrl: null,
    cartaRecomendacionUrl: null,
    documentsStatus: 'pending',
    submittedAt: null,
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

// ── classifyProfession ────────────────────────────────────────────────────────

describe('classifyProfession', () => {
  it('"AT" → AT', () => {
    expect(classifyProfession('AT')).toBe('AT');
  });

  it('"CUIDADOR" → CUIDADOR', () => {
    expect(classifyProfession('CUIDADOR')).toBe('CUIDADOR');
  });

  it('undefined → CUIDADOR', () => {
    expect(classifyProfession(undefined)).toBe('CUIDADOR');
  });

  it('null → CUIDADOR', () => {
    expect(classifyProfession(null)).toBe('CUIDADOR');
  });

  it('"" → CUIDADOR', () => {
    expect(classifyProfession('')).toBe('CUIDADOR');
  });

  it('"NURSE" → CUIDADOR', () => {
    expect(classifyProfession('NURSE')).toBe('CUIDADOR');
  });
});

// ── getRequiredDocFields ──────────────────────────────────────────────────────

describe('getRequiredDocFields', () => {
  it('AT → 5 campos obrigatórios', () => {
    const fields = getRequiredDocFields('AT');
    expect(fields).toHaveLength(5);
    expect(fields).toContain('resumeCvUrl');
    expect(fields).toContain('identityDocumentUrl');
    expect(fields).toContain('identityDocumentBackUrl');
    expect(fields).toContain('criminalRecordUrl');
    expect(fields).toContain('atCertificateUrl');
  });

  it('AT → NÃO inclui professionalRegistrationUrl nem liabilityInsuranceUrl', () => {
    const fields = getRequiredDocFields('AT');
    expect(fields).not.toContain('professionalRegistrationUrl');
    expect(fields).not.toContain('liabilityInsuranceUrl');
    expect(fields).not.toContain('monotributoCertificateUrl');
  });

  it('CUIDADOR → 3 campos obrigatórios', () => {
    const fields = getRequiredDocFields('CUIDADOR');
    expect(fields).toHaveLength(3);
    expect(fields).toContain('identityDocumentUrl');
    expect(fields).toContain('identityDocumentBackUrl');
    expect(fields).toContain('criminalRecordUrl');
  });

  it('CUIDADOR → NÃO inclui resumeCvUrl nem atCertificateUrl', () => {
    const fields = getRequiredDocFields('CUIDADOR');
    expect(fields).not.toContain('resumeCvUrl');
    expect(fields).not.toContain('atCertificateUrl');
    expect(fields).not.toContain('professionalRegistrationUrl');
    expect(fields).not.toContain('liabilityInsuranceUrl');
  });

  it('undefined → mesmos 3 campos do Cuidador', () => {
    const fields = getRequiredDocFields(undefined);
    expect(fields).toHaveLength(3);
    expect(fields).toContain('identityDocumentUrl');
    expect(fields).toContain('identityDocumentBackUrl');
    expect(fields).toContain('criminalRecordUrl');
  });

  it('null → mesmos 3 campos do Cuidador', () => {
    const fields = getRequiredDocFields(null);
    expect(fields).toHaveLength(3);
  });
});

// ── getRequiredDocSlugs ───────────────────────────────────────────────────────

describe('getRequiredDocSlugs', () => {
  it('AT → 5 slugs corretos', () => {
    const slugs = getRequiredDocSlugs('AT');
    expect(slugs).toHaveLength(5);
    expect(slugs).toContain('resume_cv');
    expect(slugs).toContain('identity_document');
    expect(slugs).toContain('identity_document_back');
    expect(slugs).toContain('criminal_record');
    expect(slugs).toContain('at_certificate');
  });

  it('AT → NÃO inclui professional_registration nem liability_insurance', () => {
    const slugs = getRequiredDocSlugs('AT');
    expect(slugs).not.toContain('professional_registration');
    expect(slugs).not.toContain('liability_insurance');
    expect(slugs).not.toContain('monotributo_certificate');
  });

  it('Cuidador → 3 slugs corretos', () => {
    const slugs = getRequiredDocSlugs('CUIDADOR');
    expect(slugs).toHaveLength(3);
    expect(slugs).toContain('identity_document');
    expect(slugs).toContain('identity_document_back');
    expect(slugs).toContain('criminal_record');
  });

  it('undefined → 3 slugs do Cuidador', () => {
    const slugs = getRequiredDocSlugs(undefined);
    expect(slugs).toHaveLength(3);
  });
});

// ── areAllRequiredDocsComplete ────────────────────────────────────────────────

describe('areAllRequiredDocsComplete', () => {
  describe('AT', () => {
    it('retorna true quando todos os 5 docs AT estão presentes', () => {
      const docs = makeDocuments({
        resumeCvUrl: 'url/cv.pdf',
        identityDocumentUrl: 'url/dni-f.pdf',
        identityDocumentBackUrl: 'url/dni-b.pdf',
        criminalRecordUrl: 'url/cr.pdf',
        atCertificateUrl: 'url/at.pdf',
      });
      expect(areAllRequiredDocsComplete(docs, 'AT')).toBe(true);
    });

    it('retorna false quando atCertificateUrl está ausente', () => {
      const docs = makeDocuments({
        resumeCvUrl: 'url/cv.pdf',
        identityDocumentUrl: 'url/dni-f.pdf',
        identityDocumentBackUrl: 'url/dni-b.pdf',
        criminalRecordUrl: 'url/cr.pdf',
      });
      expect(areAllRequiredDocsComplete(docs, 'AT')).toBe(false);
    });

    it('seguro e registro profissional preenchidos NÃO fazem retornar true sem os AT docs', () => {
      const docs = makeDocuments({
        professionalRegistrationUrl: 'url/reg.pdf',
        liabilityInsuranceUrl: 'url/ins.pdf',
      });
      expect(areAllRequiredDocsComplete(docs, 'AT')).toBe(false);
    });
  });

  describe('Cuidador', () => {
    it('retorna true com apenas DNI frente+verso+antecedentes', () => {
      const docs = makeDocuments({
        identityDocumentUrl: 'url/dni-f.pdf',
        identityDocumentBackUrl: 'url/dni-b.pdf',
        criminalRecordUrl: 'url/cr.pdf',
      });
      expect(areAllRequiredDocsComplete(docs, 'CUIDADOR')).toBe(true);
    });

    it('CV vazio NÃO bloqueia Cuidador', () => {
      const docs = makeDocuments({
        identityDocumentUrl: 'url/dni-f.pdf',
        identityDocumentBackUrl: 'url/dni-b.pdf',
        criminalRecordUrl: 'url/cr.pdf',
        resumeCvUrl: null,
      });
      expect(areAllRequiredDocsComplete(docs, 'CUIDADOR')).toBe(true);
    });

    it('retorna false quando criminalRecordUrl está ausente', () => {
      const docs = makeDocuments({
        identityDocumentUrl: 'url/dni-f.pdf',
        identityDocumentBackUrl: 'url/dni-b.pdf',
      });
      expect(areAllRequiredDocsComplete(docs, 'CUIDADOR')).toBe(false);
    });

    it('undefined profession equivale a Cuidador — retorna true com 3 docs', () => {
      const docs = makeDocuments({
        identityDocumentUrl: 'url/dni-f.pdf',
        identityDocumentBackUrl: 'url/dni-b.pdf',
        criminalRecordUrl: 'url/cr.pdf',
      });
      expect(areAllRequiredDocsComplete(docs, undefined)).toBe(true);
    });
  });

  describe('edge cases', () => {
    it('documents null → false para qualquer profissão', () => {
      expect(areAllRequiredDocsComplete(null, 'AT')).toBe(false);
      expect(areAllRequiredDocsComplete(null, 'CUIDADOR')).toBe(false);
      expect(areAllRequiredDocsComplete(null, undefined)).toBe(false);
    });

    it('documents undefined → false', () => {
      expect(areAllRequiredDocsComplete(undefined, 'CUIDADOR')).toBe(false);
    });
  });
});
