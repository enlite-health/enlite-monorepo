import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within, fireEvent } from '@testing-library/react';
import { KanbanBoard } from '../KanbanBoard';
import type { FunnelStages } from '@hooks/admin/useWJAFunnel';

// ── react-router-dom mock ────────────────────────────────────────────────────
const mockNavigate = vi.fn();
vi.mock('react-router-dom', () => ({
  useNavigate: () => mockNavigate,
}));

// ── i18n mock — returns the key so we can assert exact i18n paths ────────────
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => fallback ?? key,
  }),
}));

// ── dnd-kit mocks ────────────────────────────────────────────────────────────
let droppableIds: { id: string; disabled: boolean }[] = [];
let draggableIds: { id: string; disabled: boolean }[] = [];

vi.mock('@dnd-kit/core', () => ({
  DndContext: ({ children }: { children: React.ReactNode }) => <div data-testid="dnd-context">{children}</div>,
  DragOverlay: ({ children }: { children: React.ReactNode }) => <div data-testid="drag-overlay">{children}</div>,
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
    return {
      attributes: { 'data-draggable-id': id },
      listeners: {},
      setNodeRef: vi.fn(),
      transform: null,
      isDragging: false,
    };
  },
}));

// ── Typography mock (renders children directly) ──────────────────────────────
vi.mock('@presentation/components/atoms/Typography', () => ({
  Typography: ({ children, ...props }: { children: React.ReactNode; [k: string]: unknown }) => (
    <span {...props}>{children}</span>
  ),
}));

// ── lucide-react mock ────────────────────────────────────────────────────────
vi.mock('lucide-react', () => ({
  CalendarClock: (props: Record<string, unknown>) => <svg data-testid="icon-calendar-clock" {...props} />,
  MapPin: (props: Record<string, unknown>) => <svg data-testid="icon-map-pin" {...props} />,
  Phone: (props: Record<string, unknown>) => <svg data-testid="icon-phone" {...props} />,
  Star: (props: Record<string, unknown>) => <svg data-testid="icon-star" {...props} />,
}));

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeEncuadre(overrides: Partial<FunnelStages['INVITED'][0]> = {}) {
  return {
    id: overrides.id ?? crypto.randomUUID(),
    encuadreId: overrides.encuadreId ?? crypto.randomUUID(),
    workerId: null,
    workerName: 'María García',
    workerPhone: '+54 11 1234',
    occupation: 'AT',
    interviewDate: null,
    interviewTime: null,
    meetLink: null,
    resultado: null,
    attended: null,
    rejectionReasonCategory: null,
    rejectionReason: null,
    matchScore: 85,
    talentumStatus: null,
    workZone: 'Palermo',
    redireccionamiento: null,
    ...overrides,
  };
}

function emptyStages(): FunnelStages {
  return {
    INVITED: [],
    INICIADO: [],
    PRE_SCREENING: [],
    IN_PROGRESS: [],
    COMPLETED: [],
    CONFIRMED: [],
    SELECTED: [],
    REJECTED: [],
  };
}

const noop = vi.fn(async () => null);

// ── Setup ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  droppableIds = [];
  draggableIds = [];
  vi.clearAllMocks();
});

// ── Visual Rendering ─────────────────────────────────────────────────────────

describe('KanbanBoard — column rendering', () => {
  it('renders all 8 columns', () => {
    render(<KanbanBoard stages={emptyStages()} onMove={noop} />);

    const expectedColumns = [
      'INVITED', 'INICIADO', 'PRE_SCREENING', 'IN_PROGRESS', 'COMPLETED',
      'CONFIRMED', 'SELECTED', 'REJECTED',
    ];

    for (const id of expectedColumns) {
      expect(screen.getByTestId(`kanban-column-${id}`)).toBeInTheDocument();
    }
  });

  it('renders columns in correct order (INVITED → INICIADO → PRE_SCREENING → IN_PROGRESS → ...)', () => {
    render(<KanbanBoard stages={emptyStages()} onMove={noop} />);

    const columns = screen.getAllByTestId(/^kanban-column-[A-Z_]+$/);
    const ids = columns.map((el) => el.getAttribute('data-testid')!.replace('kanban-column-', ''));

    expect(ids).toEqual([
      'INVITED', 'INICIADO', 'PRE_SCREENING', 'IN_PROGRESS', 'COMPLETED',
      'CONFIRMED', 'SELECTED', 'REJECTED',
    ]);
  });

  it('displays internationalized column titles via i18n keys', () => {
    render(<KanbanBoard stages={emptyStages()} onMove={noop} />);

    expect(screen.getByText('admin.kanban.columns.INVITED')).toBeInTheDocument();
    expect(screen.getByText('admin.kanban.columns.INICIADO')).toBeInTheDocument();
    expect(screen.getByText('admin.kanban.columns.PRE_SCREENING')).toBeInTheDocument();
    expect(screen.getByText('admin.kanban.columns.IN_PROGRESS')).toBeInTheDocument();
    expect(screen.getByText('admin.kanban.columns.COMPLETED')).toBeInTheDocument();
    expect(screen.getByText('admin.kanban.columns.CONFIRMED')).toBeInTheDocument();
    expect(screen.getByText('admin.kanban.columns.SELECTED')).toBeInTheDocument();
    expect(screen.getByText('admin.kanban.columns.REJECTED')).toBeInTheDocument();
  });

  it('shows correct card count per column', () => {
    const stages = emptyStages();
    stages.INICIADO = [makeEncuadre(), makeEncuadre()];
    stages.COMPLETED = [makeEncuadre()];

    render(<KanbanBoard stages={stages} onMove={noop} />);

    const iniciadoCol = screen.getByTestId('kanban-column-INICIADO');
    expect(within(iniciadoCol).getByText('2')).toBeInTheDocument();

    const completedCol = screen.getByTestId('kanban-column-COMPLETED');
    expect(within(completedCol).getByText('1')).toBeInTheDocument();

    const invitedCol = screen.getByTestId('kanban-column-INVITED');
    expect(within(invitedCol).getByText('0')).toBeInTheDocument();
  });

  it('renders cards inside the correct column', () => {
    const stages = emptyStages();
    stages.IN_PROGRESS = [makeEncuadre({ id: 'enc-1', workerName: 'Carlos López' })];

    render(<KanbanBoard stages={stages} onMove={noop} />);

    const inProgressCol = screen.getByTestId('kanban-column-IN_PROGRESS');
    expect(within(inProgressCol).getByTestId('kanban-card-enc-1')).toBeInTheDocument();
    expect(within(inProgressCol).getByText('Carlos López')).toBeInTheDocument();
  });
});

// ── Drag & Drop Behavior ─────────────────────────────────────────────────────

describe('KanbanBoard — drag & drop rules', () => {
  it('disables droppable on Talentum-driven columns (INICIADO, PRE_SCREENING, IN_PROGRESS, COMPLETED)', () => {
    render(<KanbanBoard stages={emptyStages()} onMove={noop} />);

    const nonDroppable = droppableIds.filter((d) =>
      ['INICIADO', 'PRE_SCREENING', 'IN_PROGRESS', 'COMPLETED'].includes(d.id),
    );

    expect(nonDroppable).toHaveLength(4);
    for (const col of nonDroppable) {
      expect(col.disabled).toBe(true);
    }
  });

  it('keeps droppable enabled on INVITED, CONFIRMED, SELECTED, and REJECTED columns', () => {
    render(<KanbanBoard stages={emptyStages()} onMove={noop} />);

    const droppableColumns = droppableIds.filter((d) =>
      ['INVITED', 'CONFIRMED', 'SELECTED', 'REJECTED'].includes(d.id),
    );

    expect(droppableColumns).toHaveLength(4);
    for (const col of droppableColumns) {
      expect(col.disabled).toBe(false);
    }
  });

  it('INVITED column is droppable (F4 change)', () => {
    render(<KanbanBoard stages={emptyStages()} onMove={noop} />);

    const invitedDroppable = droppableIds.find((d) => d.id === 'INVITED');
    expect(invitedDroppable).toBeTruthy();
    expect(invitedDroppable?.disabled).toBe(false);
  });

  it('renders draggable cards inside INICIADO column (drag FROM is allowed)', () => {
    const stages = emptyStages();
    stages.INICIADO = [makeEncuadre({ id: 'enc-drag' })];

    render(<KanbanBoard stages={stages} onMove={noop} />);

    const card = screen.getByTestId('kanban-card-enc-drag');
    expect(card).toBeInTheDocument();
    expect(card.closest('[data-draggable-id]')).toBeTruthy();
  });

  it('renders draggable cards inside PRE_SCREENING column (drag FROM is allowed)', () => {
    const stages = emptyStages();
    stages.PRE_SCREENING = [makeEncuadre({ id: 'enc-pre-drag' })];

    render(<KanbanBoard stages={stages} onMove={noop} />);

    const card = screen.getByTestId('kanban-card-enc-pre-drag');
    expect(card).toBeInTheDocument();
    expect(card.closest('[data-draggable-id]')).toBeTruthy();
  });
});

// ── Edge Cases ───────────────────────────────────────────────────────────────

describe('KanbanBoard — edge cases', () => {
  it('renders gracefully with all stages empty', () => {
    render(<KanbanBoard stages={emptyStages()} onMove={noop} />);

    const columns = screen.getAllByTestId(/^kanban-column-[A-Z_]+$/);
    expect(columns).toHaveLength(8);
  });

  it('renders multiple cards across different Talentum columns', () => {
    const stages = emptyStages();
    stages.INICIADO = [makeEncuadre({ id: 'a' })];
    stages.PRE_SCREENING = [makeEncuadre({ id: 'e' })];
    stages.IN_PROGRESS = [makeEncuadre({ id: 'b' }), makeEncuadre({ id: 'c' })];
    stages.COMPLETED = [makeEncuadre({ id: 'd' })];

    render(<KanbanBoard stages={stages} onMove={noop} />);

    expect(screen.getByTestId('kanban-card-a')).toBeInTheDocument();
    expect(screen.getByTestId('kanban-card-b')).toBeInTheDocument();
    expect(screen.getByTestId('kanban-card-c')).toBeInTheDocument();
    expect(screen.getByTestId('kanban-card-d')).toBeInTheDocument();
    expect(screen.getByTestId('kanban-card-e')).toBeInTheDocument();
  });
});

// ── Worker Name Navigation ──────────────────────────────────────────────────

describe('KanbanBoard — worker name navigation', () => {
  it('navigates to worker detail page when clicking worker name', () => {
    const stages = emptyStages();
    stages.COMPLETED = [makeEncuadre({ id: 'enc-nav', workerId: 'worker-99', workerName: 'Carlos Test' })];

    render(<KanbanBoard stages={stages} onMove={noop} />);

    const button = screen.getByRole('button', { name: 'Carlos Test' });
    fireEvent.click(button);

    expect(mockNavigate).toHaveBeenCalledTimes(1);
    expect(mockNavigate).toHaveBeenCalledWith('/admin/workers/worker-99');
  });

  it('does NOT render clickable name when workerId is null', () => {
    const stages = emptyStages();
    stages.COMPLETED = [makeEncuadre({ id: 'enc-nolink', workerId: null, workerName: 'No Link' })];

    render(<KanbanBoard stages={stages} onMove={noop} />);

    expect(screen.queryByRole('button', { name: 'No Link' })).not.toBeInTheDocument();
    // Name should still render as plain text
    expect(screen.getByText('No Link')).toBeInTheDocument();
  });

  it('passes workerId and onWorkerClick to cards in all columns', () => {
    const stages = emptyStages();
    stages.INVITED = [makeEncuadre({ id: 'w1', workerId: 'wk-1', workerName: 'Worker A' })];
    stages.CONFIRMED = [makeEncuadre({ id: 'w2', workerId: 'wk-2', workerName: 'Worker B' })];
    stages.SELECTED = [makeEncuadre({ id: 'w3', workerId: 'wk-3', workerName: 'Worker C' })];

    render(<KanbanBoard stages={stages} onMove={noop} />);

    // All should have clickable names
    expect(screen.getByRole('button', { name: 'Worker A' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Worker B' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Worker C' })).toBeInTheDocument();

    // Click each and verify navigation
    fireEvent.click(screen.getByRole('button', { name: 'Worker C' }));
    expect(mockNavigate).toHaveBeenCalledWith('/admin/workers/wk-3');
  });
});

// ── Orphan Card Drag Blocking (Fase 1) ───────────────────────────────────────

describe('KanbanBoard — orphan card drag blocking', () => {
  it('disables drag on card with encuadreId=null (orphan)', () => {
    const stages = emptyStages();
    stages.INVITED = [makeEncuadre({ id: 'orphan-wja', encuadreId: null })];

    render(<KanbanBoard stages={stages} onMove={noop} />);

    const orphanDraggable = draggableIds.find((d) => d.id === 'orphan-wja');
    expect(orphanDraggable, 'Orphan card must be registered in useDraggable').toBeTruthy();
    expect(orphanDraggable?.disabled, 'Orphan card must have disabled=true').toBe(true);
  });

  it('keeps drag enabled on card with valid encuadreId', () => {
    const stages = emptyStages();
    stages.INICIADO = [makeEncuadre({ id: 'enc-with-id', encuadreId: 'real-enc-uuid' })];

    render(<KanbanBoard stages={stages} onMove={noop} />);

    const cardDraggable = draggableIds.find((d) => d.id === 'enc-with-id');
    expect(cardDraggable, 'Card with encuadreId must be registered in useDraggable').toBeTruthy();
    expect(cardDraggable?.disabled, 'Card with encuadreId must have disabled=false').toBe(false);
  });

  it('renders data-drag-disabled attribute on orphan card wrapper', () => {
    const stages = emptyStages();
    stages.INVITED = [makeEncuadre({ id: 'orphan-vis', encuadreId: null })];

    render(<KanbanBoard stages={stages} onMove={noop} />);

    const wrapper = screen.getByTestId('kanban-draggable-orphan-vis');
    expect(wrapper.getAttribute('data-drag-disabled')).toBe('true');
  });

  it('does NOT render data-drag-disabled on card with encuadreId', () => {
    const stages = emptyStages();
    stages.CONFIRMED = [makeEncuadre({ id: 'active-enc', encuadreId: 'uuid-abc' })];

    render(<KanbanBoard stages={stages} onMove={noop} />);

    const wrapper = screen.getByTestId('kanban-draggable-active-enc');
    expect(wrapper.getAttribute('data-drag-disabled')).not.toBe('true');
  });

  it('mixes orphan and non-orphan cards in same column correctly', () => {
    const stages = emptyStages();
    stages.INVITED = [
      makeEncuadre({ id: 'orphan-1', encuadreId: null }),
      makeEncuadre({ id: 'non-orphan-1', encuadreId: 'enc-uuid-1' }),
    ];

    render(<KanbanBoard stages={stages} onMove={noop} />);

    const orphan = draggableIds.find((d) => d.id === 'orphan-1');
    const nonOrphan = draggableIds.find((d) => d.id === 'non-orphan-1');

    expect(orphan?.disabled).toBe(true);
    expect(nonOrphan?.disabled).toBe(false);
  });
});

// ── Interview Tag in CONFIRMED ──────────────────────────────────────────────

describe('KanbanBoard — interview tag in CONFIRMED column', () => {
  it('renders interview tag inside CONFIRMED column cards', () => {
    const stages = emptyStages();
    stages.CONFIRMED = [makeEncuadre({
      id: 'enc-conf',
      interviewDate: '2026-03-15T12:00:00',
      interviewTime: '10:30',
    })];

    render(<KanbanBoard stages={stages} onMove={noop} />);

    const confirmedCol = screen.getByTestId('kanban-column-CONFIRMED');
    // CalendarClock icon should be inside the CONFIRMED column
    expect(within(confirmedCol).getByTestId('icon-calendar-clock')).toBeInTheDocument();
  });

  it('does NOT render interview tag for same data in COMPLETED column', () => {
    const stages = emptyStages();
    stages.COMPLETED = [makeEncuadre({
      id: 'enc-comp',
      interviewDate: '2026-03-15T12:00:00',
      interviewTime: '10:30',
    })];

    render(<KanbanBoard stages={stages} onMove={noop} />);

    const completedCol = screen.getByTestId('kanban-column-COMPLETED');
    expect(within(completedCol).queryByTestId('icon-calendar-clock')).not.toBeInTheDocument();
  });
});
