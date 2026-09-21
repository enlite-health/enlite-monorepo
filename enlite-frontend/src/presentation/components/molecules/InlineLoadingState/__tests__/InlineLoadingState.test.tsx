import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { InlineLoadingState } from '../InlineLoadingState';

describe('InlineLoadingState', () => {
  it('mostra o texto e o papel/aria-live corretos para leitor de tela', () => {
    render(<InlineLoadingState label="Cargando mensajes…" data-testid="my-loading" />);
    const el = screen.getByTestId('my-loading');
    expect(el).toHaveAttribute('role', 'status');
    expect(el).toHaveAttribute('aria-live', 'polite');
    expect(el).toHaveTextContent('Cargando mensajes…');
  });

  it('tem o spinner (elemento com animate-spin)', () => {
    render(<InlineLoadingState label="x" data-testid="my-loading" />);
    expect(screen.getByTestId('my-loading').querySelector('.animate-spin')).toBeInTheDocument();
  });
});
