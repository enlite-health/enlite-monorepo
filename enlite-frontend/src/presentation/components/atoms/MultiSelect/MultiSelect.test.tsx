import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { cleanup } from '@testing-library/react';
import { MultiSelect } from './MultiSelect';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      if (key === 'common.multiSelect.selectedCount') {
        return `${opts?.count} seleccionados`;
      }
      return key;
    },
  }),
}));

const OPTIONS = [
  { value: 'A', label: 'Opción A' },
  { value: 'B', label: 'Opción B' },
  { value: 'C', label: 'Opción C' },
];

function renderMultiSelect(props: Partial<Parameters<typeof MultiSelect>[0]> = {}) {
  const fallbackOnChange = vi.fn();
  const mergedProps = {
    options: OPTIONS,
    value: [] as string[],
    onChange: fallbackOnChange,
    placeholder: 'Seleccionar',
    ...props,
  };
  const result = render(<MultiSelect {...mergedProps} />);
  return { ...result, onChange: mergedProps.onChange };
}

describe('MultiSelect', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows placeholder when no value selected', () => {
    renderMultiSelect({ value: [] });
    expect(screen.getByText('Seleccionar')).toBeInTheDocument();
  });

  it('shows single option label when exactly one selected', () => {
    renderMultiSelect({ value: ['A'] });
    expect(screen.getByText('Opción A')).toBeInTheDocument();
  });

  it('shows count label when multiple values selected', () => {
    renderMultiSelect({ value: ['A', 'B'] });
    expect(screen.getByText('2 seleccionados')).toBeInTheDocument();
  });

  it('opens dropdown on click', () => {
    renderMultiSelect();
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByRole('listbox')).toBeInTheDocument();
  });

  it('renders all options when open', () => {
    renderMultiSelect();
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByText('Opción A')).toBeInTheDocument();
    expect(screen.getByText('Opción B')).toBeInTheDocument();
    expect(screen.getByText('Opción C')).toBeInTheDocument();
  });

  it('calls onChange with toggled value when clicking unchecked option', () => {
    const onChange = vi.fn();
    renderMultiSelect({ value: [], onChange });
    fireEvent.click(screen.getByRole('button'));
    // The option buttons are inside the listbox
    const listbox = screen.getByRole('listbox');
    const optionBtns = listbox.querySelectorAll('button');
    fireEvent.click(optionBtns[0]);
    expect(onChange).toHaveBeenCalledWith(['A']);
  });

  it('calls onChange removing value when clicking checked option', () => {
    const onChange = vi.fn();
    renderMultiSelect({ value: ['A', 'B'], onChange });
    fireEvent.click(screen.getByRole('button'));
    const listbox = screen.getByRole('listbox');
    const optionBtns = listbox.querySelectorAll('button');
    fireEvent.click(optionBtns[0]);
    expect(onChange).toHaveBeenCalledWith(['B']);
  });

  it('closes on outside click', () => {
    renderMultiSelect();
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('toggles open/closed on Enter keydown on trigger', () => {
    renderMultiSelect();
    const btn = screen.getByRole('button');
    fireEvent.keyDown(btn, { key: 'Enter' });
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    fireEvent.keyDown(btn, { key: 'Enter' });
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('toggles open/closed on Space keydown on trigger', () => {
    renderMultiSelect();
    const btn = screen.getByRole('button');
    fireEvent.keyDown(btn, { key: ' ' });
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    fireEvent.keyDown(btn, { key: ' ' });
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('closes on Escape keydown on trigger', () => {
    renderMultiSelect();
    const btn = screen.getByRole('button');
    fireEvent.keyDown(btn, { key: 'Enter' });
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    fireEvent.keyDown(btn, { key: 'Escape' });
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('toggles option on Enter keydown on option button', () => {
    const onChange = vi.fn();
    renderMultiSelect({ value: [], onChange });
    fireEvent.click(screen.getByRole('button'));
    const listbox = screen.getByRole('listbox');
    const optionBtns = listbox.querySelectorAll('button');
    fireEvent.keyDown(optionBtns[0], { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith(['A']);
  });

  it('closes on Escape keydown on option button', () => {
    renderMultiSelect();
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    const listbox = screen.getByRole('listbox');
    const optionBtns = listbox.querySelectorAll('button');
    fireEvent.keyDown(optionBtns[0], { key: 'Escape' });
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('does not open when disabled', () => {
    renderMultiSelect({ disabled: true });
    const btn = screen.getByRole('button');
    fireEvent.click(btn);
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('shows checked state on checkboxes for selected values', () => {
    renderMultiSelect({ value: ['B'] });
    fireEvent.click(screen.getByRole('button'));
    const checkboxes = screen.getAllByRole('checkbox') as HTMLInputElement[];
    expect(checkboxes[0].checked).toBe(false); // A
    expect(checkboxes[1].checked).toBe(true);  // B
    expect(checkboxes[2].checked).toBe(false); // C
  });

  describe('searchable (spec 060)', () => {
    const OPCOES = [
      { value: 'A', label: 'Ejercicio con kinesiólogo' },
      { value: 'B', label: 'Higiene diaria' },
      { value: 'C', label: 'Salidas' },
    ];
    const abrir = (props: Partial<Parameters<typeof MultiSelect>[0]> = {}) => {
      const r = renderMultiSelect({ id: 'x', options: OPCOES, searchable: true, ...props });
      fireEvent.click(screen.getByRole('button'));
      return r;
    };
    const rotulos = () => screen.queryAllByRole('option').map((o) => o.textContent);

    it('t1 default sem searchable não tem input de busca', () => {
      renderMultiSelect({ id: 'x', options: OPCOES });
      fireEvent.click(screen.getByRole('button'));
      expect(screen.queryByTestId('x-search')).toBeNull();
      expect(screen.getAllByRole('option')).toHaveLength(3);
      cleanup();
      renderMultiSelect({ id: 'x', options: OPCOES, value: ['fora-do-catalogo'] });
      expect(screen.getByText('fora-do-catalogo')).toBeInTheDocument();
    });

    it('t2 com searchable, abrir mostra o input com foco', () => {
      abrir();
      const input = screen.getByTestId('x-search');
      expect(document.activeElement).toBe(input);
      expect(input).toHaveAttribute('aria-label', 'common.multiSelect.searchAriaLabel');
      expect(input).toHaveAttribute('placeholder', 'common.multiSelect.searchPlaceholder');
    });

    it('t3 digitar KINESIO (maiúscula, sem acento) deixa só a opção com acento', () => {
      abrir();
      fireEvent.change(screen.getByTestId('x-search'), { target: { value: ' KINESIO ' } });
      expect(rotulos()).toEqual(['Ejercicio con kinesiólogo']);
    });

    it('t4 sem match mostra x-no-results e 0 opções; rótulos custom valem', () => {
      abrir({ searchPlaceholder: 'Procurar', noResultsLabel: 'Nada aqui' });
      expect(screen.getByTestId('x-search')).toHaveAttribute('placeholder', 'Procurar');
      fireEvent.change(screen.getByTestId('x-search'), { target: { value: 'zzz' } });
      expect(screen.getByTestId('x-no-results')).toHaveTextContent('Nada aqui');
      cleanup();
      abrir();
      fireEvent.change(screen.getByTestId('x-search'), { target: { value: 'zzz' } });
      expect(screen.getByTestId('x-no-results')).toHaveTextContent('common.multiSelect.noResults');
      expect(screen.queryAllByRole('option')).toHaveLength(0);
    });

    it('t5 filtrar por higiene e clicar a única opção chama onChange([B])', () => {
      const { onChange } = abrir();
      fireEvent.change(screen.getByTestId('x-search'), { target: { value: 'higiene' } });
      fireEvent.click(screen.getAllByRole('option')[0].querySelector('button')!);
      expect(onChange).toHaveBeenCalledWith(['B']);
    });

    it('t6 fechar e reabrir mostra as 3 opções e input vazio', () => {
      abrir();
      fireEvent.change(screen.getByTestId('x-search'), { target: { value: 'sal' } });
      expect(rotulos()).toEqual(['Salidas']);
      fireEvent.click(screen.getAllByRole('button')[0]);
      fireEvent.click(screen.getAllByRole('button')[0]);
      expect(screen.getByTestId('x-search')).toHaveValue('');
      expect(screen.getAllByRole('option')).toHaveLength(3);
    });

    it('t7 Escape no input fecha e não propaga para o pai', () => {
      const onKeyDown = vi.fn();
      render(
        <div onKeyDown={onKeyDown}>
          <MultiSelect id="x" options={OPCOES} value={[]} onChange={vi.fn()} searchable />
        </div>,
      );
      fireEvent.click(screen.getByRole('button'));
      fireEvent.keyDown(screen.getByTestId('x-search'), { key: 'Escape' });
      expect(screen.getByRole('button')).toHaveAttribute('aria-expanded', 'false');
      expect(onKeyDown).not.toHaveBeenCalled();
    });

    it('t8 ArrowDown no input foca a 1ª opção; Enter não é propagado como submit; outras teclas são ignoradas', () => {
      abrir();
      const input = screen.getByTestId('x-search');
      fireEvent.keyDown(input, { key: 'a' });
      expect(document.activeElement).toBe(input);
      expect(fireEvent.keyDown(input, { key: 'Enter' })).toBe(false);
      fireEvent.keyDown(input, { key: 'ArrowDown' });
      expect(document.activeElement).toBe(screen.getAllByRole('option')[0].querySelector('button'));
    });
  });
});
