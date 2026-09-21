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
}

/**
 * Chama `fn` a cada `ms` enquanto o componente está montado.
 *
 * Cleanup garantido no unmount (limpa o `setInterval`) — timer vazando entre
 * re-renders/desmontagens é o defeito clássico deste tipo de hook.
 */
export function usePolling(fn: () => void, ms: number, opts?: UsePollingOptions): void {
  const { pauseWhenHidden = false } = opts ?? {};
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
  }, [ms, pauseWhenHidden]);
}
