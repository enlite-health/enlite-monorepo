import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

const listShiftTemplateOptions = vi.fn();
vi.mock('@infrastructure/http/AdminTherapeuticProjectsApiService', () => ({
  AdminTherapeuticProjectsApiService: { listShiftTemplateOptions: (...a: unknown[]) => listShiftTemplateOptions(...a) },
}));

const { useServiceShiftTemplateOptions } = await import('../useServiceShiftTemplateOptions');

describe('useServiceShiftTemplateOptions', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('começa em loading, vai a ok com as guardias na ordem que o backend mandou — 1 GET só', async () => {
    listShiftTemplateOptions.mockResolvedValue([{ id: 'g1', code: 'G1', label: 'Uno', active: true, items: [{ startTime: '08:00', durationMinutes: 360 }] }, { id: 'g2', code: 'G2', label: 'Otro', active: true, items: [{ startTime: '20:00', durationMinutes: 720 }] }]);
    const { result, rerender } = renderHook(() => useServiceShiftTemplateOptions());
    expect(result.current.status).toBe('loading');
    await waitFor(() => expect(result.current.status).toBe('ok'));
    expect(result.current.options).toEqual([{ id: 'g1', code: 'G1', label: 'Uno', active: true, items: [{ startTime: '08:00', durationMinutes: 360 }] }, { id: 'g2', code: 'G2', label: 'Otro', active: true, items: [{ startTime: '20:00', durationMinutes: 720 }] }]);
    rerender();
    expect(listShiftTemplateOptions).toHaveBeenCalledTimes(1);
  });

  it('falha vira status error com lista vazia (nunca opção inventada)', async () => {
    listShiftTemplateOptions.mockRejectedValue(new Error('boom'));
    const { result } = renderHook(() => useServiceShiftTemplateOptions());
    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.options).toEqual([]);
  });

  it('desmontar antes da resposta não atualiza estado', async () => {
    let libera: (v: unknown) => void = () => {};
    listShiftTemplateOptions.mockImplementation(() => new Promise((r) => { libera = r; }));
    const { result, unmount } = renderHook(() => useServiceShiftTemplateOptions());
    unmount();
    libera([{ id: 'g1', code: 'G1', label: 'Uno', active: true, items: [{ startTime: '08:00', durationMinutes: 360 }] }]);
    await Promise.resolve();
    expect(result.current.status).toBe('loading');
  });
});
