import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Combobox, type ComboboxProps } from './Combobox';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

/**
 * Os 30 casos do SearchableSelect (spec 070 T2), reescritos contra o Combobox.
 * Diferenças deliberadas, todas por contrato novo e não por afrouxamento:
 * - a linha "Todos" agora é `clearLabel="Todos"` (antes era implícita);
 * - o gatilho é `role=combobox` e o vazio é `${id}-no-results`;
 * - `label` não existe mais no componente (o rótulo é `<label htmlFor>` / aria-label);
 * - valor que nunca esteve em lista nenhuma aparece CRU (contrato do Combobox, T1).
 */
const OPTIONS = [
  { value: '1', label: 'Caso 1-A' },
  { value: '2', label: 'Caso 2-B' },
  { value: '3', label: 'Caso Ñoño' },
];

type Extra = Partial<Extract<ComboboxProps, { multiple?: false }>>;
const ui = (extra: Extra = {}): JSX.Element => (
  <Combobox id="sel" options={OPTIONS} value="" onChange={vi.fn()} clearLabel="Todos" {...extra} />
);
const abrir = (): void => { fireEvent.click(screen.getByRole('combobox')); };
const digitar = (v: string): void => {
  fireEvent.change(screen.getByRole('textbox'), { target: { value: v } });
};
const rotulos = (): (string | null)[] => screen.getAllByRole('option').map((o) => o.textContent);

describe('Combobox (modo local, casos do SearchableSelect)', () => {
  it('renders with placeholder when no value selected', () => {
    render(ui({ placeholder: 'Todos' }));
    expect(screen.getByRole('combobox')).toHaveTextContent('Todos');
  });

  it('renders selected option label', () => {
    render(ui({ value: '1' }));
    expect(screen.getByRole('combobox')).toHaveTextContent('Caso 1-A');
  });

  it('opens dropdown on button click', () => {
    render(ui());
    abrir();
    expect(screen.getByRole('listbox')).toBeInTheDocument();
  });

  it('shows all options when dropdown is open', () => {
    render(ui());
    abrir();
    expect(screen.getAllByRole('option').length).toBe(OPTIONS.length + 1); // +1 for "Todos"
  });

  it('filters options by search text (case insensitive)', () => {
    render(ui());
    abrir();
    digitar('caso 1');
    expect(rotulos()).toEqual(['Caso 1-A']);
  });

  it('filters options ignoring accents', () => {
    render(ui());
    abrir();
    digitar('nono');
    expect(rotulos()).toEqual(['Caso Ñoño']);
  });

  it('calls onChange with selected value', () => {
    const handleChange = vi.fn();
    render(ui({ onChange: handleChange }));
    abrir();
    fireEvent.click(screen.getByText('Caso 1-A'));
    expect(handleChange).toHaveBeenCalledWith('1');
  });

  it('calls onChange with empty string when "Todos" is selected', () => {
    const handleChange = vi.fn();
    render(ui({ value: '1', onChange: handleChange, placeholder: 'Todos' }));
    abrir();
    fireEvent.click(screen.getAllByText('Todos')[0]);
    expect(handleChange).toHaveBeenCalledWith('');
  });

  it('closes dropdown after selecting an option', () => {
    render(ui());
    abrir();
    fireEvent.click(screen.getByText('Caso 1-A'));
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('does not open when disabled', () => {
    render(ui({ disabled: true }));
    abrir();
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('rótulo acessível vem de aria-label (o SearchableSelect tinha prop label)', () => {
    render(ui({ 'aria-label': 'Caso clínico' }));
    expect(screen.getByRole('combobox', { name: 'Caso clínico' })).toBeInTheDocument();
  });

  it('shows no results message when filter finds nothing', () => {
    render(ui());
    abrir();
    digitar('xyz_inexistente_999');
    expect(screen.getByTestId('sel-no-results')).toHaveTextContent('common.multiSelect.noResults');
  });
});

describe('Combobox — inputSize e data-testid (linhas de filtro, REQ-06)', () => {
  it('compact usa h-12 e default usa h-[60px]', () => {
    const { rerender } = render(ui({ inputSize: 'compact', 'data-testid': 'g' }));
    expect(screen.getByTestId('g').className).toContain('h-12');
    rerender(ui({ 'data-testid': 'g' }));
    expect(screen.getByTestId('g').className).toContain('h-[60px]');
  });

  it('data-testid vai para o botão que abre a lista', () => {
    render(ui({ 'data-testid': 'meu-combo' }));
    fireEvent.click(screen.getByTestId('meu-combo'));
    expect(screen.getByRole('listbox')).toBeInTheDocument();
  });
});

describe('Combobox — clique fora', () => {
  it('fecha a lista ao clicar fora do componente', () => {
    render(ui());
    abrir();
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('não fecha ao clicar dentro (na busca)', () => {
    render(ui());
    abrir();
    fireEvent.mouseDown(screen.getByRole('listbox'));
    expect(screen.getByRole('listbox')).toBeInTheDocument();
  });
});

/**
 * Modo BUSCA NO SERVIDOR. Sem `onSearchChange`, nada muda (o 1º teste é o que
 * MAIS importa). O modo existe porque filtrar em memória só acha quem já foi
 * carregado; no mapa isso escondia todo paciente fora de um raio de 50 km.
 */
describe('Combobox — busca no servidor', () => {
  it('🔒 sem `onSearchChange` o filtro LOCAL continua igual (os outros usos)', () => {
    render(ui());
    abrir();
    digitar('2-B');
    expect(rotulos()).toContain('Caso 2-B');
    expect(rotulos()).not.toContain('Caso 1-A');
  });

  it('com `onSearchChange` NÃO filtra em memória: mostra o que o servidor devolveu', () => {
    // `serverSearchTerm` igual ao digitado = a resposta DESTE termo já chegou
    render(ui({ onSearchChange: vi.fn(), serverSearchTerm: 'nada disso casa' }));
    abrir();
    digitar('nada disso casa');
    expect(rotulos()).toContain('Caso 1-A');
    expect(rotulos()).toContain('Caso Ñoño');
  });

  it('devolve o termo UMA vez por pausa, não por tecla', () => {
    vi.useFakeTimers();
    try {
      const onSearchChange = vi.fn();
      render(ui({ onSearchChange, searchDebounceMs: 300 }));
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
      // cada render passa uma função NOVA — o ref segura isso
      const { rerender } = render(ui({ onSearchChange: (t) => espia(t) }));
      abrir();
      digitar('Rey');
      espia.mockClear();
      rerender(ui({ onSearchChange: (t) => espia(t) }));
      rerender(ui({ onSearchChange: (t) => espia(t) }));
      vi.advanceTimersByTime(400);
      expect(espia).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('`emptyMessage` substitui o "Sin resultados" genérico', () => {
    render(ui({ options: [], onSearchChange: vi.fn(), emptyMessage: 'Escribí al menos 2 letras' }));
    abrir();
    expect(screen.getByTestId('sel-no-results').textContent).toBe('Escribí al menos 2 letras');
  });

  it('sem `emptyMessage` mantém o texto padrão', () => {
    render(ui({ options: [] }));
    abrir();
    expect(screen.getByTestId('sel-no-results').textContent).toBe('common.multiSelect.noResults');
  });
});

it('disabled não abre a lista (modo servidor)', () => {
  render(ui({ disabled: true, onSearchChange: vi.fn() }));
  fireEvent.click(screen.getByRole('combobox'));
  expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
});

describe('Combobox — rótulo e janela cega', () => {
  it('🔒 o rótulo do escolhido SOBREVIVE à troca da lista', () => {
    const escolhido = { value: 'mdp', label: 'Reyna Alaburda · Mar del Plata' };
    const { rerender } = render(ui({ options: [escolhido], onSearchChange: vi.fn() }));
    rerender(ui({ options: [escolhido], value: 'mdp', onSearchChange: vi.fn() }));
    expect(screen.getByRole('combobox').textContent).toContain('Reyna Alaburda');

    // a busca acaba e o pai volta ao escopo anterior: o escolhido SAI da lista
    rerender(ui({ value: 'mdp', onSearchChange: vi.fn(), placeholder: 'Centrar en un paciente…' }));
    const gatilho = screen.getByRole('combobox');
    expect(gatilho.textContent).toContain('Reyna Alaburda');
    expect(gatilho.textContent).not.toContain('Centrar en un paciente…');
    // 🔒 a COR anda junto: nome em cor de placeholder lê como "nada escolhido"
    expect(gatilho.querySelector('span')?.className).toContain('text-gray-800');
    expect(gatilho.querySelector('span')?.className).not.toContain('text-gray-700');
  });

  it('🔒 sem seleção alguma, a cor CONTINUA sendo a de placeholder', () => {
    render(ui({ placeholder: 'Todos' }));
    expect(screen.getByRole('combobox').querySelector('span')?.className).toContain('text-gray-700');
  });

  it('🔒 escolher NÃO dispara busca nova (o dropdown já fechou)', () => {
    vi.useFakeTimers();
    try {
      const onSearchChange = vi.fn();
      render(ui({ onSearchChange }));
      abrir();
      digitar('Cas');
      vi.advanceTimersByTime(400);
      onSearchChange.mockClear();
      fireEvent.click(screen.getAllByRole('option')[1].querySelector('button')!);
      vi.advanceTimersByTime(400);
      expect(onSearchChange).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('valor que nunca esteve em lista nenhuma aparece cru (contrato do Combobox)', () => {
    render(ui({ value: 'jamais-visto', placeholder: 'Todos' }));
    expect(screen.getByRole('combobox').textContent).toContain('jamais-visto');
  });

  it('🔒 enquanto a resposta NÃO chegou, o filtro local vale — a lista não aparece inteira', () => {
    render(ui({ onSearchChange: vi.fn(), serverSearchTerm: '' }));
    abrir();
    digitar('Z');
    expect(screen.queryAllByRole('option')).toHaveLength(0);
    expect(screen.getByTestId('sel-no-results')).toBeInTheDocument();
  });

  it('🔒 a janela do debounce também é coberta: texto longo, resposta ainda antiga', () => {
    render(ui({ onSearchChange: vi.fn(), serverSearchTerm: '' }));
    abrir();
    digitar('ZZ');
    expect(screen.queryAllByRole('option')).toHaveLength(0);
  });

  it('chegada a resposta DESTE termo, quem manda é o servidor', () => {
    render(ui({ onSearchChange: vi.fn(), serverSearchTerm: 'ZZ' }));
    abrir();
    digitar('ZZ');
    expect(rotulos()).toContain('Caso 1-A');
    expect(rotulos()).toContain('Caso Ñoño');
  });

  it('🔒 modo servidor: escolher NÃO limpa o texto; reabrir limpa', () => {
    render(ui({ onSearchChange: vi.fn(), serverSearchTerm: 'Cas' }));
    abrir();
    digitar('Cas');
    fireEvent.click(screen.getAllByRole('option')[1].querySelector('button')!);
    abrir();
    expect(screen.getByRole('textbox')).toHaveValue('');
  });

  it('modo local: escolher limpa o texto da busca', () => {
    render(ui());
    abrir();
    digitar('caso 1');
    fireEvent.click(screen.getAllByRole('option')[0].querySelector('button')!);
    abrir();
    expect(screen.getByRole('textbox')).toHaveValue('');
  });

  it('modo servidor mostra o campo de busca mesmo com poucas opções', () => {
    render(ui({ options: OPTIONS.slice(0, 1), onSearchChange: vi.fn() }));
    abrir();
    expect(screen.getByRole('textbox')).toBeInTheDocument();
  });

  it('lista vazia sem busca: mostra a mensagem, sem input', () => {
    render(ui({ options: [], clearLabel: undefined }));
    abrir();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.getByTestId('sel-no-results')).toBeInTheDocument();
  });
});
