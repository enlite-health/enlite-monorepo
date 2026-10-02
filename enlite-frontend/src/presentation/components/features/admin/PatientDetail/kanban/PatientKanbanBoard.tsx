import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  KanbanBoardShell,
  type KanbanDropEvent,
} from '@presentation/components/features/admin/Kanban/KanbanBoardShell';
import { useActionGate } from '@presentation/hooks/useCellAccess';
import { toDisplayName } from '@domain/value-objects/displayName';
import { PatientKanbanCard } from './PatientKanbanCard';
import { SuspensionExitReasonDialog } from './SuspensionExitReasonDialog';
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
    opts?: { suspensionExitReason?: string },
  ) => Promise<PatientKanbanMoveError | null>;
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

/** Drop pendente de confirmação — só existe enquanto o diálogo de motivo está aberto. */
interface PendingSuspensionExit {
  patientId: string;
  patientName: string;
  toColumnId: PatientKanbanStatus;
}

/**
 * Kanban do ciclo de vida do paciente. A mecânica (drag-and-drop, colunas,
 * overlay, colapso persistido) é a MESMA do funil de vagas e vem do
 * `KanbanBoardShell` — aqui fica só o que é de paciente: as colunas de status,
 * o card e o que fazer no drop.
 *
 * Saída de SUSPENDED (decisão do Gabriel 29/09/2026, 2ª rodada — migration 486): soltar um card
 * cuja coluna de ORIGEM é SUSPENDED não move nada sozinho. O `KanbanBoardShell` é 100% controlado
 * por `groups` (não guarda o card "no ar") — não chamar `onMove` aqui já é suficiente para o card
 * voltar à origem sozinho, sem precisar desfazer otimismo nenhum. O diálogo
 * (`SuspensionExitReasonDialog`) só chama `onMove` (com o motivo) no CONFIRMAR; no CANCELAR,
 * `pending` só é limpo — nada foi enviado, nada precisa voltar.
 */
export function PatientKanbanBoard({ groups, onMove }: Props): JSX.Element {
  const { t } = useTranslation();
  // D269 — soltar no board chama PUT /patients/:id/status → patient:write. O
  // card não é `<Button>`, então usa `useActionGate` (mesma leitura do
  // `ActionButton`): sem a célula, o ARRASTO fica desabilitado (o card
  // continua clicável para abrir a ficha — só o drag some).
  const patientWriteGate = useActionGate('patient', 'update');
  const [pending, setPending] = useState<PendingSuspensionExit | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const columns = PATIENT_KANBAN_STATUSES.map((status) => ({
    id: status,
    title: t(`admin.patients.kanban.columns.${status}`),
    color: COLUMN_COLOR[status],
    droppable: true,
  }));

  function handleDrop({ item, itemId, fromColumnId, toColumnId }: KanbanDropEvent<PatientKanbanItem>) {
    // Soltar na própria coluna não é mudança de status — não gasta request.
    if (fromColumnId === toColumnId) return;
    if (fromColumnId === 'SUSPENDED') {
      const semNome = t('admin.patients.kanban.noName', { defaultValue: '—' });
      const patientName = toDisplayName([item.firstName, item.lastName].filter(Boolean).join(' ')) || semNome;
      setPending({ patientId: itemId, patientName, toColumnId: toColumnId as PatientKanbanStatus });
      return;
    }
    void onMove(itemId, toColumnId as PatientKanbanStatus);
  }

  async function handleConfirmExit(suspensionExitReason: string): Promise<void> {
    if (!pending) return;
    setIsSubmitting(true);
    try {
      await onMove(pending.patientId, pending.toColumnId, { suspensionExitReason });
    } finally {
      setIsSubmitting(false);
      setPending(null);
    }
  }

  return (
    <>
      <KanbanBoardShell<PatientKanbanItem>
        testId="patient-kanban-board"
        columns={columns}
        itemsOf={(columnId) => groups[columnId as PatientKanbanStatus] ?? []}
        getItemId={(p) => p.id}
        isDragDisabled={() => patientWriteGate.denied}
        onDrop={handleDrop}
        collapseStorageKey="kanban-collapsed-patients"
        // 8 colunas: como no funil de vagas (DX-6), rolam horizontalmente — não
        // cabem todas na tela, e o board não precisa descobrir isso sozinho.
        columnWidthClass="w-[260px]"
        renderCard={(p) => <PatientKanbanCard patient={p} />}
      />
      {pending && (
        <SuspensionExitReasonDialog
          patientName={pending.patientName}
          targetStatusLabel={t(`admin.patients.kanban.columns.${pending.toColumnId}`)}
          onConfirm={(reason) => { void handleConfirmExit(reason); }}
          onCancel={() => setPending(null)}
          isSubmitting={isSubmitting}
        />
      )}
    </>
  );
}
