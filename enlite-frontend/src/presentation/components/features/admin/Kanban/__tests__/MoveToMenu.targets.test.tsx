import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MoveToMenu } from '../MoveToMenu';

// i18n mock — retorna a própria chave pra asserir caminhos exatos
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));

const EVENT_TARGETS = ['CONVOKED', 'SELECTED', 'QUICK_RESPONSE_TEAM'] as const;

describe('MoveToMenu — prop opcional `targets` (spec 052, kanban do evento)', () => {
  it('(a) sem a prop, os destinos são INVITED/CONFIRMED/SELECTED menos o atual', async () => {
    const user = userEvent.setup();
    render(<MoveToMenu currentStage="COMPLETED" onMove={vi.fn()} />);
    await user.click(screen.getByTestId('move-to-button'));
    const ids = screen.getAllByRole('menuitem').map((b) => b.getAttribute('data-testid'));
    expect(ids).toEqual(['move-to-option-INVITED', 'move-to-option-CONFIRMED', 'move-to-option-SELECTED']);
  });

  it('(b) com targets=[CONVOKED, SELECTED, QUICK_RESPONSE_TEAM] as três opções aparecem, com rótulo da coluna', async () => {
    const user = userEvent.setup();
    render(<MoveToMenu currentStage="REJECTED" onMove={vi.fn()} targets={EVENT_TARGETS} />);
    await user.click(screen.getByTestId('move-to-button'));
    expect(screen.getByTestId('move-to-option-CONVOKED')).toHaveTextContent('admin.kanban.columns.CONVOKED');
    expect(screen.getByTestId('move-to-option-SELECTED')).toBeInTheDocument();
    expect(screen.getByTestId('move-to-option-QUICK_RESPONSE_TEAM')).toBeInTheDocument();
    expect(screen.queryByTestId('move-to-option-INVITED')).not.toBeInTheDocument();
  });

  it('(c) com targets, o destino atual some do menu', async () => {
    const user = userEvent.setup();
    render(<MoveToMenu currentStage="SELECTED" onMove={vi.fn()} targets={EVENT_TARGETS} />);
    await user.click(screen.getByTestId('move-to-button'));
    expect(screen.queryByTestId('move-to-option-SELECTED')).not.toBeInTheDocument();
    expect(screen.getByTestId('move-to-option-CONVOKED')).toBeInTheDocument();
  });

  it('(d) teclado: Tab chega ao botão (aria-haspopup=menu), Enter abre e Enter no item chama onMove', async () => {
    const user = userEvent.setup();
    const onMove = vi.fn();
    render(<MoveToMenu currentStage="CONVOKED" onMove={onMove} targets={EVENT_TARGETS} />);
    await user.tab();
    const button = screen.getByTestId('move-to-button');
    expect(button).toHaveFocus();
    expect(button).toHaveAttribute('aria-haspopup', 'menu');
    await user.keyboard('{Enter}');
    expect(screen.getByRole('menu')).toBeInTheDocument();
    await user.tab();
    expect(screen.getByTestId('move-to-option-SELECTED')).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(onMove).toHaveBeenCalledWith('SELECTED');
  });
});
