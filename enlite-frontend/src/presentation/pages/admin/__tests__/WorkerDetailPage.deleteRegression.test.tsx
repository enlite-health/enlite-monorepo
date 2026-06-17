/**
 * WorkerDetailPage.deleteRegression.test.tsx
 *
 * INTEGRATION REGRESSION TEST
 *
 * Cenário do bug original:
 *  - Admin deleta 1 documento (ex: at_certificate)
 *  - Backend responde { success: true } SEM `data`
 *  - AdminApiService devolve `undefined`
 *  - Hook chama `onDocumentsChange(undefined)` → `patchDocuments(undefined)`
 *  - Worker.documents vira `undefined` → TODOS os cards viram empty
 *
 * Este teste integra `WorkerDetailPage` + `useAdminWorkerDocuments` +
 * `useWorkerDetail` e garante que:
 *  1. Backend retornando data: WorkerDocument funciona normalmente (apenas o
 *     campo deletado é limpo).
 *  2. Backend retornando data: undefined (bug) NÃO zera os outros documentos.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, waitFor, fireEvent, act } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import WorkerDetailPage from '../WorkerDetailPage';
import { AdminApiService } from '@infrastructure/http/AdminApiService';
import type { WorkerDetail, WorkerDocument } from '@domain/entities/Worker';

vi.mock('@infrastructure/http/AdminApiService');
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, fallback?: string) => fallback ?? key }),
}));

const WORKER_ID = 'worker-regression-delete';

const DOCS_ALL_UPLOADED: WorkerDocument = {
  id: 'doc-1',
  resumeCvUrl: 'workers/xxx/resume.pdf',
  identityDocumentUrl: 'workers/xxx/identity.pdf',
  identityDocumentBackUrl: 'workers/xxx/identity-back.pdf',
  criminalRecordUrl: 'workers/xxx/criminal.pdf',
  // professional_registration oculto por política ABAC — URL ignorada na UI
  professionalRegistrationUrl: 'workers/xxx/registration.pdf',
  liabilityInsuranceUrl: 'workers/xxx/insurance.pdf',
  monotributoCertificateUrl: 'workers/xxx/mono.pdf',
  atCertificateUrl: 'workers/xxx/at.pdf',
  aptoPsicofisicoUrl: 'workers/xxx/apto.pdf',
  analiticoUniversitarioUrl: 'workers/xxx/analitico.pdf',
  cartaRecomendacionUrl: null,
  additionalCertificatesUrls: [],
  documentsStatus: 'submitted',
  documentValidations: {},
  reviewNotes: null,
  reviewedBy: null,
  reviewedAt: null,
  submittedAt: null,
};

const MOCK_WORKER: WorkerDetail = {
  id: WORKER_ID,
  email: 'ana@test.com',
  phone: '+54 11 5555-0000',
  whatsappPhone: '+54 11 5555-0000',
  country: 'AR',
  timezone: 'America/Argentina/Buenos_Aires',
  status: 'REGISTERED',
  overallStatus: 'QUALIFIED',
  availabilityStatus: 'available',
  dataSources: ['talentum'],
  platform: 'talentum',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-03-01T00:00:00Z',
  firstName: 'Ana', lastName: 'Silva',
  sex: null, gender: null, birthDate: null,
  documentType: null, documentNumber: null, profilePhotoUrl: null,
  profession: 'AT', occupation: null, knowledgeLevel: null,
  titleCertificate: null, experienceTypes: [], yearsExperience: null,
  preferredTypes: [], preferredAgeRange: [], languages: [],
  sexualOrientation: null, race: null, religion: null,
  weightKg: null, heightCm: null, hobbies: [],
  diagnosticPreferences: [], linkedinUrl: null,
  isMatchable: true, isActive: true,
  documents: DOCS_ALL_UPLOADED,
  serviceAreas: [], location: null, encuadres: [], availability: [],
};

function renderPage() {
  return render(
    <MemoryRouter initialEntries={[`/admin/workers/${WORKER_ID}`]}>
      <Routes>
        <Route path="/admin/workers/:id" element={<WorkerDetailPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('WorkerDetailPage — delete regression', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(AdminApiService, 'getWorkerById').mockResolvedValue(MOCK_WORKER);
    vi.spyOn(AdminApiService, 'getWorkerAdditionalDocs').mockResolvedValue([]);
  });

  it('HAPPY PATH: delete com data no response zera APENAS o slot deletado', async () => {
    const AFTER_DELETE: WorkerDocument = { ...DOCS_ALL_UPLOADED, atCertificateUrl: null };
    vi.spyOn(AdminApiService, 'deleteWorkerDoc').mockResolvedValue(AFTER_DELETE);

    const { container } = renderPage();

    // Com profession=AT: 9 slots visíveis (6 universais + 3 atOnly), todos com URL
    // professional_registration está oculto por política ABAC
    await waitFor(() => {
      expect(container.querySelectorAll('[data-state="uploaded"]').length).toBe(9);
    });

    expect(container.querySelectorAll('[data-state="uploaded"]').length).toBe(9);
    expect(container.querySelectorAll('[data-state="empty"]').length).toBe(0);

    // Clica no botão "Remover" do slot at_certificate
    const atSlot = container.querySelector('[data-testid="doc-slot-at_certificate"]');
    expect(atSlot).toBeTruthy();
    const deleteBtn = atSlot!.querySelector('button[aria-label="Remover documento"]') as HTMLButtonElement | null;
    expect(deleteBtn).toBeTruthy();

    await act(async () => {
      fireEvent.click(deleteBtn as HTMLButtonElement);
    });

    await waitFor(() => {
      // Depois: 8 uploaded (at_certificate foi zerado), 1 empty
      expect(container.querySelectorAll('[data-state="uploaded"]').length).toBe(8);
    });

    expect(container.querySelectorAll('[data-state="empty"]').length).toBe(1);

    // Os outros documentos continuam uploaded
    expect(container.querySelector('[data-testid="doc-slot-resume_cv"] [data-state="uploaded"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="doc-slot-identity_document"] [data-state="uploaded"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="doc-slot-criminal_record"] [data-state="uploaded"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="doc-slot-monotributo_certificate"] [data-state="uploaded"]')).toBeTruthy();

    // Apenas o at_certificate virou empty
    expect(container.querySelector('[data-testid="doc-slot-at_certificate"] [data-state="empty"]')).toBeTruthy();
  });

  it('REGRESSION: delete com data=undefined (backend bugado) NÃO zera os outros documentos', async () => {
    // Reproduz o bug original: backend respondendo { success: true } sem data
    vi.spyOn(AdminApiService, 'deleteWorkerDoc').mockResolvedValue(undefined as unknown as WorkerDocument);

    const { container } = renderPage();

    await waitFor(() => {
      expect(container.querySelectorAll('[data-state="uploaded"]').length).toBe(9);
    });

    const atSlot = container.querySelector('[data-testid="doc-slot-at_certificate"]');
    const deleteBtn = atSlot?.querySelector('button[aria-label="Remover documento"]');

    await act(async () => {
      fireEvent.click(deleteBtn as HTMLButtonElement);
    });

    // Aguarda a promise de delete resolver
    await act(async () => { await Promise.resolve(); });

    // CRÍTICO: mesmo com data=undefined, os cards NÃO podem ter sido zerados.
    // Se a proteção defensiva (if docs) falhar, esse assert vai quebrar porque
    // todos os cards viram empty (worker.documents = undefined).
    expect(container.querySelectorAll('[data-state="uploaded"]').length).toBe(9);
    expect(container.querySelectorAll('[data-state="empty"]').length).toBe(0);
  });
});
