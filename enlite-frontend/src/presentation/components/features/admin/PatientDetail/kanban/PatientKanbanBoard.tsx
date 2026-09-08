import { useTranslation } from 'react-i18next';
import {
  KanbanBoardShell,
  type KanbanDropEvent,
} from '@presentation/components/features/admin/Kanban/KanbanBoardShell';
import { useActionGate } from '@presentation/hooks/useCellAccess';
import { PatientKanbanCard } from './PatientKanbanCard';
import {
  PATIENT_KANBAN_STATUSES,
  type PatientKanbanGroups,
  type PatientKanbanStatus,
  type PatientKanbanMoveError,
} from '@hooks/admin/usePatientKanban';
import type { PatientKanbanItem } from '@domain/entities/PatientDetail';

interface Props {
  groups: PatientKanbanGroups;
  onMove: (
    patientId: string,
    targetStatus: PatientKanbanStatus,
  ) => Promise<PatientKanbanMoveError | null>;
}

// Spec 012: as colunas são o FUNIL DE ADMISSÃO (`admission_status`); DONE = "Activo".
const COLUMN_COLOR: Record<PatientKanbanStatus, string> = {
  SOLICITANTE: 'bg-slate-400',
  ADMISSION: 'bg-blue-400',
  PENDING_ADMISSION: 'bg-yellow-400',
  DONE: 'bg-green-500',
};

/**
 * Kanban do ciclo de vida do paciente. A mecânica (drag-and-drop, colunas,
 * overlay, colapso persistido) é a MESMA do funil de vagas e vem do
 * `KanbanBoardShell` — aqui fica só o que é de paciente: as colunas de status,
 * o card e o que fazer no drop.
 */
export function PatientKanbanBoard({ groups, onMove }: Props): JSX.Element {
  const { t } = useTranslation();
  // D269 — soltar no board chama PUT /patients/:id/status → patient:write. O
  // card não é `<Button>`, então usa `useActionGate` (mesma leitura do
  // `ActionButton`): sem a célula, o ARRASTO fica desabilitado (o card
  // continua clicável para abrir a ficha — só o drag some).
  const patientWriteGate = useActionGate('patient', 'write');

  const columns = PATIENT_KANBAN_STATUSES.map((status) => ({
    id: status,
    title: t(`admin.patients.kanban.columns.${status}`),
    color: COLUMN_COLOR[status],
    droppable: true,
  }));

  function handleDrop({ itemId, fromColumnId, toColumnId }: KanbanDropEvent<PatientKanbanItem>) {
    // Soltar na própria coluna não é mudança de status — não gasta request.
    if (fromColumnId === toColumnId) return;
    void onMove(itemId, toColumnId as PatientKanbanStatus);
  }

  return (
    <KanbanBoardShell<PatientKanbanItem>
      testId="patient-kanban-board"
      columns={columns}
      itemsOf={(columnId) => groups[columnId as PatientKanbanStatus] ?? []}
      getItemId={(p) => p.id}
      isDragDisabled={() => patientWriteGate.denied}
      onDrop={handleDrop}
      collapseStorageKey="kanban-collapsed-patients"
      // 4 colunas: a 280px somavam 1156px em 1096px úteis e a 4ª ("Activo")
      // ficava 60px fora da tela. A 260px cabem as quatro (1076px) e ninguém
      // precisa descobrir que o board rola para ver a coluna que importa.
      columnWidthClass="w-[260px]"
      renderCard={(p) => <PatientKanbanCard patient={p} />}
    />
  );
}
