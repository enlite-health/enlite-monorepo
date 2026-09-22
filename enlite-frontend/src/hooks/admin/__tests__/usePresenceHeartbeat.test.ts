/**
 * usePresenceHeartbeat — heartbeat de presença (spec 022, Rodada 2). Molde: `NotificationBell`
 * (`usePolling` com fake timers, client mockado por módulo).
 *
 * Decisão do Gabriel (22/09, revisada nesta rodada): "sessão ativa em QUALQUER LUGAR do app manda
 * heartbeat a cada ~60s, com a aba visível OU escondida, disparando imediatamente ao montar" —
 * `immediate: true`, SEM `pauseWhenHidden` (mudou: antes só rodava dentro do `AdminLayout` com a
 * aba visível). Falha do heartbeat é BEST-EFFORT: nunca vira erro visível, nunca spama (a presença
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

describe('usePresenceHeartbeat (spec 022, Rodada 2)', () => {
  const originalVisibility = Object.getOwnPropertyDescriptor(document, 'visibilityState');

  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(AdminPresenceApiService.heartbeat).mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    if (originalVisibility) Object.defineProperty(document, 'visibilityState', originalVisibility);
  });

  it('🔒 manda heartbeat IMEDIATAMENTE ao montar — não espera o 1º intervalo de 60s (immediate: true)', async () => {
    renderHook(() => usePresenceHeartbeat());
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(AdminPresenceApiService.heartbeat).toHaveBeenCalledTimes(1);
  });

  it('manda heartbeat a cada ~60s enquanto montado (além do imediato)', async () => {
    renderHook(() => usePresenceHeartbeat());
    await act(async () => { await vi.advanceTimersByTimeAsync(0); }); // dispara o immediate
    expect(AdminPresenceApiService.heartbeat).toHaveBeenCalledTimes(1);

    await act(async () => { await vi.advanceTimersByTimeAsync(HEARTBEAT_MS); });
    expect(AdminPresenceApiService.heartbeat).toHaveBeenCalledTimes(2);

    await act(async () => { await vi.advanceTimersByTimeAsync(HEARTBEAT_MS); });
    expect(AdminPresenceApiService.heartbeat).toHaveBeenCalledTimes(3);
  });

  it('🔒 NÃO pausa com a aba escondida (sem pauseWhenHidden) — heartbeat continua batendo em background', async () => {
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    renderHook(() => usePresenceHeartbeat());
    await act(async () => { await vi.advanceTimersByTimeAsync(0); }); // immediate, mesmo hidden

    document.dispatchEvent(new Event('visibilitychange'));
    await act(async () => { await vi.advanceTimersByTimeAsync(HEARTBEAT_MS); });

    expect(AdminPresenceApiService.heartbeat).toHaveBeenCalledTimes(2);
  });

  it('desmontar para o timer (nenhum heartbeat depois do unmount)', async () => {
    const { unmount } = renderHook(() => usePresenceHeartbeat());
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    vi.mocked(AdminPresenceApiService.heartbeat).mockClear();
    unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(HEARTBEAT_MS * 3); });
    expect(AdminPresenceApiService.heartbeat).not.toHaveBeenCalled();
  });

  it('enabled=false: nunca chama a API, nem no immediate nem nos intervalos seguintes', async () => {
    renderHook(() => usePresenceHeartbeat(false));
    await act(async () => { await vi.advanceTimersByTimeAsync(HEARTBEAT_MS * 2); });
    expect(AdminPresenceApiService.heartbeat).not.toHaveBeenCalled();
  });

  it('falha do heartbeat é engolida (best-effort) — não propaga, não derruba o painel', async () => {
    vi.mocked(AdminPresenceApiService.heartbeat).mockRejectedValue(new Error('network'));
    renderHook(() => usePresenceHeartbeat());
    // Nenhuma exceção escapa daqui — se o `.catch()` do hook não existisse, a rejeição não
    // tratada derrubaria este `await act(...)`.
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(AdminPresenceApiService.heartbeat).toHaveBeenCalledTimes(1);
  });

  // 🔒 Achado do gate (sonda: 0 chamadas 2s após enabled virar true; 1 aos 61s). Causa raiz: o
  // `immediate: true` do usePolling só roda no efeito de MONTE, cujas deps [ms, pauseWhenHidden,
  // immediate] não incluem `enabled` — então um monte a frio com `enabled=false` (adminAuthStore
  // ainda resolvendo, ex.: F5 numa rota /admin/* já logada) captura o `enabled=false` no fechamento
  // daquele efeito para sempre; quando `enabled` vira `true` depois (auth resolveu), o efeito de
  // monte não roda de novo, e o heartbeat só sai no próximo intervalo de 60s.
  describe('transição de enabled depois do monte (auth resolve DEPOIS que o componente já montou)', () => {
    it('monta com enabled=false e nada dispara (nem o immediate, que vira no-op)', async () => {
      renderHook(({ enabled }) => usePresenceHeartbeat(enabled), { initialProps: { enabled: false } });
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      expect(AdminPresenceApiService.heartbeat).not.toHaveBeenCalled();
    });

    it('🔒 false→true dispara heartbeat IMEDIATO, sem esperar os 60s do próximo intervalo', async () => {
      const { rerender } = renderHook(
        ({ enabled }) => usePresenceHeartbeat(enabled),
        { initialProps: { enabled: false } },
      );
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      expect(AdminPresenceApiService.heartbeat).not.toHaveBeenCalled();

      rerender({ enabled: true });
      await act(async () => { await vi.advanceTimersByTimeAsync(0); }); // sem avançar o timer de 60s

      expect(AdminPresenceApiService.heartbeat).toHaveBeenCalledTimes(1);
    });

    it('monta DIRETO com enabled=true: o immediate do usePolling já cobre — a transição NÃO soma uma 2ª chamada', async () => {
      renderHook(({ enabled }) => usePresenceHeartbeat(enabled), { initialProps: { enabled: true } });
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      expect(AdminPresenceApiService.heartbeat).toHaveBeenCalledTimes(1); // não 2
    });

    it('true→false (logout): a transição não dispara heartbeat novo', async () => {
      const { rerender } = renderHook(
        ({ enabled }) => usePresenceHeartbeat(enabled),
        { initialProps: { enabled: true } },
      );
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      expect(AdminPresenceApiService.heartbeat).toHaveBeenCalledTimes(1);
      vi.mocked(AdminPresenceApiService.heartbeat).mockClear();

      rerender({ enabled: false });
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });

      expect(AdminPresenceApiService.heartbeat).not.toHaveBeenCalled();
    });
  });
});
