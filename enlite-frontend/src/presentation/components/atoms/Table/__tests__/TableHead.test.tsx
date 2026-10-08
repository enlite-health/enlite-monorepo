import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Table, TableHeader, TableHead } from '../Table';

function renderHead(props: Parameters<typeof TableHead>[0]) {
  return render(
    <Table>
      <TableHeader>
        <TableHead {...props}>Coluna</TableHead>
      </TableHeader>
    </Table>,
  );
}

describe('TableHead', () => {
  it('sem props de ordenação: sem botão, sem aria-sort, mesmo markup de antes', () => {
    const { container } = renderHead({});
    expect(screen.queryByRole('button')).toBeNull();
    const th = container.querySelector('th')!;
    expect(th.hasAttribute('aria-sort')).toBe(false);
    expect(th.innerHTML).toBe(
      '<span class="font-lexend text-sm leading-snug font-medium">Coluna</span>',
    );
  });

  it('ordenável inativa: botão, aria-sort="none", sem ícone de direção', () => {
    const { container } = renderHead({ onSort: vi.fn(), sortDirection: null });
    expect(screen.getByRole('button', { name: /Coluna/ })).toBeInTheDocument();
    expect(container.querySelector('th')!.getAttribute('aria-sort')).toBe('none');
    expect(container.querySelector('[data-sort-icon]')).toBeNull();
  });

  it('ativa asc/desc: aria-sort e ícone da direção', () => {
    const asc = renderHead({ onSort: vi.fn(), sortDirection: 'asc' });
    expect(asc.container.querySelector('th')!.getAttribute('aria-sort')).toBe('ascending');
    expect(asc.container.querySelector('[data-sort-icon="asc"]')).not.toBeNull();
    asc.unmount();
    const desc = renderHead({ onSort: vi.fn(), sortDirection: 'desc' });
    expect(desc.container.querySelector('th')!.getAttribute('aria-sort')).toBe('descending');
    expect(desc.container.querySelector('[data-sort-icon="desc"]')).not.toBeNull();
  });

  it('clique, Enter e Espaço acionam onSort', async () => {
    const onSort = vi.fn();
    renderHead({ onSort, sortDirection: null });
    const btn = screen.getByRole('button');
    await userEvent.click(btn);
    btn.focus();
    await userEvent.keyboard('{Enter}');
    await userEvent.keyboard(' ');
    expect(onSort).toHaveBeenCalledTimes(3);
    expect(btn).toHaveAttribute('type', 'button');
  });
});
