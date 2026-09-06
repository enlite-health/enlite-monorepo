/**
 * PatientKanbanBoard — o que acontece ao soltar um card.
 *
 * A mecânica de arrastar vem do `KanbanBoardShell` (dnd-kit) e não roda em
 * jsdom. O que é DESTE componente é a decisão: soltar na própria coluna não é
 * mudança de status e não pode gastar request. Para afirmar isso sem simular
 * drag, o shell é substituído por um espião que devolve o `onDrop` recebido —
 * a fronteira testada é a que o board controla.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { PatientKanbanBoard } from '../PatientKanbanBoard';
import type { PatientKanbanGroups } from '@hooks/admin/usePatientKanban';

let capturado: ((e: { itemId: string; fromColumnId: string; toColumnId: string }) => void) | null = null;

vi.mock('@presentation/components/features/admin/Kanban/KanbanBoardShell', () => ({
  KanbanBoardShell: (props: Record<string, any>) => {
    capturado = props.onDrop;
    // O shell real chama estas render-props; o espião faz o mesmo, senão elas
    // ficam descobertas e o teste mede menos do que o componente entrega.
    const itens = props.columns.flatMap((c: { id: string }) => props.itemsOf(c.id));
    return (
      <div data-testid={props.testId} data-colwidth={props.columnWidthClass}>
        <span data-testid="colunas">{props.columns.map((c: { id: string }) => c.id).join(',')}</span>
        {itens.map((i: { id: string }) => (
          <div key={props.getItemId(i)} data-testid={`item-${props.getItemId(i)}`}>
            {props.renderCard(i, 'SOLICITANTE')}
          </div>
        ))}
      </div>
    );
  },
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));

const vazio: PatientKanbanGroups = { SOLICITANTE: [], ADMISSION: [], PENDING_ADMISSION: [], DONE: [] };

const comItem: PatientKanbanGroups = {
  ...vazio,
  SOLICITANTE: [{ id: 'p1', firstName: 'Solicitante', lastName: null, caseNumber: null,
                  dependencyLevel: null, status: 'SOLICITANTE', admissionStatus: 'SOLICITANTE', responsibleName: null,
                  leadContactEmailMasked: null, leadContactIsResponsible: false }],
};

beforeEach(() => { capturado = null; });

describe('soltar um card', () => {
  it('mover para OUTRA coluna chama onMove com o status de destino', () => {
    const onMove = vi.fn().mockResolvedValue(null);
    render(<PatientKanbanBoard groups={vazio} onMove={onMove} />);

    capturado!({ itemId: 'p1', fromColumnId: 'SOLICITANTE', toColumnId: 'ADMISSION' });
    expect(onMove).toHaveBeenCalledWith('p1', 'ADMISSION');
  });

  it('soltar na PRÓPRIA coluna não gasta request', () => {
    const onMove = vi.fn().mockResolvedValue(null);
    render(<PatientKanbanBoard groups={vazio} onMove={onMove} />);

    capturado!({ itemId: 'p1', fromColumnId: 'DONE', toColumnId: 'DONE' });
    expect(onMove).not.toHaveBeenCalled();
  });

  it('as 4 colunas e o card são montados pelas render-props do board', () => {
    const { getByTestId } = render(<MemoryRouter><PatientKanbanBoard groups={comItem} onMove={async () => null} /></MemoryRouter>);
    expect(getByTestId('colunas').textContent)
      .toBe('SOLICITANTE,ADMISSION,PENDING_ADMISSION,DONE');
    expect(getByTestId('item-p1')).toBeInTheDocument();
  });

  it('coluna sem entrada no grupo devolve lista vazia, não quebra', () => {
    const incompleto = { SOLICITANTE: [] } as unknown as PatientKanbanGroups;
    const { getByTestId } = render(<PatientKanbanBoard groups={incompleto} onMove={async () => null} />);
    expect(getByTestId('patient-kanban-board')).toBeInTheDocument();
  });

  it('a largura reduzida de coluna chega ao shell', () => {
    const { getByTestId } = render(<PatientKanbanBoard groups={vazio} onMove={async () => null} />);
    expect(getByTestId('patient-kanban-board')).toHaveAttribute('data-colwidth', 'w-[260px]');
  });
});
