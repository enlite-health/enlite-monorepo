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


/**
 * Modo BUSCA NO SERVIDOR (07/09/2026).
 *
 * O componente tem 9 usos em 6 telas, e 8 deles continuam no modo local — por
 * isso o primeiro teste daqui é o que MAIS importa: sem `onSearchChange`, nada
 * muda. O modo novo existe porque filtrar em memória só acha quem já foi
 * carregado; no mapa isso escondia todo paciente fora de um raio de 50 km.
 */
describe('SearchableSelect — busca no servidor', () => {
  const abrir = (): void => { fireEvent.click(screen.getByRole('button')); };
  const digitar = (v: string): void => {
    fireEvent.change(screen.getByRole('textbox'), { target: { value: v } });
  };

  it('🔒 sem `onSearchChange` o filtro LOCAL continua igual (os outros 8 usos)', () => {
    render(<SearchableSelect options={OPTIONS} value="" onChange={vi.fn()} />);
    abrir();
    digitar('2-B');
    const opcoes = screen.getAllByRole('option').map((o) => o.textContent);
    expect(opcoes).toContain('Caso 2-B');
    expect(opcoes).not.toContain('Caso 1-A');
  });

  it('com `onSearchChange` NÃO filtra em memória: mostra o que o servidor devolveu', () => {
    // `serverSearchTerm` igual ao digitado = a resposta DESTE termo já chegou;
    // é só nesse estado que o cliente cede o filtro ao servidor.
    render(<SearchableSelect options={OPTIONS} value="" onChange={vi.fn()} onSearchChange={vi.fn()} serverSearchTerm="nada disso casa" />);
    abrir();
    digitar('nada disso casa');
    const opcoes = screen.getAllByRole('option').map((o) => o.textContent);
    expect(opcoes).toContain('Caso 1-A');
    expect(opcoes).toContain('Caso Ñoño');
  });

  it('devolve o termo UMA vez por pausa, não por tecla', () => {
    vi.useFakeTimers();
    try {
      const onSearchChange = vi.fn();
      render(<SearchableSelect options={OPTIONS} value="" onChange={vi.fn()} onSearchChange={onSearchChange} searchDebounceMs={300} />);
      abrir();
      onSearchChange.mockClear();
      digitar('R');
      digitar('Re');
      digitar('Rey');
      vi.advanceTimersByTime(299);
      expect(onSearchChange).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(onSearchChange).toHaveBeenCalledTimes(1);
      expect(onSearchChange).toHaveBeenCalledWith('Rey');
    } finally {
      vi.useRealTimers();
    }
  });

  it('🔒 pai que recria o callback a cada render NÃO dispara busca extra', () => {
    vi.useFakeTimers();
    try {
      const espia = vi.fn();
      // cada render passa uma função NOVA — é o caso que fez o autocomplete do
      // Places chamar o Google uma vez por tecla. O ref segura isso.
      const { rerender } = render(
        <SearchableSelect options={OPTIONS} value="" onChange={vi.fn()} onSearchChange={(t) => espia(t)} />,
      );
      abrir();
      digitar('Rey');
      espia.mockClear();
      rerender(<SearchableSelect options={OPTIONS} value="" onChange={vi.fn()} onSearchChange={(t) => espia(t)} />);
      rerender(<SearchableSelect options={OPTIONS} value="" onChange={vi.fn()} onSearchChange={(t) => espia(t)} />);
      vi.advanceTimersByTime(400);
      expect(espia).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('`emptyMessage` substitui o "Sin resultados" genérico', () => {
    render(
      <SearchableSelect options={[]} value="" onChange={vi.fn()} onSearchChange={vi.fn()} emptyMessage="Escribí al menos 2 letras" />,
    );
    abrir();
    expect(screen.getByTestId('searchable-select-empty').textContent).toBe('Escribí al menos 2 letras');
  });

  it('sem `emptyMessage` mantém o texto padrão', () => {
    render(<SearchableSelect options={[]} value="" onChange={vi.fn()} />);
    abrir();
    expect(screen.getByTestId('searchable-select-empty').textContent).toBe('Sin resultados');
  });
});

/**
 * ⚠️ Este teste NÃO fecha a linha 100 (`if (disabled) return` em `handleOpen`).
 * O `<button disabled>` já barra o clique no DOM, então aquele early-return é
 * inalcançável pela UI — código defensivo morto, anterior a esta mudança. Fica
 * como achado reportado, não removido aqui: apagá-lo é mudança de
 * comportamento fora do que foi pedido. O que o teste prova é o COMPORTAMENTO:
 * desabilitado não abre a lista.
 */
it('disabled não abre a lista', () => {
  const onSearchChange = vi.fn();
  render(<SearchableSelect options={OPTIONS} value="" onChange={vi.fn()} disabled onSearchChange={onSearchChange} />);
  fireEvent.click(screen.getByRole('button'));
  expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
});

/**
 * Os dois achados do gate no PR #320, nesta ordem de gravidade.
 */
describe('SearchableSelect — rótulo e mínimo de caracteres', () => {
  const abrir2 = (): void => { fireEvent.click(screen.getByRole('button')); };

  it('🔒 o rótulo do escolhido SOBREVIVE à troca da lista', () => {
    const escolhido = { value: 'mdp', label: 'Reyna Alaburda · Mar del Plata' };
    const { rerender } = render(
      <SearchableSelect options={[escolhido]} value="" onChange={vi.fn()} onSearchChange={vi.fn()} />,
    );
    // com o item na lista, o rótulo aparece
    rerender(<SearchableSelect options={[escolhido]} value="mdp" onChange={vi.fn()} onSearchChange={vi.fn()} />);
    expect(screen.getByRole('button').textContent).toContain('Reyna Alaburda');

    // a busca acaba e o pai volta ao escopo anterior: o escolhido SAI da lista.
    // Antes, aqui o botão voltava ao placeholder cinza.
    rerender(<SearchableSelect options={OPTIONS} value="mdp" onChange={vi.fn()} onSearchChange={vi.fn()} placeholder="Centrar en un paciente…" />);
    expect(screen.getByRole('button').textContent).toContain('Reyna Alaburda');
    expect(screen.getByRole('button').textContent).not.toContain('Centrar en un paciente…');
    // 🔒 e a COR anda junto: nome em cinza-de-placeholder lê como "nada escolhido"
    expect(screen.getByRole('button').querySelector('span')?.className).toContain('#374151');
    expect(screen.getByRole('button').querySelector('span')?.className).not.toContain('#B3B3B3');
  });

  it('🔒 sem seleção alguma, a cor CONTINUA sendo a de placeholder', () => {
    render(<SearchableSelect options={OPTIONS} value="" onChange={vi.fn()} placeholder="Todos" />);
    expect(screen.getByRole('button').querySelector('span')?.className).toContain('#B3B3B3');
  });

  it('🔒 escolher NÃO dispara busca nova (o dropdown já fechou)', () => {
    vi.useFakeTimers();
    try {
      const onSearchChange = vi.fn();
      render(<SearchableSelect options={OPTIONS} value="" onChange={vi.fn()} onSearchChange={onSearchChange} />);
      abrir2();
      fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Cas' } });
      vi.advanceTimersByTime(400);
      onSearchChange.mockClear();
      fireEvent.click(screen.getAllByRole('option')[1]);
      vi.advanceTimersByTime(400);
      expect(onSearchChange).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('valor que nunca esteve em lista nenhuma cai no placeholder, como antes', () => {
    render(<SearchableSelect options={OPTIONS} value="jamais-visto" onChange={vi.fn()} placeholder="Todos" />);
    expect(screen.getByRole('button').textContent).toContain('Todos');
  });

  it('🔒 enquanto a resposta NÃO chegou, o filtro local vale — a lista não aparece inteira', () => {
    // `serverSearchTerm=''` = as opções ainda são as da lista de repouso
    render(
      <SearchableSelect options={OPTIONS} value="" onChange={vi.fn()} onSearchChange={vi.fn()} serverSearchTerm="" />,
    );
    abrir2();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Z' } });
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['Todos']);
  });

  it('🔒 a janela do debounce também é coberta: texto longo, resposta ainda antiga', () => {
    // é o caso que a régua anterior (mínimo de caracteres) deixava passar:
    // 'ZZ' atingia o mínimo e o filtro local desligava ANTES da resposta.
    render(
      <SearchableSelect options={OPTIONS} value="" onChange={vi.fn()} onSearchChange={vi.fn()} serverSearchTerm="" />,
    );
    abrir2();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'ZZ' } });
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['Todos']);
  });

  it('chegada a resposta DESTE termo, quem manda é o servidor', () => {
    render(
      <SearchableSelect options={OPTIONS} value="" onChange={vi.fn()} onSearchChange={vi.fn()} serverSearchTerm="ZZ" />,
    );
    abrir2();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'ZZ' } });
    const opcoes = screen.getAllByRole('option').map((o) => o.textContent);
    expect(opcoes).toContain('Caso 1-A');
    expect(opcoes).toContain('Caso Ñoño');
  });
})
