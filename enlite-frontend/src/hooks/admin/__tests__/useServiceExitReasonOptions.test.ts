import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

const listServiceExitReasonOptions = vi.fn();
vi.mock('@infrastructure/http/AdminTherapeuticProjectsApiService', () => ({
  AdminTherapeuticProjectsApiService: { listServiceExitReasonOptions: (...a: unknown[]) => listServiceExitReasonOptions(...a) },
}));

const { useServiceExitReasonOptions } = await import('../useServiceExitReasonOptions');

describe('useServiceExitReasonOptions', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('começa em loading, vai a ok com as opções na ordem que o backend mandou — 1 GET só', async () => {
    listServiceExitReasonOptions.mockResolvedValue([{ code: 'A', label: 'Uno' }, { code: 'OTHER', label: 'Otro' }]);
    const { result, rerender } = renderHook(() => useServiceExitReasonOptions());
    expect(result.current.status).toBe('loading');
    await waitFor(() => expect(result.current.status).toBe('ok'));
    expect(result.current.options).toEqual([{ code: 'A', label: 'Uno' }, { code: 'OTHER', label: 'Otro' }]);
    rerender();
    expect(listServiceExitReasonOptions).toHaveBeenCalledTimes(1);
  });

  it('falha vira status error com lista vazia (nunca opção inventada)', async () => {
    listServiceExitReasonOptions.mockRejectedValue(new Error('boom'));
    const { result } = renderHook(() => useServiceExitReasonOptions());
    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.options).toEqual([]);
  });

  it('desmontar antes da resposta não atualiza estado', async () => {
    let libera: (v: unknown) => void = () => {};
    listServiceExitReasonOptions.mockImplementation(() => new Promise((r) => { libera = r; }));
    const { result, unmount } = renderHook(() => useServiceExitReasonOptions());
    unmount();
    libera([{ code: 'A', label: 'Uno' }]);
    await Promise.resolve();
    expect(result.current.status).toBe('loading');
  });
});
