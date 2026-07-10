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

import { useAuth } from '@presentation/hooks/useAuth';
import { WorkerApiService } from '@infrastructure/http/WorkerApiService';

const mockUseAuth = vi.mocked(useAuth);
const mockTrackAcquisitionChannel = vi.mocked(WorkerApiService.trackAcquisitionChannel);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const WHATSAPP_URL = 'https://wa.me/5511999999999';
const JOB_POSTING_ID = 'vacancy-123';

/**
 * Creates a WORKER_NOT_ELIGIBLE ApiError with the given missingFields.
 * Mirrors the 403 contract from the backend.
 */
function makeIneligibleError(missingFields: string[] = []): ApiError {
  return new ApiError(
    {
      success: false,
      error: 'registration_incomplete',
      code: 'WORKER_NOT_ELIGIBLE',
      reason: 'Worker is missing required fields',
      workerStatus: 'INCOMPLETE',
      missingFields,
    },
    403,
  );
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

    mockUseAuth.mockReturnValue({
      isAuthenticated: true,
      isLoading: false,
      user: null,
      login: vi.fn(),
      loginWithGoogle: vi.fn(),
      register: vi.fn(),
      logout: vi.fn(),
    });

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
  // 2. No jobPostingId → not_available (backend cannot be consulted)
  // -------------------------------------------------------------------------

  it('sets state to not_available when jobPostingId is null', async () => {
    const { result } = renderHook(() => usePostularseAction(WHATSAPP_URL, null), { wrapper });

    await act(async () => {
      await result.current.postularse();
    });

    expect(result.current.state).toBe('not_available');
    expect(mockTrackAcquisitionChannel).not.toHaveBeenCalled();
    expect(window.open).not.toHaveBeenCalled();
  });

  it('sets state to not_available when jobPostingId is omitted (default)', async () => {
    const { result } = renderHook(() => usePostularseAction(WHATSAPP_URL), { wrapper });

    await act(async () => {
      await result.current.postularse();
    });

    expect(result.current.state).toBe('not_available');
    expect(mockTrackAcquisitionChannel).not.toHaveBeenCalled();
    expect(window.open).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // 3. Not authenticated
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
      const { result } = renderHook(
        () => usePostularseAction(WHATSAPP_URL, JOB_POSTING_ID),
        { wrapper },
      );

      await act(async () => {
        await result.current.postularse();
      });

      expect(result.current.state).toBe('unauthenticated');
      expect(mockTrackAcquisitionChannel).not.toHaveBeenCalled();
      expect(window.open).not.toHaveBeenCalled();
    });

    it('confirmRegister navigates to /register with returnUrl state', async () => {
      sessionStorage.setItem('enlite_vacancy_return_url', '/vacantes/caso1-2');
      const { result } = renderHook(
        () => usePostularseAction(WHATSAPP_URL, JOB_POSTING_ID),
        { wrapper },
      );

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
      const { result } = renderHook(
        () => usePostularseAction(WHATSAPP_URL, JOB_POSTING_ID),
        { wrapper },
      );

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
      const { result } = renderHook(
        () => usePostularseAction(WHATSAPP_URL, JOB_POSTING_ID),
        { wrapper },
      );

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
  // 4. Backend 403 WORKER_NOT_ELIGIBLE → modal with backend missingFields
  // -------------------------------------------------------------------------

  it('sets state to incomplete with string[] missingFields from backend 403', async () => {
    const fields = ['first_name', 'last_name', 'doc_resume_cv'];
    mockTrackAcquisitionChannel.mockRejectedValueOnce(makeIneligibleError(fields));

    const { result } = renderHook(
      () => usePostularseAction(WHATSAPP_URL, JOB_POSTING_ID),
      { wrapper },
    );

    await act(async () => {
      await result.current.postularse();
    });

    expect(result.current.state).toBe('incomplete');
    expect(result.current.missingFields).toEqual(fields);
    expect(window.open).not.toHaveBeenCalled();
    expect(mockTrackAcquisitionChannel).toHaveBeenCalledWith(JOB_POSTING_ID, null);
  });

  it('sets missingFields to [] when backend returns empty missingFields array', async () => {
    mockTrackAcquisitionChannel.mockRejectedValueOnce(makeIneligibleError([]));

    const { result } = renderHook(
      () => usePostularseAction(WHATSAPP_URL, JOB_POSTING_ID),
      { wrapper },
    );

    await act(async () => {
      await result.current.postularse();
    });

    expect(result.current.state).toBe('incomplete');
    expect(result.current.missingFields).toEqual([]);
    expect(window.open).not.toHaveBeenCalled();
  });

  it('falls back to [] when backend WORKER_NOT_ELIGIBLE has no missingFields property', async () => {
    // Older backend that may omit missingFields
    const err = new ApiError(
      { success: false, error: 'registration_incomplete', code: 'WORKER_NOT_ELIGIBLE' },
      403,
    );
    mockTrackAcquisitionChannel.mockRejectedValueOnce(err);

    const { result } = renderHook(
      () => usePostularseAction(WHATSAPP_URL, JOB_POSTING_ID),
      { wrapper },
    );

    await act(async () => {
      await result.current.postularse();
    });

    expect(result.current.state).toBe('incomplete');
    expect(result.current.missingFields).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // 5. Eligible worker → WhatsApp opens after successful track
  // -------------------------------------------------------------------------

  it('opens WhatsApp when trackAcquisitionChannel succeeds', async () => {
    const { result } = renderHook(
      () => usePostularseAction(WHATSAPP_URL, JOB_POSTING_ID),
      { wrapper },
    );

    await act(async () => {
      await result.current.postularse();
    });

    expect(window.open).toHaveBeenCalledWith(WHATSAPP_URL, '_blank');
    expect(result.current.state).toBe('idle');
    expect(result.current.missingFields).toBeNull();
  });

  // -------------------------------------------------------------------------
  // 6. Fail-closed: any non-success outcome must NOT open WhatsApp
  //    (critical business rule — an unverified worker can never reach the
  //    Talentum pre-screening WhatsApp. See ClickUp 86ajfkwf7.)
  // -------------------------------------------------------------------------

  it('does NOT open WhatsApp when track throws a network error (fail-closed)', async () => {
    mockTrackAcquisitionChannel.mockRejectedValueOnce(new Error('Network error'));

    const { result } = renderHook(
      () => usePostularseAction(WHATSAPP_URL, JOB_POSTING_ID),
      { wrapper },
    );

    await act(async () => {
      await result.current.postularse();
    });

    expect(window.open).not.toHaveBeenCalled();
    expect(result.current.state).toBe('error');
  });

  it('does NOT open WhatsApp when backend returns 404 Worker not found (no code)', async () => {
    // A minimal account (email/password only) whose worker row is not yet
    // REGISTERED / not found. Backend replies 404 without WORKER_NOT_ELIGIBLE.
    const err = new ApiError({ success: false, error: 'Worker not found' }, 404);
    mockTrackAcquisitionChannel.mockRejectedValueOnce(err);

    const { result } = renderHook(
      () => usePostularseAction(WHATSAPP_URL, JOB_POSTING_ID),
      { wrapper },
    );

    await act(async () => {
      await result.current.postularse();
    });

    expect(window.open).not.toHaveBeenCalled();
    expect(result.current.state).toBe('error');
  });

  it('does NOT open WhatsApp on unexpected 500 (fail-closed)', async () => {
    const err = new ApiError({ success: false, error: 'Internal error' }, 500);
    mockTrackAcquisitionChannel.mockRejectedValueOnce(err);

    const { result } = renderHook(
      () => usePostularseAction(WHATSAPP_URL, JOB_POSTING_ID),
      { wrapper },
    );

    await act(async () => {
      await result.current.postularse();
    });

    expect(window.open).not.toHaveBeenCalled();
    expect(result.current.state).toBe('error');
  });

  // -------------------------------------------------------------------------
  // 7. UTM sessionStorage handling
  // -------------------------------------------------------------------------

  it('calls trackAcquisitionChannel with null channel when no UTM in sessionStorage', async () => {
    const { result } = renderHook(
      () => usePostularseAction(WHATSAPP_URL, JOB_POSTING_ID),
      { wrapper },
    );

    await act(async () => {
      await result.current.postularse();
    });

    expect(mockTrackAcquisitionChannel).toHaveBeenCalledWith(JOB_POSTING_ID, null);
    expect(window.open).toHaveBeenCalledWith(WHATSAPP_URL, '_blank');
  });

  it('calls trackAcquisitionChannel with UTM channel when present in sessionStorage', async () => {
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
  });

  it('clears enlite_utm_source from sessionStorage after successful track', async () => {
    sessionStorage.setItem('enlite_utm_source', 'facebook');

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

    expect(sessionStorage.getItem('enlite_utm_source')).toBeNull();
  });

  it('does NOT clear sessionStorage when WORKER_NOT_ELIGIBLE (block path)', async () => {
    sessionStorage.setItem('enlite_utm_source', 'whatsapp');
    mockTrackAcquisitionChannel.mockRejectedValueOnce(
      makeIneligibleError(['first_name']),
    );

    const { result } = renderHook(
      () => usePostularseAction(WHATSAPP_URL, JOB_POSTING_ID),
      { wrapper },
    );

    await act(async () => {
      await result.current.postularse();
    });

    // UTM should be preserved so we can retry after the worker completes registration
    expect(sessionStorage.getItem('enlite_utm_source')).toBe('whatsapp');
  });

  it('preserves sessionStorage UTM on network failure (fail-closed, retry after fixing)', async () => {
    sessionStorage.setItem('enlite_utm_source', 'linkedin');
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

    // WhatsApp must NOT open, and UTM is preserved so the attribution survives a retry.
    expect(window.open).not.toHaveBeenCalled();
    expect(sessionStorage.getItem('enlite_utm_source')).toBe('linkedin');
  });

  // -------------------------------------------------------------------------
  // 8. dismissModal resets state and missingFields
  // -------------------------------------------------------------------------

  it('dismissModal resets state to idle and clears missingFields', async () => {
    mockTrackAcquisitionChannel.mockRejectedValueOnce(
      makeIneligibleError(['first_name', 'doc_resume_cv']),
    );

    const { result } = renderHook(
      () => usePostularseAction(WHATSAPP_URL, JOB_POSTING_ID),
      { wrapper },
    );

    await act(async () => {
      await result.current.postularse();
    });

    expect(result.current.state).toBe('incomplete');
    expect(result.current.missingFields).not.toBeNull();

    act(() => {
      result.current.dismissModal();
    });

    expect(result.current.state).toBe('idle');
    expect(result.current.missingFields).toBeNull();
  });

  // -------------------------------------------------------------------------
  // 9. All 21 backend tokens can be present in missingFields (shape check)
  // -------------------------------------------------------------------------

  it('accepts all 21 backend token types in missingFields', async () => {
    const allTokens = [
      'first_name', 'last_name', 'sex', 'gender', 'birth_date', 'document_number',
      'languages', 'phone', 'profession', 'knowledge_level', 'title_certificate',
      'years_experience', 'experience_types', 'preferred_types', 'preferred_age_range',
      'worker_service_areas', 'worker_availability',
      'doc_resume_cv', 'doc_identity_document', 'doc_criminal_record', 'doc_at_certificate',
    ];
    mockTrackAcquisitionChannel.mockRejectedValueOnce(makeIneligibleError(allTokens));

    const { result } = renderHook(
      () => usePostularseAction(WHATSAPP_URL, JOB_POSTING_ID),
      { wrapper },
    );

    await act(async () => {
      await result.current.postularse();
    });

    expect(result.current.state).toBe('incomplete');
    expect(result.current.missingFields).toEqual(allTokens);
    expect(result.current.missingFields).toHaveLength(21);
  });
});
