import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import colors from 'tailwindcss/colors';
import { CustosChip } from '../CustosChip';
import { CHIP_TONES, type ChipTone } from '../custosChipTones';

/** Paleta efetiva do projeto: a padrão do Tailwind + as chaves de `tailwind.config.js` que o chip usa (valores lidos de lá, não de cabeça). */
const PROJETO: Record<string, string> = { 'gray-300': '#EEEEEE', 'gray-800': '#737373', primary: '#180149' };

function hexDe(token: string): string {
  const nome = token.replace(/^(bg|text)-/, '');
  if (PROJETO[nome]) return PROJETO[nome];
  const [familia, tom] = nome.split('-');
  return (colors as unknown as Record<string, Record<string, string>>)[familia][tom];
}
function luminancia(hex: string): number {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
export function contraste(a: string, b: string): number {
  const [x, y] = [luminancia(a), luminancia(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

describe('CustosChip — par de cores medido (UI-4, ≥ 7:1)', () => {
  it.each(Object.keys(CHIP_TONES) as ChipTone[])('tom %s: contraste texto/fundo ≥ 7', (tom) => {
    const { bg, fg } = CHIP_TONES[tom];
    expect(contraste(hexDe(bg), hexDe(fg))).toBeGreaterThanOrEqual(7);
  });

  it('controle positivo: o cálculo reprova o cinza padrão do Text (#737373 no branco = 4,74:1)', () => {
    expect(contraste('#FFFFFF', '#737373')).toBeLessThan(7);
    expect(contraste('#FFFFFF', '#737373')).toBeCloseTo(4.74, 1);
  });

  it('renderiza texto + classes do tom e marca a linha única (cor nunca é o único sinal)', () => {
    render(<CustosChip tone="new">novo</CustosChip>);
    const el = screen.getByText('novo');
    expect(el).toHaveAttribute('data-single-line', 'selo');
    expect(el.className).toContain('bg-blue-100');
    expect(el.className).toContain('whitespace-nowrap');
  });
});
