/**
 * useWJAFunnel.test.ts
 *
 * Foco: a ação rejectBlocked ("Rechazar" de um card BLOQUEADO).
 * - success  → chama AdminApiService.rejectBlockedAttempt com id + categoria, refaz o fetch, retorna null
 * - ApiError → mapeia code/reason/workerStatus
 * - Error    → mapeia message
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { useWJAFunnel } from '../useWJAFunnel';
import { AdminApiService } from '@infrastructure/http/AdminApiService';
import { ApiError } from '@infrastructure/http/ApiError';

vi.mock('@infrastructure/http/AdminApiService');

const VACANCY_ID = 'vac-1';

function emptyFunnel() {
  return {
    stages: {
      INVITED: [], BLOQUEADO: [], INICIADO: [], PRE_SCREENING: [], IN_PROGRESS: [],
      COMPLETED: [], CONFIRMED: [], SELECTED: [], REJECTED: [],
    },
    totalEncuadres: 0,
  };
}

describe('useWJAFunnel — rejectBlocked', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(AdminApiService.getEncuadreFunnel).mockResolvedValue(emptyFunnel());
  });

  async function mountReady() {
    const hook = renderHook(() => useWJAFunnel(VACANCY_ID));
    await waitFor(() => expect(hook.result.current.isLoading).toBe(false));
    vi.mocked(AdminApiService.getEncuadreFunnel).mockClear();
    return hook;
  }

  it('success: chama rejectBlockedAttempt com id+categoria, refaz o fetch e retorna null', async () => {
    vi.mocked(AdminApiService.rejectBlockedAttempt).mockResolvedValue(undefined);
    const { result } = await mountReady();

    let ret: unknown;
    await act(async () => {
      ret = await result.current.rejectBlocked('ba-42', 'WORKER_DECLINED');
    });

    expect(ret).toBeNull();
    expect(AdminApiService.rejectBlockedAttempt).toHaveBeenCalledWith('ba-42', {
      rejectionReasonCategory: 'WORKER_DECLINED',
    });
    // Refaz o fetch após rejeitar (card sai de BLOQUEADO).
    expect(AdminApiService.getEncuadreFunnel).toHaveBeenCalledTimes(1);
  });

  it('ApiError: mapeia message/code/reason/workerStatus', async () => {
    vi.mocked(AdminApiService.rejectBlockedAttempt).mockRejectedValue(
      new ApiError({ success: false, error: 'boom', code: 'X', reason: 'r', workerStatus: 'DISABLED' }, 409),
    );
    const { result } = await mountReady();

    let ret: { message: string; code?: string; reason?: string; workerStatus?: string | null } | null = null;
    await act(async () => {
      ret = await result.current.rejectBlocked('ba-9', 'OTHER');
    });

    expect(ret).toEqual({ message: 'boom', code: 'X', reason: 'r', workerStatus: 'DISABLED' });
  });

  it('Error genérico: mapeia só a message', async () => {
    vi.mocked(AdminApiService.rejectBlockedAttempt).mockRejectedValue(new Error('network down'));
    const { result } = await mountReady();

    let ret: { message: string } | null = null;
    await act(async () => {
      ret = await result.current.rejectBlocked('ba-9', 'OTHER');
    });

    expect(ret).toEqual({ message: 'network down' });
  });

  it('unrejectBlocked: chama restoreBlockedAttempt, refaz o fetch e retorna null', async () => {
    vi.mocked(AdminApiService.restoreBlockedAttempt).mockResolvedValue(undefined);
    const { result } = await mountReady();

    let ret: unknown;
    await act(async () => {
      ret = await result.current.unrejectBlocked('ba-42');
    });

    expect(ret).toBeNull();
    expect(AdminApiService.restoreBlockedAttempt).toHaveBeenCalledWith('ba-42');
    expect(AdminApiService.getEncuadreFunnel).toHaveBeenCalledTimes(1);
  });
});
