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
import type { EncuadreRole } from '@domain/entities/EncuadreRole';

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

  it('rejectBlocked: valor não-Error cai no fallback "Erro desconhecido"', async () => {
    vi.mocked(AdminApiService.rejectBlockedAttempt).mockRejectedValue('boom-string');
    const { result } = await mountReady();

    let ret: { message: string } | null = null;
    await act(async () => {
      ret = await result.current.rejectBlocked('ba-9', 'OTHER');
    });

    expect(ret).toEqual({ message: 'Erro desconhecido' });
  });

  it('unrejectBlocked ApiError: mapeia message/code/reason/workerStatus', async () => {
    vi.mocked(AdminApiService.restoreBlockedAttempt).mockRejectedValue(
      new ApiError({ success: false, error: 'boom', code: 'X', reason: 'r', workerStatus: 'DISABLED' }, 409),
    );
    const { result } = await mountReady();

    let ret: { message: string; code?: string; reason?: string; workerStatus?: string | null } | null = null;
    await act(async () => {
      ret = await result.current.unrejectBlocked('ba-42');
    });

    expect(ret).toEqual({ message: 'boom', code: 'X', reason: 'r', workerStatus: 'DISABLED' });
  });

  it('unrejectBlocked Error genérico: mapeia só a message', async () => {
    vi.mocked(AdminApiService.restoreBlockedAttempt).mockRejectedValue(new Error('network down'));
    const { result } = await mountReady();

    let ret: { message: string } | null = null;
    await act(async () => {
      ret = await result.current.unrejectBlocked('ba-42');
    });

    expect(ret).toEqual({ message: 'network down' });
  });

  it('unrejectBlocked: valor não-Error cai no fallback "Erro desconhecido"', async () => {
    vi.mocked(AdminApiService.restoreBlockedAttempt).mockRejectedValue('boom-string');
    const { result } = await mountReady();

    let ret: { message: string } | null = null;
    await act(async () => {
      ret = await result.current.unrejectBlocked('ba-42');
    });

    expect(ret).toEqual({ message: 'Erro desconhecido' });
  });
});

describe('useWJAFunnel — fetchFunnel (busca inicial e guarda)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('vacancyId ausente: nunca chama a API nem sai de isLoading=true', async () => {
    const { result } = renderHook(() => useWJAFunnel(undefined));
    await act(async () => {});
    expect(AdminApiService.getEncuadreFunnel).not.toHaveBeenCalled();
    expect(result.current.isLoading).toBe(true);
  });

  it('erro na busca inicial (Error): seta error com a message', async () => {
    vi.mocked(AdminApiService.getEncuadreFunnel).mockRejectedValue(new Error('network down'));
    const { result } = renderHook(() => useWJAFunnel(VACANCY_ID));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.error).toBe('network down');
    expect(result.current.data).toBeNull();
  });

  it('erro na busca inicial (valor não-Error): cai no fallback "Failed to load funnel"', async () => {
    vi.mocked(AdminApiService.getEncuadreFunnel).mockRejectedValue('boom-string');
    const { result } = renderHook(() => useWJAFunnel(VACANCY_ID));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.error).toBe('Failed to load funnel');
  });
});

describe('useWJAFunnel — moveEncuadre', () => {
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

  it('success: repassa todos os campos (schedule incluso), refaz o fetch e retorna null', async () => {
    vi.mocked(AdminApiService.moveEncuadre).mockResolvedValue(undefined);
    const { result } = await mountReady();

    let ret: unknown;
    await act(async () => {
      ret = await result.current.moveEncuadre('enc-1', 'CONFIRMED', 'CAT', 'TITULAR' as EncuadreRole, {
        interviewDate: '2026-09-01',
        interviewTime: '10:00',
        interviewMeetLink: 'https://meet.example/x',
      });
    });

    expect(ret).toBeNull();
    expect(AdminApiService.moveEncuadre).toHaveBeenCalledWith('enc-1', {
      targetStage: 'CONFIRMED',
      rejectionReasonCategory: 'CAT',
      role: 'TITULAR',
      interviewDate: '2026-09-01',
      interviewTime: '10:00',
      interviewMeetLink: 'https://meet.example/x',
    });
    expect(AdminApiService.getEncuadreFunnel).toHaveBeenCalledTimes(1);
  });

  it('ApiError: mapeia message/code/reason/workerStatus', async () => {
    vi.mocked(AdminApiService.moveEncuadre).mockRejectedValue(
      new ApiError({ success: false, error: 'boom', code: 'WORKER_NOT_ELIGIBLE', reason: 'r', workerStatus: 'DISABLED' }, 409),
    );
    const { result } = await mountReady();

    let ret: { message: string; code?: string; reason?: string; workerStatus?: string | null } | null = null;
    await act(async () => {
      ret = await result.current.moveEncuadre('enc-1', 'REJECTED');
    });

    expect(ret).toEqual({ message: 'boom', code: 'WORKER_NOT_ELIGIBLE', reason: 'r', workerStatus: 'DISABLED' });
    // erro não derruba o funil: nenhum refetch acontece após falha
    expect(AdminApiService.getEncuadreFunnel).not.toHaveBeenCalled();
  });

  it('Error genérico: mapeia só a message', async () => {
    vi.mocked(AdminApiService.moveEncuadre).mockRejectedValue(new Error('network down'));
    const { result } = await mountReady();

    let ret: { message: string } | null = null;
    await act(async () => {
      ret = await result.current.moveEncuadre('enc-1', 'REJECTED');
    });

    expect(ret).toEqual({ message: 'network down' });
  });

  it('valor não-Error: cai no fallback "Erro desconhecido"', async () => {
    vi.mocked(AdminApiService.moveEncuadre).mockRejectedValue('boom-string');
    const { result } = await mountReady();

    let ret: { message: string } | null = null;
    await act(async () => {
      ret = await result.current.moveEncuadre('enc-1', 'REJECTED');
    });

    expect(ret).toEqual({ message: 'Erro desconhecido' });
  });
});

/**
 * D300 — promoteBlocked: o card ELEGIBLE vira candidatura real.
 *
 * Mesmo contrato dos irmãos (null = sucesso, objeto = falha mapeada), com uma
 * diferença que importa: o 409 aqui não é erro de sistema, é o mundo tendo mudado
 * entre a tela carregar e a recrutadora clicar. O `reason` é o que a tela traduz.
 */
describe('useWJAFunnel — promoteBlocked', () => {
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

  it('sucesso: chama promoteBlockedAttempt, refaz o fetch e retorna null', async () => {
    vi.mocked(AdminApiService.promoteBlockedAttempt).mockResolvedValue(undefined);
    const { result } = await mountReady();

    let ret: unknown;
    await act(async () => {
      ret = await result.current.promoteBlocked('ba-eligible');
    });

    expect(ret).toBeNull();
    expect(AdminApiService.promoteBlockedAttempt).toHaveBeenCalledWith('ba-eligible');
    expect(AdminApiService.getEncuadreFunnel).toHaveBeenCalledTimes(1);
  });

  it('409 do backend: devolve o reason, que é o que a tela precisa para explicar', async () => {
    vi.mocked(AdminApiService.promoteBlockedAttempt).mockRejectedValue(
      new ApiError({ success: false, error: 'vacancy_invalid', reason: 'vacancy_invalid' }, 409),
    );
    const { result } = await mountReady();

    let ret: { reason?: string } | null = null;
    await act(async () => {
      ret = await result.current.promoteBlocked('ba-eligible');
    });

    expect(ret!.reason).toBe('vacancy_invalid');
  });

  it('valor não-Error cai no fallback "Erro desconhecido"', async () => {
    vi.mocked(AdminApiService.promoteBlockedAttempt).mockRejectedValue('boom-string');
    const { result } = await mountReady();

    let ret: { message: string } | null = null;
    await act(async () => {
      ret = await result.current.promoteBlocked('ba-eligible');
    });

    expect(ret).toEqual({ message: 'Erro desconhecido' });
  });

  it('Error comum: mapeia a mensagem', async () => {
    vi.mocked(AdminApiService.promoteBlockedAttempt).mockRejectedValue(new Error('network down'));
    const { result } = await mountReady();

    let ret: { message: string } | null = null;
    await act(async () => {
      ret = await result.current.promoteBlocked('ba-eligible');
    });

    expect(ret).toEqual({ message: 'network down' });
  });
});
