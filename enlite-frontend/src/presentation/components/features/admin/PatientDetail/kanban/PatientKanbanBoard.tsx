import { useTranslation } from 'react-i18next';
import { KanbanBoardShell } from '@presentation/components/features/admin/Kanban/KanbanBoardShell';
import { PatientKanbanCard } from './PatientKanbanCard';
import { PATIENT_KANBAN_STATUSES, type PatientKanbanGroups, type PatientKanbanStatus } from '@hooks/admin/usePatientKanban';
import type { PatientKanbanItem } from '@domain/entities/PatientDetail';

interface Props {
  groups: PatientKanbanGroups;
}

// eixo = `patients.status` (D427/D430)
const COLUMN_COLOR: Record<PatientKanbanStatus, string> = {
  ADMISSION: 'bg-blue-400',
  SEARCHING: 'bg-wait',
  REPLACEMENT: 'bg-indigo-400',
  ACTIVE: 'bg-green-500',
  ON_HOLD: 'bg-clinic',
  SUSPENDED: 'bg-orange-400',
  ALTA: 'bg-teal-500',
  DISCHARGED: 'bg-slate-400',
};

/**
 * Kanban do ciclo de vida do paciente — SÓ DE LEITURA (estado-automatico-do-paciente, F5). As colunas, o card e o colapso
 * persistido vêm do `KanbanBoardShell` (o mesmo motor do funil de vagas); aqui fica só o que é de paciente. O estado
 * é definido pelo fluxo automático (foguete, itinerário) e pelas ações da ficha (pausar, suspender, dar alta/baja, retomar,
 * reativar): este board NÃO muda estado — o shell sem `onDrop` não dá ao card atributo nem listener de arrasto.
 */
export function PatientKanbanBoard({ groups }: Props): JSX.Element {
  const { t } = useTranslation();

  const columns = PATIENT_KANBAN_STATUSES.map((status) => ({
    id: status,
    title: t(`admin.patients.kanban.columns.${status}`),
    color: COLUMN_COLOR[status],
    droppable: false,
  }));

  return (
    <KanbanBoardShell<PatientKanbanItem>
      testId="patient-kanban-board"
      columns={columns}
      itemsOf={(columnId) => groups[columnId as PatientKanbanStatus] ?? []}
      getItemId={(p) => p.id}
      collapseStorageKey="kanban-collapsed-patients"
      // 8 colunas: como no funil de vagas (DX-6), rolam horizontalmente — não
      // cabem todas na tela, e o board não precisa descobrir isso sozinho.
      columnWidthClass="w-[260px]"
      renderCard={(p) => <PatientKanbanCard patient={p} />}
    />
  );
}
