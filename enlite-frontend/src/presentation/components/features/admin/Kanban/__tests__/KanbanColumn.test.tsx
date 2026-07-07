import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { KanbanColumn } from '../KanbanColumn';

vi.mock('@dnd-kit/core', () => ({
  useDroppable: () => ({ setNodeRef: vi.fn(), isOver: false }),
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
