import { useEffect, useRef } from 'react';

interface UsePollingOptions {
  /**
   * Pausa o polling quando `document.visibilityState === 'hidden'` e retoma
   * ao voltar a ficar visível. Default `false`.
   *
   * Por que importa: sem pausar, cada aba esquecida aberta em background vira
   * tráfego e custo contínuos contra a API de produção (spec 022 — o painel de
   * chat polla a cada 5s, o sino a cada 45s).
   */
  pauseWhenHidden?: boolean;
  /**
   * 🔒 Achado do gate revisao-pr (B4, T409): `setInterval` NUNCA chama `fn` de imediato — quem usa
   * este hook como ÚNICA fonte do fetch inicial (sem outro `useEffect` fazendo um fetch por fora,
   * como `NotificationBell.tsx` faz) mostra o estado zerado pelo intervalo INTEIRO (45s em
   * produção) antes da 1ª chamada. Default `false` — NÃO muda o comportamento dos callers
   * existentes (`ConversationPanel.tsx`/`PatientConversationHandle.tsx` já fazem seu próprio fetch
   * inicial por fora, ou dependem desse atraso por desenho; mudar o default sem grep dos 3 callers
   * seria "conserto que vira ripple" — CLAUDE.md). Opt-in explícito por quem precisa.
   */
  immediate?: boolean;
}

/**
 * Chama `fn` a cada `ms` enquanto o componente está montado.
 *
 * Cleanup garantido no unmount (limpa o `setInterval`) — timer vazando entre
 * re-renders/desmontagens é o defeito clássico deste tipo de hook.
 */
export function usePolling(fn: () => void, ms: number, opts?: UsePollingOptions): void {
  const { pauseWhenHidden = false, immediate = false } = opts ?? {};
  const fnRef = useRef(fn);
  fnRef.current = fn;

  useEffect(() => {
    let intervalId: ReturnType<typeof setInterval> | null = null;

    const start = (): void => {
      if (intervalId !== null) return;
      intervalId = setInterval(() => fnRef.current(), ms);
    };
    const stop = (): void => {
      if (intervalId === null) return;
      clearInterval(intervalId);
      intervalId = null;
    };

    const startedHidden = pauseWhenHidden && document.visibilityState === 'hidden';
    if (!startedHidden) {
      // Só no MONTE inicial (nunca de novo ao retomar de hidden→visible — isso é o `start()` do
      // listener de visibilidade abaixo, que não passa por aqui).
      if (immediate) fnRef.current();
      start();
    }

    const onVisibilityChange = (): void => {
      if (document.visibilityState === 'hidden') {
        stop();
      } else {
        start();
      }
    };

    if (pauseWhenHidden) {
      document.addEventListener('visibilitychange', onVisibilityChange);
    }

    return () => {
      stop();
      if (pauseWhenHidden) {
        document.removeEventListener('visibilitychange', onVisibilityChange);
      }
    };
  }, [ms, pauseWhenHidden, immediate]);
}
