/**
 * Unit de `PatientKanbanBoard` — a mecânica de arrasto/colunas em si é do
 * `KanbanBoardShell` compartilhado (fora do escopo desta família); aqui o que
 * importa testar é o que ESTE arquivo decide: as colunas, o mapeamento de
 * itens, o no-op ao soltar na própria coluna, e o gate D269 do arrasto.
 *
 * `KanbanBoardShell` é mockado (shallow) — captura as props que o board de
 * paciente calcula e as expõe para os testes chamarem direto, sem simular
 * drag-and-drop real via dnd-kit.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import { useAdminAuthStore } from '@presentation/stores/adminAuthStore';
import type { AuthzContract } from '@domain/entities/Authz';
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

function comEnforcement(permissions: string[], enforcement: AuthzContract['enforcement']) {
  useAdminAuthStore.setState({
    authzStatus: 'ready',
    authz: {
      uid: 'u', tenantId: 't', status: 'ACTIVE', permissions, countries: [], groups: [], features: {}, enforcement,
    } as AuthzContract,
  });
}

describe('PatientKanbanBoard', () => {
  beforeEach(() => {
    captured = null;
    useAdminAuthStore.setState({ authz: null, authzStatus: 'idle' });
  });

  it('monta as 8 colunas de status, todas droppable, na ordem de PATIENT_KANBAN_STATUSES', () => {
    render(<PatientKanbanBoard groups={GROUPS} onMove={vi.fn()} />);
    expect(captured.columns.map((c: { id: string }) => c.id)).toEqual([
      'ADMISSION', 'SEARCHING', 'REPLACEMENT', 'ACTIVE', 'ON_HOLD', 'SUSPENDED', 'ALTA', 'DISCHARGED',
    ]);
    expect(captured.columns.every((c: { droppable: boolean }) => c.droppable)).toBe(true);
  });

  it('itemsOf devolve os itens do grupo da coluna pedida', () => {
    render(<PatientKanbanBoard groups={GROUPS} onMove={vi.fn()} />);
    expect(captured.itemsOf('ADMISSION')).toEqual([PATIENT_1]);
    expect(captured.itemsOf('SEARCHING')).toEqual([]);
  });

  it('itemsOf devolve [] para uma coluna sem grupo (defensivo)', () => {
    render(<PatientKanbanBoard groups={{} as PatientKanbanGroups} onMove={vi.fn()} />);
    expect(captured.itemsOf('DISCHARGED')).toEqual([]);
  });

  it('getItemId devolve o id do paciente', () => {
    render(<PatientKanbanBoard groups={GROUPS} onMove={vi.fn()} />);
    expect(captured.getItemId(PATIENT_1)).toBe('p1');
  });

  it('renderCard renderiza o PatientKanbanCard com o paciente', () => {
    render(<PatientKanbanBoard groups={GROUPS} onMove={vi.fn()} />);
    const { getByTestId } = render(captured.renderCard(PATIENT_1));
    expect(getByTestId('stub-card-p1')).toBeInTheDocument();
  });

  it('soltar na PRÓPRIA coluna é no-op — não chama onMove', () => {
    const onMove = vi.fn();
    render(<PatientKanbanBoard groups={GROUPS} onMove={onMove} />);
    captured.onDrop({ item: PATIENT_1, itemId: 'p1', fromColumnId: 'ADMISSION', toColumnId: 'ADMISSION' });
    expect(onMove).not.toHaveBeenCalled();
  });

  it('soltar em coluna DIFERENTE chama onMove com o id e o status alvo', () => {
    const onMove = vi.fn().mockResolvedValue(null);
    render(<PatientKanbanBoard groups={GROUPS} onMove={onMove} />);
    captured.onDrop({ item: PATIENT_1, itemId: 'p1', fromColumnId: 'ADMISSION', toColumnId: 'ALTA' });
    expect(onMove).toHaveBeenCalledWith('p1', 'ALTA');
  });

  // ── D269 — soltar chama PUT /patients/:id/status → patient:write ──────────

  it('🔴 enforcement=on, sem patient:write: isDragDisabled retorna true (arrasto bloqueado)', () => {
    comEnforcement([], 'on');
    render(<PatientKanbanBoard groups={GROUPS} onMove={vi.fn()} />);
    expect(captured.isDragDisabled(PATIENT_1)).toBe(true);
  });

  it('enforcement=on, com patient:write: isDragDisabled retorna false', () => {
    comEnforcement(['patient:update'], 'on');
    render(<PatientKanbanBoard groups={GROUPS} onMove={vi.fn()} />);
    expect(captured.isDragDisabled(PATIENT_1)).toBe(false);
  });

  it('enforcement OFF (ou ausente): isDragDisabled retorna false mesmo sem célula', () => {
    render(<PatientKanbanBoard groups={GROUPS} onMove={vi.fn()} />);
    expect(captured.isDragDisabled(PATIENT_1)).toBe(false);
  });
});
