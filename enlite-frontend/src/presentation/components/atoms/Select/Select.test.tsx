import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { createRef } from 'react';
import { Select, type SelectOption } from './Select';

const OPTIONS: SelectOption[] = [
  { value: 'op1', label: 'Opção 1' },
  { value: 'op2', label: 'Opção 2' },
  { value: 'op3', label: 'Opção 3', disabled: true },
];

describe('Select', () => {
  // ─── Render básico ────────────────────────────────────────────────────────

  it('renderiza um select nativo', () => {
    const { container } = render(<Select options={OPTIONS} />);
    const select = container.querySelector('select');
    expect(select).toBeTruthy();
  });

  it('renderiza todas as opções', () => {
    render(<Select options={OPTIONS} />);
    expect(screen.getByText('Opção 1')).toBeTruthy();
    expect(screen.getByText('Opção 2')).toBeTruthy();
    expect(screen.getByText('Opção 3')).toBeTruthy();
  });

  it('renderiza placeholder como primeira opção quando fornecido', () => {
    render(<Select options={OPTIONS} placeholder="Selecione uma opção" />);
    expect(screen.getByText('Selecione uma opção')).toBeTruthy();
  });

  it('NAO renderiza placeholder option quando não fornecido', () => {
    const { container } = render(<Select options={OPTIONS} />);
    const select = container.querySelector('select');
    // Sem placeholder: 3 opções exatamente
    expect(select?.querySelectorAll('option').length).toBe(3);
  });

  it('renderiza ChevronDown icon', () => {
    const { container } = render(<Select options={OPTIONS} />);
    // lucide-react renderiza svg
    const svg = container.querySelector('svg');
    expect(svg).toBeTruthy();
  });

  it('opção desabilitada propaga atributo disabled', () => {
    const { container } = render(<Select options={OPTIONS} />);
    const disabledOption = container.querySelector('option[disabled]');
    expect(disabledOption?.textContent).toBe('Opção 3');
  });

  // ─── Wrapper ──────────────────────────────────────────────────────────────

  it('renderiza dentro de um wrapper div', () => {
    const { container } = render(<Select options={OPTIONS} />);
    expect(container.firstChild?.nodeName).toBe('DIV');
  });

  // ─── Estado de erro ───────────────────────────────────────────────────────

  it('wrapper aplica border-red-500 quando error está presente', () => {
    const { container } = render(<Select options={OPTIONS} error="Campo obrigatório" />);
    const wrapper = container.firstChild as HTMLElement;
    expect(wrapper.className).toContain('border-red-500');
  });

  it('aplica aria-invalid=true no select quando error está presente', () => {
    const { container } = render(<Select options={OPTIONS} error="Erro" />);
    const select = container.querySelector('select');
    expect(select?.getAttribute('aria-invalid')).toBe('true');
  });

  it('aplica aria-invalid=false quando sem error', () => {
    const { container } = render(<Select options={OPTIONS} />);
    const select = container.querySelector('select');
    expect(select?.getAttribute('aria-invalid')).toBe('false');
  });

  // ─── Disabled ─────────────────────────────────────────────────────────────

  it('wrapper aplica bg cinza quando disabled', () => {
    const { container } = render(<Select options={OPTIONS} disabled />);
    const wrapper = container.firstChild as HTMLElement;
    // Disabled style migrated from opacity-60 → bg-[#f3f4f6] (text stays
    // legible). See feedback: "Disabled = bg gris, não opacity".
    expect(wrapper.className).toContain('bg-[#f3f4f6]');
  });

  it('propaga disabled para o select nativo', () => {
    const { container } = render(<Select options={OPTIONS} disabled />);
    const select = container.querySelector('select') as HTMLSelectElement;
    expect(select.disabled).toBe(true);
  });

  // ─── Size ─────────────────────────────────────────────────────────────────

  it('wrapper aplica h-[60px] quando inputSize=default', () => {
    const { container } = render(<Select options={OPTIONS} />);
    const wrapper = container.firstChild as HTMLElement;
    expect(wrapper.className).toContain('h-[60px]');
  });

  it('wrapper aplica h-[42px] quando inputSize=compact', () => {
    const { container } = render(<Select options={OPTIONS} inputSize="compact" />);
    const wrapper = container.firstChild as HTMLElement;
    expect(wrapper.className).toContain('h-[42px]');
  });

  // ─── Callbacks ────────────────────────────────────────────────────────────

  it('chama onValueChange com o valor selecionado', () => {
    const handler = vi.fn();
    const { container } = render(
      <Select options={OPTIONS} onValueChange={handler} defaultValue="" />
    );
    const select = container.querySelector('select') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'op1' } });
    expect(handler).toHaveBeenCalledWith('op1');
  });

  it('chama onChange nativo quando fornecido', () => {
    const handler = vi.fn();
    const { container } = render(
      <Select options={OPTIONS} onChange={handler} defaultValue="" />
    );
    const select = container.querySelector('select') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'op2' } });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  // ─── ref forwarding ───────────────────────────────────────────────────────

  it('encaminha ref para o elemento <select> nativo', () => {
    const ref = createRef<HTMLSelectElement>();
    const { container } = render(<Select ref={ref} options={OPTIONS} />);
    const select = container.querySelector('select');
    expect(ref.current).toBe(select);
  });
});
