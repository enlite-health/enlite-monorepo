/**
 * Unit de `PatientKanbanBoard` — a mecânica de colunas é do `KanbanBoardShell` compartilhado (fora do escopo desta família); aqui o que
 * importa testar é o que ESTE arquivo decide: as colunas, o mapeamento de itens e — F5, estado-automatico-do-paciente — que o board é SÓ
 * DE LEITURA: nenhuma coluna aceita soltar card, o shell não recebe `onDrop` nem `isDragDisabled`.
 *
 * `KanbanBoardShell` é mockado (shallow) — captura as props que o board de paciente calcula.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import type { PatientKanbanGroups } from '@hooks/admin/usePatientKanban';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

let captured: any = null;
vi.mock('@presentation/components/features/admin/Kanban/KanbanBoardShell', () => ({
  KanbanBoardShell: (props: unknown) => {
    captured = props;
    return null;
  },
}));

vi.mock('../PatientKanbanCard', () => ({
  PatientKanbanCard: ({ patient }: { patient: { id: string } }) => (
    <div data-testid={`stub-card-${patient.id}`} />
  ),
}));

const { PatientKanbanBoard } = await import('../PatientKanbanBoard');

const PATIENT_1 = {
  id: 'p1', firstName: 'Ana', lastName: 'Gomez', caseNumber: 10,
  dependencyLevel: null, status: 'ADMISSION', admissionStatus: 'SOLICITANTE', responsibleName: null,
  hoursInStage: null, slaBreached: false,
};

const GROUPS: PatientKanbanGroups = {
  ADMISSION: [PATIENT_1],
  SEARCHING: [],
  REPLACEMENT: [],
  ACTIVE: [],
  ON_HOLD: [],
  SUSPENDED: [],
  ALTA: [],
  DISCHARGED: [],
};

describe('PatientKanbanBoard', () => {
  beforeEach(() => {
    captured = null;
  });

  it('monta as 8 colunas de status, NENHUMA droppable, na ordem de PATIENT_KANBAN_STATUSES', () => {
    render(<PatientKanbanBoard groups={GROUPS} />);
    expect(captured.columns.map((c: { id: string }) => c.id)).toEqual([
      'ADMISSION', 'SEARCHING', 'REPLACEMENT', 'ACTIVE', 'ON_HOLD', 'SUSPENDED', 'ALTA', 'DISCHARGED',
    ]);
    expect(captured.columns.every((c: { droppable: boolean }) => c.droppable === false)).toBe(true);
  });

  it('itemsOf devolve os itens do grupo da coluna pedida', () => {
    render(<PatientKanbanBoard groups={GROUPS} />);
    expect(captured.itemsOf('ADMISSION')).toEqual([PATIENT_1]);
    expect(captured.itemsOf('SEARCHING')).toEqual([]);
  });

  it('itemsOf devolve [] para uma coluna sem grupo (defensivo)', () => {
    render(<PatientKanbanBoard groups={{} as PatientKanbanGroups} />);
    expect(captured.itemsOf('DISCHARGED')).toEqual([]);
  });

  it('getItemId devolve o id do paciente', () => {
    render(<PatientKanbanBoard groups={GROUPS} />);
    expect(captured.getItemId(PATIENT_1)).toBe('p1');
  });

  it('renderCard renderiza o PatientKanbanCard com o paciente', () => {
    render(<PatientKanbanBoard groups={GROUPS} />);
    const { getByTestId } = render(captured.renderCard(PATIENT_1));
    expect(getByTestId('stub-card-p1')).toBeInTheDocument();
  });

  it('F5: o board é só de leitura — o shell NÃO recebe onDrop nem isDragDisabled (sem onDrop o card não ganha arrasto)', () => {
    render(<PatientKanbanBoard groups={GROUPS} />);
    expect(captured.onDrop).toBeUndefined();
    expect(captured.isDragDisabled).toBeUndefined();
  });
});
