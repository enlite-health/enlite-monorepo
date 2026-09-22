import { describe, it, expect } from 'vitest';
import { clampMentionPopupPosition } from '../mentionPopupPosition';

const VIEWPORT = { width: 1000, height: 800 };
const POPUP = { width: 200, height: 150 };

describe('clampMentionPopupPosition (item 1, F4 — popup ancorado no cursor)', () => {
  it('cursor no meio da tela: nasce logo abaixo, alinhado à esquerda da âncora', () => {
    const anchor = { top: 100, bottom: 116, left: 300, right: 310 };
    const pos = clampMentionPopupPosition(anchor, POPUP, VIEWPORT);
    expect(pos).toEqual({ top: 120, left: 300 });
  });

  it('cursor perto da borda DIREITA: clampa left para caber inteiro no viewport', () => {
    const anchor = { top: 100, bottom: 116, left: 950, right: 960 };
    const pos = clampMentionPopupPosition(anchor, POPUP, VIEWPORT);
    // 1000 - 200 - 4 = 796
    expect(pos.left).toBe(796);
    expect(pos.left + POPUP.width).toBeLessThanOrEqual(VIEWPORT.width);
  });

  it('cursor perto da borda INFERIOR: inverte para cima da âncora quando cabe', () => {
    const anchor = { top: 700, bottom: 716, left: 300, right: 310 };
    const pos = clampMentionPopupPosition(anchor, POPUP, VIEWPORT);
    // abaixo estouraria (716+4+150=870 > 800) — cima: 700-150-4=546, cabe.
    expect(pos.top).toBe(546);
    expect(pos.top + POPUP.height).toBeLessThanOrEqual(VIEWPORT.height);
  });

  it('viewport minúsculo (popup maior que o espaço em qualquer direção): nunca sai do viewport', () => {
    const tinyViewport = { width: 220, height: 180 };
    const anchor = { top: 170, bottom: 178, left: 210, right: 215 };
    const pos = clampMentionPopupPosition(anchor, POPUP, tinyViewport);
    expect(pos.left).toBeGreaterThanOrEqual(0);
    expect(pos.top).toBeGreaterThanOrEqual(0);
  });

  it('cursor no canto superior esquerdo: left/top nunca ficam negativos', () => {
    const anchor = { top: 0, bottom: 10, left: 0, right: 5 };
    const pos = clampMentionPopupPosition(anchor, POPUP, VIEWPORT);
    expect(pos.left).toBeGreaterThanOrEqual(0);
    expect(pos.top).toBeGreaterThanOrEqual(0);
  });
});
