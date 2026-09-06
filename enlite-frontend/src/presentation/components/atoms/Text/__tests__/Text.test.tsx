/**
 * Text — QA caça ℹ️4 (spec 011): o atom descartava `data-*`/`aria-*`, e todo
 * `<Text data-testid="…">` do painel (8 consumidores) era um testid inerte.
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Text } from '../Text';

describe('Text', () => {
  it('repassa data-* e aria-* ao elemento', () => {
    render(<Text data-testid="t-1" aria-label="rótulo" data-clarity-mask="True">olá</Text>);
    const el = screen.getByTestId('t-1');
    expect(el.tagName).toBe('P');
    expect(el).toHaveAttribute('aria-label', 'rótulo');
    expect(el).toHaveAttribute('data-clarity-mask', 'True');
    expect(el).toHaveTextContent('olá');
  });

  it('mantém as classes do sistema (tamanho/peso/cor) e o title', () => {
    render(<Text as="span" size="xs" weight="semibold" color="muted" className="extra" title="dica" data-testid="t-2">x</Text>);
    const el = screen.getByTestId('t-2');
    expect(el.tagName).toBe('SPAN');
    expect(el).toHaveAttribute('title', 'dica');
    expect(el.className).toContain('font-lexend');
    expect(el.className).toContain('text-xs');
    expect(el.className).toContain('font-semibold');
    expect(el.className).toContain('text-gray-700');
    expect(el.className).toContain('extra');
  });
});
