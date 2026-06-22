/**
 * useDedupGroupDetail.test.ts
 *
 * Covers:
 * - phoneNormalized=null skips fetch (detail stays null)
 * - Happy path: loads detail with fields and reparent_preview
 * - Error path: Error and plain string
 * - refetch() triggers re-fetch
 * - merge(): success path and error path
 * - dismiss(): success path and error path
 * - hasConflict detection: counted fields with has_conflict
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { useDedupGroupDetail } from '../useDedupGroupDetail';
import { AdminDedupApiService } from '@infrastructure/http/AdminDedupApiService';
import type { DedupGroupDetail, MergeRequest, DismissRequest } from '@domain/entities/DedupGroup';

vi.mock('@infrastructure/http/AdminDedupApiService');

const PHONE = '+5491112345678';

const MOCK_DETAIL: DedupGroupDetail = {
  phone_normalized: PHONE,
  accounts: [
    {
      id: 'acc-001',
      email: 'a@test.com',
      tier: 'REGISTERED',
      status: 'ACTIVE',
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
      wja_count: 3,
      docs_count: 2,
      encuadres_count: 1,
      login_real: true,
    },
    {
      id: 'acc-002',
      email: null,
      tier: 'INCOMPLETE_REGISTER',
      status: 'INCOMPLETE',
      created_at: '2026-02-01T00:00:00Z',
      updated_at: '2026-02-01T00:00:00Z',
      wja_count: 0,
      docs_count: 0,
      encuadres_count: 0,
      login_real: false,
    },
  ],
  survivor_suggested: 'acc-001',
  field_comparisons: [
    {
      field: 'email',
      values: { 'acc-001': 'a@test.com', 'acc-002': null },
      is_encrypted: false,
      has_conflict: false,
    },
    {
      field: 'firstName',
      values: { 'acc-001': 'María', 'acc-002': 'Maria' },
      is_encrypted: false,
      has_conflict: true,
    },
    {
      field: 'documentNumber',
      values: { 'acc-001': null, 'acc-002': null },
      is_encrypted: true,
      has_conflict: false,
    },
  ],
  reparent_preview: [
    { entity: 'worker_job_applications', count: 3 },
    { entity: 'worker_documents', count: 2 },
  ],
};

const MOCK_MERGE_RESULT = {
  survivorId: 'acc-001',
  absorbedIds: ['acc-002'],
  mergedAt: '2026-06-22T10:00:00Z',
};

const MOCK_DISMISS_RESULT = {
  phoneNormalized: PHONE,
  dismissedAt: '2026-06-22T10:00:00Z',
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('useDedupGroupDetail — skip when null', () => {
  it('does not call API and keeps detail null when phoneNormalized is null', async () => {
    const spy = vi.spyOn(AdminDedupApiService, 'getGroupDetail');

    const { result } = renderHook(() => useDedupGroupDetail(null));

    // Give it a tick
    await new Promise((r) => setTimeout(r, 50));

    expect(spy).not.toHaveBeenCalled();
    expect(result.current.detail).toBeNull();
    expect(result.current.isLoading).toBe(false);
  });
});

describe('useDedupGroupDetail — happy path', () => {
  it('fetches and sets detail', async () => {
    vi.spyOn(AdminDedupApiService, 'getGroupDetail').mockResolvedValue(MOCK_DETAIL);

    const { result } = renderHook(() => useDedupGroupDetail(PHONE));
    expect(result.current.isLoading).toBe(true);

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.detail).toEqual(MOCK_DETAIL);
    expect(result.current.error).toBeNull();
  });

  it('correctly surfaces conflicting fields', async () => {
    vi.spyOn(AdminDedupApiService, 'getGroupDetail').mockResolvedValue(MOCK_DETAIL);

    const { result } = renderHook(() => useDedupGroupDetail(PHONE));
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    const conflicts = result.current.detail!.field_comparisons.filter(
      (f) => f.has_conflict,
    );
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].field).toBe('firstName');
  });

  it('correctly identifies encrypted fields', async () => {
    vi.spyOn(AdminDedupApiService, 'getGroupDetail').mockResolvedValue(MOCK_DETAIL);

    const { result } = renderHook(() => useDedupGroupDetail(PHONE));
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    const encrypted = result.current.detail!.field_comparisons.filter(
      (f) => f.is_encrypted,
    );
    expect(encrypted).toHaveLength(1);
    expect(encrypted[0].field).toBe('documentNumber');
  });
});

describe('useDedupGroupDetail — error state', () => {
  it('sets error when getGroupDetail throws Error', async () => {
    vi.spyOn(AdminDedupApiService, 'getGroupDetail').mockRejectedValue(
      new Error('Not found'),
    );

    const { result } = renderHook(() => useDedupGroupDetail(PHONE));
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.error).toBe('Not found');
    expect(result.current.detail).toBeNull();
  });

  it('sets generic error for non-Error throws', async () => {
    vi.spyOn(AdminDedupApiService, 'getGroupDetail').mockRejectedValue('oops');

    const { result } = renderHook(() => useDedupGroupDetail(PHONE));
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.error).toBe('Error al cargar detalle del grupo');
  });
});

describe('useDedupGroupDetail — refetch', () => {
  it('refetch() triggers a second API call', async () => {
    const spy = vi
      .spyOn(AdminDedupApiService, 'getGroupDetail')
      .mockResolvedValue(MOCK_DETAIL);

    const { result } = renderHook(() => useDedupGroupDetail(PHONE));
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(spy).toHaveBeenCalledTimes(1);

    act(() => result.current.refetch());

    await waitFor(() => expect(spy).toHaveBeenCalledTimes(2));
  });
});

describe('useDedupGroupDetail — merge mutation', () => {
  it('calls AdminDedupApiService.merge and returns result', async () => {
    vi.spyOn(AdminDedupApiService, 'getGroupDetail').mockResolvedValue(MOCK_DETAIL);
    const spy = vi
      .spyOn(AdminDedupApiService, 'merge')
      .mockResolvedValue(MOCK_MERGE_RESULT);

    const { result } = renderHook(() => useDedupGroupDetail(PHONE));
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    const payload: MergeRequest = {
      survivorId: 'acc-001',
      absorbedIds: ['acc-002'],
    };

    let mergeResult: unknown;
    await act(async () => {
      mergeResult = await result.current.merge(payload);
    });

    expect(spy).toHaveBeenCalledWith(payload);
    expect(mergeResult).toEqual(MOCK_MERGE_RESULT);
    expect(result.current.mergeError).toBeNull();
  });

  it('sets mergeError when merge throws', async () => {
    vi.spyOn(AdminDedupApiService, 'getGroupDetail').mockResolvedValue(MOCK_DETAIL);
    vi.spyOn(AdminDedupApiService, 'merge').mockRejectedValue(
      new Error('Merge failed'),
    );

    const { result } = renderHook(() => useDedupGroupDetail(PHONE));
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await act(async () => {
      try {
        await result.current.merge({ survivorId: 'acc-001', absorbedIds: ['acc-002'] });
      } catch {
        // expected
      }
    });

    expect(result.current.mergeError).toBe('Merge failed');
  });
});

describe('useDedupGroupDetail — dismiss mutation', () => {
  it('calls AdminDedupApiService.dismiss and returns result', async () => {
    vi.spyOn(AdminDedupApiService, 'getGroupDetail').mockResolvedValue(MOCK_DETAIL);
    const spy = vi
      .spyOn(AdminDedupApiService, 'dismiss')
      .mockResolvedValue(MOCK_DISMISS_RESULT);

    const { result } = renderHook(() => useDedupGroupDetail(PHONE));
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    const payload: DismissRequest = { phoneNormalized: PHONE, reason: 'not_a_dup' };

    let dismissResult: unknown;
    await act(async () => {
      dismissResult = await result.current.dismiss(payload);
    });

    expect(spy).toHaveBeenCalledWith(payload);
    expect(dismissResult).toEqual(MOCK_DISMISS_RESULT);
    expect(result.current.dismissError).toBeNull();
  });

  it('sets dismissError when dismiss throws', async () => {
    vi.spyOn(AdminDedupApiService, 'getGroupDetail').mockResolvedValue(MOCK_DETAIL);
    vi.spyOn(AdminDedupApiService, 'dismiss').mockRejectedValue(
      new Error('Dismiss failed'),
    );

    const { result } = renderHook(() => useDedupGroupDetail(PHONE));
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await act(async () => {
      try {
        await result.current.dismiss({ phoneNormalized: PHONE });
      } catch {
        // expected
      }
    });

    expect(result.current.dismissError).toBe('Dismiss failed');
  });
});
