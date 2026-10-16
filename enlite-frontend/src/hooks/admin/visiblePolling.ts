/**
 * Polling que só busca com a aba visível. Aba oculta: o tick do intervalo é ignorado (nenhuma
 * request); ao voltar para 'visible' busca na hora e o intervalo segue no mesmo ritmo.
 * Não usa `usePolling`: ele retoma sem buscar de imediato ao voltar, e aqui o dado precisa estar
 * fresco no instante em que a pessoa volta para a aba. Devolve o cleanup (para o return do useEffect).
 */
export function startVisiblePolling(fetchSilent: () => void, intervalMs: number): () => void {
  const intervalId = setInterval(() => {
    if (document.visibilityState === 'hidden') return;
    fetchSilent();
  }, intervalMs);

  const onVisibilityChange = (): void => {
    if (document.visibilityState === 'visible') fetchSilent();
  };
  document.addEventListener('visibilitychange', onVisibilityChange);

  return () => {
    clearInterval(intervalId);
    document.removeEventListener('visibilitychange', onVisibilityChange);
  };
}
