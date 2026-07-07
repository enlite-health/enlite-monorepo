import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { KanbanColumn } from '../KanbanColumn';

vi.mock('@dnd-kit/core', () => ({
  useDroppable: () => ({ setNodeRef: vi.fn(), isOver: false }),
}));

// i18n mock — retorna a própria chave, pra podermos assertar aria-labels.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@presentation/components/atoms/Typography', () => ({
  Typography: ({ children, ...props }: { children: React.ReactNode; [k: string]: unknown }) => (
    <span {...props}>{children}</span>
  ),
}));

function renderColumn(props: Partial<React.ComponentProps<typeof KanbanColumn>> = {}) {
  return render(
    <KanbanColumn id="CONFIRMED" title="Confirmados" count={0} color="bg-cyan-400" {...props}>
      <div />
    </KanbanColumn>,
  );
}

describe('KanbanColumn — realce de drop durante o arrasto', () => {
  it('coluna droppable durante drag vira destino válido (data-valid-drop-target=true + ring verde)', () => {
    renderColumn({ droppable: true, dragActive: true });
    const col = screen.getByTestId('kanban-column-CONFIRMED');
    expect(col).toHaveAttribute('data-valid-drop-target', 'true');
    expect(col.className).toContain('ring-green-200');
  });

  it('coluna NÃO-droppable durante drag não é destino válido e é esmaecida', () => {
    renderColumn({ id: 'PRE_SCREENING', droppable: false, dragActive: true });
    const col = screen.getByTestId('kanban-column-PRE_SCREENING');
    expect(col).not.toHaveAttribute('data-valid-drop-target');
    expect(col.className).toContain('opacity-50');
  });

  it('sem drag ativo não há realce de destino', () => {
    renderColumn({ droppable: true, dragActive: false });
    const col = screen.getByTestId('kanban-column-CONFIRMED');
    expect(col).not.toHaveAttribute('data-valid-drop-target');
    expect(col.className).not.toContain('ring-green-200');
  });
});

describe('KanbanColumn — colapsar/expandir (trilho estilo ClickUp)', () => {
  it('expandida com onToggleCollapse mostra o botão de colapsar; clicar chama o callback', () => {
    const onToggleCollapse = vi.fn();
    renderColumn({ onToggleCollapse });
    const col = screen.getByTestId('kanban-column-CONFIRMED');
    expect(col).not.toHaveAttribute('data-collapsed');
    expect(col.className).toContain('w-[280px]');

    const btn = screen.getByTestId('kanban-column-CONFIRMED-collapse');
    fireEvent.click(btn);
    expect(onToggleCollapse).toHaveBeenCalledTimes(1);
  });

  it('sem onToggleCollapse não renderiza o botão de colapsar', () => {
    renderColumn();
    expect(screen.queryByTestId('kanban-column-CONFIRMED-collapse')).not.toBeInTheDocument();
  });

  it('colapsada vira trilho fino (data-collapsed + max-w-[52px]) mas mantém título e contagem', () => {
    renderColumn({ collapsed: true, count: 7, onToggleCollapse: vi.fn() });
    const col = screen.getByTestId('kanban-column-CONFIRMED');
    expect(col).toHaveAttribute('data-collapsed', 'true');
    expect(col.className).toContain('w-[52px]');
    expect(col.className).not.toContain('w-[280px]');
    // título preservado (só rotacionado) + contagem visível no trilho
    expect(screen.getByText('Confirmados')).toBeInTheDocument();
    expect(screen.getByTestId('kanban-column-CONFIRMED-count')).toHaveTextContent('7');
  });

  it('clicar no trilho colapsado expande (chama onToggleCollapse)', () => {
    const onToggleCollapse = vi.fn();
    renderColumn({ collapsed: true, onToggleCollapse });
    fireEvent.click(screen.getByTestId('kanban-column-CONFIRMED'));
    expect(onToggleCollapse).toHaveBeenCalledTimes(1);
  });

  it('anima a largura (transition-all + duration-300) nos dois estados', () => {
    const { rerender } = renderColumn({ onToggleCollapse: vi.fn() });
    expect(screen.getByTestId('kanban-column-CONFIRMED').className).toContain('transition-all');
    rerender(
      <KanbanColumn id="CONFIRMED" title="Confirmados" count={0} color="bg-cyan-400" collapsed onToggleCollapse={vi.fn()}>
        <div />
      </KanbanColumn>,
    );
    const col = screen.getByTestId('kanban-column-CONFIRMED');
    expect(col.className).toContain('transition-all');
    expect(col.className).toContain('duration-300');
  });
});
