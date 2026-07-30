import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within, fireEvent, act } from '@testing-library/react';
import type { DragEndEvent, DragStartEvent } from '@dnd-kit/core';
import { KanbanBoardShell, type KanbanColumnSpec } from '../KanbanBoardShell';

// ── i18n: devolve a própria chave (asserção exata de caminho de i18n) ────────
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

// ── dnd-kit: captura os handlers do DndContext para simular o arrasto ────────
let dndHandlers: {
  onDragStart?: (e: DragStartEvent) => void;
  onDragEnd?: (e: DragEndEvent) => void;
} = {};
let droppableIds: { id: string; disabled: boolean }[] = [];
let draggableIds: { id: string; disabled: boolean }[] = [];

vi.mock('@dnd-kit/core', () => ({
  DndContext: ({ children, onDragStart, onDragEnd }: {
    children: React.ReactNode;
    onDragStart: (e: DragStartEvent) => void;
    onDragEnd: (e: DragEndEvent) => void;
  }) => {
    dndHandlers = { onDragStart, onDragEnd };
    return <div data-testid="dnd-context">{children}</div>;
  },
  DragOverlay: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="drag-overlay">{children}</div>
  ),
  useSensor: vi.fn(),
  useSensors: vi.fn(() => []),
  PointerSensor: vi.fn(),
  closestCenter: vi.fn(),
  useDroppable: ({ id, disabled }: { id: string; disabled?: boolean }) => {
    droppableIds.push({ id, disabled: !!disabled });
    return { setNodeRef: vi.fn(), isOver: false };
  },
  useDraggable: ({ id, disabled }: { id: string; disabled?: boolean }) => {
    draggableIds.push({ id, disabled: !!disabled });
    return { attributes: {}, listeners: {}, setNodeRef: vi.fn(), transform: null, isDragging: false };
  },
}));

vi.mock('@presentation/components/atoms/Typography', () => ({
  Typography: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
}));

vi.mock('lucide-react', () => ({
  ChevronsLeft: (props: Record<string, unknown>) => <svg data-testid="icon-collapse" {...props} />,
  ChevronsRight: (props: Record<string, unknown>) => <svg data-testid="icon-expand" {...props} />,
}));

// ── Fixture: um board minúsculo de 3 colunas ─────────────────────────────────
interface Card { id: string; label: string; locked?: boolean }

const COLUMNS: KanbanColumnSpec[] = [
  { id: 'TODO', title: 'A fazer', color: 'bg-slate-400', droppable: true },
  { id: 'DOING', title: 'Fazendo', color: 'bg-blue-400', droppable: false },
  { id: 'DONE', title: 'Feito', color: 'bg-green-500', droppable: true },
];

const ITEMS: Record<string, Card[]> = {
  TODO: [{ id: 'c1', label: 'Card 1' }, { id: 'c2', label: 'Card 2', locked: true }],
  DOING: [],
  DONE: [{ id: 'c3', label: 'Card 3' }],
};

function renderShell(overrides: Partial<React.ComponentProps<typeof KanbanBoardShell<Card>>> = {}) {
  const onDrop = vi.fn();
  render(
    <KanbanBoardShell<Card>
      columns={COLUMNS}
      itemsOf={(columnId) => ITEMS[columnId] ?? []}
      getItemId={(c) => c.id}
      isDragDisabled={(c) => !!c.locked}
      renderCard={(c) => <div data-testid={`card-${c.id}`}>{c.label}</div>}
      onDrop={onDrop}
      {...overrides}
    />,
  );
  return { onDrop };
}

/** Começa a arrastar `itemId` (deixa o card "ativo", como sob o cursor). */
function startDrag(itemId: string) {
  act(() => {
    dndHandlers.onDragStart?.({ active: { id: itemId } } as DragStartEvent);
  });
}

/** Simula soltar o card `itemId` na coluna `columnId` (null = fora do board). */
function drag(itemId: string, columnId: string | null) {
  startDrag(itemId);
  act(() => {
    dndHandlers.onDragEnd?.({ over: columnId ? { id: columnId } : null } as DragEndEvent);
  });
}

beforeEach(() => {
  droppableIds = [];
  draggableIds = [];
  dndHandlers = {};
  localStorage.clear();
  vi.clearAllMocks();
});

describe('KanbanBoardShell — colunas e cards', () => {
  it('renderiza cada coluna com título e contagem', () => {
    renderShell();

    expect(within(screen.getByTestId('kanban-column-TODO')).getByText('A fazer')).toBeInTheDocument();
    expect(screen.getByTestId('kanban-column-TODO-count')).toHaveTextContent('2');
    expect(screen.getByTestId('kanban-column-DOING-count')).toHaveTextContent('0');
    expect(screen.getByTestId('kanban-column-DONE-count')).toHaveTextContent('1');
  });

  it('coloca cada card na sua coluna', () => {
    renderShell();

    expect(within(screen.getByTestId('kanban-column-TODO')).getByTestId('card-c1')).toBeInTheDocument();
    expect(within(screen.getByTestId('kanban-column-DONE')).getByTestId('card-c3')).toBeInTheDocument();
  });

  it('desabilita o drop na coluna marcada como não-droppable', () => {
    renderShell();

    expect(droppableIds.find((d) => d.id === 'DOING')?.disabled).toBe(true);
    expect(droppableIds.find((d) => d.id === 'TODO')?.disabled).toBe(false);
  });

  it('bloqueia o arrasto do card quando isDragDisabled devolve true', () => {
    renderShell();

    expect(draggableIds.find((d) => d.id === 'c2')?.disabled).toBe(true);
    expect(draggableIds.find((d) => d.id === 'c1')?.disabled).toBe(false);
  });

  it('usa testId customizado no board', () => {
    renderShell({ testId: 'patient-kanban-board' });
    expect(screen.getByTestId('patient-kanban-board')).toBeInTheDocument();
  });
});

describe('KanbanBoardShell — drop', () => {
  it('entrega item, coluna de origem e coluna de destino', () => {
    const { onDrop } = renderShell();

    drag('c1', 'DONE');

    expect(onDrop).toHaveBeenCalledTimes(1);
    expect(onDrop).toHaveBeenCalledWith({
      item: ITEMS.TODO[0],
      itemId: 'c1',
      fromColumnId: 'TODO',
      toColumnId: 'DONE',
    });
  });

  it('avisa quando o card é solto na PRÓPRIA coluna (quem decide é o board de negócio)', () => {
    const { onDrop } = renderShell();

    drag('c1', 'TODO');

    expect(onDrop).toHaveBeenCalledWith(
      expect.objectContaining({ fromColumnId: 'TODO', toColumnId: 'TODO' }),
    );
  });

  it('não dispara onDrop em coluna não-droppable', () => {
    const { onDrop } = renderShell();

    drag('c1', 'DOING');

    expect(onDrop).not.toHaveBeenCalled();
  });

  it('não dispara onDrop quando o card é solto fora de qualquer coluna', () => {
    const { onDrop } = renderShell();

    drag('c1', null);

    expect(onDrop).not.toHaveBeenCalled();
  });
});

describe('KanbanBoardShell — colapso de coluna', () => {
  it('SEM collapseStorageKey não mostra o botão de colapsar', () => {
    renderShell();
    expect(screen.queryByTestId('kanban-column-TODO-collapse')).not.toBeInTheDocument();
  });

  it('COM collapseStorageKey mostra o botão em toda coluna', () => {
    renderShell({ collapseStorageKey: 'kanban-collapsed-test' });

    for (const id of ['TODO', 'DOING', 'DONE']) {
      expect(screen.getByTestId(`kanban-column-${id}-collapse`)).toBeInTheDocument();
    }
  });

  it('colapsa a coluna ao clicar e persiste no localStorage', () => {
    renderShell({ collapseStorageKey: 'kanban-collapsed-test' });

    fireEvent.click(screen.getByTestId('kanban-column-TODO-collapse'));

    expect(screen.getByTestId('kanban-column-TODO')).toHaveAttribute('data-collapsed', 'true');
    expect(JSON.parse(localStorage.getItem('kanban-collapsed-test')!)).toEqual(['TODO']);
  });

  it('restaura o colapso salvo ao montar', () => {
    localStorage.setItem('kanban-collapsed-test', JSON.stringify(['DONE']));

    renderShell({ collapseStorageKey: 'kanban-collapsed-test' });

    expect(screen.getByTestId('kanban-column-DONE')).toHaveAttribute('data-collapsed', 'true');
    expect(screen.getByTestId('kanban-column-TODO')).not.toHaveAttribute('data-collapsed');
  });

  it('cada board tem sua própria chave — colapso de um não vaza para o outro', () => {
    localStorage.setItem('kanban-collapsed-vaga-1', JSON.stringify(['TODO']));

    renderShell({ collapseStorageKey: 'kanban-collapsed-patients' });

    expect(screen.getByTestId('kanban-column-TODO')).not.toHaveAttribute('data-collapsed');
  });
});

describe('KanbanBoardShell — overlay de arrasto', () => {
  it('usa renderDragOverlay para o card sob o cursor', () => {
    renderShell({
      renderDragOverlay: (c) => <div data-testid={`overlay-${c.id}`}>{c.label}</div>,
    });

    startDrag('c1');

    const overlay = screen.getByTestId('drag-overlay');
    expect(within(overlay).getByTestId('overlay-c1')).toBeInTheDocument();
  });

  it('sem renderDragOverlay o overlay cai no renderCard', () => {
    renderShell();

    startDrag('c3');

    const overlay = screen.getByTestId('drag-overlay');
    expect(within(overlay).getByTestId('card-c3')).toBeInTheDocument();
  });

  it('o overlay fica vazio quando nada está sendo arrastado', () => {
    renderShell();
    expect(screen.getByTestId('drag-overlay')).toBeEmptyDOMElement();
  });
});
