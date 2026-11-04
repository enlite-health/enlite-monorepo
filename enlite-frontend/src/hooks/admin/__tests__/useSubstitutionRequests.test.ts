/**
 * useSubstitutionRequests — spec 069, FR-20: a lista de pedidos do serviço (Próximas/Pasadas); guarda por requestId, 403 → forbidden,
 * `refreshKey` e `refresh` refazem o GET.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { AdminSubstitutionRequestsApiService } from '@infrastructure/http/AdminSubstitutionRequestsApiService';
import { ContractedServiceApiError } from '@infrastructure/http/AdminContractedServicesApiService';
import { useSubstitutionRequests } from '../useSubstitutionRequests';

vi.mock('@infrastructure/http/AdminSubstitutionRequestsApiService', () => ({ AdminSubstitutionRequestsApiService: { list: vi.fn() } }));
const list = AdminSubstitutionRequestsApiService.list as ReturnType<typeof vi.fn>;
const ok = (requests: unknown[]) => ({ patientId: 'p-1', serviceId: 's-1', when: 'upcoming', requests });

beforeEach(() => {
  list.mockReset();
});

describe('useSubstitutionRequests', () => {
  it('feliz: 1 GET com o filtro; requests chega só depois de carregar', async () => {
    list.mockResolvedValue(ok([{ requestId: 'r-1' }]));
    const { result } = renderHook(() => useSubstitutionRequests('p-1', 's-1', 'upcoming'));
    expect(result.current.status).toBe('loading');
    expect(result.current.requests).toBeNull();
    await waitFor(() => expect(result.current.status).toBe('ok'));
    expect(result.current.requests).toEqual([{ requestId: 'r-1' }]);
    expect(list).toHaveBeenCalledWith('p-1', 's-1', 'upcoming');
  });

  it('trocar Próximas → Pasadas refaz o GET e zera a lista enquanto carrega (nunca mostra o filtro errado)', async () => {
    list.mockResolvedValueOnce(ok([{ requestId: 'r-1' }]));
    const { result, rerender } = renderHook(({ when }) => useSubstitutionRequests('p-1', 's-1', when), { initialProps: { when: 'upcoming' as 'upcoming' | 'past' } });
    await waitFor(() => expect(result.current.status).toBe('ok'));
    list.mockResolvedValueOnce(ok([{ requestId: 'r-2' }]));
    rerender({ when: 'past' });
    expect(result.current.requests).toBeNull();
    await waitFor(() => expect(result.current.requests).toEqual([{ requestId: 'r-2' }]));
    expect(list).toHaveBeenLastCalledWith('p-1', 's-1', 'past');
  });

  it('refreshKey novo e refresh() refazem o GET', async () => {
    list.mockResolvedValue(ok([]));
    const { result, rerender } = renderHook(({ key }) => useSubstitutionRequests('p-1', 's-1', 'upcoming', key), { initialProps: { key: 0 } });
    await waitFor(() => expect(result.current.status).toBe('ok'));
    rerender({ key: 1 });
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
    act(() => result.current.refresh());
    await waitFor(() => expect(list).toHaveBeenCalledTimes(3));
  });

  it('403 → forbidden; outro erro → error', async () => {
    list.mockRejectedValueOnce(new ContractedServiceApiError('x', 403));
    const a = renderHook(() => useSubstitutionRequests('p-1', 's-1', 'upcoming'));
    await waitFor(() => expect(a.result.current.status).toBe('forbidden'));
    list.mockRejectedValueOnce(new Error('boom'));
    const b = renderHook(() => useSubstitutionRequests('p-1', 's-1', 'upcoming'));
    await waitFor(() => expect(b.result.current.status).toBe('error'));
  });

  it('guarda por requestId: resposta atrasada (sucesso e erro) de um filtro antigo não sobrescreve', async () => {
    let resolveFirst: (v: unknown) => void = () => undefined;
    let rejectSecond: (e: unknown) => void = () => undefined;
    list.mockImplementationOnce(() => new Promise((r) => (resolveFirst = r)));
    list.mockImplementationOnce(() => new Promise((_r, rej) => (rejectSecond = rej)));
    list.mockResolvedValueOnce(ok([{ requestId: 'atual' }]));
    const { result, rerender } = renderHook(({ when }) => useSubstitutionRequests('p-1', 's-1', when), { initialProps: { when: 'upcoming' as 'upcoming' | 'past' } });
    rerender({ when: 'past' });
    rerender({ when: 'upcoming' });
    await waitFor(() => expect(result.current.status).toBe('ok'));
    resolveFirst(ok([{ requestId: 'velho' }]));
    rejectSecond(new Error('tarde'));
    await new Promise((r) => setTimeout(r, 10));
    expect(result.current.requests).toEqual([{ requestId: 'atual' }]);
    expect(result.current.status).toBe('ok');
  });
});
