/**
 * useDedupGroupDetail.nonError.test.ts
 *
 * Covers the non-Error (plain string/value) catch branches in merge and dismiss:
 *
 * - merge throws a non-Error value → sets "Error al ejecutar el merge"
 *   (lines 97-100 in useDedupGroupDetail.ts)
 * - dismiss throws a non-Error value → sets "Error al descartar el grupo"
 *   (lines 113-116 in useDedupGroupDetail.ts)
 *
 * These are the uncovered branches shown in coverage report:
 *   hooks/admin/useDedupGroupDetail.ts → 77.27% branch | lines 65,97-100,113-116
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { useDedupGroupDetail } from '../useDedupGroupDetail';
import { AdminDedupApiService } from '@infrastructure/http/AdminDedupApiService';
import type { DedupGroupDetail } from '@domain/entities/DedupGroup';

vi.mock('@infrastructure/http/AdminDedupApiService');

const PHONE = '+5491199998888';

const MOCK_DETAIL: DedupGroupDetail = {
  phone_normalized: PHONE,
  accounts: [
    {
      id: 'acc-x1',
      email: 'x1@test.com',
      tier: 'REGISTERED',
      status: 'ACTIVE',
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
      wja_count: 1,
      docs_count: 0,
      encuadres_count: 0,
      login_real: true,
    },
  ],
  survivor_suggested: 'acc-x1',
  field_comparisons: [],
  reparent_preview: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(AdminDedupApiService, 'getGroupDetail').mockResolvedValue(MOCK_DETAIL);
});

// ── merge — non-Error throw (lines 97-100) ────────────────────────────────────

describe('useDedupGroupDetail — merge non-Error catch (lines 97-100)', () => {
  it('sets "Error al ejecutar el merge" when merge throws a plain string', async () => {
    vi.spyOn(AdminDedupApiService, 'merge').mockRejectedValue('plain string error');

    const { result } = renderHook(() => useDedupGroupDetail(PHONE));
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await act(async () => {
      try {
        await result.current.merge({ survivorId: 'acc-x1', absorbedIds: [] });
      } catch {
        // expected to rethrow
      }
    });

    expect(result.current.mergeError).toBe('Error al ejecutar el merge');
  });

  it('sets "Error al ejecutar el merge" when merge throws a number', async () => {
    vi.spyOn(AdminDedupApiService, 'merge').mockRejectedValue(42);

    const { result } = renderHook(() => useDedupGroupDetail(PHONE));
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await act(async () => {
      try {
        await result.current.merge({ survivorId: 'acc-x1', absorbedIds: [] });
      } catch {
        // expected
      }
    });

    expect(result.current.mergeError).toBe('Error al ejecutar el merge');
  });

  it('merge re-throws the original non-Error value', async () => {
    const originalError = 'raw-error-value';
    vi.spyOn(AdminDedupApiService, 'merge').mockRejectedValue(originalError);

    const { result } = renderHook(() => useDedupGroupDetail(PHONE));
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    let caughtError: unknown;
    await act(async () => {
      try {
        await result.current.merge({ survivorId: 'acc-x1', absorbedIds: [] });
      } catch (e) {
        caughtError = e;
      }
    });

    expect(caughtError).toBe(originalError);
  });
});

// ── dismiss — non-Error throw (lines 113-116) ─────────────────────────────────

describe('useDedupGroupDetail — dismiss non-Error catch (lines 113-116)', () => {
  it('sets "Error al descartar el grupo" when dismiss throws a plain string', async () => {
    vi.spyOn(AdminDedupApiService, 'dismiss').mockRejectedValue('plain string dismiss error');

    const { result } = renderHook(() => useDedupGroupDetail(PHONE));
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await act(async () => {
      try {
        await result.current.dismiss({ phoneNormalized: PHONE });
      } catch {
        // expected to rethrow
      }
    });

    expect(result.current.dismissError).toBe('Error al descartar el grupo');
  });

  it('sets "Error al descartar el grupo" when dismiss throws null', async () => {
    vi.spyOn(AdminDedupApiService, 'dismiss').mockRejectedValue(null);

    const { result } = renderHook(() => useDedupGroupDetail(PHONE));
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await act(async () => {
      try {
        await result.current.dismiss({ phoneNormalized: PHONE });
      } catch {
        // expected
      }
    });

    expect(result.current.dismissError).toBe('Error al descartar el grupo');
  });

  it('dismiss re-throws the original non-Error value', async () => {
    const originalError = { code: 'DISMISS_FAILED' };
    vi.spyOn(AdminDedupApiService, 'dismiss').mockRejectedValue(originalError);

    const { result } = renderHook(() => useDedupGroupDetail(PHONE));
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    let caughtError: unknown;
    await act(async () => {
      try {
        await result.current.dismiss({ phoneNormalized: PHONE });
      } catch (e) {
        caughtError = e;
      }
    });

    expect(caughtError).toBe(originalError);
  });
});
