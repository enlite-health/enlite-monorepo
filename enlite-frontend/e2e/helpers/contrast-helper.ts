/**
 * contrast-helper.ts
 *
 * Prova de contraste WCAG 2.1 que NÃO depende do nome da classe Tailwind —
 * só do que o navegador de fato PINTA (`getComputedStyle`). Achado do gate
 * (11/09): `color="muted"` do atom `Text` mapeia pra `gray-700`, que na
 * paleta desta casa (`tailwind.config.js`) é `rgba(115, 115, 115, 0.5)` —
 * um cinza com ALPHA, invisível no nome da classe. Composto sobre fundo
 * branco isso vira ~#B9B9B9, contraste 1,96:1 — bem abaixo do mínimo WCAG
 * AA pra texto pequeno (4,5:1). Uma asserção que só lesse a classe CSS
 * (ex.: `toHaveClass(/text-gray-700/)`) teria aprovado o defeito.
 */
import type { Locator } from '@playwright/test';

interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

function parseCssColor(css: string): Rgba {
  const m = css.match(/rgba?\(([^)]+)\)/);
  if (!m) throw new Error(`Cor não reconhecida (esperava rgb()/rgba()): "${css}"`);
  const parts = m[1].split(',').map((s) => parseFloat(s.trim()));
  const [r, g, b, a] = parts;
  return { r, g, b, a: a === undefined ? 1 : a };
}

function channelLuminance(channel255: number): number {
  const s = channel255 / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

function relativeLuminance({ r, g, b }: { r: number; g: number; b: number }): number {
  return 0.2126 * channelLuminance(r) + 0.7152 * channelLuminance(g) + 0.0722 * channelLuminance(b);
}

/**
 * Composita `fg` (que pode ter alpha < 1) sobre `bg` OPACO — "o que o olho
 * vê" de verdade, não a cor nominal do canal `color`.
 */
function compositeOverOpaqueBackground(fg: Rgba, bg: Rgba): { r: number; g: number; b: number } {
  return {
    r: fg.r * fg.a + bg.r * (1 - fg.a),
    g: fg.g * fg.a + bg.g * (1 - fg.a),
    b: fg.b * fg.a + bg.b * (1 - fg.a),
  };
}

/** Razão de contraste WCAG 2.1 (fórmula (L1+0.05)/(L2+0.05), L1 ≥ L2) entre duas cores CSS `rgb()`/`rgba()`. */
export function contrastRatioFromCss(fgCss: string, bgCss: string): number {
  const fg = parseCssColor(fgCss);
  const bg = parseCssColor(bgCss);
  const composited = compositeOverOpaqueBackground(fg, bg);
  const l1 = relativeLuminance(composited);
  const l2 = relativeLuminance(bg);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * Lê `color` computado do elemento e o fundo EFETIVO (primeiro ancestral
 * com `background-color` não-transparente, subindo o DOM — o mesmo que o
 * olho humano vê) e devolve a razão de contraste real entre os dois.
 */
export async function readTextContrastRatio(locator: Locator): Promise<number> {
  const { fg, bg } = await locator.evaluate((el) => {
    const color = getComputedStyle(el).color;
    let node: Element | null = el;
    let bgColor = 'rgb(255, 255, 255)'; // fallback: fundo branco da página
    while (node) {
      const candidate = getComputedStyle(node).backgroundColor;
      if (candidate && candidate !== 'rgba(0, 0, 0, 0)' && candidate !== 'transparent') {
        bgColor = candidate;
        break;
      }
      node = node.parentElement;
    }
    return { fg: color, bg: bgColor };
  });
  return contrastRatioFromCss(fg, bg);
}
