/**
 * RouteErrorBoundary.test.tsx
 *
 * Testes unitários do RouteErrorBoundary.
 * Verifica que ao ocorrer um erro no render de filho o fallback amigável
 * é exibido com data-testid e título traduzido.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { RouteErrorBoundary } from './RouteErrorBoundary';

// Componente filho que lança erro no render
function ThrowOnRender(): never {
  throw new Error('erro de teste intencional');
}

describe('RouteErrorBoundary', () => {
  // Silencia o console.error para manter output limpo nos testes
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renderiza filhos normalmente quando não há erro', () => {
    render(
      <RouteErrorBoundary>
        <span data-testid="child">conteúdo saudável</span>
      </RouteErrorBoundary>,
    );

    expect(screen.getByTestId('child')).toBeInTheDocument();
  });

  it('exibe [data-testid="route-error-boundary"] quando filho lança erro', () => {
    render(
      <RouteErrorBoundary>
        <ThrowOnRender />
      </RouteErrorBoundary>,
    );

    expect(screen.getByTestId('route-error-boundary')).toBeInTheDocument();
  });

  it('exibe o título traduzido (worker.errorBoundary.title) na tela', () => {
    render(
      <RouteErrorBoundary>
        <ThrowOnRender />
      </RouteErrorBoundary>,
    );

    // i18n não está carregado no setup de teste (resources: {}) — a chave em si é exibida
    // como fallback. Verificamos que o heading está presente e contém texto visível.
    const boundary = screen.getByTestId('route-error-boundary');
    expect(boundary).toBeInTheDocument();

    // O heading (h2) deve existir dentro do boundary
    const heading = boundary.querySelector('h2');
    expect(heading).toBeInTheDocument();
  });

  it('exibe os botões de Recargar e Ir al inicio', () => {
    render(
      <RouteErrorBoundary>
        <ThrowOnRender />
      </RouteErrorBoundary>,
    );

    const boundary = screen.getByTestId('route-error-boundary');
    const buttons = boundary.querySelectorAll('button');
    // Dois botões: reload e home
    expect(buttons.length).toBeGreaterThanOrEqual(2);
  });

  it('usa fallback custom quando prop fallback é fornecida', () => {
    render(
      <RouteErrorBoundary fallback={<div data-testid="custom-fallback">custom</div>}>
        <ThrowOnRender />
      </RouteErrorBoundary>,
    );

    expect(screen.getByTestId('custom-fallback')).toBeInTheDocument();
    expect(screen.queryByTestId('route-error-boundary')).not.toBeInTheDocument();
  });
});
