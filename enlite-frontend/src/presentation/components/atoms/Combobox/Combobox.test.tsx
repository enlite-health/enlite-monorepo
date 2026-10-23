import { createRef } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useForm, Controller } from 'react-hook-form';
import { Combobox, SEARCH_MIN_OPTIONS, type ComboboxProps } from './Combobox';
import { selectCombo } from './testUtils';

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

function renderMultiSelect(props: Record<string, unknown> = {}) {
  const fallbackOnChange = vi.fn();
  const mergedProps = {
    multiple: true,
    options: OPTIONS,
    value: [] as string[],
    onChange: fallbackOnChange,
    placeholder: 'Seleccionar',
    ...props,
  } as ComboboxProps;
  const result = render(<Combobox {...mergedProps} />);
  return { ...result, onChange: mergedProps.onChange as ReturnType<typeof vi.fn> };
}

function renderSingle(props: Record<string, unknown> = {}) {
  const onChange = vi.fn();
  const mergedProps = {
    options: OPTIONS,
    value: '',
    onChange,
    placeholder: 'Seleccionar',
    ...props,
  } as ComboboxProps;
  const result = render(<Combobox {...mergedProps} />);
  return { ...result, onChange: mergedProps.onChange as ReturnType<typeof vi.fn> };
}

const trigger = () => screen.getByRole('combobox');

describe('Combobox múltipla (herdada do MultiSelect)', () => {
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

  it('multi: id desconhecido não aparece cru nem entra na contagem', () => {
    renderMultiSelect({ value: ['zzz'] });
    expect(trigger()).toHaveTextContent('Seleccionar');
    expect(trigger().textContent).not.toContain('zzz');
    cleanup();
    renderMultiSelect({ value: ['A', 'zzz'] });
    expect(trigger()).toHaveTextContent('Opción A');
  });

  it('opens dropdown on click', () => {
    renderMultiSelect();
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    fireEvent.click(trigger());
    expect(screen.getByRole('listbox')).toBeInTheDocument();
  });

  it('renders all options when open', () => {
    renderMultiSelect();
    fireEvent.click(trigger());
    expect(screen.getByText('Opción A')).toBeInTheDocument();
    expect(screen.getByText('Opción B')).toBeInTheDocument();
    expect(screen.getByText('Opción C')).toBeInTheDocument();
  });

  it('calls onChange with toggled value when clicking unchecked option', () => {
    const onChange = vi.fn();
    renderMultiSelect({ value: [], onChange });
    fireEvent.click(trigger());
    // The option buttons are inside the listbox
    const listbox = screen.getByRole('listbox');
    const optionBtns = listbox.querySelectorAll('button');
    fireEvent.click(optionBtns[0]);
    expect(onChange).toHaveBeenCalledWith(['A']);
  });

  it('calls onChange removing value when clicking checked option', () => {
    const onChange = vi.fn();
    renderMultiSelect({ value: ['A', 'B'], onChange });
    fireEvent.click(trigger());
    const listbox = screen.getByRole('listbox');
    const optionBtns = listbox.querySelectorAll('button');
    fireEvent.click(optionBtns[0]);
    expect(onChange).toHaveBeenCalledWith(['B']);
  });

  it('closes on outside click', () => {
    renderMultiSelect();
    fireEvent.click(trigger());
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('toggles open/closed on Enter keydown on trigger', () => {
    renderMultiSelect();
    const btn = trigger();
    fireEvent.keyDown(btn, { key: 'Enter' });
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    fireEvent.keyDown(btn, { key: 'Enter' });
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('toggles open/closed on Space keydown on trigger', () => {
    renderMultiSelect();
    const btn = trigger();
    fireEvent.keyDown(btn, { key: ' ' });
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    fireEvent.keyDown(btn, { key: ' ' });
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('closes on Escape keydown on trigger', () => {
    renderMultiSelect();
    const btn = trigger();
    fireEvent.keyDown(btn, { key: 'Enter' });
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    fireEvent.keyDown(btn, { key: 'Escape' });
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('toggles option on Enter keydown on option button', () => {
    const onChange = vi.fn();
    renderMultiSelect({ value: [], onChange });
    fireEvent.click(trigger());
    const listbox = screen.getByRole('listbox');
    const optionBtns = listbox.querySelectorAll('button');
    fireEvent.keyDown(optionBtns[0], { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith(['A']);
  });

  it('closes on Escape keydown on option button', () => {
    renderMultiSelect();
    fireEvent.click(trigger());
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    const listbox = screen.getByRole('listbox');
    const optionBtns = listbox.querySelectorAll('button');
    fireEvent.keyDown(optionBtns[0], { key: 'Escape' });
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('does not open when disabled', () => {
    renderMultiSelect({ disabled: true });
    const btn = trigger();
    fireEvent.click(btn);
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('shows checked state on checkboxes for selected values', () => {
    renderMultiSelect({ value: ['B'] });
    fireEvent.click(trigger());
    const checkboxes = screen.getAllByRole('checkbox') as HTMLInputElement[];
    expect(checkboxes[0].checked).toBe(false); // A
    expect(checkboxes[1].checked).toBe(true);  // B
    expect(checkboxes[2].checked).toBe(false); // C
  });

  describe('busca local (spec 060 → 070)', () => {
    const OPCOES = [
      { value: 'A', label: 'Ejercicio con kinesiólogo' },
      { value: 'B', label: 'Higiene diaria' },
      { value: 'C', label: 'Salidas' },
    ];
    const abrir = (props: Record<string, unknown> = {}) => {
      const r = renderMultiSelect({ id: 'x', options: OPCOES, ...props });
      fireEvent.click(trigger());
      return r;
    };
    const rotulos = () => screen.queryAllByRole('option').map((o) => o.textContent);

    it('t1 com 2 opções NÃO mostra input; com 3 mostra (SEARCH_MIN_OPTIONS)', () => {
      expect(SEARCH_MIN_OPTIONS).toBe(3);
      renderMultiSelect({ id: 'x', options: OPCOES.slice(0, 2) });
      fireEvent.click(trigger());
      expect(screen.queryByTestId('x-search')).toBeNull();
      expect(screen.getAllByRole('option')).toHaveLength(2);
      cleanup();
      renderMultiSelect({ id: 'x', options: OPCOES });
      fireEvent.click(trigger());
      expect(screen.getByTestId('x-search')).toBeInTheDocument();
      cleanup();
      renderMultiSelect({ id: 'x', options: OPCOES, value: ['fora-do-catalogo'] });
      expect(screen.queryByText('fora-do-catalogo')).not.toBeInTheDocument();
    });

    it('t2 abrir mostra o input com foco', () => {
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
      fireEvent.click(trigger());
      fireEvent.click(trigger());
      expect(screen.getByTestId('x-search')).toHaveValue('');
      expect(screen.getAllByRole('option')).toHaveLength(3);
    });

    it('t7 Escape no input fecha e não propaga para o pai', () => {
      const onKeyDown = vi.fn();
      render(
        <div onKeyDown={onKeyDown}>
          <Combobox multiple id="x" options={OPCOES} value={[]} onChange={vi.fn()} />
        </div>,
      );
      fireEvent.click(trigger());
      fireEvent.keyDown(screen.getByTestId('x-search'), { key: 'Escape' });
      expect(trigger()).toHaveAttribute('aria-expanded', 'false');
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

  describe('seleção única', () => {
    it('abre, escolhe, chama onChange e fecha', async () => {
      const { onChange } = renderSingle();
      const user = userEvent.setup();
      await user.click(trigger());
      await user.click(screen.getByRole('option', { name: 'Opción B' }).querySelector('button')!);
      expect(onChange).toHaveBeenCalledWith('B');
      expect(screen.queryByRole('listbox')).toBeNull();
    });

    it('mostra o rótulo escolhido no gatilho e o placeholder quando vazio', () => {
      renderSingle({ value: 'C' });
      expect(trigger()).toHaveTextContent('Opción C');
      cleanup();
      renderSingle({ value: '' });
      expect(trigger()).toHaveTextContent('Seleccionar');
    });

    it('valor fora do catálogo mostra o placeholder, nunca o valor cru', () => {
      renderSingle({ value: 'zzz' });
      expect(trigger()).toHaveTextContent('Seleccionar');
      expect(trigger().textContent).not.toContain('zzz');
    });

    it('clearLabel cria a 1ª linha que limpa para ""', async () => {
      const { onChange } = renderSingle({ value: 'B', clearLabel: 'Todos' });
      const user = userEvent.setup();
      await user.click(trigger());
      const rows = screen.getAllByRole('option');
      expect(rows[0]).toHaveTextContent('Todos');
      await user.click(rows[0].querySelector('button')!);
      expect(onChange).toHaveBeenCalledWith('');
    });

    it('sem clearLabel não há linha ""', async () => {
      renderSingle({ value: 'B' });
      await userEvent.setup().click(trigger());
      expect(screen.getAllByRole('option')).toHaveLength(3);
    });

    it('selectCombo (helper) escolhe pelo nome acessível e rótulo', async () => {
      const { onChange } = renderSingle({ 'aria-label': 'Campo' });
      await selectCombo('Campo', 'Opción C');
      expect(onChange).toHaveBeenCalledWith('C');
    });

    it('opção disabled não é clicável', async () => {
      const { onChange } = renderSingle({
        options: [...OPTIONS.slice(0, 2), { value: 'D', label: 'Opción D', disabled: true }],
      });
      await userEvent.setup().click(trigger());
      await userEvent.setup().click(screen.getByRole('option', { name: 'Opción D' }).querySelector('button')!);
      expect(onChange).not.toHaveBeenCalled();
    });
  });

  describe('múltipla', () => {
    it('alterna e fica aberta', async () => {
      const { onChange } = renderMultiSelect({ value: ['A'] });
      const user = userEvent.setup();
      await user.click(trigger());
      await user.click(screen.getByRole('option', { name: 'Opción B' }).querySelector('button')!);
      expect(onChange).toHaveBeenCalledWith(['A', 'B']);
      expect(screen.getByRole('listbox')).toHaveAttribute('aria-multiselectable', 'true');
    });
  });

  describe('busca com acento e searchText', () => {
    const NOMES = [
      { value: '1', label: 'García' },
      { value: '2', label: 'Zeta', searchText: 'ZZ-900' },
      { value: '3', label: 'Ñandú' },
    ];

    it('acento NO TERMO: "garcía" acha "Garcia" e "GARCIA" acha "García"', async () => {
      const user = userEvent.setup();
      renderSingle({ id: 'n', options: [{ value: '1', label: 'Garcia' }, NOMES[1], NOMES[2]] });
      await user.click(trigger());
      await user.type(screen.getByTestId('n-search'), 'garcía');
      expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['Garcia']);
      cleanup();
      renderSingle({ id: 'n', options: NOMES });
      await user.click(trigger());
      await user.type(screen.getByTestId('n-search'), 'GARCIA');
      expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['García']);
    });

    it('"garcia" acha "García"; "nandu" acha "Ñandú"', async () => {
      renderSingle({ id: 'n', options: NOMES });
      const user = userEvent.setup();
      await user.click(trigger());
      await user.type(screen.getByTestId('n-search'), 'garcia');
      expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['García']);
      await user.clear(screen.getByTestId('n-search'));
      await user.type(screen.getByTestId('n-search'), 'NANDU');
      expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['Ñandú']);
    });

    it('searchText casa e não aparece', async () => {
      renderSingle({ id: 'n', options: NOMES });
      const user = userEvent.setup();
      await user.click(trigger());
      await user.type(screen.getByTestId('n-search'), 'zz-900');
      expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['Zeta']);
      expect(screen.queryByText('ZZ-900')).toBeNull();
    });

    it('sem resultado mostra ${id}-no-results', async () => {
      renderSingle({ id: 'n', options: NOMES });
      const user = userEvent.setup();
      await user.click(trigger());
      await user.type(screen.getByTestId('n-search'), 'qqq');
      expect(screen.getByTestId('n-no-results')).toBeInTheDocument();
    });

    it('clearLabel some enquanto se busca', async () => {
      renderSingle({ id: 'n', options: NOMES, clearLabel: 'Todos' });
      const user = userEvent.setup();
      await user.click(trigger());
      expect(screen.getAllByRole('option')).toHaveLength(4);
      await user.type(screen.getByTestId('n-search'), 'gar');
      expect(screen.getAllByRole('option')).toHaveLength(1);
    });
  });

  describe('teclado', () => {
    it('Esc no input fecha e devolve o foco ao gatilho', async () => {
      renderSingle({ id: 'k' });
      const user = userEvent.setup();
      await user.click(trigger());
      expect(document.activeElement).toBe(screen.getByTestId('k-search'));
      await user.keyboard('{Escape}');
      expect(screen.queryByRole('listbox')).toBeNull();
      expect(document.activeElement).toBe(trigger());
    });

    it('Esc numa opção devolve o foco ao gatilho', async () => {
      renderSingle({ id: 'k' });
      const user = userEvent.setup();
      await user.click(trigger());
      screen.getAllByRole('option')[0].querySelector('button')!.focus();
      await user.keyboard('{Escape}');
      expect(document.activeElement).toBe(trigger());
    });

    it('ArrowDown input → 1ª opção → próxima; ArrowUp volta; Home/End', async () => {
      renderSingle({ id: 'k' });
      const user = userEvent.setup();
      await user.click(trigger());
      const btns = () => screen.getAllByRole('option').map((o) => o.querySelector('button'));
      await user.keyboard('{ArrowDown}');
      expect(document.activeElement).toBe(btns()[0]);
      await user.keyboard('{ArrowDown}');
      expect(document.activeElement).toBe(btns()[1]);
      await user.keyboard('{End}');
      expect(document.activeElement).toBe(btns()[2]);
      await user.keyboard('{ArrowDown}');
      expect(document.activeElement).toBe(btns()[2]);
      await user.keyboard('{ArrowUp}');
      expect(document.activeElement).toBe(btns()[1]);
      await user.keyboard('{Home}');
      expect(document.activeElement).toBe(btns()[0]);
      await user.keyboard('{ArrowUp}');
      expect(document.activeElement).toBe(screen.getByTestId('k-search'));
    });

    it('ArrowUp na 1ª opção sem input (2 opções) fica na opção', async () => {
      renderSingle({ id: 'k', options: OPTIONS.slice(0, 2) });
      const user = userEvent.setup();
      await user.click(trigger());
      const first = screen.getAllByRole('option')[0].querySelector('button')!;
      first.focus();
      await user.keyboard('{ArrowUp}');
      expect(document.activeElement).toBe(first);
    });

    it('ArrowDown no gatilho abre; com o painel aberto vai ao input; ArrowUp também abre', async () => {
      renderSingle({ id: 'k' });
      trigger().focus();
      const user = userEvent.setup();
      await user.keyboard('{ArrowDown}');
      expect(screen.getByRole('listbox')).toBeInTheDocument();
      trigger().focus();
      await user.keyboard('{ArrowDown}');
      expect(document.activeElement).toBe(screen.getByTestId('k-search'));
      await user.keyboard('{Escape}');
      await user.keyboard('{ArrowUp}');
      expect(screen.getByRole('listbox')).toBeInTheDocument();
    });

    it('ArrowDown no gatilho com 2 opções (sem input) foca a 1ª opção', async () => {
      renderSingle({ id: 'k', options: OPTIONS.slice(0, 2) });
      trigger().focus();
      const user = userEvent.setup();
      await user.keyboard('{ArrowDown}');
      await user.keyboard('{ArrowDown}');
      expect(document.activeElement).toBe(screen.getAllByRole('option')[0].querySelector('button'));
    });

    it('digitar com o gatilho focado abre e já filtra', async () => {
      renderSingle({
        id: 'k',
        options: [
          { value: '1', label: 'García' },
          { value: '2', label: 'Zeta' },
          { value: '3', label: 'Ñandú' },
        ],
      });
      trigger().focus();
      const user = userEvent.setup();
      await user.keyboard('z');
      expect(screen.getByTestId('k-search')).toHaveValue('z');
      expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['Zeta']);
      fireEvent.keyDown(trigger(), { key: 'e' });
      expect(screen.getByTestId('k-search')).toHaveValue('ze');
    });

    it('digitar com 2 opções abre sem busca; Ctrl+tecla é ignorada; disabled não abre', async () => {
      renderSingle({ id: 'k', options: OPTIONS.slice(0, 2) });
      fireEvent.keyDown(trigger(), { key: 'c', ctrlKey: true });
      expect(screen.queryByRole('listbox')).toBeNull();
      fireEvent.keyDown(trigger(), { key: 'a' });
      expect(screen.getByRole('listbox')).toBeInTheDocument();
      expect(screen.queryByTestId('k-search')).toBeNull();
      cleanup();
      renderSingle({ id: 'k', disabled: true });
      fireEvent.keyDown(trigger(), { key: 'a' });
      expect(screen.queryByRole('listbox')).toBeNull();
    });

    it('Tab fecha (gatilho, input e opção)', async () => {
      renderSingle({ id: 'k' });
      const user = userEvent.setup();
      await user.click(trigger());
      fireEvent.keyDown(screen.getByTestId('k-search'), { key: 'Tab' });
      expect(screen.queryByRole('listbox')).toBeNull();
      await user.click(trigger());
      fireEvent.keyDown(screen.getAllByRole('option')[0].querySelector('button')!, { key: 'Tab' });
      expect(screen.queryByRole('listbox')).toBeNull();
      await user.click(trigger());
      fireEvent.keyDown(trigger(), { key: 'Tab' });
      expect(screen.queryByRole('listbox')).toBeNull();
    });

    it('Space numa opção escolhe', () => {
      const { onChange } = renderSingle();
      fireEvent.click(trigger());
      fireEvent.keyDown(screen.getAllByRole('option')[1].querySelector('button')!, { key: ' ' });
      expect(onChange).toHaveBeenCalledWith('B');
    });
  });

  describe('ARIA e contrato de DOM', () => {
    it('gatilho: role=combobox, aria-expanded, aria-controls = id do ul', async () => {
      renderSingle();
      expect(trigger()).toHaveAttribute('aria-expanded', 'false');
      expect(trigger()).not.toHaveAttribute('aria-controls');
      await userEvent.setup().click(trigger());
      expect(trigger()).toHaveAttribute('aria-expanded', 'true');
      expect(trigger().getAttribute('aria-controls')).toBe(screen.getByRole('listbox').id);
    });

    it('id, data-testid, name e aria-label vão para o gatilho; label htmlFor acha o gatilho', () => {
      render(
        <>
          <label htmlFor="meu-id">Meu campo</label>
          <Combobox
            id="meu-id"
            name="campo"
            data-testid="tid"
            aria-label="rótulo aria"
            options={OPTIONS}
            value=""
            onChange={vi.fn()}
          />
        </>,
      );
      const t = screen.getByTestId('tid');
      expect(t).toBe(trigger());
      expect(t).toHaveAttribute('id', 'meu-id');
      expect(t).toHaveAttribute('name', 'campo');
      expect(t).toHaveAttribute('aria-label', 'rótulo aria');
      cleanup();
      render(
        <>
          <label htmlFor="meu-id">Meu campo</label>
          <Combobox id="meu-id" options={OPTIONS} value="" onChange={vi.fn()} />
        </>,
      );
      expect(screen.getByLabelText('Meu campo')).toBe(trigger());
    });

    it('aria-labelledby e className chegam ao DOM; onBlur dispara', () => {
      const onBlur = vi.fn();
      const { container } = render(
        <>
          <span id="lbl">Rotulo externo</span>
          <Combobox
            aria-labelledby="lbl"
            className="extra"
            onBlur={onBlur}
            options={OPTIONS}
            value=""
            onChange={vi.fn()}
          />
        </>,
      );
      expect(screen.getByRole('combobox', { name: 'Rotulo externo' })).toBe(trigger());
      expect(container.querySelector('.extra')).not.toBeNull();
      fireEvent.blur(trigger());
      expect(onBlur).toHaveBeenCalledTimes(1);
    });

    it('sem id, o input usa o data-testid como base', async () => {
      renderSingle({ 'data-testid': 'base' });
      await userEvent.setup().click(trigger());
      expect(screen.getByTestId('base-search')).toBeInTheDocument();
    });

    it('ref (objeto e função) recebe o gatilho', () => {
      const ref = createRef<HTMLButtonElement>();
      render(<Combobox ref={ref} options={OPTIONS} value="" onChange={vi.fn()} />);
      expect(ref.current).toBe(trigger());
      cleanup();
      const fn = vi.fn();
      render(<Combobox ref={fn} options={OPTIONS} value="" onChange={vi.fn()} />);
      expect(fn).toHaveBeenCalledWith(trigger());
    });

    it('Controller do RHF: ref no gatilho e valor escolhido', async () => {
      let setFocusFn: (() => void) | undefined;
      function Form() {
        const { control, watch, setFocus } = useForm({ defaultValues: { c: '' } });
        setFocusFn = () => setFocus('c');
        return (
          <>
            <Controller
              name="c"
              control={control}
              render={({ field }) => (
                <Combobox
                  ref={field.ref}
                  name={field.name}
                  value={field.value}
                  onChange={field.onChange}
                  onBlur={field.onBlur}
                  options={OPTIONS}
                  aria-label="c"
                />
              )}
            />
            <output data-testid="out">{watch('c')}</output>
          </>
        );
      }
      render(<Form />);
      await userEvent.setup().click(trigger());
      await userEvent.setup().click(screen.getByRole('option', { name: 'Opción B' }).querySelector('button')!);
      expect(screen.getByTestId('out')).toHaveTextContent('B');
      document.body.focus();
      act(() => setFocusFn?.());
      expect(document.activeElement).toBe(trigger());
    });

    it('error: mensagem + aria-invalid', () => {
      renderSingle({ error: 'Obrigatório' });
      expect(screen.getByText('Obrigatório')).toBeInTheDocument();
      expect(trigger()).toHaveAttribute('aria-invalid', 'true');
      cleanup();
      renderSingle();
      expect(trigger()).not.toHaveAttribute('aria-invalid');
    });

    it('disabled não abre (única)', async () => {
      renderSingle({ disabled: true });
      await userEvent.setup().click(trigger());
      expect(screen.queryByRole('listbox')).toBeNull();
    });

    it.each([
      ['default', 'h-[60px]'],
      ['compact', 'h-12'],
      ['dense', 'h-[35px]'],
    ])('inputSize %s usa a altura %s', (size, cls) => {
      renderSingle({ inputSize: size });
      expect(trigger().className).toContain(cls);
    });

    it('inputSize padrão é default (h-[60px]), igual a Select/SelectField', () => {
      renderSingle();
      expect(trigger().className).toContain('h-[60px]');
      expect(trigger().className).not.toContain('h-12');
    });
  });
});

describe('Combobox — data-clarity-mask (gatilho e painel)', () => {
  const painel = () => screen.getByRole('listbox').parentElement as HTMLElement;

  it('com a prop: gatilho E painel aberto (busca + opções) levam o atributo', () => {
    renderSingle({ 'data-clarity-mask': 'True' });
    expect(trigger()).toHaveAttribute('data-clarity-mask', 'True');
    fireEvent.click(trigger());
    expect(painel()).toHaveAttribute('data-clarity-mask', 'True');
    expect(painel().contains(screen.getByRole('listbox'))).toBe(true);
  });

  it('sem a prop: nem gatilho nem painel levam o atributo', () => {
    renderSingle();
    expect(trigger()).not.toHaveAttribute('data-clarity-mask');
    fireEvent.click(trigger());
    expect(painel()).not.toHaveAttribute('data-clarity-mask');
  });
});

describe('Combobox — painel no celular (spec 070 T10)', () => {
  it('o painel é absoluto e tem a largura do gatilho (w-full dentro do wrapper relative): não cria rolagem horizontal em 390px', () => {
    renderSingle();
    const gatilho = screen.getByRole('combobox');
    fireEvent.click(gatilho);
    const painel = screen.getByRole('listbox').parentElement as HTMLElement;
    expect(painel.className).toContain('absolute');
    expect(painel.className).toContain('w-full');
    expect(painel.parentElement?.className).toContain('relative');
    expect(painel.parentElement?.contains(gatilho)).toBe(true);
  });
});
