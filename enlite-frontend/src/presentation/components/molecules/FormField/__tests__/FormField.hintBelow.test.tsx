/**
 * FormField `hintBelow` — a dica abaixo do campo mantém os campos de uma grade alinhados
 * (Gabriel, 06/09: "as colunas estão desalinhadas por causa dos comentários").
 */
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { FormField } from '../FormField';

const ordem = (el: HTMLElement) => Array.from(el.querySelectorAll('label, span, input')).map((n) => n.tagName + ':' + (n.textContent || (n as HTMLInputElement).id));

describe('FormField — posição da dica', () => {
  it('default: rótulo → dica → campo (comportamento antigo, inalterado)', () => {
    const { container } = render(<FormField label="Valor" htmlFor="v" hint="Solo números"><input id="v" /></FormField>);
    expect(ordem(container.firstChild as HTMLElement)).toEqual(['LABEL:Valor', 'SPAN:Solo números', 'INPUT:v']);
  });

  it('hintBelow: rótulo → campo → dica; e o erro vem depois da dica', () => {
    const { container } = render(<FormField label="Valor" htmlFor="v" hint="Solo números" hintBelow error="Só números"><input id="v" /></FormField>);
    expect(ordem(container.firstChild as HTMLElement)).toEqual(['LABEL:Valor', 'INPUT:v', 'SPAN:Solo números', 'SPAN:Só números']);
  });

  it('hintBelow sem hint: não renderiza dica nenhuma', () => {
    const { container } = render(<FormField label="Valor" htmlFor="v" hintBelow><input id="v" /></FormField>);
    expect(ordem(container.firstChild as HTMLElement)).toEqual(['LABEL:Valor', 'INPUT:v']);
  });
});
