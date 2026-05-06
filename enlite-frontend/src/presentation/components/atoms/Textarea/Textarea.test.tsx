import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { createRef } from 'react';
import { Textarea } from './Textarea';

describe('Textarea', () => {
  // ─── Render básico ────────────────────────────────────────────────────────

  it('renderiza um textarea nativo', () => {
    const { container } = render(<Textarea />);
    const textarea = container.querySelector('textarea');
    expect(textarea).toBeTruthy();
  });

  it('aplica placeholder corretamente', () => {
    render(<Textarea placeholder="Descreva aqui" />);
    expect(screen.getByPlaceholderText('Descreva aqui')).toBeTruthy();
  });

  // ─── Sem height fixa ──────────────────────────────────────────────────────

  it('NAO aplica h-[60px] (height deve ser livre para textarea)', () => {
    const { container } = render(<Textarea />);
    const textarea = container.querySelector('textarea');
    expect(textarea?.className).not.toContain('h-[60px]');
  });

  it('NAO aplica h-[42px] no inputSize compact', () => {
    const { container } = render(<Textarea inputSize="compact" />);
    const textarea = container.querySelector('textarea');
    expect(textarea?.className).not.toContain('h-[42px]');
  });

  // ─── Resize ───────────────────────────────────────────────────────────────

  it('aplica resize-none por padrão', () => {
    const { container } = render(<Textarea />);
    const textarea = container.querySelector('textarea');
    expect(textarea?.className).toContain('resize-none');
  });

  it('aplica resize-y quando resize=vertical', () => {
    const { container } = render(<Textarea resize="vertical" />);
    const textarea = container.querySelector('textarea');
    expect(textarea?.className).toContain('resize-y');
  });

  it('aplica resize quando resize=both', () => {
    const { container } = render(<Textarea resize="both" />);
    const textarea = container.querySelector('textarea');
    expect(textarea?.className).toContain('resize');
    expect(textarea?.className).not.toContain('resize-none');
    expect(textarea?.className).not.toContain('resize-y');
  });

  // ─── Estado de erro ───────────────────────────────────────────────────────

  it('aplica border-red-500 quando error está presente', () => {
    const { container } = render(<Textarea error="Campo obrigatório" />);
    const textarea = container.querySelector('textarea');
    expect(textarea?.className).toContain('border-red-500');
  });

  it('aplica aria-invalid=true quando error está presente', () => {
    const { container } = render(<Textarea error="Erro" />);
    const textarea = container.querySelector('textarea');
    expect(textarea?.getAttribute('aria-invalid')).toBe('true');
  });

  it('aplica aria-invalid=false quando sem error', () => {
    const { container } = render(<Textarea />);
    const textarea = container.querySelector('textarea');
    expect(textarea?.getAttribute('aria-invalid')).toBe('false');
  });

  // ─── Disabled ─────────────────────────────────────────────────────────────

  it('aplica bg cinza e cursor-not-allowed quando disabled', () => {
    const { container } = render(<Textarea disabled />);
    const textarea = container.querySelector('textarea');
    // Disabled style migrated from opacity-60 → bg-[#f3f4f6] (text stays
    // legible). See feedback: "Disabled = bg gris, não opacity".
    expect(textarea?.className).toContain('bg-[#f3f4f6]');
    expect(textarea?.className).toContain('cursor-not-allowed');
  });

  it('propaga atributo disabled para o elemento nativo', () => {
    const { container } = render(<Textarea disabled />);
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
    expect(textarea.disabled).toBe(true);
  });

  // ─── Size compact ─────────────────────────────────────────────────────────

  it('aplica text-sm quando inputSize=compact', () => {
    const { container } = render(<Textarea inputSize="compact" />);
    const textarea = container.querySelector('textarea');
    expect(textarea?.className).toContain('text-sm');
  });

  it('aplica text-[20px] quando inputSize=default', () => {
    const { container } = render(<Textarea />);
    const textarea = container.querySelector('textarea');
    expect(textarea?.className).toContain('text-[20px]');
  });

  // ─── ref forwarding ───────────────────────────────────────────────────────

  it('encaminha ref para o elemento <textarea> nativo', () => {
    const ref = createRef<HTMLTextAreaElement>();
    const { container } = render(<Textarea ref={ref} />);
    const textarea = container.querySelector('textarea');
    expect(ref.current).toBe(textarea);
  });

  // ─── rows prop ────────────────────────────────────────────────────────────

  it('propaga prop rows para o nativo', () => {
    const { container } = render(<Textarea rows={4} />);
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
    expect(textarea.rows).toBe(4);
  });
});
