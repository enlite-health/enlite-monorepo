import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act, within } from '@testing-library/react';
import { KanbanBoard } from '../KanbanBoard';
import type { FunnelStages, MoveEncuadreError } from '@hooks/admin/useWJAFunnel';
import type { KanbanDropEvent } from '../KanbanBoardShell';

/**
 * Fase 4 (DX-4.6/DX-4.10): a API recusa o `move` com 422 `MOVE_REASON_REQUIRED` por salto ou
 * saída de Rejeitados; o board guarda o movimento pendente e abre o MESMO `RejectionReasonSelect`,
 * generalizado (`testIdPrefix="move-reason"`). O front nunca decide "o que é salto" — só reage ao
 * código que a API devolve. Entrar em Rejeitados continua abrindo o diálogo ANTES de qualquer
 * chamada (fluxo de hoje, não muda).
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
    return <div data-testid="shell">{props.itemsOf('COMPLETED').map((c) => props.renderCard(c, 'COMPLETED'))}</div>;
  },
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
// RejectionReasonSelect NÃO é mockado aqui: é o componente real, generalizado (DX-4.10/DX-4.11),
// que este arquivo cobre tanto no modo "rejection" (padrão) quanto "move-reason".
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
  return {
    INVITED: [], INICIADO: [], PRE_SCREENING: [], IN_PROGRESS: [], COMPLETED: [c],
    CONFIRMED: [], SELECTED: [], QUICK_RESPONSE_TEAM: [], REJECTED: [],
  } as unknown as FunnelStages;
}
const drop = (c: Card, to: string) =>
  act(() => { capturedOnDrop!({ item: c, itemId: c.id, fromColumnId: 'COMPLETED', toColumnId: to }); });

const JUMP_REQUIRED: MoveEncuadreError = { message: 'move_reason_required', code: 'MOVE_REASON_REQUIRED', reason: 'JUMP' };
const LEAVE_REJECTED_REQUIRED: MoveEncuadreError = {
  message: 'move_reason_required', code: 'MOVE_REASON_REQUIRED', reason: 'LEAVE_REJECTED',
};

describe('KanbanBoard — motivo do movimento (Fase 4, DX-4.6/DX-4.10)', () => {
  const onMove = vi.fn();
  beforeEach(() => {
    onMove.mockReset();
    capturedOnDrop = null;
  });

  function renderBoard(c: Card) {
    render(<KanbanBoard stages={stagesWith(c)} vacancyId="v-1" onMove={onMove} />);
    expect(capturedOnDrop).not.toBeNull();
  }

  it('drop vizinho (papel escolhido, onMove aceita): 1 chamada, sem diálogo de motivo', async () => {
    onMove.mockResolvedValue(null);
    renderBoard(card());
    drop(card(), 'SELECTED');
    fireEvent.click(screen.getByTestId('role-submit'));

    await waitFor(() => expect(onMove).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId('move-reason-modal')).not.toBeInTheDocument();
  });

  it('422 JUMP: abre move-reason-modal com as 4 opções rotuladas (nenhum enum cru)', async () => {
    onMove.mockResolvedValue(JUMP_REQUIRED);
    renderBoard(card());
    drop(card(), 'INVITED');

    await waitFor(() => expect(screen.getByTestId('move-reason-modal')).toBeInTheDocument());
    expect(screen.getByText('admin.kanban.moveReasonModal.titleJump')).toBeInTheDocument();
    for (const opt of ['ENCUADRE_ANTECIPADO', 'REAPROVEITADO_DE_OUTRA_VAGA', 'INDICACAO_DA_EQUIPE', 'OTHER']) {
      const slug = opt.toLowerCase().replace(/_/g, '-');
      const option = screen.getByTestId(`move-reason-option-${slug}`);
      // A opção passa pelo i18n com o prefixo moveReasonOptions — nunca o enum cru sozinho.
      expect(within(option).getByText(`admin.kanban.moveReasonOptions.${opt}`)).toBeInTheDocument();
    }
    expect(screen.getAllByTestId(/^move-reason-option-/)).toHaveLength(4);
  });

  it('confirmar o motivo do salto reenvia os MESMOS args + a categoria', async () => {
    onMove.mockResolvedValueOnce(JUMP_REQUIRED).mockResolvedValueOnce(null);
    renderBoard(card());
    drop(card(), 'INVITED');
    await waitFor(() => expect(screen.getByTestId('move-reason-modal')).toBeInTheDocument());

    fireEvent.click(within(screen.getByTestId('move-reason-option-other')).getByRole('radio'));
    fireEvent.click(screen.getByTestId('move-reason-confirm'));

    await waitFor(() => expect(onMove).toHaveBeenCalledTimes(2));
    expect(onMove).toHaveBeenNthCalledWith(1, 'uuid-1', 'INVITED', undefined, undefined, undefined);
    expect(onMove).toHaveBeenNthCalledWith(2, 'uuid-1', 'INVITED', 'OTHER', undefined, undefined);
    expect(screen.queryByTestId('move-reason-modal')).not.toBeInTheDocument();
  });

  it('confirmar o motivo do salto QUANDO havia papel/agendamento pendente: reenvia com role/schedule preservados', async () => {
    onMove.mockResolvedValueOnce(JUMP_REQUIRED).mockResolvedValueOnce(null);
    renderBoard(card());
    drop(card(), 'SELECTED');
    fireEvent.click(screen.getByTestId('role-submit'));
    await waitFor(() => expect(screen.getByTestId('move-reason-modal')).toBeInTheDocument());

    fireEvent.click(within(screen.getByTestId('move-reason-option-other')).getByRole('radio'));
    fireEvent.click(screen.getByTestId('move-reason-confirm'));

    await waitFor(() => expect(onMove).toHaveBeenCalledTimes(2));
    expect(onMove).toHaveBeenNthCalledWith(1, 'uuid-1', 'SELECTED', undefined, 'TITULAR', undefined);
    expect(onMove).toHaveBeenNthCalledWith(2, 'uuid-1', 'SELECTED', 'OTHER', 'TITULAR', undefined);
  });

  it('cancelar o motivo do salto: nenhuma 2ª chamada, e o card continua na origem', async () => {
    onMove.mockResolvedValue(JUMP_REQUIRED);
    renderBoard(card());
    drop(card(), 'INVITED');
    await waitFor(() => expect(screen.getByTestId('move-reason-modal')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('move-reason-cancel'));

    expect(screen.queryByTestId('move-reason-modal')).not.toBeInTheDocument();
    expect(onMove).toHaveBeenCalledTimes(1);
  });

  it('422 LEAVE_REJECTED: move-reason-modal com as 3 opções', async () => {
    onMove.mockResolvedValue(LEAVE_REJECTED_REQUIRED);
    renderBoard(card());
    drop(card(), 'INVITED');

    await waitFor(() => expect(screen.getByTestId('move-reason-modal')).toBeInTheDocument());
    expect(screen.getByText('admin.kanban.moveReasonModal.titleLeaveRejected')).toBeInTheDocument();
    expect(screen.getAllByTestId(/^move-reason-option-/)).toHaveLength(3);
  });

  it('drop em Rejeitados abre rejection-modal ANTES de qualquer chamada (não é motivo de salto)', () => {
    onMove.mockResolvedValue(null);
    renderBoard(card());
    drop(card(), 'REJECTED');

    expect(onMove).not.toHaveBeenCalled();
    expect(screen.getByTestId('rejection-modal')).toBeInTheDocument();
    expect(screen.queryByTestId('move-reason-modal')).not.toBeInTheDocument();
  });
});
