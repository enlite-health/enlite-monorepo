import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within, fireEvent, act } from '@testing-library/react';
import { KanbanBoard } from '../KanbanBoard';
import type { FunnelStages } from '@hooks/admin/useWJAFunnel';

// ── react-router-dom mock ────────────────────────────────────────────────────
const mockNavigate = vi.fn();
vi.mock('react-router-dom', () => ({
  useNavigate: () => mockNavigate,
}));

// ── i18n mock — returns the key so we can assert exact i18n paths ────────────
// Supports both call shapes used across the Kanban components:
//   t(key, 'stringFallback')            — e.g. rejection labels
//   t(key, { defaultValue, count, ... }) — e.g. blocked reason / attempt count
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: string | { defaultValue?: string; count?: number }) => {
      if (typeof options === 'string') return options;
      if (options && typeof options === 'object') return options.defaultValue ?? key;
      return key;
    },
  }),
}));

// ── dnd-kit mocks ────────────────────────────────────────────────────────────
let droppableIds: { id: string; disabled: boolean }[] = [];
let draggableIds: { id: string; disabled: boolean }[] = [];
// Capturado do DndContext real (KanbanBoardShell) — permite simular o INÍCIO
// do arrasto sem depender de pointer events reais do dnd-kit em jsdom.
let capturedOnDragStart: ((e: { active: { id: string } }) => void) | null = null;

vi.mock('@dnd-kit/core', () => ({
  DndContext: ({
    children,
    onDragStart,
  }: {
    children: React.ReactNode;
    onDragStart?: (e: { active: { id: string } }) => void;
  }) => {
    capturedOnDragStart = onDragStart ?? null;
    return <div data-testid="dnd-context">{children}</div>;
  },
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
  MessageSquare: (props: Record<string, unknown>) => <svg data-testid="icon-message-square" {...props} />,
  Send: (props: Record<string, unknown>) => <svg data-testid="icon-send" {...props} />,
  Phone: (props: Record<string, unknown>) => <svg data-testid="icon-phone" {...props} />,
  Star: (props: Record<string, unknown>) => <svg data-testid="icon-star" {...props} />,
  ArrowRightLeft: (props: Record<string, unknown>) => <svg data-testid="icon-move" {...props} />,
  ChevronDown: (props: Record<string, unknown>) => <svg data-testid="icon-chevron" {...props} />,
  ChevronsLeft: (props: Record<string, unknown>) => <svg data-testid="icon-collapse" {...props} />,
  ChevronsRight: (props: Record<string, unknown>) => <svg data-testid="icon-expand" {...props} />,
}));

// ── ContactNotesModal mock — evita montar o hook/data-fetching real ──────────
vi.mock('@presentation/components/features/admin/VacancyDetail/Funnel/ContactNotesModal', () => ({
  ContactNotesModal: ({
    vacancyId,
    workerId,
    workerName,
    onClose,
  }: {
    vacancyId: string;
    workerId: string;
    workerName: string | null;
    onClose: () => void;
  }) => (
    <div data-testid="contact-notes-modal" data-vacancy-id={vacancyId} data-worker-id={workerId} data-worker-name={workerName ?? ''}>
      <button data-testid="contact-notes-close" onClick={onClose}>fechar</button>
    </div>
  ),
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
    BLOQUEADO: [],
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
  capturedOnDragStart = null;
  vi.clearAllMocks();
});

// ── Visual Rendering ─────────────────────────────────────────────────────────

describe('KanbanBoard — column rendering', () => {
  it('renders all 9 columns', () => {
    render(<KanbanBoard stages={emptyStages()} vacancyId="test-vacancy" onMove={noop} onRejectBlocked={noop} onUnrejectBlocked={noop} />);

    const expectedColumns = [
      'INVITED', 'BLOQUEADO', 'INICIADO', 'PRE_SCREENING', 'IN_PROGRESS', 'COMPLETED',
      'CONFIRMED', 'SELECTED', 'REJECTED',
    ];

    for (const id of expectedColumns) {
      expect(screen.getByTestId(`kanban-column-${id}`)).toBeInTheDocument();
    }
  });

  it('renders columns in correct order (INVITED → BLOQUEADO → INICIADO → PRE_SCREENING → IN_PROGRESS → ...)', () => {
    render(<KanbanBoard stages={emptyStages()} vacancyId="test-vacancy" onMove={noop} onRejectBlocked={noop} onUnrejectBlocked={noop} />);

    const columns = screen.getAllByTestId(/^kanban-column-[A-Z_]+$/);
    const ids = columns.map((el) => el.getAttribute('data-testid')!.replace('kanban-column-', ''));

    expect(ids).toEqual([
      'INVITED', 'BLOQUEADO', 'INICIADO', 'PRE_SCREENING', 'IN_PROGRESS', 'COMPLETED',
      'CONFIRMED', 'SELECTED', 'REJECTED',
    ]);
  });

  it('displays internationalized column titles via i18n keys', () => {
    render(<KanbanBoard stages={emptyStages()} vacancyId="test-vacancy" onMove={noop} onRejectBlocked={noop} onUnrejectBlocked={noop} />);

    expect(screen.getByText('admin.kanban.columns.INVITED')).toBeInTheDocument();
    expect(screen.getByText('admin.kanban.columns.BLOQUEADO')).toBeInTheDocument();
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

    render(<KanbanBoard stages={stages} vacancyId="test-vacancy" onMove={noop} onRejectBlocked={noop} onUnrejectBlocked={noop} />);

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

    render(<KanbanBoard stages={stages} vacancyId="test-vacancy" onMove={noop} onRejectBlocked={noop} onUnrejectBlocked={noop} />);

    const inProgressCol = screen.getByTestId('kanban-column-IN_PROGRESS');
    expect(within(inProgressCol).getByTestId('kanban-card-enc-1')).toBeInTheDocument();
    expect(within(inProgressCol).getByText('Carlos López')).toBeInTheDocument();
  });
});

// ── Drag & Drop Behavior ─────────────────────────────────────────────────────

describe('KanbanBoard — drag & drop rules', () => {
  it('disables droppable on Talentum-driven columns (INICIADO, PRE_SCREENING, IN_PROGRESS, COMPLETED)', () => {
    render(<KanbanBoard stages={emptyStages()} vacancyId="test-vacancy" onMove={noop} onRejectBlocked={noop} onUnrejectBlocked={noop} />);

    const nonDroppable = droppableIds.filter((d) =>
      ['INICIADO', 'PRE_SCREENING', 'IN_PROGRESS', 'COMPLETED'].includes(d.id),
    );

    expect(nonDroppable).toHaveLength(4);
    for (const col of nonDroppable) {
      expect(col.disabled).toBe(true);
    }
  });

  it('disables droppable on BLOQUEADO column (cards have no encuadreId, never a drop target)', () => {
    render(<KanbanBoard stages={emptyStages()} vacancyId="test-vacancy" onMove={noop} onRejectBlocked={noop} onUnrejectBlocked={noop} />);

    const bloqueado = droppableIds.find((d) => d.id === 'BLOQUEADO');
    expect(bloqueado, 'BLOQUEADO column must be registered in useDroppable').toBeTruthy();
    expect(bloqueado?.disabled, 'BLOQUEADO must have droppable disabled').toBe(true);
  });

  it('keeps droppable enabled on INVITED, CONFIRMED, SELECTED, and REJECTED columns', () => {
    render(<KanbanBoard stages={emptyStages()} vacancyId="test-vacancy" onMove={noop} onRejectBlocked={noop} onUnrejectBlocked={noop} />);

    const droppableColumns = droppableIds.filter((d) =>
      ['INVITED', 'CONFIRMED', 'SELECTED', 'REJECTED'].includes(d.id),
    );

    expect(droppableColumns).toHaveLength(4);
    for (const col of droppableColumns) {
      expect(col.disabled).toBe(false);
    }
  });

  it('INVITED column is droppable (F4 change)', () => {
    render(<KanbanBoard stages={emptyStages()} vacancyId="test-vacancy" onMove={noop} onRejectBlocked={noop} onUnrejectBlocked={noop} />);

    const invitedDroppable = droppableIds.find((d) => d.id === 'INVITED');
    expect(invitedDroppable).toBeTruthy();
    expect(invitedDroppable?.disabled).toBe(false);
  });

  it('renders draggable cards inside INICIADO column (drag FROM is allowed)', () => {
    const stages = emptyStages();
    stages.INICIADO = [makeEncuadre({ id: 'enc-drag' })];

    render(<KanbanBoard stages={stages} vacancyId="test-vacancy" onMove={noop} onRejectBlocked={noop} onUnrejectBlocked={noop} />);

    const card = screen.getByTestId('kanban-card-enc-drag');
    expect(card).toBeInTheDocument();
    expect(card.closest('[data-draggable-id]')).toBeTruthy();
  });

  it('renders draggable cards inside PRE_SCREENING column (drag FROM is allowed)', () => {
    const stages = emptyStages();
    stages.PRE_SCREENING = [makeEncuadre({ id: 'enc-pre-drag' })];

    render(<KanbanBoard stages={stages} vacancyId="test-vacancy" onMove={noop} onRejectBlocked={noop} onUnrejectBlocked={noop} />);

    const card = screen.getByTestId('kanban-card-enc-pre-drag');
    expect(card).toBeInTheDocument();
    expect(card.closest('[data-draggable-id]')).toBeTruthy();
  });
});

// ── Edge Cases ───────────────────────────────────────────────────────────────

describe('KanbanBoard — edge cases', () => {
  it('renders gracefully with all stages empty', () => {
    render(<KanbanBoard stages={emptyStages()} vacancyId="test-vacancy" onMove={noop} onRejectBlocked={noop} onUnrejectBlocked={noop} />);

    const columns = screen.getAllByTestId(/^kanban-column-[A-Z_]+$/);
    expect(columns).toHaveLength(9);
  });

  it('renders multiple cards across different Talentum columns', () => {
    const stages = emptyStages();
    stages.INICIADO = [makeEncuadre({ id: 'a' })];
    stages.PRE_SCREENING = [makeEncuadre({ id: 'e' })];
    stages.IN_PROGRESS = [makeEncuadre({ id: 'b' }), makeEncuadre({ id: 'c' })];
    stages.COMPLETED = [makeEncuadre({ id: 'd' })];

    render(<KanbanBoard stages={stages} vacancyId="test-vacancy" onMove={noop} onRejectBlocked={noop} onUnrejectBlocked={noop} />);

    expect(screen.getByTestId('kanban-card-a')).toBeInTheDocument();
    expect(screen.getByTestId('kanban-card-b')).toBeInTheDocument();
    expect(screen.getByTestId('kanban-card-c')).toBeInTheDocument();
    expect(screen.getByTestId('kanban-card-d')).toBeInTheDocument();
    expect(screen.getByTestId('kanban-card-e')).toBeInTheDocument();
  });
});

// ── Worker Name Navigation ──────────────────────────────────────────────────

describe('KanbanBoard — worker name opens the profile in a new tab', () => {
  it('renders the worker name as a link to /admin/workers/:id with target=_blank', () => {
    const stages = emptyStages();
    stages.COMPLETED = [makeEncuadre({ id: 'enc-nav', workerId: 'worker-99', workerName: 'Carlos Test' })];

    render(<KanbanBoard stages={stages} vacancyId="test-vacancy" onMove={noop} onRejectBlocked={noop} onUnrejectBlocked={noop} />);

    const link = screen.getByRole('link', { name: 'Carlos Test' });
    expect(link).toHaveAttribute('href', '/admin/workers/worker-99');
    expect(link).toHaveAttribute('target', '_blank');
    // Não navega na mesma aba: nenhum navigate() é chamado
    fireEvent.click(link);
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('does NOT render a link when workerId is null', () => {
    const stages = emptyStages();
    stages.COMPLETED = [makeEncuadre({ id: 'enc-nolink', workerId: null, workerName: 'No Link' })];

    render(<KanbanBoard stages={stages} vacancyId="test-vacancy" onMove={noop} onRejectBlocked={noop} onUnrejectBlocked={noop} />);

    expect(screen.queryByRole('link', { name: 'No Link' })).not.toBeInTheDocument();
    // Name should still render as plain text
    expect(screen.getByText('No Link')).toBeInTheDocument();
  });

  it('links the name in cards of all columns', () => {
    const stages = emptyStages();
    stages.INVITED = [makeEncuadre({ id: 'w1', workerId: 'wk-1', workerName: 'Worker A' })];
    stages.CONFIRMED = [makeEncuadre({ id: 'w2', workerId: 'wk-2', workerName: 'Worker B' })];
    stages.SELECTED = [makeEncuadre({ id: 'w3', workerId: 'wk-3', workerName: 'Worker C' })];

    render(<KanbanBoard stages={stages} vacancyId="test-vacancy" onMove={noop} onRejectBlocked={noop} onUnrejectBlocked={noop} />);

    expect(screen.getByRole('link', { name: 'Worker A' })).toHaveAttribute('href', '/admin/workers/wk-1');
    expect(screen.getByRole('link', { name: 'Worker B' })).toHaveAttribute('href', '/admin/workers/wk-2');
    expect(screen.getByRole('link', { name: 'Worker C' })).toHaveAttribute('href', '/admin/workers/wk-3');
  });
});

// ── Orphan Card Drag Blocking (Fase 1) ───────────────────────────────────────

describe('KanbanBoard — orphan card drag blocking', () => {
  it('disables drag on card with encuadreId=null (orphan)', () => {
    const stages = emptyStages();
    stages.INVITED = [makeEncuadre({ id: 'orphan-wja', encuadreId: null })];

    render(<KanbanBoard stages={stages} vacancyId="test-vacancy" onMove={noop} onRejectBlocked={noop} onUnrejectBlocked={noop} />);

    const orphanDraggable = draggableIds.find((d) => d.id === 'orphan-wja');
    expect(orphanDraggable, 'Orphan card must be registered in useDraggable').toBeTruthy();
    expect(orphanDraggable?.disabled, 'Orphan card must have disabled=true').toBe(true);
  });

  it('keeps drag enabled on card with valid encuadreId', () => {
    const stages = emptyStages();
    stages.INICIADO = [makeEncuadre({ id: 'enc-with-id', encuadreId: 'real-enc-uuid' })];

    render(<KanbanBoard stages={stages} vacancyId="test-vacancy" onMove={noop} onRejectBlocked={noop} onUnrejectBlocked={noop} />);

    const cardDraggable = draggableIds.find((d) => d.id === 'enc-with-id');
    expect(cardDraggable, 'Card with encuadreId must be registered in useDraggable').toBeTruthy();
    expect(cardDraggable?.disabled, 'Card with encuadreId must have disabled=false').toBe(false);
  });

  it('renders data-drag-disabled attribute on orphan card wrapper', () => {
    const stages = emptyStages();
    stages.INVITED = [makeEncuadre({ id: 'orphan-vis', encuadreId: null })];

    render(<KanbanBoard stages={stages} vacancyId="test-vacancy" onMove={noop} onRejectBlocked={noop} onUnrejectBlocked={noop} />);

    const wrapper = screen.getByTestId('kanban-draggable-orphan-vis');
    expect(wrapper.getAttribute('data-drag-disabled')).toBe('true');
  });

  it('does NOT render data-drag-disabled on card with encuadreId', () => {
    const stages = emptyStages();
    stages.CONFIRMED = [makeEncuadre({ id: 'active-enc', encuadreId: 'uuid-abc' })];

    render(<KanbanBoard stages={stages} vacancyId="test-vacancy" onMove={noop} onRejectBlocked={noop} onUnrejectBlocked={noop} />);

    const wrapper = screen.getByTestId('kanban-draggable-active-enc');
    expect(wrapper.getAttribute('data-drag-disabled')).not.toBe('true');
  });

  it('mixes orphan and non-orphan cards in same column correctly', () => {
    const stages = emptyStages();
    stages.INVITED = [
      makeEncuadre({ id: 'orphan-1', encuadreId: null }),
      makeEncuadre({ id: 'non-orphan-1', encuadreId: 'enc-uuid-1' }),
    ];

    render(<KanbanBoard stages={stages} vacancyId="test-vacancy" onMove={noop} onRejectBlocked={noop} onUnrejectBlocked={noop} />);

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

    render(<KanbanBoard stages={stages} vacancyId="test-vacancy" onMove={noop} onRejectBlocked={noop} onUnrejectBlocked={noop} />);

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

    render(<KanbanBoard stages={stages} vacancyId="test-vacancy" onMove={noop} onRejectBlocked={noop} onUnrejectBlocked={noop} />);

    const completedCol = screen.getByTestId('kanban-column-COMPLETED');
    expect(within(completedCol).queryByTestId('icon-calendar-clock')).not.toBeInTheDocument();
  });
});

// ── BLOQUEADO column ─────────────────────────────────────────────────────────

describe('KanbanBoard — BLOQUEADO column', () => {
  it('renders blocked cards in the BLOQUEADO column with badge, reason and missing fields', () => {
    const stages = emptyStages();
    stages.BLOQUEADO = [makeEncuadre({
      id: 'enc-blocked',
      encuadreId: null,
      isBlocked: true,
      blockedReason: 'registration_incomplete',
      missingFields: ['profession', 'phone'],
      attemptCount: 2,
    })];

    render(<KanbanBoard stages={stages} vacancyId="test-vacancy" onMove={noop} onRejectBlocked={noop} onUnrejectBlocked={noop} />);

    const bloqueadoCol = screen.getByTestId('kanban-column-BLOQUEADO');
    const card = within(bloqueadoCol).getByTestId('kanban-card-enc-blocked');

    expect(within(card).getByTestId('blocked-badge')).toBeInTheDocument();
    expect(within(card).getByTestId('blocked-reason')).toBeInTheDocument();
    expect(within(card).getByTestId('blocked-missing-fields')).toBeInTheDocument();
    expect(within(card).getByTestId('blocked-attempt-count')).toBeInTheDocument();
  });

  it('renders BLOQUEADO card as drag-disabled (encuadreId=null)', () => {
    const stages = emptyStages();
    stages.BLOQUEADO = [makeEncuadre({ id: 'enc-blocked-drag', encuadreId: null, isBlocked: true })];

    render(<KanbanBoard stages={stages} vacancyId="test-vacancy" onMove={noop} onRejectBlocked={noop} onUnrejectBlocked={noop} />);

    const wrapper = screen.getByTestId('kanban-draggable-enc-blocked-drag');
    expect(wrapper.getAttribute('data-drag-disabled')).toBe('true');
  });

  it('shows correct card count in the BLOQUEADO column', () => {
    const stages = emptyStages();
    stages.BLOQUEADO = [
      makeEncuadre({ id: 'b1', encuadreId: null, isBlocked: true }),
      makeEncuadre({ id: 'b2', encuadreId: null, isBlocked: true }),
    ];

    render(<KanbanBoard stages={stages} vacancyId="test-vacancy" onMove={noop} onRejectBlocked={noop} onUnrejectBlocked={noop} />);

    const bloqueadoCol = screen.getByTestId('kanban-column-BLOQUEADO');
    expect(within(bloqueadoCol).getByText('2')).toBeInTheDocument();
  });
});

// ── Notes Button Wiring (contact notes / comentários) ────────────────────────

describe('KanbanBoard — botão de comentários abre o ContactNotesModal', () => {
  it('não renderiza o modal de comentários até o botão do card ser clicado', () => {
    const stages = emptyStages();
    stages.COMPLETED = [makeEncuadre({ id: 'wja-1', workerId: 'wk-1', workerName: 'Marcia Costa' })];

    render(<KanbanBoard stages={stages} vacancyId="vac-77" onMove={noop} onRejectBlocked={noop} onUnrejectBlocked={noop} />);

    expect(screen.queryByTestId('contact-notes-modal')).not.toBeInTheDocument();
  });

  it('abre o modal com o workerId (par worker×vaga, não o wjaId) e o vacancyId do board ao clicar', () => {
    const stages = emptyStages();
    stages.COMPLETED = [makeEncuadre({ id: 'wja-1', workerId: 'wk-1', workerName: 'Marcia Costa' })];

    render(<KanbanBoard stages={stages} vacancyId="vac-77" onMove={noop} onRejectBlocked={noop} onUnrejectBlocked={noop} />);

    fireEvent.click(screen.getByTestId('notes-button'));

    const modal = screen.getByTestId('contact-notes-modal');
    expect(modal).toHaveAttribute('data-vacancy-id', 'vac-77');
    expect(modal).toHaveAttribute('data-worker-id', 'wk-1');
    expect(modal).toHaveAttribute('data-worker-name', 'Marcia Costa');
  });

  it('renderiza o botão de comentários em cards BLOQUEADO quando workerId está presente — histórico é o mesmo do worker×vaga em qualquer coluna', () => {
    const stages = emptyStages();
    stages.BLOQUEADO = [
      makeEncuadre({ id: 'b1', encuadreId: null, workerId: 'wk-blocked', isBlocked: true, contactNotesCount: 3 }),
    ];

    render(<KanbanBoard stages={stages} vacancyId="vac-77" onMove={noop} onRejectBlocked={noop} onUnrejectBlocked={noop} />);

    expect(screen.getByTestId('notes-button')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('notes-button'));
    const modal = screen.getByTestId('contact-notes-modal');
    expect(modal).toHaveAttribute('data-worker-id', 'wk-blocked');
  });

  it('não renderiza botão de comentários quando workerId é null (defensivo — não deve ocorrer em bloqueado real)', () => {
    const stages = emptyStages();
    stages.BLOQUEADO = [makeEncuadre({ id: 'b1', encuadreId: null, workerId: null, isBlocked: true })];

    render(<KanbanBoard stages={stages} vacancyId="vac-77" onMove={noop} onRejectBlocked={noop} onUnrejectBlocked={noop} />);

    expect(screen.queryByTestId('notes-button')).not.toBeInTheDocument();
  });

  it('repassa contactNotesCount do encuadre para o badge do card', () => {
    const stages = emptyStages();
    stages.COMPLETED = [makeEncuadre({ id: 'wja-1', workerId: 'wk-1', contactNotesCount: 4 })];

    render(<KanbanBoard stages={stages} vacancyId="vac-77" onMove={noop} onRejectBlocked={noop} onUnrejectBlocked={noop} />);

    expect(screen.getByTestId('notes-count-badge')).toHaveTextContent('4');
  });
});

// ── Menu "Mover a…" (alternativa de clique ao arrasto) ───────────────────────

describe('KanbanBoard — menu "Mover a…"', () => {
  it('card movível (com encuadre) mostra o botão "Mover a…"', () => {
    const stages = emptyStages();
    stages.COMPLETED = [makeEncuadre({ id: 'wja-mv', encuadreId: 'enc-mv', workerId: 'wk-1' })];

    render(<KanbanBoard stages={stages} vacancyId="vac-1" onMove={noop} onRejectBlocked={noop} onUnrejectBlocked={noop} />);

    expect(screen.getByTestId('move-to-button')).toBeInTheDocument();
  });

  it('card órfão (encuadreId=null) NÃO mostra o botão "Mover a…"', () => {
    const stages = emptyStages();
    stages.INVITED = [makeEncuadre({ id: 'orphan', encuadreId: null })];

    render(<KanbanBoard stages={stages} vacancyId="vac-1" onMove={noop} onRejectBlocked={noop} onUnrejectBlocked={noop} />);

    expect(screen.queryByTestId('move-to-button')).not.toBeInTheDocument();
  });

  it('escolher um destino sem pergunta extra chama onMove(encuadreId, targetStage)', () => {
    const onMove = vi.fn(async () => null);
    const stages = emptyStages();
    stages.COMPLETED = [makeEncuadre({ id: 'wja-mv', encuadreId: 'enc-42', workerId: 'wk-1' })];

    render(<KanbanBoard stages={stages} vacancyId="vac-1" onMove={onMove} onRejectBlocked={noop} onUnrejectBlocked={noop} />);

    fireEvent.click(screen.getByTestId('move-to-button'));
    fireEvent.click(screen.getByTestId('move-to-option-INVITED'));

    expect(onMove).toHaveBeenCalledWith('enc-42', 'INVITED');
  });

  /**
   * O menu não pode ser a porta dos fundos: se só o arrasto pedisse a data, mover pelo
   * menu gravaria card agendado sem QUANDO — que é o problema que a captura conserta.
   */
  it('mover para CONFIRMED pelo menu abre o modal de data antes de chamar onMove', () => {
    const onMove = vi.fn(async () => null);
    const stages = emptyStages();
    stages.COMPLETED = [makeEncuadre({ id: 'wja-mv', encuadreId: 'enc-42', workerId: 'wk-1' })];

    render(<KanbanBoard stages={stages} vacancyId="vac-1" onMove={onMove} onRejectBlocked={noop} onUnrejectBlocked={noop} />);

    fireEvent.click(screen.getByTestId('move-to-button'));
    fireEvent.click(screen.getByTestId('move-to-option-CONFIRMED'));

    expect(screen.getByTestId('interview-schedule-modal')).toBeInTheDocument();
    expect(onMove).not.toHaveBeenCalled();
  });

  it('"ainda não sei" no modal move para CONFIRMED sem data', () => {
    const onMove = vi.fn(async () => null);
    const stages = emptyStages();
    stages.COMPLETED = [makeEncuadre({ id: 'wja-mv', encuadreId: 'enc-42', workerId: 'wk-1' })];

    render(<KanbanBoard stages={stages} vacancyId="vac-1" onMove={onMove} onRejectBlocked={noop} onUnrejectBlocked={noop} />);

    fireEvent.click(screen.getByTestId('move-to-button'));
    fireEvent.click(screen.getByTestId('move-to-option-CONFIRMED'));
    fireEvent.click(screen.getByTestId('interview-schedule-unknown'));

    expect(onMove).toHaveBeenCalledWith('enc-42', 'CONFIRMED', undefined, undefined, undefined);
  });

  it('confirmar data no modal repassa o agendamento para onMove', () => {
    const onMove = vi.fn(async () => null);
    const stages = emptyStages();
    stages.COMPLETED = [makeEncuadre({ id: 'wja-mv', encuadreId: 'enc-42', workerId: 'wk-1' })];

    render(<KanbanBoard stages={stages} vacancyId="vac-1" onMove={onMove} onRejectBlocked={noop} onUnrejectBlocked={noop} />);

    fireEvent.click(screen.getByTestId('move-to-button'));
    fireEvent.click(screen.getByTestId('move-to-option-CONFIRMED'));
    fireEvent.change(screen.getByTestId('interview-date-input'), { target: { value: '2026-08-05' } });
    fireEvent.change(screen.getByTestId('interview-time-input'), { target: { value: '14:30' } });
    fireEvent.click(screen.getByTestId('interview-schedule-confirm'));

    expect(onMove).toHaveBeenCalledWith('enc-42', 'CONFIRMED', undefined, undefined, {
      interviewDate: '2026-08-05',
      interviewTime: '14:30',
      interviewMeetLink: undefined,
    });
  });

  it('mover para SELECTED abre o modal de papel antes de chamar onMove', () => {
    const onMove = vi.fn(async () => null);
    const stages = emptyStages();
    stages.COMPLETED = [makeEncuadre({ id: 'wja-sel', encuadreId: 'enc-99', workerId: 'wk-1' })];

    render(<KanbanBoard stages={stages} vacancyId="vac-1" onMove={onMove} onRejectBlocked={noop} onUnrejectBlocked={noop} />);

    fireEvent.click(screen.getByTestId('move-to-button'));
    fireEvent.click(screen.getByTestId('move-to-option-SELECTED'));

    // Ainda não moveu — pede o papel primeiro.
    expect(onMove).not.toHaveBeenCalled();
    expect(screen.getByTestId('role-modal')).toBeInTheDocument();

    fireEvent.click(within(screen.getByTestId('role-option-rapid-response')).getByRole('radio'));
    fireEvent.click(screen.getByTestId('role-confirm'));

    expect(onMove).toHaveBeenCalledWith('enc-99', 'SELECTED', undefined, 'RAPID_RESPONSE');
  });

  it('"Rechazar" num card BLOQUEADO abre o MESMO modal de motivo e chama onRejectBlocked com id + categoria', () => {
    const onRejectBlocked = vi.fn(async () => null);
    const stages = emptyStages();
    // Card bloqueado: sem encuadreId, isBlocked=true (id = worker_blocked_applications.id)
    stages.BLOQUEADO = [
      makeEncuadre({ id: 'ba-42', encuadreId: null, isBlocked: true, workerName: 'Diego Trevisan' }),
    ];

    render(<KanbanBoard stages={stages} vacancyId="vac-1" onMove={noop} onRejectBlocked={onRejectBlocked} onUnrejectBlocked={noop} />);

    // Clica em "Rechazar" — abre o dropdown de motivo (mesmo do rejeitado normal), ainda não rejeita.
    fireEvent.click(screen.getByTestId('reject-button'));
    expect(onRejectBlocked).not.toHaveBeenCalled();
    expect(screen.getByTestId('rejection-modal')).toBeInTheDocument();

    // Escolhe um motivo e confirma → rejeita com id do card + a categoria escolhida.
    fireEvent.click(within(screen.getByTestId('rejection-option-worker-declined')).getByRole('radio'));
    fireEvent.click(screen.getByTestId('rejection-confirm'));
    expect(onRejectBlocked).toHaveBeenCalledWith('ba-42', 'WORKER_DECLINED');
  });

  it('cancelar o modal de motivo de um bloqueado não chama onRejectBlocked', () => {
    const onRejectBlocked = vi.fn(async () => null);
    const stages = emptyStages();
    stages.BLOQUEADO = [makeEncuadre({ id: 'ba-7', encuadreId: null, isBlocked: true })];

    render(<KanbanBoard stages={stages} vacancyId="vac-1" onMove={noop} onRejectBlocked={onRejectBlocked} onUnrejectBlocked={noop} />);

    fireEvent.click(screen.getByTestId('reject-button'));
    fireEvent.click(screen.getByTestId('rejection-cancel'));

    expect(onRejectBlocked).not.toHaveBeenCalled();
    expect(screen.queryByTestId('rejection-modal')).not.toBeInTheDocument();
  });

  it('card bloqueado RECHAZADO (isDismissed) em REJECTED mostra "Voltar" e chama onUnrejectBlocked', () => {
    const onUnrejectBlocked = vi.fn(async () => null);
    const stages = emptyStages();
    // Card de bloqueado rechazado: isBlocked + isDismissed, na coluna RECHAZADOS.
    stages.REJECTED = [
      makeEncuadre({ id: 'ba-99', encuadreId: null, isBlocked: true, isDismissed: true, rejectionReasonCategory: 'WORKER_DECLINED' }),
    ];

    render(<KanbanBoard stages={stages} vacancyId="vac-1" onMove={noop} onRejectBlocked={noop} onUnrejectBlocked={onUnrejectBlocked} />);

    // Não mostra "Rechazar" (já está rechazado); mostra "Voltar a bloqueados".
    expect(screen.queryByTestId('reject-button')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('undismiss-button'));
    expect(onUnrejectBlocked).toHaveBeenCalledWith('ba-99');
  });
});

// ── "Reenviar" por card (REQ-08) ───────────────────────────────────────────

describe('KanbanBoard — Reenviar', () => {
  const noopAsync = vi.fn().mockResolvedValue(null);

  it('sem onResendInvite não há botão', () => {
    const stages = emptyStages();
    stages.COMPLETED = [makeEncuadre({ id: 'c1', workerId: 'w-1', encuadreId: 'enc-1' })];
    render(<KanbanBoard stages={stages} vacancyId="v" onMove={noopAsync} onRejectBlocked={noopAsync} onUnrejectBlocked={noopAsync} />);
    expect(screen.queryByTestId('resend-button')).not.toBeInTheDocument();
  });

  it('card sem workerId ou sem encuadre não ganha o botão', () => {
    const stages = emptyStages();
    stages.COMPLETED = [
      makeEncuadre({ id: 'no-worker', workerId: null, encuadreId: 'enc-1' }),
      makeEncuadre({ id: 'no-enc', workerId: 'w-2', encuadreId: null }),
    ];
    render(<KanbanBoard stages={stages} vacancyId="v" onMove={noopAsync} onRejectBlocked={noopAsync} onUnrejectBlocked={noopAsync} onResendInvite={vi.fn()} />);
    expect(screen.queryByTestId('resend-button')).not.toBeInTheDocument();
  });

  it('clique → chama onResendInvite(workerId) e mostra "enviado"; recusa mostra o motivo', async () => {
    const stages = emptyStages();
    stages.COMPLETED = [
      makeEncuadre({ id: 'ok', workerId: 'w-ok', encuadreId: 'enc-ok', lastMessagedAt: null }),
      makeEncuadre({ id: 'blocked', workerId: 'w-bl', encuadreId: 'enc-bl' }),
    ];
    const onResendInvite = vi.fn(async (workerId: string) => (workerId === 'w-bl' ? 'Ya se le reenvió' : null));
    render(<KanbanBoard stages={stages} vacancyId="v" onMove={noopAsync} onRejectBlocked={noopAsync} onUnrejectBlocked={noopAsync} onResendInvite={onResendInvite} />);

    const buttons = screen.getAllByTestId('resend-button');
    fireEvent.click(buttons[0]);
    expect(onResendInvite).toHaveBeenCalledWith('w-ok');
    expect(await screen.findByText('admin.kanban.resendDone')).toBeInTheDocument();

    fireEvent.click(buttons[1]);
    expect(await screen.findByRole('alert')).toHaveTextContent('Ya se le reenvió');
  });

  // D200.1: o motivo vem do funil (mesma janela do 422) e chega ao card — botão desabilitado ANTES do clique.
  it('resendBlockedReason do funil desabilita o botão do card com o motivo', () => {
    const stages = emptyStages();
    stages.COMPLETED = [
      makeEncuadre({
        id: 'in-window', workerId: 'w-1', encuadreId: 'enc-1',
        lastMessagedAt: '2026-08-28T10:00:00.000Z',
        resendBlockedReason: { code: 'RESEND_COOLDOWN', until: '2026-08-29T10:00:00.000Z' },
      }),
    ];
    const onResendInvite = vi.fn();
    render(<KanbanBoard stages={stages} vacancyId="v" onMove={noopAsync} onRejectBlocked={noopAsync} onUnrejectBlocked={noopAsync} onResendInvite={onResendInvite} />);
    const btn = screen.getByTestId('resend-button');
    expect(btn).toBeDisabled();
    expect(screen.getByTestId('resend-blocked-reason')).toHaveTextContent('admin.messaging.blocked.RESEND_COOLDOWN');
    fireEvent.click(btn);
    expect(onResendInvite).not.toHaveBeenCalled();
  });
});

// ── "Rechazar" num card NÃO bloqueado (tem encuadreId) ───────────────────────

describe('KanbanBoard — "Rechazar" num card com encuadreId (não bloqueado)', () => {
  it('abre o modal de motivo e chama onMove(encuadreId, REJECTED, categoria) — não onRejectBlocked', () => {
    const onMove = vi.fn(async () => null);
    const onRejectBlocked = vi.fn(async () => null);
    const stages = emptyStages();
    stages.COMPLETED = [makeEncuadre({ id: 'wja-rej', encuadreId: 'enc-rej', workerName: 'Pedro Luna' })];

    render(<KanbanBoard stages={stages} vacancyId="vac-1" onMove={onMove} onRejectBlocked={onRejectBlocked} onUnrejectBlocked={noop} />);

    fireEvent.click(screen.getByTestId('reject-button'));
    expect(onMove).not.toHaveBeenCalled();
    expect(screen.getByTestId('rejection-modal')).toBeInTheDocument();

    fireEvent.click(within(screen.getByTestId('rejection-option-worker-declined')).getByRole('radio'));
    fireEvent.click(screen.getByTestId('rejection-confirm'));

    expect(onMove).toHaveBeenCalledWith('enc-rej', 'REJECTED', 'WORKER_DECLINED');
    expect(onRejectBlocked).not.toHaveBeenCalled();
  });
});

// ── Overlay de arrasto (card sob o cursor) ───────────────────────────────────

describe('KanbanBoard — overlay de arrasto', () => {
  it('mostra uma cópia SÓ LEITURA do card no overlay ao iniciar o arrasto (sem menu de mover)', () => {
    const stages = emptyStages();
    stages.INICIADO = [makeEncuadre({ id: 'enc-overlay', encuadreId: 'enc-overlay-real', workerName: 'Overlay Worker' })];

    render(<KanbanBoard stages={stages} vacancyId="test-vacancy" onMove={noop} onRejectBlocked={noop} onUnrejectBlocked={noop} />);

    expect(capturedOnDragStart).toBeTruthy();
    act(() => {
      capturedOnDragStart!({ active: { id: 'enc-overlay' } });
    });

    const overlay = screen.getByTestId('drag-overlay');
    expect(within(overlay).getByText('Overlay Worker')).toBeInTheDocument();
    // Read-only: o overlay não recebe onMoveTo/onReject/onOpenNotes.
    expect(within(overlay).queryByTestId('move-to-button')).not.toBeInTheDocument();
  });
});

// ── Cancelar os modais de papel e de agenda ──────────────────────────────────

describe('KanbanBoard — cancelar os modais de papel e de agenda', () => {
  it('cancelar o modal de papel (SELECTED) não chama onMove e fecha o modal', () => {
    const onMove = vi.fn(async () => null);
    const stages = emptyStages();
    stages.COMPLETED = [makeEncuadre({ id: 'wja-role-cancel', encuadreId: 'enc-role-cancel', workerId: 'wk-1' })];

    render(<KanbanBoard stages={stages} vacancyId="vac-1" onMove={onMove} onRejectBlocked={noop} onUnrejectBlocked={noop} />);

    fireEvent.click(screen.getByTestId('move-to-button'));
    fireEvent.click(screen.getByTestId('move-to-option-SELECTED'));
    expect(screen.getByTestId('role-modal')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('role-cancel'));

    expect(screen.queryByTestId('role-modal')).not.toBeInTheDocument();
    expect(onMove).not.toHaveBeenCalled();
  });

  it('cancelar o modal de agenda (CONFIRMED) não chama onMove e fecha o modal', () => {
    const onMove = vi.fn(async () => null);
    const stages = emptyStages();
    stages.COMPLETED = [makeEncuadre({ id: 'wja-sched-cancel', encuadreId: 'enc-sched-cancel', workerId: 'wk-1' })];

    render(<KanbanBoard stages={stages} vacancyId="vac-1" onMove={onMove} onRejectBlocked={noop} onUnrejectBlocked={noop} />);

    fireEvent.click(screen.getByTestId('move-to-button'));
    fireEvent.click(screen.getByTestId('move-to-option-CONFIRMED'));
    expect(screen.getByTestId('interview-schedule-modal')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('interview-schedule-cancel'));

    expect(screen.queryByTestId('interview-schedule-modal')).not.toBeInTheDocument();
    expect(onMove).not.toHaveBeenCalled();
  });
});

// ── Fechar o modal de comentários ─────────────────────────────────────────────

describe('KanbanBoard — fechar o modal de comentários', () => {
  it('fechar o ContactNotesModal remove o modal da tela', () => {
    const stages = emptyStages();
    stages.COMPLETED = [makeEncuadre({ id: 'wja-notes-close', workerId: 'wk-1', workerName: 'Marcia Costa' })];

    render(<KanbanBoard stages={stages} vacancyId="vac-77" onMove={noop} onRejectBlocked={noop} onUnrejectBlocked={noop} />);

    fireEvent.click(screen.getByTestId('notes-button'));
    expect(screen.getByTestId('contact-notes-modal')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('contact-notes-close'));

    expect(screen.queryByTestId('contact-notes-modal')).not.toBeInTheDocument();
  });
});

