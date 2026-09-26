import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { KanbanBoard } from '../KanbanBoard';
import type { FunnelStages } from '@hooks/admin/useWJAFunnel';
import type { KanbanDropEvent } from '../KanbanBoardShell';

/**
 * Cobre a regra de negócio do DROP (handleDrop) e os modais que ele abre —
 * o shell de drag-and-drop é substituído por um stub que expõe `onDrop`,
 * porque o dnd-kit real não dispara drop em jsdom.
 */

type Card = FunnelStages[keyof FunnelStages][number];
let capturedOnDrop: ((e: KanbanDropEvent<Card>) => void) | null = null;

vi.mock('../KanbanBoardShell', () => ({
  KanbanBoardShell: (props: {
    onDrop: (e: KanbanDropEvent<Card>) => void;
    itemsOf: (c: string) => Card[];
    renderCard: (c: Card, col: string) => React.ReactNode;
  }) => {
    capturedOnDrop = props.onDrop;
    // coluna desconhecida → lista vazia (ramo `?? []`)
    expect(props.itemsOf('NAO_EXISTE')).toEqual([]);
    return <div data-testid="shell">{props.itemsOf('COMPLETED').map((c) => props.renderCard(c, 'COMPLETED'))}</div>;
  },
}));
vi.mock('../RejectionReasonSelect', () => ({
  RejectionReasonSelect: ({ onSubmit }: { onSubmit: (c: string) => void }) => (
    <button data-testid="rejection-submit" onClick={() => onSubmit('NO_SHOW')}>rejeitar</button>
  ),
}));
vi.mock('../RoleSelect', () => ({
  RoleSelect: ({ onSubmit }: { onSubmit: (r: string) => void }) => (
    <button data-testid="role-submit" onClick={() => onSubmit('TITULAR')}>papel</button>
  ),
}));
vi.mock('../InterviewScheduleSelect', () => ({
  InterviewScheduleSelect: ({ onSubmit }: { onSubmit: (s: null) => void }) => (
    <button data-testid="schedule-submit" onClick={() => onSubmit(null)}>agendar</button>
  ),
}));
vi.mock('../KanbanCard', () => ({ KanbanCard: ({ id }: { id: string }) => <div data-testid={`card-${id}`} /> }));
vi.mock('@presentation/components/features/admin/VacancyDetail/Funnel/ContactNotesModal', () => ({ ContactNotesModal: () => null }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));

function card(overrides: Partial<Card> = {}): Card {
  return {
    id: 'enc-1', encuadreId: 'uuid-1', workerId: 'w-1', workerName: 'Ana', workerPhone: null, occupation: null,
    interviewDate: null, interviewTime: null, meetLink: null, resultado: null, attended: null,
    rejectionReasonCategory: null, rejectionReason: null, matchScore: null, talentumStatus: null, workZone: null,
    redireccionamiento: null, ...overrides,
  } as Card;
}
function stagesWith(c: Card): FunnelStages {
  return { INVITED: [], INICIADO: [], PRE_SCREENING: [], IN_PROGRESS: [], COMPLETED: [c], CONFIRMED: [], SELECTED: [], REJECTED: [] } as unknown as FunnelStages;
}
const drop = (c: Card, to: string) =>
  act(() => { capturedOnDrop!({ item: c, itemId: c.id, fromColumnId: 'COMPLETED', toColumnId: to }); });

describe('KanbanBoard — handleDrop', () => {
  const onMove = vi.fn().mockResolvedValue(null);
  beforeEach(() => { onMove.mockClear(); capturedOnDrop = null; });

  function renderBoard(c: Card) {
    render(<KanbanBoard stages={stagesWith(c)} vacancyId="v-1" onMove={onMove} />);
    expect(capturedOnDrop).not.toBeNull();
  }

  it('ignores a drop of an orphan card (no encuadreId)', () => {
    renderBoard(card({ encuadreId: null }));
    drop(card({ encuadreId: null }), 'CONFIRMED');
    expect(onMove).not.toHaveBeenCalled();
  });

  it('REJECTED asks the reason first, then moves with the category', async () => {
    renderBoard(card());
    drop(card(), 'REJECTED');
    expect(onMove).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('rejection-submit'));
    await waitFor(() => expect(onMove).toHaveBeenCalledWith('uuid-1', 'REJECTED', 'NO_SHOW'));
  });

  it('SELECTED asks the role first, then moves with it', async () => {
    renderBoard(card());
    drop(card(), 'SELECTED');
    fireEvent.click(screen.getByTestId('role-submit'));
    await waitFor(() => expect(onMove).toHaveBeenCalledWith('uuid-1', 'SELECTED', undefined, 'TITULAR'));
  });

  it('CONFIRMED asks the interview date first; "ainda não sei" moves without schedule', async () => {
    renderBoard(card());
    drop(card(), 'CONFIRMED');
    fireEvent.click(screen.getByTestId('schedule-submit'));
    await waitFor(() => expect(onMove).toHaveBeenCalledWith('uuid-1', 'CONFIRMED', undefined, undefined, undefined));
  });

  it('any other column moves directly', () => {
    renderBoard(card());
    drop(card(), 'INVITED');
    expect(onMove).toHaveBeenCalledWith('uuid-1', 'INVITED');
  });
});
