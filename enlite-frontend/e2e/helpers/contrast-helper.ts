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

export interface ContrastViolation {
  selector: string;
  text: string;
  color: string;
  backgroundColor: string;
  ratio: number;
}

/**
 * Varre TODO elemento visível com texto DIRETO (não herdado de um filho) dentro de `container` e
 * devolve os que ficam ABAIXO de `minRatio` (default 4.5, AA para texto pequeno) — ajustes de UI
 * B5 (achado "Aún no hay mensajes"/"Adjuntar" quase invisíveis, pedido de varredura completa do
 * Gabriel). Roda inteiro DENTRO do browser (`locator.evaluate`) — mesma matemática de
 * `contrastRatioFromCss`/`relativeLuminance` acima, mas inline (uma função passada a `evaluate`
 * não pode fechar sobre as de fora: o Playwright serializa só o código, não o escopo léxico).
 *
 * "Régua que morre se clarear de novo": qualquer classe futura que deixe um texto abaixo de
 * 4.5:1 aparece aqui — não depende de saber o nome/testid do elemento de antemão.
 */
export async function scanContrastViolations(container: Locator, minRatio = 4.5): Promise<ContrastViolation[]> {
  return container.evaluate((root: Element, minRatioArg: number) => {
    function channelLuminance(c: number): number {
      const s = c / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    }
    function relLum(c: { r: number; g: number; b: number }): number {
      return 0.2126 * channelLuminance(c.r) + 0.7152 * channelLuminance(c.g) + 0.0722 * channelLuminance(c.b);
    }
    function parseColor(css: string): { r: number; g: number; b: number; a: number } | null {
      const m = css.match(/rgba?\(([^)]+)\)/);
      if (!m) return null;
      const parts = m[1].split(',').map((s) => parseFloat(s.trim()));
      return { r: parts[0], g: parts[1], b: parts[2], a: parts[3] === undefined ? 1 : parts[3] };
    }
    function compositeOver(
      fg: { r: number; g: number; b: number; a: number },
      bg: { r: number; g: number; b: number },
    ): { r: number; g: number; b: number } {
      return { r: fg.r * fg.a + bg.r * (1 - fg.a), g: fg.g * fg.a + bg.g * (1 - fg.a), b: fg.b * fg.a + bg.b * (1 - fg.a) };
    }
    function effectiveBg(el: Element): { r: number; g: number; b: number } {
      let node: Element | null = el;
      while (node) {
        const parsed = parseColor(getComputedStyle(node).backgroundColor);
        if (parsed && parsed.a > 0) return compositeOver(parsed, { r: 255, g: 255, b: 255 });
        node = node.parentElement;
      }
      return { r: 255, g: 255, b: 255 };
    }
    function hasDirectText(el: Element): boolean {
      return Array.from(el.childNodes).some((n) => n.nodeType === Node.TEXT_NODE && (n.textContent ?? '').trim().length > 0);
    }
    function isVisible(el: Element): boolean {
      const style = getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || parseFloat(style.opacity) === 0) return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    }

    const violations: Array<{ selector: string; text: string; color: string; backgroundColor: string; ratio: number }> = [];
    root.querySelectorAll('*').forEach((el) => {
      if (!hasDirectText(el) || !isVisible(el)) return;
      const style = getComputedStyle(el);
      const fg = parseColor(style.color);
      if (!fg) return;
      const bg = effectiveBg(el);
      const composited = compositeOver(fg, bg);
      const l1 = relLum(composited);
      const l2 = relLum(bg);
      const lighter = Math.max(l1, l2);
      const darker = Math.min(l1, l2);
      const ratio = (lighter + 0.05) / (darker + 0.05);
      if (ratio < minRatioArg) {
        const testid = el.getAttribute('data-testid');
        const selector = testid ? `[data-testid="${testid}"]` : el.tagName.toLowerCase();
        violations.push({
          selector,
          text: (el.textContent ?? '').trim().slice(0, 60),
          color: style.color,
          backgroundColor: `rgb(${Math.round(bg.r)}, ${Math.round(bg.g)}, ${Math.round(bg.b)})`,
          ratio: Math.round(ratio * 100) / 100,
        });
      }
    });
    return violations;
  }, minRatio);
}
