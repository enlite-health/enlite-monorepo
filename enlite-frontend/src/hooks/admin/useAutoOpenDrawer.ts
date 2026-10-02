import { useEffect, useRef } from 'react';

/** Um pedido de foco do checklist de completude (US-D1) — `token` muda a cada clique, mesmo
 * clicando duas vezes no MESMO item, para o card reabrir o drawer de novo. */
export interface DrawerFocusRequest {
  code: string;
  token: number;
  /** Deep-link do sino de notificações (item 3, change 022-ux-mencao-e-notificacao): mensagem de
   * origem a rolar/destacar. Opcional — quem não usa (checklist, US-D1) nunca lê este campo. */
  messageId?: string;
  /** Presente quando a mensagem de origem é uma reply — root da thread a abrir. `null`/ausente
   * quando é mensagem de topo. */
  rootMessageId?: string | null;
}

/**
 * Abre o drawer de edição do card automaticamente quando o checklist de completude da ficha
 * (spec 014, US-D1: "cada item com link que abre o drawer certo") pede foco NESTE card — nunca
 * mais de uma vez pelo MESMO pedido (compara `token`, não só `code`, porque o mesmo código pode
 * ser clicado de novo em seguida).
 *
 * `open` recebe o `request` inteiro (item 3): quem só precisa abrir (checklist) ignora o
 * argumento — TypeScript permite um callback com MENOS parâmetros no lugar de um que declara
 * mais (mesma variância de `Array.prototype.forEach`); quem precisa do alvo de deep-link
 * (`PatientConversationHandle`) lê `request.messageId`/`request.rootMessageId`.
 */
export function useAutoOpenDrawer(
  request: DrawerFocusRequest | null | undefined,
  ownCode: string,
  open: (request: DrawerFocusRequest) => void,
): void {
  const lastToken = useRef<number | null>(null);

  useEffect(() => {
    if (!request || request.code !== ownCode) return;
    if (lastToken.current === request.token) return;
    lastToken.current = request.token;
    open(request);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request, ownCode]);
}
