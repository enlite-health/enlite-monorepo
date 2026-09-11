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
    // Veredito do BACKEND: nada falta. É ele que define completude desde
    // 08/09/2026 — os campos acima só hidratam a tela.
    //
    // Reparo que esta fixture NUNCA teve `phone` nem `titleCertificate`, e
    // mesmo assim era considerada "step1 completo" pela lista que o frontend
    // mantinha. Eram exatamente os dois campos que o portão exige e a lista
    // ignorava — o defeito que travou 23 prestadoras estava dentro da própria
    // fixture, verde.
    missingFields: [],
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
    it('worker AT completo com todos os 4 docs obrigatórios → seção docs 100%', () => {
      const worker = makeWorker({ profession: 'AT' });
      const docs = makeDocuments({
        resumeCvUrl: 'path/cv.pdf',
        identityDocumentUrl: 'path/dni-front.pdf',
        criminalRecordUrl: 'path/criminal.pdf',
        atCertificateUrl: 'path/at-cert.pdf',
      });

      const { result } = renderHook(() => useWorkerProfileProgress(worker, docs));
      const docsSection = result.current.progress.sections.find((s) => s.id === 'documents');

      expect(docsSection?.totalCount).toBe(4);
      expect(docsSection?.completedCount).toBe(4);
      expect(docsSection?.percentage).toBe(100);
    });

    it('worker AT sem DNI verso → seção docs 100% (verso é opcional)', () => {
      const worker = makeWorker({ profession: 'AT' });
      const docs = makeDocuments({
        resumeCvUrl: 'path/cv.pdf',
        identityDocumentUrl: 'path/dni-front.pdf',
        // identityDocumentBackUrl: ausente — não deve impactar
        criminalRecordUrl: 'path/criminal.pdf',
        atCertificateUrl: 'path/at-cert.pdf',
      });

      const { result } = renderHook(() => useWorkerProfileProgress(worker, docs));
      const docsSection = result.current.progress.sections.find((s) => s.id === 'documents');

      expect(docsSection?.totalCount).toBe(4);
      expect(docsSection?.completedCount).toBe(4);
      expect(docsSection?.percentage).toBe(100);
    });

    it('worker AT completo COM docs AT → isComplete true (overall 100%)', () => {
      const worker = makeWorker({ profession: 'AT' });
      const docs = makeDocuments({
        resumeCvUrl: 'path/cv.pdf',
        identityDocumentUrl: 'path/dni-front.pdf',
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
        criminalRecordUrl: 'path/criminal.pdf',
        // atCertificateUrl ausente
      });

      const { result } = renderHook(() => useWorkerProfileProgress(worker, docs));
      const docsSection = result.current.progress.sections.find((s) => s.id === 'documents');

      expect(docsSection?.totalCount).toBe(4);
      expect(docsSection?.completedCount).toBe(3);
      expect(docsSection?.percentage).toBe(75);
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

      // Apenas os 4 docs AT — profReg e insurance não contam
      expect(docsSection?.totalCount).toBe(4);
      expect(docsSection?.completedCount).toBe(0);
    });

    it('worker AT — steps de doc incluem as chaves corretas (sem identity_document_back)', () => {
      const worker = makeWorker({ profession: 'AT' });
      const { result } = renderHook(() => useWorkerProfileProgress(worker));
      const docsSection = result.current.progress.sections.find((s) => s.id === 'documents');
      const stepIds = docsSection?.steps.map((s) => s.id) ?? [];

      expect(stepIds).toContain('doc1'); // resume_cv
      expect(stepIds).toContain('doc2'); // identity_document
      expect(stepIds).toContain('doc3'); // criminal_record
      expect(stepIds).toContain('doc4'); // at_certificate
      expect(stepIds).toHaveLength(4);
    });
  });

  describe('profissão Cuidador (não-AT)', () => {
    it('worker Cuidador com DNI frente + antecedentes → seção docs 100% (verso opcional)', () => {
      const worker = makeWorker({ profession: 'CUIDADOR' });
      const docs = makeDocuments({
        identityDocumentUrl: 'path/dni-front.pdf',
        // identityDocumentBackUrl: ausente — não deve bloquear
        criminalRecordUrl: 'path/criminal.pdf',
      });

      const { result } = renderHook(() => useWorkerProfileProgress(worker, docs));
      const docsSection = result.current.progress.sections.find((s) => s.id === 'documents');

      expect(docsSection?.totalCount).toBe(2);
      expect(docsSection?.completedCount).toBe(2);
      expect(docsSection?.percentage).toBe(100);
    });

    it('worker Cuidador com DNI frente+antecedentes → isComplete true (verso opcional)', () => {
      const worker = makeWorker({ profession: 'CUIDADOR' });
      const docs = makeDocuments({
        identityDocumentUrl: 'path/dni-front.pdf',
        criminalRecordUrl: 'path/criminal.pdf',
      });

      const { result } = renderHook(() => useWorkerProfileProgress(worker, docs));
      expect(result.current.isComplete).toBe(true);
    });

    it('worker Cuidador NÃO exige identityDocumentBack (DNI verso é opcional)', () => {
      const worker = makeWorker({ profession: 'CUIDADOR' });
      const docs = makeDocuments({
        identityDocumentUrl: 'path/dni-front.pdf',
        identityDocumentBackUrl: null, // verso ausente — deve ser ignorado
        criminalRecordUrl: 'path/criminal.pdf',
      });

      const { result } = renderHook(() => useWorkerProfileProgress(worker, docs));
      const docsSection = result.current.progress.sections.find((s) => s.id === 'documents');
      expect(docsSection?.totalCount).toBe(2);
      expect(docsSection?.percentage).toBe(100);
    });

    it('worker Cuidador NÃO exige resume_cv', () => {
      const worker = makeWorker({ profession: 'CUIDADOR' });
      const docs = makeDocuments({
        identityDocumentUrl: 'path/dni-front.pdf',
        criminalRecordUrl: 'path/criminal.pdf',
        resumeCvUrl: null,
      });

      const { result } = renderHook(() => useWorkerProfileProgress(worker, docs));
      const docsSection = result.current.progress.sections.find((s) => s.id === 'documents');
      expect(docsSection?.totalCount).toBe(2);
      expect(docsSection?.percentage).toBe(100);
    });

    it('worker Cuidador NÃO exige at_certificate', () => {
      const worker = makeWorker({ profession: 'CUIDADOR' });
      const docs = makeDocuments({
        identityDocumentUrl: 'path/dni-front.pdf',
        criminalRecordUrl: 'path/criminal.pdf',
        atCertificateUrl: null,
      });

      const { result } = renderHook(() => useWorkerProfileProgress(worker, docs));
      const docsSection = result.current.progress.sections.find((s) => s.id === 'documents');
      expect(docsSection?.totalCount).toBe(2);
      expect(docsSection?.percentage).toBe(100);
    });

    it('worker com profession undefined (inclui undefined como não-AT) → 2 docs obrigatórios', () => {
      const worker = makeWorker({ profession: undefined });
      const docs = makeDocuments({
        identityDocumentUrl: 'path/dni-front.pdf',
        criminalRecordUrl: 'path/criminal.pdf',
      });

      const { result } = renderHook(() => useWorkerProfileProgress(worker, docs));
      const docsSection = result.current.progress.sections.find((s) => s.id === 'documents');
      expect(docsSection?.totalCount).toBe(2);
      expect(docsSection?.completedCount).toBe(2);
      expect(docsSection?.percentage).toBe(100);
    });

    it('worker não-AT sem docs → completedCount 0, totalCount 2', () => {
      const worker = makeWorker({ profession: undefined });
      const docs = makeDocuments();

      const { result } = renderHook(() => useWorkerProfileProgress(worker, docs));
      const docsSection = result.current.progress.sections.find((s) => s.id === 'documents');
      expect(docsSection?.totalCount).toBe(2);
      expect(docsSection?.completedCount).toBe(0);
    });
  });

  describe('nextAction', () => {
    it('CTA de documentos leva direto ao slot do 1º documento obrigatório pendente (rota real, com foco)', () => {
      const worker = makeWorker({ profession: 'CUIDADOR' });
      const docs = makeDocuments(); // todos null — falta identity_document primeiro

      const { result } = renderHook(() => useWorkerProfileProgress(worker, docs));
      // Regressão: a rota antiga '/worker/documents' NÃO existe em App.tsx (cai no catch-all
      // e devolve pra '/'). O CTA tem de usar o contrato real de WorkerProfilePage
      // (?tab=documents&focus=<docType>), reaproveitando incompleteFieldDestinations.
      expect(result.current.progress.nextAction?.route).toBe(
        '/worker/profile?tab=documents&focus=identity_document',
      );
    });

    it('CTA de documentos aponta pro 2º doc pendente quando o 1º já foi enviado (Cuidador)', () => {
      const worker = makeWorker({ profession: 'CUIDADOR' });
      const docs = makeDocuments({ identityDocumentUrl: 'path/dni-front.pdf' }); // falta criminal_record

      const { result } = renderHook(() => useWorkerProfileProgress(worker, docs));
      expect(result.current.progress.nextAction?.route).toBe(
        '/worker/profile?tab=documents&focus=criminal_record',
      );
    });

    it('CTA de documentos para AT aponta pro 1º doc obrigatório pendente (resume_cv)', () => {
      const worker = makeWorker({ profession: 'AT' });
      const docs = makeDocuments(); // todos null

      const { result } = renderHook(() => useWorkerProfileProgress(worker, docs));
      expect(result.current.progress.nextAction?.route).toBe(
        '/worker/profile?tab=documents&focus=resume_cv',
      );
    });

    it('nextAction é undefined quando tudo está completo (Cuidador — verso não exigido)', () => {
      const worker = makeWorker({ profession: 'CUIDADOR' });
      const docs = makeDocuments({
        identityDocumentUrl: 'path/dni-front.pdf',
        // identityDocumentBackUrl: ausente — não é obrigatório
        criminalRecordUrl: 'path/criminal.pdf',
      });

      const { result } = renderHook(() => useWorkerProfileProgress(worker, docs));
      expect(result.current.progress.nextAction).toBeUndefined();
    });
  });
});
