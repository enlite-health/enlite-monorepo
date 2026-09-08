/**
 * Heading — o atom de título. Regressão da LISTA da spec 017 (08/09): `data-testid` (e qualquer atributo de
 * `<hN>`) era descartado, e o e2e "não achava" o título. Molde do `Text`, que já repassa `...rest`.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Heading } from '../Heading';

describe('Heading', () => {
  it('nível vira a tag semântica (h1–h4) e `as` sobrescreve só a tag; `id` chega ao DOM', () => {
    const { container, rerender } = render(<Heading level={2} id="t">Título</Heading>);
    expect(container.querySelector('h2#t')).not.toBeNull();
    rerender(<Heading level={1} as="h3">Título</Heading>);
    expect(container.querySelector('h3')).not.toBeNull();
    expect(container.querySelector('h1')).toBeNull();
  });

  it('🔒 repassa `data-testid`, `aria-*`, `title` e `onClick` (antes eram descartados em silêncio)', () => {
    const onClick = vi.fn();
    render(<Heading data-testid="meu-titulo" aria-label="rótulo" title="dica" onClick={onClick}>Título</Heading>);
    const h = screen.getByTestId('meu-titulo');
    expect(h.tagName).toBe('H1');
    expect(h.getAttribute('aria-label')).toBe('rótulo');
    expect(h.getAttribute('title')).toBe('dica');
    fireEvent.click(h);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('tamanho visual separado do nível: `size="compact"` mede 22px sem mudar a tag; pesos e cores viram classes; className é somado', () => {
    const { container } = render(<Heading level={1} size="compact" weight="bold" color="white" className="extra">T</Heading>);
    const h = container.querySelector('h1') as HTMLElement;
    expect(h.className).toContain('text-[22px]');
    expect(h.className).toContain('font-bold');
    expect(h.className).toContain('text-white');
    expect(h.className).toContain('extra');
    expect(h.className).not.toContain('text-2xl');
    const { container: c2 } = render(<Heading level={4} color="inherit">T</Heading>);
    expect((c2.querySelector('h4') as HTMLElement).className).toContain('text-base');
  });
});
