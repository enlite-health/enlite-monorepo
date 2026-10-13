/**
 * EnquadreEventKanban — a tela de UM evento (spec 052 §6): cabeçalho + o kanban dos convocados + os diálogos de
 * encerrar, cancelar, motivo de Rejeitados e o painel "Gestionar convocados". O motor é o `KanbanBoardShell` (o mesmo do
 * funil da vaga e do kanban de pacientes); as regras do funil da vaga não vêm junto.
 *
 * Arrasto e "Mover a…" chamam a MESMA função (`moveParticipant`). Motivo de Rejeitados (spec §5.2) espelha o funil da
 * vaga: ENTRAR pergunta antes (soltar na coluna ou "Rechazar"); SAIR é decidido pelo servidor — 422
 * `MOVE_REASON_REQUIRED` com `reason: LEAVE_REJECTED` — e a tela reage abrindo o mesmo diálogo com a lista de saída.
 * Evento `closed`/`cancelled`: nada se arrasta, não há menu nem "Rechazar".
 * Fase 0: o botão de notas do card NÃO é ligado (o modal chama a API; a ligação é da Fase 2).
 */
import { useState, type JSX } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2 } from 'lucide-react';
import { Text } from '@presentation/components/atoms/Text';
import { KanbanBoardShell, type KanbanDropEvent } from '../../Kanban/KanbanBoardShell';
import { KanbanCard } from '../../Kanban/KanbanCard';
import { RejectionReasonSelect } from '../../Kanban/RejectionReasonSelect';
import { AdmissionConfirmDialog } from '../../PatientDetail/admission/AdmissionConfirmDialog';
import { timeZoneForCountry } from '../../PatientDetail/admission/admissionTime';
import { useEnquadreEvent } from '@hooks/admin/useEnquadreEvent';
import { ApiError } from '@infrastructure/http/ApiError';
import { AdminEnquadreApiService } from '@infrastructure/http/AdminEnquadreApiService';
import { MOVE_REASON_OPTIONS, MOVE_REASON_REQUIRED } from '@domain/entities/MoveReason';
import type { EnquadreColumnId, EnquadreParticipant } from '@domain/entities/EnquadreEvent';
import { ENQUADRE_COLUMNS, ENQUADRE_COLUMN_WIDTH, ENQUADRE_MOVE_TARGETS } from './enquadreColumns';
import { ENQUADRE_PHASE_OPEN } from './enquadreEventPhase';
import { EnquadreEventKanbanHeader } from './EnquadreEventKanbanHeader';
import { EnquadreConvokedPanel } from './EnquadreConvokedPanel';

interface Props {
  vacancyId: string;
  eventId: string;
  /** Volta para a lista (a aba recarrega lista e contador). */
  onBack: () => void;
  /** Relógio injetável (teste e harness). */
  now?: () => Date;
}

/** Props de exibição do card — as MESMAS na coluna e no overlay de arrasto. Sem telefone: o convocado não o expõe. */
function cardProps(p: EnquadreParticipant, column: string) {
  return {
    id: p.id,
    workerId: p.workerId,
    workerName: p.workerName,
    workerPhone: null,
    occupation: p.occupation,
    workZone: null,
    matchScore: null,
    talentumStatus: null,
    rejectionReasonCategory: p.rejectionReasonCategory,
    interviewDate: null,
    interviewTime: null,
    stage: column,
  };
}

export function EnquadreEventKanban({ vacancyId, eventId, onBack, now = () => new Date() }: Props): JSX.Element {
  const { t } = useTranslation();
  const te = (key: string, opts?: Record<string, unknown>): string => t(`admin.vacancyDetail.enquadre.${key}`, opts);
  const { event, status, reload } = useEnquadreEvent(vacancyId, eventId);
  const timeZone = timeZoneForCountry(null);

  const [pendingReject, setPendingReject] = useState<string | null>(null);
  const [pendingLeave, setPendingLeave] = useState<{ participantId: string; column: EnquadreColumnId } | null>(null);
  const [confirm, setConfirm] = useState<'close' | 'cancel' | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [moveError, setMoveError] = useState<string | null>(null);

  if (status === 'loading' && !event) {
    return (
      <div className="flex items-center gap-2 text-slate-600 text-sm" data-testid="enquadre-kanban-loading">
        <Loader2 size={16} className="animate-spin" aria-hidden="true" />
        {te('loading')}
      </div>
    );
  }
  if (!event) {
    return (
      <div className="flex flex-col gap-3 items-start">
        <Text color="inherit" as="p" size="sm" role="alert" className="text-red-800" data-testid="enquadre-kanban-load-error">{te('loadError')}</Text>
        <button type="button" onClick={onBack} className="text-primary underline text-sm" data-testid="enquadre-kanban-back">{te('kanban.back')}</button>
      </div>
    );
  }

  const open = ENQUADRE_PHASE_OPEN[event.phase];

  /** Ponto ÚNICO de mover (arrasto e "Mover a…"). Faltou o motivo de saída de Rejeitados → o servidor diz, a tela pergunta. */
  async function moveParticipant(participantId: string, column: EnquadreColumnId, reason?: string): Promise<void> {
    setMoveError(null);
    try {
      await AdminEnquadreApiService.moveParticipant(vacancyId, eventId, participantId, column, reason);
      await reload();
    } catch (err) {
      if (err instanceof ApiError && err.code === MOVE_REASON_REQUIRED && err.reason === 'LEAVE_REJECTED') {
        setPendingLeave({ participantId, column });
        return;
      }
      setMoveError(te('kanban.moveError'));
      await reload();
    }
  }

  function handleDrop({ itemId, fromColumnId, toColumnId }: KanbanDropEvent<EnquadreParticipant>): void {
    if (fromColumnId === toColumnId) return;
    if (toColumnId === 'REJECTED') {
      setPendingReject(itemId);
      return;
    }
    void moveParticipant(itemId, toColumnId as EnquadreColumnId);
  }

  async function runConfirmed(action: () => Promise<unknown>, errorKey: string, after: () => void | Promise<void>): Promise<void> {
    setBusy(true);
    setDialogError(null);
    try {
      await action();
      setConfirm(null);
      await after();
    } catch {
      setDialogError(te(errorKey));
    } finally {
      setBusy(false);
    }
  }

  const columns = ENQUADRE_COLUMNS.map((c) => ({ id: c.id, color: c.color, droppable: true, title: t(`admin.kanban.columns.${c.id}`) }));

  return (
    <div className="flex flex-col gap-4" data-testid="enquadre-kanban" data-event-id={event.id} data-phase={event.phase}>
      <EnquadreEventKanbanHeader
        event={event}
        timeZone={timeZone}
        now={now()}
        onBack={onBack}
        onManageConvoked={() => setPanelOpen(true)}
        onCancel={() => { setDialogError(null); setConfirm('cancel'); }}
        onClose={() => { setDialogError(null); setConfirm('close'); }}
      />
      {moveError && <Text color="inherit" as="p" size="sm" role="alert" className="text-red-800" data-testid="enquadre-kanban-error">{moveError}</Text>}

      <KanbanBoardShell<EnquadreParticipant>
        testId="enquadre-kanban-board"
        columns={columns}
        itemsOf={(columnId) => event.participants.filter((p) => p.column === columnId)}
        getItemId={(p) => p.id}
        isDragDisabled={() => !open}
        onDrop={handleDrop}
        columnWidthClass={ENQUADRE_COLUMN_WIDTH}
        renderCard={(p, columnId) => (
          <div data-testid={`enquadre-participant-${p.id}`} data-column={columnId}>
            <KanbanCard
              {...cardProps(p, columnId)}
              onReject={open ? () => setPendingReject(p.id) : undefined}
              onMoveTo={open ? (target) => { void moveParticipant(p.id, target as EnquadreColumnId); } : undefined}
              moveTargets={ENQUADRE_MOVE_TARGETS}
            />
            {p.outcome === 'returned' && (
              <span
                className="mt-1 inline-block px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-slate-100 text-slate-700"
                data-testid={`enquadre-participant-returned-${p.id}`}
              >
                {te('kanban.returned')}
              </span>
            )}
          </div>
        )}
        renderDragOverlay={(p, columnId) => <KanbanCard {...cardProps(p, columnId)} />}
      />

      {pendingReject && (
        <RejectionReasonSelect
          onSubmit={(category) => { const id = pendingReject; setPendingReject(null); void moveParticipant(id, 'REJECTED', category); }}
          onCancel={() => setPendingReject(null)}
        />
      )}
      {pendingLeave && (
        <RejectionReasonSelect
          options={MOVE_REASON_OPTIONS.LEAVE_REJECTED}
          titleKey="admin.kanban.moveReasonModal.titleLeaveRejected"
          optionKeyPrefix="admin.kanban.moveReasonOptions"
          confirmKey="admin.kanban.moveReasonModal.confirm"
          cancelKey="admin.kanban.moveReasonModal.cancel"
          testIdPrefix="move-reason"
          onSubmit={(category) => { const m = pendingLeave; setPendingLeave(null); void moveParticipant(m.participantId, m.column, category); }}
          onCancel={() => setPendingLeave(null)}
        />
      )}
      {confirm === 'close' && (
        <AdmissionConfirmDialog
          testId="enquadre-close-dialog"
          title={te('kanban.closeConfirm.title')}
          body={te('kanban.closeConfirm.body', { count: event.unmarkedCount })}
          confirmLabel={te('kanban.closeConfirm.confirm')}
          busyLabel={te('kanban.closeConfirm.busy')}
          busy={busy}
          error={dialogError}
          onConfirm={() => { void runConfirmed(() => AdminEnquadreApiService.closeEvent(vacancyId, eventId), 'kanban.closeError', reload); }}
          onClose={() => setConfirm(null)}
        />
      )}
      {confirm === 'cancel' && (
        <AdmissionConfirmDialog
          testId="enquadre-cancel-dialog"
          title={te('cancel.title')}
          body={te('cancel.body', { count: event.participants.length })}
          confirmLabel={te('cancel.confirm')}
          busyLabel={te('cancel.busy')}
          busy={busy}
          error={dialogError}
          onConfirm={() => { void runConfirmed(() => AdminEnquadreApiService.cancelEvent(vacancyId, eventId), 'cancel.error', onBack); }}
          onClose={() => setConfirm(null)}
        />
      )}
      {panelOpen && open && (
        <EnquadreConvokedPanel vacancyId={vacancyId} event={event} onChanged={reload} onClose={() => setPanelOpen(false)} />
      )}
    </div>
  );
}
