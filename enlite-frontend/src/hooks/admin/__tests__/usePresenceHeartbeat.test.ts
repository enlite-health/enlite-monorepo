/**
 * usePresenceHeartbeat — heartbeat de presença (spec 022, Rodada 2/R2-F). Molde: `NotificationBell`
 * (`usePolling` com fake timers, client mockado por módulo).
 *
 * Decisão do Gabriel (22/09): "presença simples — painel admin aberto manda heartbeat a cada ~60s".
 * `pauseWhenHidden: true` — mesma régua dos outros pollers (não gasta heartbeat com a aba em
 * background). Falha do heartbeat é BEST-EFFORT: nunca vira erro visível, nunca spama (a presença
 * não é canal de alerta).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { AdminPresenceApiService } from '@infrastructure/http/AdminPresenceApiService';
import { usePresenceHeartbeat } from '../usePresenceHeartbeat';

vi.mock('@infrastructure/http/AdminPresenceApiService', () => ({
  AdminPresenceApiService: { heartbeat: vi.fn() },
}));

const HEARTBEAT_MS = 60000;

describe('usePresenceHeartbeat (spec 022, Rodada 2/R2-F)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(AdminPresenceApiService.heartbeat).mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('não manda heartbeat no monte — só depois do 1º intervalo (não é immediate)', async () => {
    renderHook(() => usePresenceHeartbeat());
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(AdminPresenceApiService.heartbeat).not.toHaveBeenCalled();
  });

  it('manda heartbeat a cada ~60s enquanto montado', async () => {
    renderHook(() => usePresenceHeartbeat());

    await act(async () => { await vi.advanceTimersByTimeAsync(HEARTBEAT_MS); });
    expect(AdminPresenceApiService.heartbeat).toHaveBeenCalledTimes(1);

    await act(async () => { await vi.advanceTimersByTimeAsync(HEARTBEAT_MS); });
    expect(AdminPresenceApiService.heartbeat).toHaveBeenCalledTimes(2);
  });

  it('desmontar para o timer (nenhum heartbeat depois do unmount)', async () => {
    const { unmount } = renderHook(() => usePresenceHeartbeat());
    unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(HEARTBEAT_MS * 3); });
    expect(AdminPresenceApiService.heartbeat).not.toHaveBeenCalled();
  });

  it('falha do heartbeat é engolida (best-effort) — não propaga, não derruba o painel', async () => {
    vi.mocked(AdminPresenceApiService.heartbeat).mockRejectedValue(new Error('network'));
    renderHook(() => usePresenceHeartbeat());
    // Nenhuma exceção escapa daqui — se o `.catch()` do hook não existisse, a rejeição não
    // tratada derrubaria este `await act(...)`.
    await act(async () => { await vi.advanceTimersByTimeAsync(HEARTBEAT_MS); });
    expect(AdminPresenceApiService.heartbeat).toHaveBeenCalledTimes(1);
  });
});
