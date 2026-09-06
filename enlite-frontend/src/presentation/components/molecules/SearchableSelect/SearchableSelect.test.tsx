import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SearchableSelect } from './SearchableSelect';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => fallback ?? key,
  }),
}));

const OPTIONS = [
  { value: '1', label: 'Caso 1-A' },
  { value: '2', label: 'Caso 2-B' },
  { value: '3', label: 'Caso Ñoño' },
];

describe('SearchableSelect', () => {
  it('renders with placeholder when no value selected', () => {
    render(
      <SearchableSelect options={OPTIONS} value="" onChange={vi.fn()} placeholder="Todos" />
    );
    expect(screen.getByText('Todos')).toBeInTheDocument();
  });

  it('renders selected option label', () => {
    render(
      <SearchableSelect options={OPTIONS} value="1" onChange={vi.fn()} />
    );
    expect(screen.getByText('Caso 1-A')).toBeInTheDocument();
  });

  it('opens dropdown on button click', () => {
    render(
      <SearchableSelect options={OPTIONS} value="" onChange={vi.fn()} />
    );
    const button = screen.getByRole('button');
    fireEvent.click(button);
    expect(screen.getByRole('listbox')).toBeInTheDocument();
  });

  it('shows all options when dropdown is open', () => {
    render(
      <SearchableSelect options={OPTIONS} value="" onChange={vi.fn()} />
    );
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getAllByRole('option').length).toBe(OPTIONS.length + 1); // +1 for "Todos"
  });

  it('filters options by search text (case insensitive)', () => {
    render(
      <SearchableSelect options={OPTIONS} value="" onChange={vi.fn()} />
    );
    fireEvent.click(screen.getByRole('button'));
    const searchInput = screen.getByPlaceholderText('Buscar...');
    fireEvent.change(searchInput, { target: { value: 'caso 1' } });
    expect(screen.getByText('Caso 1-A')).toBeInTheDocument();
    expect(screen.queryByText('Caso 2-B')).not.toBeInTheDocument();
  });

  it('filters options ignoring accents', () => {
    render(
      <SearchableSelect options={OPTIONS} value="" onChange={vi.fn()} />
    );
    fireEvent.click(screen.getByRole('button'));
    const searchInput = screen.getByPlaceholderText('Buscar...');
    fireEvent.change(searchInput, { target: { value: 'nono' } });
    expect(screen.getByText('Caso Ñoño')).toBeInTheDocument();
  });

  it('calls onChange with selected value', () => {
    const handleChange = vi.fn();
    render(
      <SearchableSelect options={OPTIONS} value="" onChange={handleChange} />
    );
    fireEvent.click(screen.getByRole('button'));
    fireEvent.click(screen.getByText('Caso 1-A'));
    expect(handleChange).toHaveBeenCalledWith('1');
  });

  it('calls onChange with empty string when "Todos" is selected', () => {
    const handleChange = vi.fn();
    render(
      <SearchableSelect options={OPTIONS} value="1" onChange={handleChange} placeholder="Todos" />
    );
    fireEvent.click(screen.getByRole('button'));
    fireEvent.click(screen.getAllByText('Todos')[0]);
    expect(handleChange).toHaveBeenCalledWith('');
  });

  it('closes dropdown after selecting an option', () => {
    render(
      <SearchableSelect options={OPTIONS} value="" onChange={vi.fn()} />
    );
    fireEvent.click(screen.getByRole('button'));
    fireEvent.click(screen.getByText('Caso 1-A'));
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('does not open when disabled', () => {
    render(
      <SearchableSelect options={OPTIONS} value="" onChange={vi.fn()} disabled />
    );
    fireEvent.click(screen.getByRole('button'));
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('renders label when provided', () => {
    render(
      <SearchableSelect options={OPTIONS} value="" onChange={vi.fn()} label="Caso clínico" />
    );
    expect(screen.getByText('Caso clínico')).toBeInTheDocument();
  });

  it('shows no results message when filter finds nothing', () => {
    render(
      <SearchableSelect options={OPTIONS} value="" onChange={vi.fn()} />
    );
    fireEvent.click(screen.getByRole('button'));
    const searchInput = screen.getByPlaceholderText('Buscar...');
    fireEvent.change(searchInput, { target: { value: 'xyz_inexistente_999' } });
    expect(screen.getByText('Sin resultados')).toBeInTheDocument();
  });
});

describe('SearchableSelect — inputSize e data-testid (linhas de filtro, REQ-06)', () => {
  it('compact usa a altura do Select compact (h-10) e default mantém h-12', () => {
    const { rerender } = render(
      <SearchableSelect options={OPTIONS} value="" onChange={vi.fn()} inputSize="compact" data-testid="sel" />
    );
    expect(screen.getByTestId('sel').className).toContain('h-10');
    rerender(<SearchableSelect options={OPTIONS} value="" onChange={vi.fn()} data-testid="sel" />);
    expect(screen.getByTestId('sel').className).toContain('h-12');
  });

  it('data-testid vai para o botão que abre a lista', () => {
    render(<SearchableSelect options={OPTIONS} value="" onChange={vi.fn()} data-testid="meu-combo" />);
    fireEvent.click(screen.getByTestId('meu-combo'));
    expect(screen.getByRole('listbox')).toBeInTheDocument();
  });
});

describe('SearchableSelect — clique fora', () => {
  it('fecha a lista ao clicar fora do componente', () => {
    render(<SearchableSelect options={OPTIONS} value="" onChange={vi.fn()} data-testid="sel" />);
    fireEvent.click(screen.getByTestId('sel'));
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('não fecha ao clicar dentro (na busca)', () => {
    render(<SearchableSelect options={OPTIONS} value="" onChange={vi.fn()} data-testid="sel" />);
    fireEvent.click(screen.getByTestId('sel'));
    fireEvent.mouseDown(screen.getByRole('listbox'));
    expect(screen.getByRole('listbox')).toBeInTheDocument();
  });
});

