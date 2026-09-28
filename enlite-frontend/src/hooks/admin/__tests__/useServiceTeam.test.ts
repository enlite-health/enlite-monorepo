/**
 * useServiceTeam — quadro C (DX-10.8): 1 GET por seleção de linha, `reject`/`revert` recebem o
 * time recalculado na resposta (0 GET extra), resposta atrasada de seleção anterior é descartada.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

const getServiceTeam = vi.fn();
const rejectServiceTeamMember = vi.fn();
const revertServiceTeamMember = vi.fn();

// Molde de mock do cliente: usePatientKanban.test.ts:16-18.
vi.mock('@infrastructure/http/AdminContractedServicesApiService', () => ({
  AdminContractedServicesApiService: {
    getServiceTeam: (...a: unknown[]) => getServiceTeam(...a),
    rejectServiceTeamMember: (...a: unknown[]) => rejectServiceTeamMember(...a),
    revertServiceTeamMember: (...a: unknown[]) => revertServiceTeamMember(...a),
  },
  ContractedServiceApiError: class ContractedServiceApiError extends Error {
    readonly status: number;
    readonly code?: string;
    constructor(message: string, status: number, body?: { code?: string }) {
      super(message);
      this.name = 'ContractedServiceApiError';
      this.status = status;
      this.code = body?.code;
    }
  },
}));

import { useServiceTeam } from '../useServiceTeam';
import { ContractedServiceApiError } from '@infrastructure/http/AdminContractedServicesApiService';
import type { ServiceTeam } from '@domain/entities/ServiceTeam';

function team(serviceId: string, vacancyId: string | null = null): ServiceTeam {
  return { serviceId, vacancyId, selected: [], inService: [], rejected: [] };
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('useServiceTeam', () => {
  beforeEach(() => {
    getServiceTeam.mockReset();
    rejectServiceTeamMember.mockReset();
    revertServiceTeamMember.mockReset();
  });

  it('serviceId null: idle, 0 chamadas', () => {
    const { result } = renderHook(() => useServiceTeam('p1', null, 0));
    expect(result.current.status).toBe('idle');
    expect(result.current.team).toBeNull();
    expect(getServiceTeam).not.toHaveBeenCalled();
  });

  it('seleção: exatamente 1 GET, com patientId e serviceId; time no estado', async () => {
    getServiceTeam.mockResolvedValueOnce(team('s1'));
    const { result } = renderHook(() => useServiceTeam('p1', 's1', 0));
    await waitFor(() => expect(result.current.status).toBe('ok'));
    expect(getServiceTeam).toHaveBeenCalledTimes(1);
    expect(getServiceTeam).toHaveBeenCalledWith('p1', 's1');
    expect(result.current.team).toEqual(team('s1'));
  });

  it('o MESMO serviceId com selectionNonce + 1 → +1 GET (re-clicar a mesma linha "atualiza")', async () => {
    getServiceTeam.mockResolvedValue(team('s1'));
    const { result, rerender } = renderHook(({ nonce }) => useServiceTeam('p1', 's1', nonce), {
      initialProps: { nonce: 0 },
    });
    await waitFor(() => expect(result.current.status).toBe('ok'));
    expect(getServiceTeam).toHaveBeenCalledTimes(1);
    rerender({ nonce: 1 });
    await waitFor(() => expect(getServiceTeam).toHaveBeenCalledTimes(2));
  });

  it('gate parcial #8: duas seleções da MESMA linha (nonce muda) — a 1ª resposta chegando DEPOIS da 2ª não sobrescreve, o estado fica com o time da 2ª', async () => {
    const first = deferred<ServiceTeam>();
    const second = deferred<ServiceTeam>();
    getServiceTeam.mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise);
    const { result, rerender } = renderHook(({ nonce }) => useServiceTeam('p1', 's1', nonce), {
      initialProps: { nonce: 0 },
    });
    rerender({ nonce: 1 });
    expect(getServiceTeam).toHaveBeenCalledTimes(2);

    // a 2ª requisição (a mais recente) resolve primeiro.
    const secondTeam = team('s1', 'v2');
    await act(async () => {
      second.resolve(secondTeam);
      await second.promise;
    });
    await waitFor(() => expect(result.current.status).toBe('ok'));
    expect(result.current.team).toEqual(secondTeam);

    // a resposta ATRASADA da 1ª requisição (mesmo serviceId!) chega depois — é descartada.
    const firstTeam = team('s1', 'v1');
    await act(async () => {
      first.resolve(firstTeam);
      await first.promise;
    });
    expect(result.current.team).toEqual(secondTeam);
  });

  it('troca de serviço com a resposta antiga chegando depois: o estado fica com o time do serviço corrente', async () => {
    const first = deferred<ServiceTeam>();
    const second = deferred<ServiceTeam>();
    getServiceTeam.mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise);
    const { result, rerender } = renderHook(({ sid }) => useServiceTeam('p1', sid, 0), {
      initialProps: { sid: 's1' },
    });
    rerender({ sid: 's2' });

    // a resposta de s2 (seleção atual) chega primeiro
    await act(async () => {
      second.resolve(team('s2'));
      await second.promise;
    });
    await waitFor(() => expect(result.current.status).toBe('ok'));
    expect(result.current.team).toEqual(team('s2'));

    // a resposta atrasada de s1 (seleção anterior) chega depois — é descartada
    await act(async () => {
      first.resolve(team('s1'));
      await first.promise;
    });
    expect(result.current.team).toEqual(team('s2'));
  });

  it('reject ok: 0 GET extra e o time da resposta no estado', async () => {
    getServiceTeam.mockResolvedValueOnce(team('s1'));
    const rejected = team('s1', null);
    rejectServiceTeamMember.mockResolvedValueOnce(rejected);
    const { result } = renderHook(() => useServiceTeam('p1', 's1', 0));
    await waitFor(() => expect(result.current.status).toBe('ok'));
    getServiceTeam.mockClear();

    await act(async () => {
      await result.current.reject('w1', 'INDISPONIBILIDADE_DE_HORARIO');
    });
    expect(getServiceTeam).not.toHaveBeenCalled();
    expect(rejectServiceTeamMember).toHaveBeenCalledWith('p1', 's1', 'w1', 'INDISPONIBILIDADE_DE_HORARIO');
    expect(result.current.team).toEqual(rejected);
    expect(result.current.status).toBe('ok');
  });

  it('revert ok: 0 GET extra e o time da resposta no estado', async () => {
    getServiceTeam.mockResolvedValueOnce(team('s1'));
    const reverted = team('s1', 'v1');
    revertServiceTeamMember.mockResolvedValueOnce(reverted);
    const { result } = renderHook(() => useServiceTeam('p1', 's1', 0));
    await waitFor(() => expect(result.current.status).toBe('ok'));
    getServiceTeam.mockClear();

    await act(async () => {
      await result.current.revert('w1', 'REAVALIACAO');
    });
    expect(getServiceTeam).not.toHaveBeenCalled();
    expect(revertServiceTeamMember).toHaveBeenCalledWith('p1', 's1', 'w1', 'REAVALIACAO');
    expect(result.current.team).toEqual(reverted);
  });

  it('422 na ação: actionError = SERVICE_TEAM_WORKER_ALLOCATED', async () => {
    getServiceTeam.mockResolvedValueOnce(team('s1'));
    rejectServiceTeamMember.mockRejectedValueOnce(
      new ContractedServiceApiError('remova do itinerário primeiro', 422, { code: 'SERVICE_TEAM_WORKER_ALLOCATED' }),
    );
    const { result } = renderHook(() => useServiceTeam('p1', 's1', 0));
    await waitFor(() => expect(result.current.status).toBe('ok'));

    await act(async () => {
      await result.current.reject('w1', 'OTHER');
    });
    expect(result.current.actionError).toBe('SERVICE_TEAM_WORKER_ALLOCATED');
  });

  it('403 na ação: status vira forbidden', async () => {
    getServiceTeam.mockResolvedValueOnce(team('s1'));
    revertServiceTeamMember.mockRejectedValueOnce(new ContractedServiceApiError('sem célula', 403));
    const { result } = renderHook(() => useServiceTeam('p1', 's1', 0));
    await waitFor(() => expect(result.current.status).toBe('ok'));

    await act(async () => {
      await result.current.revert('w1', 'REAVALIACAO');
    });
    expect(result.current.status).toBe('forbidden');
  });

  it('500 na ação: status vira error', async () => {
    getServiceTeam.mockResolvedValueOnce(team('s1'));
    rejectServiceTeamMember.mockRejectedValueOnce(new ContractedServiceApiError('boom', 500));
    const { result } = renderHook(() => useServiceTeam('p1', 's1', 0));
    await waitFor(() => expect(result.current.status).toBe('ok'));

    await act(async () => {
      await result.current.reject('w1', 'OTHER');
    });
    expect(result.current.status).toBe('error');
  });

  it('GET com 403: status forbidden; próxima seleção com outro erro: status error', async () => {
    getServiceTeam.mockRejectedValueOnce(new ContractedServiceApiError('sem célula', 403));
    const { result, rerender } = renderHook(({ sid }) => useServiceTeam('p1', sid, 0), {
      initialProps: { sid: 's1' },
    });
    await waitFor(() => expect(result.current.status).toBe('forbidden'));

    getServiceTeam.mockRejectedValueOnce(new Error('rede'));
    rerender({ sid: 's2' });
    await waitFor(() => expect(result.current.status).toBe('error'));
  });

  it('reject/revert sem seleção (serviceId null) não chama a API', async () => {
    const { result } = renderHook(() => useServiceTeam('p1', null, 0));
    await act(async () => {
      await result.current.reject('w1', 'OTHER');
      await result.current.revert('w1', 'OTHER');
    });
    expect(rejectServiceTeamMember).not.toHaveBeenCalled();
    expect(revertServiceTeamMember).not.toHaveBeenCalled();
  });
});
