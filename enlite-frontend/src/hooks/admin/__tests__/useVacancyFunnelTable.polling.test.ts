/**
 * useVacancyFunnelTable — polling pausa com a aba oculta (054b item 7).
 * Hidden: o intervalo não busca. Voltou a 'visible': busca na hora e o intervalo segue.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useVacancyFunnelTable } from '../useVacancyFunnelTable';
import { AdminApiService } from '@infrastructure/http/AdminApiService';

vi.mock('@infrastructure/http/AdminApiService');

const INTERVAL_MS = 10_000;
const fetchMock = () => vi.mocked(AdminApiService.getVacancyFunnelTable);

function setVisibility(state: 'hidden' | 'visible'): void {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
}

describe('useVacancyFunnelTable — polling com a aba oculta', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setVisibility('visible');
    vi.clearAllMocks();
    fetchMock().mockResolvedValue({ rows: [], counts: {} } as never);
  });
  afterEach(() => {
    vi.useRealTimers();
    setVisibility('visible');
  });

  async function mount() {
    const hook = renderHook(() => useVacancyFunnelTable('vac-1', { key: 'k', kind: 'bucket', bucket: 'ALL' }, true));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    fetchMock().mockClear();
    return hook;
  }

  it('visível: o intervalo busca', async () => {
    await mount();
    await act(async () => { await vi.advanceTimersByTimeAsync(INTERVAL_MS); });
    expect(fetchMock()).toHaveBeenCalledTimes(1);
  });

  it('oculta: avançar o intervalo NÃO busca; voltar a visible busca 1x na hora e o intervalo retoma', async () => {
    await mount();
    setVisibility('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    await act(async () => { await vi.advanceTimersByTimeAsync(INTERVAL_MS * 3); });
    expect(fetchMock()).toHaveBeenCalledTimes(0);

    setVisibility('visible');
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(fetchMock()).toHaveBeenCalledTimes(1);

    await act(async () => { await vi.advanceTimersByTimeAsync(INTERVAL_MS); });
    expect(fetchMock()).toHaveBeenCalledTimes(2);
  });

  it('desmontar remove o listener e o intervalo', async () => {
    const { unmount } = await mount();
    unmount();
    document.dispatchEvent(new Event('visibilitychange'));
    await act(async () => { await vi.advanceTimersByTimeAsync(INTERVAL_MS * 2); });
    expect(fetchMock()).toHaveBeenCalledTimes(0);
  });
});
