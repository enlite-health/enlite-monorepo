import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SlideOverPanel } from './SlideOverPanel';

describe('SlideOverPanel', () => {
  it('quando fechado, o painel fica fora da viewport (translate-x-full)', () => {
    render(
      <SlideOverPanel isOpen={false} onClose={vi.fn()} ariaLabel="Painel de teste">
        <div>conteúdo</div>
      </SlideOverPanel>
    );
    const panel = screen.getByTestId('slide-over-panel');
    expect(panel.className).toContain('translate-x-full');
    expect(panel.className).not.toContain('translate-x-0');
  });

  it('quando aberto, o painel fica na viewport (translate-x-0)', () => {
    render(
      <SlideOverPanel isOpen onClose={vi.fn()} ariaLabel="Painel de teste">
        <div>conteúdo</div>
      </SlideOverPanel>
    );
    const panel = screen.getByTestId('slide-over-panel');
    expect(panel.className).toContain('translate-x-0');
    expect(panel.className).not.toContain('translate-x-full');
  });

  it('modal=true mostra overlay bg-black/50', () => {
    render(
      <SlideOverPanel isOpen onClose={vi.fn()} modal ariaLabel="Painel de teste">
        <div>conteúdo</div>
      </SlideOverPanel>
    );
    const overlay = screen.getByTestId('slide-over-panel-backdrop');
    expect(overlay.className).toContain('bg-black/50');
  });

  it('modal=true: clicar no overlay chama onClose', () => {
    const onClose = vi.fn();
    render(
      <SlideOverPanel isOpen onClose={onClose} modal ariaLabel="Painel de teste">
        <div>conteúdo</div>
      </SlideOverPanel>
    );
    fireEvent.click(screen.getByTestId('slide-over-panel-backdrop'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('modal=true e fechado: overlay existe mas com opacity-0 (não bloqueia)', () => {
    render(
      <SlideOverPanel isOpen={false} onClose={vi.fn()} modal ariaLabel="Painel de teste">
        <div>conteúdo</div>
      </SlideOverPanel>
    );
    const overlay = screen.getByTestId('slide-over-panel-backdrop');
    expect(overlay.className).toContain('opacity-0');
    expect(overlay.className).toContain('pointer-events-none');
  });

  it('modal=false (default) não mostra overlay e o resto da tela continua interativo', () => {
    const outsideClick = vi.fn();
    render(
      <>
        <button onClick={outsideClick}>botão de fora</button>
        <SlideOverPanel isOpen onClose={vi.fn()} ariaLabel="Painel de teste">
          <div>conteúdo</div>
        </SlideOverPanel>
      </>
    );
    expect(screen.queryByTestId('slide-over-panel-backdrop')).not.toBeInTheDocument();

    // o resto da tela segue clicável — nada bloqueia o clique no botão de fora
    fireEvent.click(screen.getByText('botão de fora'));
    expect(outsideClick).toHaveBeenCalledTimes(1);
  });

  it('Esc fecha o painel', () => {
    const onClose = vi.fn();
    render(
      <SlideOverPanel isOpen onClose={onClose} ariaLabel="Painel de teste">
        <div>conteúdo</div>
      </SlideOverPanel>
    );
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Esc não faz nada quando o painel está fechado', () => {
    const onClose = vi.fn();
    render(
      <SlideOverPanel isOpen={false} onClose={onClose} ariaLabel="Painel de teste">
        <div>conteúdo</div>
      </SlideOverPanel>
    );
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
  });
});
