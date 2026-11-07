import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { useVacancyInviteBoard } from '../useVacancyInviteBoard';
import { AdminApiService } from '@infrastructure/http/AdminApiService';

vi.mock('@infrastructure/http/AdminApiService', () => ({
  AdminApiService: { getMatchResults: vi.fn(), triggerMatch: vi.fn() },
}));

const get = vi.mocked(AdminApiService.getMatchResults);
const post = vi.mocked(AdminApiService.triggerMatch);

const meta = (lat: number | null) => ({
  jobPostingId: 'v1', lastMatchAt: null, totalCandidates: 0, invitedCount: 0, pendingInVacancyCount: 0,
  operationDate: '2026-11-06', service: { lat, lng: lat == null ? null : -58.4, addressLabel: 'X' }, candidates: [],
});
const withCands = { ...meta(-34.6), candidates: [{ workerId: 'w1' }, { workerId: 'w2' }] } as never;

beforeEach(() => {
  vi.clearAllMocks();
  post.mockResolvedValue({ ...meta(-34.6), candidates: [{ workerId: 'w1' }] } as never);
});

describe('useVacancyInviteBoard', () => {
  it('com match:execute: GET meta, 1 POST (50 km, top 500), GET 500 — nesta ordem', async () => {
    get.mockResolvedValueOnce(meta(-34.6) as never).mockResolvedValueOnce(withCands);
    const { result } = renderHook(() => useVacancyInviteBoard('v1', { enabled: true, canExecute: true }));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(get.mock.calls).toEqual([['v1', 0], ['v1', 500]]);
    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith('v1', { radiusKm: 50, topN: 500 });
    expect([...result.current.currentIds]).toEqual(['w1']);
  });

  it('serviço sem coordenada: NÃO chama o POST (DF-11)', async () => {
    get.mockResolvedValueOnce(meta(null) as never);
    const { result } = renderHook(() => useVacancyInviteBoard('v1', { enabled: true, canExecute: true }));
    await waitFor(() => expect(result.current.status).toBe('noService'));
    expect(post).not.toHaveBeenCalled();
  });

  it('sem match:execute: só 1 GET, sem POST', async () => {
    get.mockResolvedValueOnce(withCands);
    const { result } = renderHook(() => useVacancyInviteBoard('v1', { enabled: true, canExecute: false }));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(get).toHaveBeenCalledTimes(1);
    expect(post).not.toHaveBeenCalled();
  });

  it('disabled não faz request nenhuma', () => {
    renderHook(() => useVacancyInviteBoard('v1', { enabled: false, canExecute: true }));
    expect(get).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
  });

  it('refetch lê só o GET (nunca POST) e mantém currentIds', async () => {
    get.mockResolvedValueOnce(meta(-34.6) as never).mockResolvedValue(withCands);
    const { result } = renderHook(() => useVacancyInviteBoard('v1', { enabled: true, canExecute: true }));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    await act(async () => { await result.current.refetch(); });
    expect(get).toHaveBeenCalledTimes(3);
    expect(post).toHaveBeenCalledTimes(1);
    expect([...result.current.currentIds]).toEqual(['w1']);
  });

  it('erro de carga vira status error', async () => {
    get.mockRejectedValueOnce(new Error('boom'));
    const { result } = renderHook(() => useVacancyInviteBoard('v1', { enabled: true, canExecute: true }));
    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.error).toBe('boom');
  });
});
