import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { TableRow } from '../Table';

// Literais copiados do `origin/stage` (sha `bae2c9b1`), NUNCA do átomo local — são o
// contrato do lado desligado (byte a byte). Fonte:
// `git show origin/stage:enlite-frontend/src/presentation/components/atoms/Table/Table.tsx | sed -n '86,87p'`
//   'border-b border-gray-600 last:border-0',
//   isClickable ? 'cursor-pointer hover:bg-slate-50 transition-colors' : '',
const BASE = 'border-b border-gray-600 last:border-0';
const CLICAVEL = 'cursor-pointer hover:bg-slate-50 transition-colors';

describe('TableRow', () => {
  // Lado desligado — sem a prop `selected`, o <tr> tem de ser idêntico ao de hoje.
  it('(1) sem onClick: className é BASE, sem aria-selected, sem atributo novo', () => {
    const { container } = render(
      <table>
        <tbody>
          <TableRow>
            <td>x</td>
          </TableRow>
        </tbody>
      </table>
    );
    const tr = container.querySelector('tr') as HTMLTableRowElement;
    expect(tr.className).toBe(BASE);
    expect(tr.getAttribute('aria-selected')).toBeNull();
    expect(Array.from(tr.attributes).map((a) => a.name)).toEqual(['class']);
  });

  it('(2) com onClick: className é BASE + CLICAVEL, sem aria-selected, sem atributo novo', () => {
    const { container } = render(
      <table>
        <tbody>
          <TableRow onClick={() => {}}>
            <td>x</td>
          </TableRow>
        </tbody>
      </table>
    );
    const tr = container.querySelector('tr') as HTMLTableRowElement;
    expect(tr.className).toBe(`${BASE} ${CLICAVEL}`);
    expect(tr.getAttribute('aria-selected')).toBeNull();
    expect(Array.from(tr.attributes).map((a) => a.name)).toEqual(['class']);
  });

  it('(3) clickable sem onClick: mesma className da variante clicável', () => {
    const { container } = render(
      <table>
        <tbody>
          <TableRow clickable>
            <td>x</td>
          </TableRow>
        </tbody>
      </table>
    );
    const tr = container.querySelector('tr') as HTMLTableRowElement;
    expect(tr.className).toBe(`${BASE} ${CLICAVEL}`);
  });

  it('(4) className="x": aplica ao final da string, sem espaço a mais', () => {
    const { container } = render(
      <table>
        <tbody>
          <TableRow className="x">
            <td>x</td>
          </TableRow>
        </tbody>
      </table>
    );
    const tr = container.querySelector('tr') as HTMLTableRowElement;
    expect(tr.className).toBe(`${BASE} x`);
  });

  it('(5) selected={false} explícito: igual ao lado desligado padrão', () => {
    const { container } = render(
      <table>
        <tbody>
          <TableRow selected={false}>
            <td>x</td>
          </TableRow>
        </tbody>
      </table>
    );
    const tr = container.querySelector('tr') as HTMLTableRowElement;
    expect(tr.className).toBe(BASE);
    expect(tr.getAttribute('aria-selected')).toBeNull();
  });

  it('(6) consumidor que já passa aria-selected="false" sem selected: atributo chega intacto', () => {
    const { container } = render(
      <table>
        <tbody>
          <TableRow aria-selected="false">
            <td>x</td>
          </TableRow>
        </tbody>
      </table>
    );
    const tr = container.querySelector('tr') as HTMLTableRowElement;
    expect(tr.getAttribute('aria-selected')).toBe('false');
  });

  // Lado que liga — a prop `selected` ainda não existe no átomo (nasce no P8).
  // Vermelho esperado aqui: é o TDD (red-first) da DX-9.4.
  it('(7) selected sem onClick: token do tema e aria-selected="true"', () => {
    const { container } = render(
      <table>
        <tbody>
          <TableRow selected>
            <td>x</td>
          </TableRow>
        </tbody>
      </table>
    );
    const tr = container.querySelector('tr') as HTMLTableRowElement;
    expect(tr.className).toBe(`${BASE} bg-primary/5`);
    expect(tr.getAttribute('aria-selected')).toBe('true');
  });

  it('(8) selected com onClick: variante clicável sem hover, aria-selected="true", dispara onClick 1×', () => {
    const onClick = vi.fn();
    const { container } = render(
      <table>
        <tbody>
          <TableRow selected onClick={onClick}>
            <td>x</td>
          </TableRow>
        </tbody>
      </table>
    );
    const tr = container.querySelector('tr') as HTMLTableRowElement;
    expect(tr.className).toBe(`${BASE} cursor-pointer transition-colors bg-primary/5`);
    expect(tr.getAttribute('aria-selected')).toBe('true');
    tr.click();
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
