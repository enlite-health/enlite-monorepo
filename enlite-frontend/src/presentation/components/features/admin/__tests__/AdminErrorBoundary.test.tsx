/**
 * AdminErrorBoundary — o que a operadora vê quando a tela quebra.
 *
 * Achado da revisão de 30/08: ao quebrar, a tela cuspia
 * `Cannot read properties of undefined (reading 'map')` seguido de sete linhas
 * de `at RenderedRoute` — em cima, visível, sem nada dizendo o que fazer. Para a
 * Ana ou a Marcela isso é indistinguível de "o sistema morreu", e o texto que
 * acompanhava terminava em "Detalhes técnicos:", apresentando o stack como se
 * fosse a informação principal.
 *
 * Agora o detalhe vive num `<details>` recolhido: o suporte pede para expandir
 * quando precisa, e o console continua recebendo tudo — que é onde o dev olha.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AdminErrorBoundary } from '../AdminErrorBoundary';

function Explode(): JSX.Element {
  throw new Error("Cannot read properties of undefined (reading 'map')");
}

let spy: ReturnType<typeof vi.spyOn>;
beforeEach(() => { spy = vi.spyOn(console, 'error').mockImplementation(() => {}); });
afterEach(() => { spy.mockRestore(); });

describe('quando a tela quebra', () => {
  it('o stack trace NÃO fica visível — vive dentro de um <details> recolhido', () => {
    render(<AdminErrorBoundary><Explode /></AdminErrorBoundary>);

    const det = screen.getByTestId('admin-error-details') as HTMLDetailsElement;
    expect(det.tagName).toBe('DETAILS');
    // `open` ausente = recolhido. Se alguém trocar por <pre> solto, isto cai.
    expect(det.open).toBe(false);
    expect(det.querySelector('summary')).not.toBeNull();
  });

  it('a mensagem técnica continua ACESSÍVEL — recolher não é esconder', () => {
    render(<AdminErrorBoundary><Explode /></AdminErrorBoundary>);
    expect(screen.getByTestId('admin-error-details').textContent)
      .toContain("Cannot read properties of undefined");
  });

  it('o texto principal diz o que fazer, e não termina em "Detalhes técnicos:"', () => {
    render(<AdminErrorBoundary><Explode /></AdminErrorBoundary>);
    const corpo = screen.getByTestId('admin-error-details').parentElement!;
    const texto = corpo.querySelector('p')!.textContent!;
    expect(texto).not.toMatch(/técnicos:\s*$/i);
    expect(texto.length).toBeGreaterThan(30);
  });

  it('o console continua recebendo o erro — o dev não perde nada', () => {
    render(<AdminErrorBoundary><Explode /></AdminErrorBoundary>);
    const juntos = spy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(juntos).toContain('[AdminErrorBoundary]');
  });

  it('sem erro, renderiza os filhos e nenhum bloco de detalhe', () => {
    render(<AdminErrorBoundary><span>conteúdo</span></AdminErrorBoundary>);
    expect(screen.getByText('conteúdo')).toBeInTheDocument();
    expect(screen.queryByTestId('admin-error-details')).toBeNull();
  });
});
