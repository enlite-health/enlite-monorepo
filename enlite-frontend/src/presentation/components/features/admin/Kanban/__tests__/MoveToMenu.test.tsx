import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MoveToMenu } from '../MoveToMenu';

// i18n mock — retorna a própria chave pra asserir caminhos exatos
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));

vi.mock('lucide-react', () => ({
  ArrowRightLeft: (p: Record<string, unknown>) => <svg data-testid="icon-move" {...p} />,
  ChevronDown: (p: Record<string, unknown>) => <svg data-testid="icon-chevron" {...p} />,
}));

describe('MoveToMenu', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('mostra o botão "Mover a…"', () => {
    render(<MoveToMenu currentStage="COMPLETED" onMove={vi.fn()} />);
    expect(screen.getByTestId('move-to-button')).toBeInTheDocument();
  });

  it('menu fechado por padrão; abre ao clicar no botão', () => {
    render(<MoveToMenu currentStage="COMPLETED" onMove={vi.fn()} />);
    expect(screen.queryByTestId('move-to-menu')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('move-to-button'));
    expect(screen.getByTestId('move-to-menu')).toBeInTheDocument();
  });

  it('lista os 3 destinos manuais numa coluna não-target (COMPLETED)', () => {
    render(<MoveToMenu currentStage="COMPLETED" onMove={vi.fn()} />);
    fireEvent.click(screen.getByTestId('move-to-button'));
    expect(screen.getByTestId('move-to-option-INVITED')).toBeInTheDocument();
    expect(screen.getByTestId('move-to-option-CONFIRMED')).toBeInTheDocument();
    expect(screen.getByTestId('move-to-option-SELECTED')).toBeInTheDocument();
  });

  it('exclui o destino atual (CONFIRMED some se o card já está em CONFIRMED)', () => {
    render(<MoveToMenu currentStage="CONFIRMED" onMove={vi.fn()} />);
    fireEvent.click(screen.getByTestId('move-to-button'));
    expect(screen.queryByTestId('move-to-option-CONFIRMED')).not.toBeInTheDocument();
    expect(screen.getByTestId('move-to-option-INVITED')).toBeInTheDocument();
    expect(screen.getByTestId('move-to-option-SELECTED')).toBeInTheDocument();
  });

  it('trata INICIADO como INVITED efetivo (não oferece Invitados)', () => {
    render(<MoveToMenu currentStage="INICIADO" onMove={vi.fn()} />);
    fireEvent.click(screen.getByTestId('move-to-button'));
    expect(screen.queryByTestId('move-to-option-INVITED')).not.toBeInTheDocument();
    expect(screen.getByTestId('move-to-option-CONFIRMED')).toBeInTheDocument();
    expect(screen.getByTestId('move-to-option-SELECTED')).toBeInTheDocument();
  });

  it('chama onMove com o stage escolhido e fecha o menu', () => {
    const onMove = vi.fn();
    render(<MoveToMenu currentStage="COMPLETED" onMove={onMove} />);
    fireEvent.click(screen.getByTestId('move-to-button'));
    fireEvent.click(screen.getByTestId('move-to-option-SELECTED'));
    expect(onMove).toHaveBeenCalledWith('SELECTED');
    expect(screen.queryByTestId('move-to-menu')).not.toBeInTheDocument();
  });

  it('rótulo de cada opção usa a label da coluna (admin.kanban.columns.*)', () => {
    render(<MoveToMenu currentStage="COMPLETED" onMove={vi.fn()} />);
    fireEvent.click(screen.getByTestId('move-to-button'));
    expect(screen.getByTestId('move-to-option-INVITED')).toHaveTextContent('admin.kanban.columns.INVITED');
  });
});
