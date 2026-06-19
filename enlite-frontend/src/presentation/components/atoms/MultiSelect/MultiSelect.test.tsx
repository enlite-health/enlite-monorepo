import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
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
});
