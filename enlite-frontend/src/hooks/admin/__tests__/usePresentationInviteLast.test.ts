/**
 * usePresentationInviteLast.test.ts — chave estável (ordenada, sem nulos), desligado não consulta,
 * falha não derruba, resposta após unmount não vaza estado.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { usePresentationInviteLast } from '../usePresentationInviteLast';

const last = vi.fn();
vi.mock('@infrastructure/http/AdminPresentationInviteApiService', () => ({
  AdminPresentationInviteApiService: { last: (...a: unknown[]) => last(...a) },
}));

describe('usePresentationInviteLast', () => {
  beforeEach(() => { last.mockReset(); });

  it('consulta os ids ordenados e sem nulos; expõe o mapa e o setter', async () => {
    last.mockResolvedValue({ 'w-1': { at: '2026-08-29T15:00:00Z', by: 'Gabi' } });
    const { result } = renderHook(() => usePresentationInviteLast(['w-2', null, 'w-1', undefined]));
    await waitFor(() => expect(result.current[0]).toEqual({ 'w-1': { at: '2026-08-29T15:00:00Z', by: 'Gabi' } }));
    expect(last).toHaveBeenCalledTimes(1); expect(last).toHaveBeenCalledWith(['w-1', 'w-2']);
    act(() => result.current[1]((prev) => ({ ...prev, 'w-2': { at: 'now', by: null } })));
    expect(result.current[0]['w-2']).toEqual({ at: 'now', by: null });
  });

  it('desligado ou sem ids → não consulta; falha do serviço → mapa vazio, sem erro', async () => {
    last.mockRejectedValue(new Error('down'));
    const { result: off } = renderHook(() => usePresentationInviteLast(['w-1'], false));
    const { result: empty } = renderHook(() => usePresentationInviteLast([null]));
    expect(last).not.toHaveBeenCalled();
    expect(off.current[0]).toEqual({}); expect(empty.current[0]).toEqual({});
    const { result } = renderHook(() => usePresentationInviteLast(['w-1']));
    await waitFor(() => expect(last).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 0));
    expect(result.current[0]).toEqual({});
  });

  it('resposta que chega depois do unmount não é aplicada', async () => {
    let resolve: (v: unknown) => void = () => undefined;
    last.mockImplementation(() => new Promise((r) => { resolve = r; }));
    const { result, unmount } = renderHook(() => usePresentationInviteLast(['w-1']));
    await waitFor(() => expect(last).toHaveBeenCalledTimes(1));
    unmount();
    await act(async () => { resolve({ 'w-1': { at: 'late', by: null } }); });
    expect(result.current[0]).toEqual({});
  });
});
