import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ProviderFilterCombobox } from './ProviderFilterCombobox';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

const OPTIONS = [
  { value: 'p1', label: 'García QA' },
  { value: 'p2', label: 'Gómez QA' },
];

describe('ProviderFilterCombobox', () => {
  it('POSITIVO — abre a listbox ao focar e lista as opções', () => {
    const onValueChange = vi.fn();
    render(<ProviderFilterCombobox id="combo" options={OPTIONS} value="" onValueChange={onValueChange} placeholder="Todos" ariaLabel="Filtrar" />);
    fireEvent.focus(screen.getByTestId('combo'));
    expect(screen.getByTestId('combo-listbox')).toBeInTheDocument();
    expect(screen.getByTestId('combo-option-p1')).toBeInTheDocument();
    expect(screen.getByTestId('combo-option-p2')).toBeInTheDocument();
  });

  it('POSITIVO — filtro ignora acento e maiúscula (D343)', () => {
    render(<ProviderFilterCombobox id="combo" options={OPTIONS} value="" onValueChange={vi.fn()} placeholder="Todos" ariaLabel="Filtrar" />);
    const input = screen.getByTestId('combo');
    fireEvent.change(input, { target: { value: 'garcia' } });
    expect(screen.getByTestId('combo-option-p1')).toBeInTheDocument();
    expect(screen.queryByTestId('combo-option-p2')).not.toBeInTheDocument();
  });

  it('NEGATIVO — sem match mostra a mensagem de "nenhum prestador"', () => {
    render(<ProviderFilterCombobox id="combo" options={OPTIONS} value="" onValueChange={vi.fn()} placeholder="Todos" ariaLabel="Filtrar" />);
    fireEvent.change(screen.getByTestId('combo'), { target: { value: 'zzz-no-existe' } });
    expect(screen.getByTestId('combo-no-match')).toBeInTheDocument();
  });

  it('POSITIVO — clicar numa opção seleciona e fecha a listbox', () => {
    const onValueChange = vi.fn();
    render(<ProviderFilterCombobox id="combo" options={OPTIONS} value="" onValueChange={onValueChange} placeholder="Todos" ariaLabel="Filtrar" />);
    fireEvent.focus(screen.getByTestId('combo'));
    fireEvent.click(screen.getByTestId('combo-option-p1'));
    expect(onValueChange).toHaveBeenCalledWith('p1');
    expect(screen.queryByTestId('combo-listbox')).not.toBeInTheDocument();
    expect(screen.getByTestId('combo')).toHaveValue('García QA');
  });

  it('POSITIVO — clicar em "Todos" (opção all) limpa o filtro', () => {
    const onValueChange = vi.fn();
    render(<ProviderFilterCombobox id="combo" options={OPTIONS} value="p1" onValueChange={onValueChange} placeholder="Todos" ariaLabel="Filtrar" />);
    fireEvent.focus(screen.getByTestId('combo'));
    fireEvent.click(screen.getByTestId('combo-option-all'));
    expect(onValueChange).toHaveBeenCalledWith('');
  });

  it('POSITIVO — navegação por teclado (seta baixo/cima, Enter seleciona)', () => {
    const onValueChange = vi.fn();
    render(<ProviderFilterCombobox id="combo" options={OPTIONS} value="" onValueChange={onValueChange} placeholder="Todos" ariaLabel="Filtrar" />);
    const input = screen.getByTestId('combo');
    fireEvent.focus(input);
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onValueChange).toHaveBeenCalledWith('p1');
  });

  it('POSITIVO — Escape fecha a listbox sem selecionar', () => {
    render(<ProviderFilterCombobox id="combo" options={OPTIONS} value="" onValueChange={vi.fn()} placeholder="Todos" ariaLabel="Filtrar" />);
    const input = screen.getByTestId('combo');
    fireEvent.focus(input);
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByTestId('combo-listbox')).not.toBeInTheDocument();
  });

  it('POSITIVO — Enter sem item ativo não chama onValueChange', () => {
    const onValueChange = vi.fn();
    render(<ProviderFilterCombobox id="combo" options={OPTIONS} value="" onValueChange={onValueChange} placeholder="Todos" ariaLabel="Filtrar" />);
    const input = screen.getByTestId('combo');
    fireEvent.focus(input);
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onValueChange).not.toHaveBeenCalled();
  });

  it('POSITIVO — clique fora fecha a listbox e volta o texto pro valor selecionado', () => {
    render(
      <div>
        <div data-testid="outside">fora</div>
        <ProviderFilterCombobox id="combo" options={OPTIONS} value="p1" onValueChange={vi.fn()} placeholder="Todos" ariaLabel="Filtrar" />
      </div>,
    );
    const input = screen.getByTestId('combo');
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'xyz' } });
    fireEvent.mouseDown(screen.getByTestId('outside'));
    expect(screen.queryByTestId('combo-listbox')).not.toBeInTheDocument();
    expect(input).toHaveValue('García QA');
  });

  it('POSITIVO — mousedown DENTRO do combobox (no próprio input) não fecha nem reseta o texto', () => {
    render(<ProviderFilterCombobox id="combo" options={OPTIONS} value="" onValueChange={vi.fn()} placeholder="Todos" ariaLabel="Filtrar" />);
    const input = screen.getByTestId('combo');
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'garcia' } });
    fireEvent.mouseDown(input);
    expect(screen.getByTestId('combo-listbox')).toBeInTheDocument();
    expect(input).toHaveValue('garcia');
  });

  it('NEGATIVO — tecla de seta com a listbox FECHADA não abre nem move o índice (early return)', () => {
    const onValueChange = vi.fn();
    render(<ProviderFilterCombobox id="combo" options={OPTIONS} value="" onValueChange={onValueChange} placeholder="Todos" ariaLabel="Filtrar" />);
    const input = screen.getByTestId('combo');
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(screen.queryByTestId('combo-listbox')).not.toBeInTheDocument();
    expect(onValueChange).not.toHaveBeenCalled();
  });

  it('POSITIVO — desmontar remove o listener de clique fora sem quebrar (cleanup do useEffect)', () => {
    const { unmount } = render(<ProviderFilterCombobox id="combo" options={OPTIONS} value="" onValueChange={vi.fn()} placeholder="Todos" ariaLabel="Filtrar" />);
    expect(() => unmount()).not.toThrow();
  });

  it('POSITIVO — troca de `value` por fora sincroniza o texto exibido', () => {
    const { rerender } = render(
      <ProviderFilterCombobox id="combo" options={OPTIONS} value="" onValueChange={vi.fn()} placeholder="Todos" ariaLabel="Filtrar" />,
    );
    rerender(<ProviderFilterCombobox id="combo" options={OPTIONS} value="p2" onValueChange={vi.fn()} placeholder="Todos" ariaLabel="Filtrar" />);
    expect(screen.getByTestId('combo')).toHaveValue('Gómez QA');
  });
});
