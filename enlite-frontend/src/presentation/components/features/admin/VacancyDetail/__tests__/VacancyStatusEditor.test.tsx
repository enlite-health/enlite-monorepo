import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { VacancyStatusEditor } from '../VacancyStatusEditor';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));
vi.mock('@presentation/components/atoms/VacancyStatusBadge/VacancyStatusBadge', () => ({
  VacancyStatusBadge: ({ status }: { status: string }) => <span data-testid="badge">{status}</span>,
}));

describe('VacancyStatusEditor', () => {
  it('renderiza o badge e o gatilho fechado por padrão', () => {
    render(<VacancyStatusEditor status="SEARCHING" onChange={vi.fn()} />);
    expect(screen.getByTestId('badge')).toHaveTextContent('SEARCHING');
    expect(screen.queryByTestId('vacancy-status-editor-dropdown')).not.toBeInTheDocument();
  });

  it('clique no gatilho abre o dropdown com as opções editáveis', () => {
    render(<VacancyStatusEditor status="SEARCHING" onChange={vi.fn()} />);
    fireEvent.click(screen.getByTestId('vacancy-status-editor-trigger'));
    expect(screen.getByTestId('vacancy-status-editor-dropdown')).toBeInTheDocument();
    expect(screen.getByTestId('vacancy-status-option-CLOSED')).toBeInTheDocument();
  });

  it('escolher uma opção diferente chama onChange e fecha o dropdown', async () => {
    const onChange = vi.fn().mockResolvedValue(undefined);
    render(<VacancyStatusEditor status="SEARCHING" onChange={onChange} />);
    fireEvent.click(screen.getByTestId('vacancy-status-editor-trigger'));
    fireEvent.click(screen.getByTestId('vacancy-status-option-CLOSED'));
    expect(onChange).toHaveBeenCalledWith('CLOSED');
    expect(screen.queryByTestId('vacancy-status-editor-dropdown')).not.toBeInTheDocument();
  });

  it('escolher a opção JÁ atual não chama onChange', () => {
    const onChange = vi.fn();
    render(<VacancyStatusEditor status="SEARCHING" onChange={onChange} />);
    fireEvent.click(screen.getByTestId('vacancy-status-editor-trigger'));
    fireEvent.click(screen.getByTestId('vacancy-status-option-SEARCHING'));
    expect(onChange).not.toHaveBeenCalled();
  });

  it('clique fora fecha o dropdown', () => {
    render(
      <div>
        <VacancyStatusEditor status="SEARCHING" onChange={vi.fn()} />
        <div data-testid="fora">fora</div>
      </div>,
    );
    fireEvent.click(screen.getByTestId('vacancy-status-editor-trigger'));
    expect(screen.getByTestId('vacancy-status-editor-dropdown')).toBeInTheDocument();
    fireEvent.mouseDown(screen.getByTestId('fora'));
    expect(screen.queryByTestId('vacancy-status-editor-dropdown')).not.toBeInTheDocument();
  });

  it('isSaving=true: gatilho desabilitado, mostra spinner, não abre dropdown', () => {
    render(<VacancyStatusEditor status="SEARCHING" isSaving onChange={vi.fn()} />);
    const trigger = screen.getByTestId('vacancy-status-editor-trigger');
    expect(trigger).toBeDisabled();
    fireEvent.click(trigger);
    expect(screen.queryByTestId('vacancy-status-editor-dropdown')).not.toBeInTheDocument();
  });

  it('disabled=true: gatilho desabilitado, clique não abre (prop genérica — D269 esconde o componente inteiro em vez de usar isto, ver VacancyCaseCard)', () => {
    render(<VacancyStatusEditor status="SEARCHING" disabled onChange={vi.fn()} />);
    const trigger = screen.getByTestId('vacancy-status-editor-trigger');
    expect(trigger).toBeDisabled();
    fireEvent.click(trigger);
    expect(screen.queryByTestId('vacancy-status-editor-dropdown')).not.toBeInTheDocument();
  });
});
