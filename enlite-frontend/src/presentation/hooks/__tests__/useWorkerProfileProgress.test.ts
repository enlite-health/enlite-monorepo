import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useWorkerProfileProgress } from '../useWorkerProfileProgress';
import type { WorkerProgressResponse } from '@infrastructure/http/WorkerApiService';
import type { WorkerDocumentsResponse } from '@infrastructure/http/DocumentApiService';

// Suprime os avisos do i18next em ambiente de teste
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeWorker(overrides: Partial<WorkerProgressResponse> = {}): WorkerProgressResponse {
  return {
    id: 'worker-test-001',
    authUid: 'auth-test-001',
    email: 'test@test.com',
    country: 'AR',
    timezone: 'America/Argentina/Buenos_Aires',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    // Campos de step1 completos
    firstName: 'Test',
    lastName: 'Worker',
    birthDate: '1990-01-01',
    sex: 'male',
    gender: 'male',
    documentType: 'DNI',
    documentNumber: '12345678',
    languages: ['es'],
    profession: undefined,
    knowledgeLevel: 'technical',
    experienceTypes: ['adults'],
    yearsExperience: '3_5',
    preferredTypes: ['adults'],
    preferredAgeRange: ['adults'],
    // Campos de step2 completos
    serviceAddress: 'Av. Corrientes 1234, Buenos Aires',
    serviceRadiusKm: 10,
    // Campos de step3 completos
    availability: { monday: { start: '09:00', end: '17:00' } },
    ...overrides,
  };
}

function makeDocuments(overrides: Partial<WorkerDocumentsResponse> = {}): WorkerDocumentsResponse {
  return {
    id: 'docs-test-001',
    workerId: 'worker-test-001',
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

// ── Suite ─────────────────────────────────────────────────────────────────────

describe('useWorkerProfileProgress', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('workerData nulo', () => {
    it('retorna 0% e sections vazio quando workerData é null', () => {
      const { result } = renderHook(() => useWorkerProfileProgress(null));
      expect(result.current.progress.overallPercentage).toBe(0);
      expect(result.current.progress.sections).toHaveLength(0);
      expect(result.current.isComplete).toBe(false);
    });
  });

  describe('profissão AT', () => {
    it('worker AT completo com todos os 5 docs obrigatórios → seção docs 100%', () => {
      const worker = makeWorker({ profession: 'AT' });
      const docs = makeDocuments({
        resumeCvUrl: 'path/cv.pdf',
        identityDocumentUrl: 'path/dni-front.pdf',
        identityDocumentBackUrl: 'path/dni-back.pdf',
        criminalRecordUrl: 'path/criminal.pdf',
        atCertificateUrl: 'path/at-cert.pdf',
      });

      const { result } = renderHook(() => useWorkerProfileProgress(worker, docs));
      const docsSection = result.current.progress.sections.find((s) => s.id === 'documents');

      expect(docsSection?.totalCount).toBe(5);
      expect(docsSection?.completedCount).toBe(5);
      expect(docsSection?.percentage).toBe(100);
    });

    it('worker AT completo COM docs AT → isComplete true (overall 100%)', () => {
      const worker = makeWorker({ profession: 'AT' });
      const docs = makeDocuments({
        resumeCvUrl: 'path/cv.pdf',
        identityDocumentUrl: 'path/dni-front.pdf',
        identityDocumentBackUrl: 'path/dni-back.pdf',
        criminalRecordUrl: 'path/criminal.pdf',
        atCertificateUrl: 'path/at-cert.pdf',
      });

      const { result } = renderHook(() => useWorkerProfileProgress(worker, docs));
      expect(result.current.isComplete).toBe(true);
    });

    it('worker AT sem at_certificate → seção docs < 100%', () => {
      const worker = makeWorker({ profession: 'AT' });
      const docs = makeDocuments({
        resumeCvUrl: 'path/cv.pdf',
        identityDocumentUrl: 'path/dni-front.pdf',
        identityDocumentBackUrl: 'path/dni-back.pdf',
        criminalRecordUrl: 'path/criminal.pdf',
        // atCertificateUrl ausente
      });

      const { result } = renderHook(() => useWorkerProfileProgress(worker, docs));
      const docsSection = result.current.progress.sections.find((s) => s.id === 'documents');

      expect(docsSection?.totalCount).toBe(5);
      expect(docsSection?.completedCount).toBe(4);
      expect(docsSection?.percentage).toBe(80);
      expect(result.current.isComplete).toBe(false);
    });

    it('worker AT NÃO tem professional_registration nem liability_insurance nos steps de doc', () => {
      const worker = makeWorker({ profession: 'AT' });
      const docs = makeDocuments({
        professionalRegistrationUrl: 'path/reg.pdf',
        liabilityInsuranceUrl: 'path/ins.pdf',
      });

      const { result } = renderHook(() => useWorkerProfileProgress(worker, docs));
      const docsSection = result.current.progress.sections.find((s) => s.id === 'documents');

      // Apenas os 5 docs AT — profReg e insurance não contam
      expect(docsSection?.totalCount).toBe(5);
      expect(docsSection?.completedCount).toBe(0);
    });

    it('worker AT — steps de doc incluem as chaves corretas', () => {
      const worker = makeWorker({ profession: 'AT' });
      const { result } = renderHook(() => useWorkerProfileProgress(worker));
      const docsSection = result.current.progress.sections.find((s) => s.id === 'documents');
      const stepIds = docsSection?.steps.map((s) => s.id) ?? [];

      expect(stepIds).toContain('doc1'); // resume_cv
      expect(stepIds).toContain('doc2'); // identity_document
      expect(stepIds).toContain('doc3'); // identity_document_back
      expect(stepIds).toContain('doc4'); // criminal_record
      expect(stepIds).toContain('doc5'); // at_certificate
      expect(stepIds).toHaveLength(5);
    });
  });

  describe('profissão Cuidador (não-AT)', () => {
    it('worker Cuidador com apenas DNI frente+verso+antecedentes → seção docs 100%', () => {
      const worker = makeWorker({ profession: 'CUIDADOR' });
      const docs = makeDocuments({
        identityDocumentUrl: 'path/dni-front.pdf',
        identityDocumentBackUrl: 'path/dni-back.pdf',
        criminalRecordUrl: 'path/criminal.pdf',
        // resume_cv, professional_registration e liability_insurance ausentes
      });

      const { result } = renderHook(() => useWorkerProfileProgress(worker, docs));
      const docsSection = result.current.progress.sections.find((s) => s.id === 'documents');

      expect(docsSection?.totalCount).toBe(3);
      expect(docsSection?.completedCount).toBe(3);
      expect(docsSection?.percentage).toBe(100);
    });

    it('worker Cuidador com DNI frente+verso+antecedentes → isComplete true', () => {
      const worker = makeWorker({ profession: 'CUIDADOR' });
      const docs = makeDocuments({
        identityDocumentUrl: 'path/dni-front.pdf',
        identityDocumentBackUrl: 'path/dni-back.pdf',
        criminalRecordUrl: 'path/criminal.pdf',
      });

      const { result } = renderHook(() => useWorkerProfileProgress(worker, docs));
      expect(result.current.isComplete).toBe(true);
    });

    it('worker Cuidador NÃO exige resume_cv', () => {
      const worker = makeWorker({ profession: 'CUIDADOR' });
      const docs = makeDocuments({
        identityDocumentUrl: 'path/dni-front.pdf',
        identityDocumentBackUrl: 'path/dni-back.pdf',
        criminalRecordUrl: 'path/criminal.pdf',
        resumeCvUrl: null, // CV não enviado — deve ser ignorado
      });

      const { result } = renderHook(() => useWorkerProfileProgress(worker, docs));
      const docsSection = result.current.progress.sections.find((s) => s.id === 'documents');
      expect(docsSection?.totalCount).toBe(3);
      expect(docsSection?.percentage).toBe(100);
    });

    it('worker Cuidador NÃO exige at_certificate', () => {
      const worker = makeWorker({ profession: 'CUIDADOR' });
      const docs = makeDocuments({
        identityDocumentUrl: 'path/dni-front.pdf',
        identityDocumentBackUrl: 'path/dni-back.pdf',
        criminalRecordUrl: 'path/criminal.pdf',
        atCertificateUrl: null, // at_cert não enviado — deve ser ignorado
      });

      const { result } = renderHook(() => useWorkerProfileProgress(worker, docs));
      const docsSection = result.current.progress.sections.find((s) => s.id === 'documents');
      expect(docsSection?.totalCount).toBe(3);
      expect(docsSection?.percentage).toBe(100);
    });

    it('worker com profession undefined (inclui undefined como não-AT) → 3 docs obrigatórios', () => {
      const worker = makeWorker({ profession: undefined });
      const docs = makeDocuments({
        identityDocumentUrl: 'path/dni-front.pdf',
        identityDocumentBackUrl: 'path/dni-back.pdf',
        criminalRecordUrl: 'path/criminal.pdf',
      });

      const { result } = renderHook(() => useWorkerProfileProgress(worker, docs));
      const docsSection = result.current.progress.sections.find((s) => s.id === 'documents');
      expect(docsSection?.totalCount).toBe(3);
      expect(docsSection?.completedCount).toBe(3);
      expect(docsSection?.percentage).toBe(100);
    });

    it('worker não-AT sem docs → completedCount 0, totalCount 3', () => {
      const worker = makeWorker({ profession: undefined });
      const docs = makeDocuments();

      const { result } = renderHook(() => useWorkerProfileProgress(worker, docs));
      const docsSection = result.current.progress.sections.find((s) => s.id === 'documents');
      expect(docsSection?.totalCount).toBe(3);
      expect(docsSection?.completedCount).toBe(0);
    });
  });

  describe('nextAction', () => {
    it('retorna uploadDocuments quando cadastro está completo mas documentos faltam', () => {
      const worker = makeWorker({ profession: 'CUIDADOR' });
      const docs = makeDocuments(); // todos null

      const { result } = renderHook(() => useWorkerProfileProgress(worker, docs));
      expect(result.current.progress.nextAction?.route).toBe('/worker/documents');
    });

    it('nextAction é undefined quando tudo está completo (Cuidador)', () => {
      const worker = makeWorker({ profession: 'CUIDADOR' });
      const docs = makeDocuments({
        identityDocumentUrl: 'path/dni-front.pdf',
        identityDocumentBackUrl: 'path/dni-back.pdf',
        criminalRecordUrl: 'path/criminal.pdf',
      });

      const { result } = renderHook(() => useWorkerProfileProgress(worker, docs));
      expect(result.current.progress.nextAction).toBeUndefined();
    });
  });
});
