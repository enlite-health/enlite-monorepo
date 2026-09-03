import { useEffect, useRef } from 'react';

/** Um pedido de foco do checklist de completude (US-D1) — `token` muda a cada clique, mesmo
 * clicando duas vezes no MESMO item, para o card reabrir o drawer de novo. */
export interface DrawerFocusRequest {
  code: string;
  token: number;
}

/**
 * Abre o drawer de edição do card automaticamente quando o checklist de completude da ficha
 * (spec 014, US-D1: "cada item com link que abre o drawer certo") pede foco NESTE card — nunca
 * mais de uma vez pelo MESMO pedido (compara `token`, não só `code`, porque o mesmo código pode
 * ser clicado de novo em seguida).
 */
export function useAutoOpenDrawer(
  request: DrawerFocusRequest | null | undefined,
  ownCode: string,
  open: () => void,
): void {
  const lastToken = useRef<number | null>(null);

  useEffect(() => {
    if (!request || request.code !== ownCode) return;
    if (lastToken.current === request.token) return;
    lastToken.current = request.token;
    open();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request, ownCode]);
}
