import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import React from 'react';
import { usePostularseAction } from '../usePostularseAction';
import { ApiError } from '@infrastructure/http/ApiError';

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

const mockNavigate = vi.fn();

vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>();
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

vi.mock('@presentation/hooks/useAuth');
vi.mock('@infrastructure/http/WorkerApiService');
vi.mock('@infrastructure/http/DocumentApiService');

import { useAuth } from '@presentation/hooks/useAuth';
import { WorkerApiService } from '@infrastructure/http/WorkerApiService';
import { DocumentApiService } from '@infrastructure/http/DocumentApiService';

const mockUseAuth = vi.mocked(useAuth);
const mockGetProgress = vi.mocked(WorkerApiService.getProgress);
const mockGetAvailability = vi.mocked(WorkerApiService.getAvailability);
const mockGetDocuments = vi.mocked(DocumentApiService.getDocuments);
const mockTrackAcquisitionChannel = vi.mocked(WorkerApiService.trackAcquisitionChannel);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const WHATSAPP_URL = 'https://wa.me/5511999999999';
const JOB_POSTING_ID = 'vacancy-123';

// COMPLETE_WORKER tem profession: 'caregiver' (não-AT).
// Docs obrigatórios para Cuidador: identityDocumentUrl, identityDocumentBackUrl, criminalRecordUrl.
// professionalRegistrationUrl e liabilityInsuranceUrl NÃO são mais obrigatórios.
const COMPLETE_DOCS = {
  id: 'doc-1',
  workerId: 'w-1',
  resumeCvUrl: null,
  identityDocumentUrl: 'https://example.com/id.pdf',
  identityDocumentBackUrl: 'https://example.com/id-back.pdf',
  criminalRecordUrl: 'https://example.com/cr.pdf',
  professionalRegistrationUrl: null,
  liabilityInsuranceUrl: null,
  monotributoCertificateUrl: null,
  atCertificateUrl: null,
  aptoPsicofisicoUrl: null,
  analiticoUniversitarioUrl: null,
  cartaRecomendacionUrl: null,
  documentsStatus: 'approved',
  submittedAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

const COMPLETE_AVAILABILITY = [
  { id: 'a-1', workerId: 'w-1', dayOfWeek: 1, startTime: '09:00', endTime: '17:00', timezone: 'America/Argentina/Buenos_Aires', crossesMidnight: false },
];

const COMPLETE_WORKER = {
  id: 'w-1',
  authUid: 'uid-1',
  email: 'at@test.com',
  status: 'active',
  country: 'AR',
  timezone: 'America/Argentina/Buenos_Aires',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  // Step 1 fields (isStep1Complete)
  firstName: 'Ana',
  lastName: 'García',
  birthDate: '1990-05-15',
  sex: 'female',
  gender: 'female',
  documentType: 'CUIL_CUIT',
  documentNumber: '27123456789',
  languages: ['es'],
  profession: 'caregiver',
  knowledgeLevel: 'technical',
  experienceTypes: ['adhd'],
  yearsExperience: '3_5',
  preferredTypes: ['adhd'],
  preferredAgeRange: ['adolescents'],
  // Step 2 fields (isStep2Complete)
  serviceAddress: 'Av. Corrientes 1234, Buenos Aires',
  serviceRadiusKm: 10,
};

const INCOMPLETE_WORKER = {
  ...COMPLETE_WORKER,
  firstName: undefined,
  lastName: undefined,
};

function makeIneligibleError(): ApiError {
  return new ApiError({ success: false, error: 'Worker not eligible', code: 'WORKER_NOT_ELIGIBLE' }, 403);
}

function wrapper({ children }: { children: React.ReactNode }) {
  return React.createElement(MemoryRouter, null, children);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('usePostularseAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('open', vi.fn());
    sessionStorage.clear();

    // Default: authenticated worker with complete registration and docs
    mockUseAuth.mockReturnValue({
      isAuthenticated: true,
      isLoading: false,
      user: null,
      login: vi.fn(),
      loginWithGoogle: vi.fn(),
      register: vi.fn(),
      logout: vi.fn(),
    });

    mockGetProgress.mockResolvedValue(COMPLETE_WORKER);
    mockGetAvailability.mockResolvedValue(COMPLETE_AVAILABILITY);
    mockGetDocuments.mockResolvedValue(COMPLETE_DOCS);
    mockTrackAcquisitionChannel.mockResolvedValue(undefined);
  });

  afterEach(() => {
    sessionStorage.clear();
  });

  // -------------------------------------------------------------------------
  // 1. whatsappUrl null
  // -------------------------------------------------------------------------

  it('sets state to not_available when whatsappUrl is null', async () => {
    const { result } = renderHook(() => usePostularseAction(null), { wrapper });

    await act(async () => {
      await result.current.postularse();
    });

    expect(result.current.state).toBe('not_available');
    expect(mockNavigate).not.toHaveBeenCalled();
    expect(window.open).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // 2. Not authenticated
  // -------------------------------------------------------------------------

  describe('when worker is NOT authenticated', () => {
    beforeEach(() => {
      mockUseAuth.mockReturnValue({
        isAuthenticated: false,
        isLoading: false,
        user: null,
        login: vi.fn(),
        loginWithGoogle: vi.fn(),
        register: vi.fn(),
        logout: vi.fn(),
      });
    });

    it('sets state to unauthenticated', async () => {
      const { result } = renderHook(() => usePostularseAction(WHATSAPP_URL), { wrapper });

      await act(async () => {
        await result.current.postularse();
      });

      expect(result.current.state).toBe('unauthenticated');
      expect(mockGetProgress).not.toHaveBeenCalled();
      expect(window.open).not.toHaveBeenCalled();
    });

    it('confirmRegister navigates to /register with returnUrl state', async () => {
      sessionStorage.setItem('enlite_vacancy_return_url', '/vacantes/caso1-2');
      const { result } = renderHook(() => usePostularseAction(WHATSAPP_URL), { wrapper });

      await act(async () => {
        await result.current.postularse();
      });

      act(() => {
        result.current.confirmRegister();
      });

      expect(mockNavigate).toHaveBeenCalledWith('/register', {
        state: { returnUrl: '/vacantes/caso1-2' },
      });
    });

    it('confirmRegister passes null returnUrl when sessionStorage is empty', async () => {
      const { result } = renderHook(() => usePostularseAction(WHATSAPP_URL), { wrapper });

      await act(async () => {
        await result.current.postularse();
      });

      act(() => {
        result.current.confirmRegister();
      });

      expect(mockNavigate).toHaveBeenCalledWith('/register', {
        state: { returnUrl: null },
      });
    });

    it('dismissModal resets state to idle', async () => {
      const { result } = renderHook(() => usePostularseAction(WHATSAPP_URL), { wrapper });

      await act(async () => {
        await result.current.postularse();
      });

      expect(result.current.state).toBe('unauthenticated');

      act(() => {
        result.current.dismissModal();
      });

      expect(result.current.state).toBe('idle');
    });
  });

  // -------------------------------------------------------------------------
  // 3. Authenticated + registrationCompleted = false — sem jobPostingId
  // -------------------------------------------------------------------------

  it('sets state to incomplete with missingFields when registration is incomplete (no jobPostingId)', async () => {
    mockGetProgress.mockResolvedValue(INCOMPLETE_WORKER);

    const { result } = renderHook(() => usePostularseAction(WHATSAPP_URL), { wrapper });

    await act(async () => {
      await result.current.postularse();
    });

    expect(result.current.state).toBe('incomplete');
    expect(result.current.missingFields).not.toBeNull();
    expect(result.current.missingFields!.registration.firstName).toBe(false);
    expect(result.current.missingFields!.registration.lastName).toBe(false);
    expect(result.current.missingFields!.registration.profession).toBe(true);
    expect(mockNavigate).not.toHaveBeenCalled();
    expect(window.open).not.toHaveBeenCalled();
    // sem jobPostingId → track não deve ser chamado
    expect(mockTrackAcquisitionChannel).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // 4. Authenticated + registrationCompleted = true + docs incompletos (sem jobPostingId)
  // -------------------------------------------------------------------------

  // Docs obrigatórios para Cuidador (profession: 'caregiver'):
  // identityDocumentUrl, identityDocumentBackUrl, criminalRecordUrl.
  // professionalRegistration e liabilityInsurance NÃO são mais obrigatórios.
  // Chaves em missingFields.documents são o nome do campo sem o sufixo "Url"
  // (ex: identityDocumentUrl → identityDocument), conforme detectDocumentFields.
  it.each([
    ['identityDocumentUrl', 'identityDocument', { identityDocumentUrl: null }],
    ['identityDocumentBackUrl', 'identityDocumentBack', { identityDocumentBackUrl: null }],
    ['criminalRecordUrl', 'criminalRecord', { criminalRecordUrl: null }],
  ])(
    'sets state to incomplete when %s is missing (no jobPostingId)',
    async (_fieldName, docKey, missingField) => {
      mockGetDocuments.mockResolvedValue({ ...COMPLETE_DOCS, ...missingField });

      const { result } = renderHook(() => usePostularseAction(WHATSAPP_URL), { wrapper });

      await act(async () => {
        await result.current.postularse();
      });

      expect(result.current.state).toBe('incomplete');
      expect(result.current.missingFields!.documents[docKey]).toBe(false);
      expect(mockNavigate).not.toHaveBeenCalled();
      expect(window.open).not.toHaveBeenCalled();
    },
  );

  // -------------------------------------------------------------------------
  // 5. Authenticated + complete + sem jobPostingId → WhatsApp direto
  // -------------------------------------------------------------------------

  it('opens whatsapp URL when worker is complete with all required documents and no jobPostingId', async () => {
    const { result } = renderHook(() => usePostularseAction(WHATSAPP_URL), { wrapper });

    await act(async () => {
      await result.current.postularse();
    });

    expect(window.open).toHaveBeenCalledWith(WHATSAPP_URL, '_blank');
    expect(mockTrackAcquisitionChannel).not.toHaveBeenCalled();
    expect(mockNavigate).not.toHaveBeenCalled();
    expect(result.current.state).toBe('idle');
  });

  // -------------------------------------------------------------------------
  // 6. getProgress throws → fallback a incomplete
  // -------------------------------------------------------------------------

  it('sets state to incomplete when getProgress throws an error', async () => {
    mockGetProgress.mockRejectedValue(new Error('Network error'));

    const { result } = renderHook(() => usePostularseAction(WHATSAPP_URL), { wrapper });

    await act(async () => {
      await result.current.postularse();
    });

    expect(result.current.state).toBe('incomplete');
    expect(result.current.missingFields).toBeNull();
    expect(mockNavigate).not.toHaveBeenCalled();
    expect(window.open).not.toHaveBeenCalled();
  });

  it('sets state to incomplete when getDocuments throws an error', async () => {
    mockGetDocuments.mockRejectedValue(new Error('Documents fetch failed'));

    const { result } = renderHook(() => usePostularseAction(WHATSAPP_URL), { wrapper });

    await act(async () => {
      await result.current.postularse();
    });

    expect(result.current.state).toBe('incomplete');
    expect(result.current.missingFields).toBeNull();
    expect(mockNavigate).not.toHaveBeenCalled();
    expect(window.open).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // 7. Acquisition channel tracking — novo comportamento
  // -------------------------------------------------------------------------

  describe('acquisition channel tracking', () => {
    // -----------------------------------------------------------------------
    // (a) Worker INCOMPLETO com jobPostingId → backend track É chamado + modal aberto
    // -----------------------------------------------------------------------
    it('(a) calls trackAcquisitionChannel even when worker is incomplete', async () => {
      mockGetProgress.mockResolvedValue(INCOMPLETE_WORKER);
      // Backend retorna 403 WORKER_NOT_ELIGIBLE para worker incompleto
      mockTrackAcquisitionChannel.mockRejectedValueOnce(makeIneligibleError());
      // Re-fetch para montar o modal
      mockGetProgress.mockResolvedValueOnce(INCOMPLETE_WORKER);
      mockGetDocuments.mockResolvedValueOnce(COMPLETE_DOCS);
      mockGetAvailability.mockResolvedValueOnce(COMPLETE_AVAILABILITY);

      const { result } = renderHook(
        () => usePostularseAction(WHATSAPP_URL, JOB_POSTING_ID),
        { wrapper },
      );

      await act(async () => {
        await result.current.postularse();
      });

      // track deve ter sido chamado com channel=null (sem UTM)
      expect(mockTrackAcquisitionChannel).toHaveBeenCalledWith(JOB_POSTING_ID, null);
      // modal de incompleto deve abrir
      expect(result.current.state).toBe('incomplete');
      expect(result.current.missingFields).not.toBeNull();
      expect(result.current.missingFields!.registration.firstName).toBe(false);
      // WhatsApp NÃO deve abrir
      expect(window.open).not.toHaveBeenCalled();
    });

    // -----------------------------------------------------------------------
    // (b) Worker SEM UTM (link direto) → backend track ainda é chamado com channel=null
    // -----------------------------------------------------------------------
    it('(b) calls trackAcquisitionChannel with null channel when no UTM in sessionStorage', async () => {
      // sessionStorage vazio (sem UTM) — garantido pelo beforeEach
      const { result } = renderHook(
        () => usePostularseAction(WHATSAPP_URL, JOB_POSTING_ID),
        { wrapper },
      );

      await act(async () => {
        await result.current.postularse();
      });

      expect(mockTrackAcquisitionChannel).toHaveBeenCalledWith(JOB_POSTING_ID, null);
      expect(window.open).toHaveBeenCalledWith(WHATSAPP_URL, '_blank');
      expect(result.current.state).toBe('idle');
    });

    // -----------------------------------------------------------------------
    // (c) Falha do track (rede) → fluxo NÃO quebra; modal/WhatsApp ocorrem via fallback
    // -----------------------------------------------------------------------
    it('(c) track network failure does not break flow — falls back to client-side check (complete → WhatsApp)', async () => {
      mockTrackAcquisitionChannel.mockRejectedValueOnce(new Error('Network error'));

      const { result } = renderHook(
        () => usePostularseAction(WHATSAPP_URL, JOB_POSTING_ID),
        { wrapper },
      );

      await act(async () => {
        await result.current.postularse();
      });

      // track foi tentado
      expect(mockTrackAcquisitionChannel).toHaveBeenCalledWith(JOB_POSTING_ID, null);
      // worker completo → fallback client-side abre WhatsApp
      expect(window.open).toHaveBeenCalledWith(WHATSAPP_URL, '_blank');
      expect(result.current.state).toBe('idle');
    });

    it('(c) track network failure does not break flow — falls back to client-side check (incomplete → modal)', async () => {
      mockGetProgress.mockResolvedValue(INCOMPLETE_WORKER);
      mockTrackAcquisitionChannel.mockRejectedValueOnce(new Error('Network error'));

      const { result } = renderHook(
        () => usePostularseAction(WHATSAPP_URL, JOB_POSTING_ID),
        { wrapper },
      );

      await act(async () => {
        await result.current.postularse();
      });

      // track foi tentado
      expect(mockTrackAcquisitionChannel).toHaveBeenCalledWith(JOB_POSTING_ID, null);
      // worker incompleto + track falhou por rede → fallback client-side abre modal
      expect(result.current.state).toBe('incomplete');
      expect(result.current.missingFields).not.toBeNull();
      expect(window.open).not.toHaveBeenCalled();
    });

    // -----------------------------------------------------------------------
    // (d) Worker ELEGÍVEL com jobPostingId → WhatsApp aberto após track bem-sucedido
    // -----------------------------------------------------------------------
    it('(d) eligible worker with jobPostingId — track succeeds → opens WhatsApp', async () => {
      sessionStorage.setItem('enlite_utm_source', 'instagram');

      const { result } = renderHook(
        () => usePostularseAction(WHATSAPP_URL, JOB_POSTING_ID),
        { wrapper },
      );

      await act(async () => {
        await result.current.postularse();
      });

      expect(mockTrackAcquisitionChannel).toHaveBeenCalledWith(JOB_POSTING_ID, 'instagram');
      expect(window.open).toHaveBeenCalledWith(WHATSAPP_URL, '_blank');
      expect(result.current.state).toBe('idle');
    });

    // -----------------------------------------------------------------------
    // Comportamentos legados mantidos
    // -----------------------------------------------------------------------

    it('calls trackAcquisitionChannel with UTM channel when utm_source is in sessionStorage', async () => {
      sessionStorage.setItem('enlite_utm_source', 'facebook');
      const { result } = renderHook(
        () => usePostularseAction(WHATSAPP_URL, JOB_POSTING_ID),
        { wrapper },
      );

      await act(async () => {
        await result.current.postularse();
      });

      expect(mockTrackAcquisitionChannel).toHaveBeenCalledWith(JOB_POSTING_ID, 'facebook');
      expect(window.open).toHaveBeenCalledWith(WHATSAPP_URL, '_blank');
    });

    it('does NOT call trackAcquisitionChannel when jobPostingId is null', async () => {
      sessionStorage.setItem('enlite_utm_source', 'instagram');
      const { result } = renderHook(
        () => usePostularseAction(WHATSAPP_URL, null),
        { wrapper },
      );

      await act(async () => {
        await result.current.postularse();
      });

      expect(mockTrackAcquisitionChannel).not.toHaveBeenCalled();
      expect(window.open).toHaveBeenCalledWith(WHATSAPP_URL, '_blank');
    });

    it('still opens WhatsApp when trackAcquisitionChannel fails with network error', async () => {
      sessionStorage.setItem('enlite_utm_source', 'linkedin');
      mockTrackAcquisitionChannel.mockRejectedValueOnce(new Error('Network error'));

      const { result } = renderHook(
        () => usePostularseAction(WHATSAPP_URL, JOB_POSTING_ID),
        { wrapper },
      );

      await act(async () => {
        await result.current.postularse();
      });

      expect(window.open).toHaveBeenCalledWith(WHATSAPP_URL, '_blank');
      expect(result.current.state).toBe('idle');
    });

    it('clears enlite_utm_source from sessionStorage after successful track', async () => {
      sessionStorage.setItem('enlite_utm_source', 'instagram');

      const { result } = renderHook(
        () => usePostularseAction(WHATSAPP_URL, JOB_POSTING_ID),
        { wrapper },
      );

      await act(async () => {
        await result.current.postularse();
      });

      // The .then() callback runs asynchronously; flush microtasks before asserting
      await act(async () => {
        await Promise.resolve();
      });

      expect(mockTrackAcquisitionChannel).toHaveBeenCalledWith(JOB_POSTING_ID, 'instagram');
      expect(sessionStorage.getItem('enlite_utm_source')).toBeNull();
    });

    it('does NOT clear sessionStorage when trackAcquisitionChannel fails', async () => {
      sessionStorage.setItem('enlite_utm_source', 'whatsapp');
      mockTrackAcquisitionChannel.mockRejectedValueOnce(new Error('Network error'));

      const { result } = renderHook(
        () => usePostularseAction(WHATSAPP_URL, JOB_POSTING_ID),
        { wrapper },
      );

      await act(async () => {
        await result.current.postularse();
      });

      await act(async () => {
        await Promise.resolve();
      });

      // sessionStorage should remain intact on failure
      expect(sessionStorage.getItem('enlite_utm_source')).toBe('whatsapp');
    });

    it('shows incomplete modal via backend 403 WORKER_NOT_ELIGIBLE with re-fetched fields', async () => {
      const incompleteWorker = { ...COMPLETE_WORKER, firstName: undefined };
      mockGetProgress
        .mockResolvedValueOnce(incompleteWorker)  // primeira leva de fetches
        .mockResolvedValueOnce(incompleteWorker); // re-fetch após 403
      mockGetDocuments
        .mockResolvedValueOnce(COMPLETE_DOCS)
        .mockResolvedValueOnce(COMPLETE_DOCS);
      mockGetAvailability
        .mockResolvedValueOnce(COMPLETE_AVAILABILITY)
        .mockResolvedValueOnce(COMPLETE_AVAILABILITY);
      mockTrackAcquisitionChannel.mockRejectedValueOnce(makeIneligibleError());

      const { result } = renderHook(
        () => usePostularseAction(WHATSAPP_URL, JOB_POSTING_ID),
        { wrapper },
      );

      await act(async () => {
        await result.current.postularse();
      });

      expect(result.current.state).toBe('incomplete');
      expect(result.current.missingFields!.registration.firstName).toBe(false);
      expect(window.open).not.toHaveBeenCalled();
    });
  });
});
