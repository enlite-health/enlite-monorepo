/**
 * mentionPopupPosition — aritmética pura de posicionamento do popup de menção (item 1, change
 * 022-ux-mencao-e-notificacao; `design.md` §1, F4 de `fatos-medidos.md`).
 *
 * Extraída para ser testável sem DOM real (jsdom não faz layout — `getBoundingClientRect` sempre
 * devolve zero — então a matemática de clamp vive aqui, testada com retângulos fabricados; quem
 * chama, no `MessageComposer`, só lê `clientRect()`/`getBoundingClientRect()` de verdade e repassa).
 *
 * Decisão de design (revisão do gate): NÃO usa Popper/Floating UI — é aritmética simples sobre um
 * retângulo já disponível via `props.clientRect` do TipTap (Prior-art, `Suggestion` utility).
 */
export interface AnchorRect {
  top: number;
  left: number;
  bottom: number;
  right: number;
}

export interface PopupSize {
  width: number;
  height: number;
}

export interface ViewportSize {
  width: number;
  height: number;
}

export interface PopupPosition {
  top: number;
  left: number;
}

const DEFAULT_MARGIN = 4;

/**
 * Posiciona o popup logo ABAIXO do cursor/âncora, alinhado à esquerda dela — e clampa aos 4 lados
 * do viewport: nunca nasce fora da tela (nem à direita/embaixo, nem à esquerda/em cima, quando o
 * próprio popup é maior que o espaço disponível).
 *
 * Quando não há espaço abaixo (`anchor.bottom + popup.height` estoura o viewport), inverte para
 * cima da âncora (`anchor.top - popup.height`) — só quando isso realmente cabe; senão, clampa no
 * teto do viewport (nunca corta o popup pra fora, mesmo em telas minúsculas).
 */
export function clampMentionPopupPosition(
  anchor: AnchorRect,
  popup: PopupSize,
  viewport: ViewportSize,
  margin: number = DEFAULT_MARGIN,
): PopupPosition {
  const maxLeft = Math.max(margin, viewport.width - popup.width - margin);
  let left = anchor.left;
  if (left > maxLeft) left = maxLeft;
  if (left < margin) left = margin;

  const maxTop = Math.max(margin, viewport.height - popup.height - margin);
  let top = anchor.bottom + margin;
  if (top > maxTop) {
    const above = anchor.top - popup.height - margin;
    top = above >= margin ? above : maxTop;
  }
  if (top < margin) top = margin;

  return { top, left };
}
