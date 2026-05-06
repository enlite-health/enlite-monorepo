import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { useForm } from 'react-hook-form';
import { createRef } from 'react';
import { Input } from './Input';
import { Search } from 'lucide-react';

describe('Input', () => {
  // ─── Render básico ────────────────────────────────────────────────────────

  it('renderiza um input nativo', () => {
    const { container } = render(<Input placeholder="Digite aqui" />);
    const input = container.querySelector('input');
    expect(input).toBeTruthy();
  });

  it('aplica placeholder corretamente', () => {
    render(<Input placeholder="Seu nome" />);
    expect(screen.getByPlaceholderText('Seu nome')).toBeTruthy();
  });

  it('renderiza sem wrapper quando sem ícones', () => {
    const { container } = render(<Input />);
    // Sem ícones: raiz é diretamente o <input>
    expect(container.firstChild?.nodeName).toBe('INPUT');
  });

  // ─── Estado de erro ───────────────────────────────────────────────────────

  it('aplica border-red-500 quando error está presente', () => {
    const { container } = render(<Input error="Campo obrigatório" />);
    const input = container.querySelector('input');
    expect(input?.className).toContain('border-red-500');
  });

  it('aplica aria-invalid=true quando error está presente', () => {
    const { container } = render(<Input error="Erro" />);
    const input = container.querySelector('input');
    expect(input?.getAttribute('aria-invalid')).toBe('true');
  });

  it('aplica aria-invalid=false quando sem error', () => {
    const { container } = render(<Input />);
    const input = container.querySelector('input');
    expect(input?.getAttribute('aria-invalid')).toBe('false');
  });

  // ─── Disabled ─────────────────────────────────────────────────────────────

  it('aplica fundo cinza e cursor-not-allowed quando disabled', () => {
    const { container } = render(<Input disabled />);
    const input = container.querySelector('input');
    expect(input?.className).toContain('bg-[#f3f4f6]');
    expect(input?.className).toContain('cursor-not-allowed');
  });

  it('propaga atributo disabled para o elemento nativo', () => {
    const { container } = render(<Input disabled />);
    const input = container.querySelector('input') as HTMLInputElement;
    expect(input.disabled).toBe(true);
  });

  // ─── Size compact ─────────────────────────────────────────────────────────

  it('aplica h-[42px] quando inputSize=compact', () => {
    const { container } = render(<Input inputSize="compact" />);
    const input = container.querySelector('input');
    expect(input?.className).toContain('h-[42px]');
  });

  it('aplica h-[60px] quando inputSize=default (padrão)', () => {
    const { container } = render(<Input />);
    const input = container.querySelector('input');
    expect(input?.className).toContain('h-[60px]');
  });

  // ─── Ícones ───────────────────────────────────────────────────────────────

  it('renderiza wrapper flex quando leftIcon está presente', () => {
    const { container } = render(
      <Input leftIcon={<Search size={16} />} placeholder="Buscar" />
    );
    // Com ícone, raiz é div (wrapper)
    expect(container.firstChild?.nodeName).toBe('DIV');
    const input = container.querySelector('input');
    expect(input).toBeTruthy();
  });

  it('renderiza wrapper flex quando rightIcon está presente', () => {
    const { container } = render(
      <Input rightIcon={<Search size={16} />} />
    );
    expect(container.firstChild?.nodeName).toBe('DIV');
  });

  it('renderiza ambos os ícones quando fornecidos', () => {
    render(
      <Input
        leftIcon={<span data-testid="left-icon">L</span>}
        rightIcon={<span data-testid="right-icon">R</span>}
      />
    );
    expect(screen.getByTestId('left-icon')).toBeTruthy();
    expect(screen.getByTestId('right-icon')).toBeTruthy();
  });

  it('input interno sem ícone tem aria-invalid também', () => {
    const { container } = render(
      <Input leftIcon={<Search size={16} />} error="Erro" />
    );
    const input = container.querySelector('input');
    expect(input?.getAttribute('aria-invalid')).toBe('true');
  });

  // ─── ref forwarding ───────────────────────────────────────────────────────

  it('encaminha ref para o elemento <input> nativo (sem ícones)', () => {
    const ref = createRef<HTMLInputElement>();
    const { container } = render(<Input ref={ref} />);
    const input = container.querySelector('input');
    expect(ref.current).toBe(input);
  });

  it('encaminha ref para o elemento <input> nativo (com ícone)', () => {
    const ref = createRef<HTMLInputElement>();
    const { container } = render(
      <Input ref={ref} leftIcon={<Search size={16} />} />
    );
    const input = container.querySelector('input');
    expect(ref.current).toBe(input);
  });

  // ─── Smoke test com React Hook Form ──────────────────────────────────────

  it('funciona com useForm register (smoke test)', async () => {
    const submitHandler = vi.fn();

    function TestForm() {
      const { register, handleSubmit } = useForm<{ nome: string }>();
      return (
        <form onSubmit={handleSubmit(submitHandler)}>
          <Input {...register('nome')} placeholder="Nome" />
          <button type="submit">Enviar</button>
        </form>
      );
    }

    render(<TestForm />);
    const input = screen.getByPlaceholderText('Nome');
    expect(input).toBeTruthy();
    // Verifica que o input tem o atributo name registrado pelo RHF
    expect((input as HTMLInputElement).name).toBe('nome');
  });
});
