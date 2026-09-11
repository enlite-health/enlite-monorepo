/**
 * workerProgressFixtures.ts
 *
 * Fixture compartilhada de `WorkerProgressResponse`/`WorkerDocumentsResponse`
 * pros testes de progresso/documentos do worker. Extraída porque
 * `useWorkerProfileProgress.test.ts`, `DocumentsGrid.test.tsx` e
 * `WorkerHome.test.tsx` tinham a MESMA estrutura de campos copiada e colada
 * (gate revisao-pr, critério 2 — duplicação >=5 linhas em 3 arquivos).
 *
 * Cada teste chama com overrides — a fixture não decide o cenário, só evita
 * repetir a lista inteira de campos em cada arquivo.
 */
import type { WorkerProgressResponse } from '@infrastructure/http/WorkerApiService';
import type { WorkerDocumentsResponse } from '@infrastructure/http/DocumentApiService';

/**
 * Worker com cadastro completo por padrão (missingFields: []).
 *
 * Reparo que esta fixture NUNCA teve `phone` nem `titleCertificate`, e mesmo
 * assim era considerada "step1 completo" pela lista que o frontend mantinha.
 * Eram exatamente os dois campos que o portão exige e a lista ignorava — o
 * defeito que travou 23 prestadoras estava dentro da própria fixture, verde.
 * Desde 08/09/2026 é o BACKEND (`missingFields`) que define completude — os
 * campos abaixo só hidratam a tela.
 */
export function makeWorkerProgress(
  overrides: Partial<WorkerProgressResponse> = {},
): WorkerProgressResponse {
  return {
    id: 'worker-test-001',
    authUid: 'auth-test-001',
    email: 'test@test.com',
    country: 'AR',
    timezone: 'America/Argentina/Buenos_Aires',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
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
    serviceAddress: 'Av. Corrientes 1234, Buenos Aires',
    serviceRadiusKm: 10,
    availability: { monday: { start: '09:00', end: '17:00' } },
    missingFields: [],
    ...overrides,
  };
}

/** Documentos do worker — todos ausentes por padrão. */
export function makeWorkerDocuments(
  overrides: Partial<WorkerDocumentsResponse> = {},
): WorkerDocumentsResponse {
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
