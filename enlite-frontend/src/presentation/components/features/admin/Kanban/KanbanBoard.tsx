import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import type { FunnelStages, MoveEncuadreError } from '@hooks/admin/useWJAFunnel';
import { KanbanBoardShell, type KanbanColumnSpec, type KanbanDropEvent } from './KanbanBoardShell';
import { KanbanCard } from './KanbanCard';
import { RejectionReasonSelect } from './RejectionReasonSelect';
import { RoleSelect } from './RoleSelect';
import { InterviewScheduleSelect, type InterviewSchedule } from './InterviewScheduleSelect';
import { ContactNotesModal } from '@presentation/components/features/admin/VacancyDetail/Funnel/ContactNotesModal';
import type { EncuadreRole } from '@domain/entities/EncuadreRole';

interface KanbanBoardProps {
  stages: FunnelStages;
  vacancyId: string;
  onMove: (
    encuadreId: string,
    targetStage: string,
    rejectionReasonCategory?: string,
    role?: EncuadreRole,
    /** Data/hora da entrevista ao mover para CONFIRMED. Ausente = "ainda não sei". */
    schedule?: InterviewSchedule,
  ) => Promise<MoveEncuadreError | null>;
  /** "Rechazar" de um card BLOQUEADO: soft-dismiss com motivo → vai p/ RECHAZADOS. */
  onRejectBlocked: (blockedId: string, rejectionReasonCategory: string) => Promise<MoveEncuadreError | null>;
  /** "Voltar a bloqueados": desfaz o rechazo de um card bloqueado (RECHAZADOS → BLOQUEADO). */
  onUnrejectBlocked: (blockedId: string) => Promise<MoveEncuadreError | null>;
  /**
   * "Reenviar" da tarjeta (REQ-08): redispara a mensagem para o worker. Devolve
   * null quando enviou, ou a mensagem localizada do motivo da recusa/falha.
   * Ausente = o board não mostra o botão.
   */
  onResendInvite?: (workerId: string) => Promise<string | null>;
}

/** Colunas do funil de vaga. Fonte ÚNICA de quais aceitam drop (`droppable`) —
 *  antes existia também um Set DROPPABLE_STAGES espelhando isto à mão. */
const COLUMN_CONFIG: Omit<KanbanColumnSpec, 'title'>[] = [
  { id: 'INVITED', color: 'bg-blue-400', droppable: true },
  { id: 'BLOQUEADO', color: 'bg-red-500', droppable: false, alert: true },
  { id: 'INICIADO', color: 'bg-indigo-400', droppable: false },
  { id: 'PRE_SCREENING', color: 'bg-violet-400', droppable: false },
  { id: 'IN_PROGRESS', color: 'bg-violet-500', droppable: false },
  { id: 'COMPLETED', color: 'bg-violet-600', droppable: false },
  { id: 'CONFIRMED', color: 'bg-cyan-400', droppable: true },
  { id: 'SELECTED', color: 'bg-green-500', droppable: true },
  { id: 'REJECTED', color: 'bg-red-400', droppable: true },
];

/** Um card do funil (o mesmo shape em qualquer etapa). */
type FunnelCard = FunnelStages[keyof FunnelStages][number];

/**
 * Props de exibição do card — as MESMAS na coluna e no overlay de arrasto.
 * Estavam escritas duas vezes; qualquer campo novo entrava só numa e o card
 * arrastado ficava diferente do card parado.
 */
function cardProps(enc: FunnelCard, stage: string) {
  return {
    id: enc.id,
    workerId: enc.workerId,
    workerName: enc.workerName,
    workerPhone: enc.workerPhone,
    occupation: enc.occupation,
    workZone: enc.workZone,
    matchScore: enc.matchScore,
    talentumStatus: enc.talentumStatus,
    rejectionReasonCategory: enc.rejectionReasonCategory,
    interviewDate: enc.interviewDate,
    interviewTime: enc.interviewTime,
    stage,
    interviewResponse: enc.interviewResponse,
    meetLink: enc.meetLink,
    acquisitionChannel: enc.acquisitionChannel,
    internalStage: enc.internalStage ?? null,
    isBlocked: enc.isBlocked,
    blockedReason: enc.blockedReason,
    missingFields: enc.missingFields,
    attemptCount: enc.attemptCount,
    lastMessagedAt: enc.lastMessagedAt ?? null,
  };
}

export function KanbanBoard({ stages, vacancyId, onMove, onRejectBlocked, onUnrejectBlocked, onResendInvite }: KanbanBoardProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  /**
   * Modal de motivo de rejeição. Serve dois alvos com o MESMO dropdown:
   *  - { encuadreId } → mover encuadre para REJECTED (onMove).
   *  - { blockedId }  → rejeitar tentativa bloqueada, promovendo a RECHAZADOS (onRejectBlocked).
   */
  const [showRejectionSelect, setShowRejectionSelect] = useState<
    { encuadreId: string } | { blockedId: string } | null
  >(null);
  /** Card aguardando escolha de papel (Titular/Substituto) ao ir para SELECTED. */
  const [showRoleSelect, setShowRoleSelect] = useState<{ encuadreId: string } | null>(null);
  const [showScheduleSelect, setShowScheduleSelect] = useState<{ encuadreId: string } | null>(null);
  /**
   * Worker cujo modal de comentários (contact notes) está aberto. Chaveado
   * por workerId (não wjaId): o histórico é o MESMO em todas as colunas —
   * inclusive BLOQUEADO — e não zera quando o card é promovido.
   */
  const [activeNotes, setActiveNotes] = useState<{ workerId: string; workerName: string | null } | null>(null);
  /** Estado do "Reenviar" por card (id do card): enviando / enviado / motivo da recusa. */
  const [resendByCard, setResendByCard] = useState<
    Record<string, { status: 'sending' | 'sent' | 'error'; message: string | null }>
  >({});

  async function handleResend(cardId: string, workerId: string) {
    if (!onResendInvite) return;
    setResendByCard((prev) => ({ ...prev, [cardId]: { status: 'sending', message: null } }));
    const failure = await onResendInvite(workerId);
    setResendByCard((prev) => ({
      ...prev,
      [cardId]: failure ? { status: 'error', message: failure } : { status: 'sent', message: null },
    }));
  }

  function handleWorkerClick(workerId: string) {
    navigate(`/admin/workers/${workerId}`);
  }

  const columns = COLUMN_CONFIG.map((col) => ({
    ...col,
    title: t(`admin.kanban.columns.${col.id}`),
  }));

  /**
   * Drop numa coluna que aceita: o shell já filtrou coluna inválida. Aqui só
   * fica a regra do funil — card órfão (sem encuadre) não move, e REJECTED /
   * SELECTED abrem modal em vez de mover direto.
   */
  function handleDrop({ item, toColumnId }: KanbanDropEvent<FunnelCard>) {
    const encuadreId = item.encuadreId;
    // Órfão já é drag-disabled no card; o guard evita request por estado velho.
    if (!encuadreId) return;

    if (toColumnId === 'REJECTED') {
      setShowRejectionSelect({ encuadreId });
      return;
    }
    if (toColumnId === 'SELECTED') {
      setShowRoleSelect({ encuadreId });
      return;
    }
    // Ao agendar, perguntar QUANDO — é o único ponto em que o sistema captura a data
    // da entrevista (sem ela, lembretes e no-show não têm do que disparar).
    if (toColumnId === 'CONFIRMED') {
      setShowScheduleSelect({ encuadreId });
      return;
    }
    void onMove(encuadreId, toColumnId);
  }

  async function handleScheduleSubmit(
    encuadreId: string,
    schedule: InterviewSchedule | null,
  ) {
    setShowScheduleSelect(null);
    // schedule=null → "ainda não sei": move mesmo assim, sem inventar horário.
    await onMove(encuadreId, 'CONFIRMED', undefined, undefined, schedule ?? undefined);
  }


  async function handleRejectionSubmit(
    target: { encuadreId: string } | { blockedId: string },
    category: string,
  ) {
    setShowRejectionSelect(null);
    if ('blockedId' in target) {
      await onRejectBlocked(target.blockedId, category);
    } else {
      await onMove(target.encuadreId, 'REJECTED', category);
    }
  }

  async function handleRoleSubmit(encuadreId: string, role: EncuadreRole) {
    setShowRoleSelect(null);
    await onMove(encuadreId, 'SELECTED', undefined, role);
  }

  /**
   * Move click (MoveToMenu): mesma pergunta do arrasto — papel ao selecionar, data ao
   * agendar. Os dois caminhos têm que pedir a mesma coisa, senão o menu vira a porta dos
   * fundos que grava card sem data.
   */
  function handleCardMoveTo(encuadreId: string, target: string) {
    if (target === 'SELECTED') {
      setShowRoleSelect({ encuadreId });
      return;
    }
    if (target === 'CONFIRMED') {
      setShowScheduleSelect({ encuadreId });
      return;
    }
    void onMove(encuadreId, target);
  }

  return (
    <>
      <KanbanBoardShell<FunnelCard>
        columns={columns}
        itemsOf={(columnId) => stages[columnId as keyof FunnelStages] ?? []}
        getItemId={(enc) => enc.id}
        isDragDisabled={(enc) => !enc.encuadreId}
        onDrop={handleDrop}
        collapseStorageKey={`kanban-collapsed-${vacancyId}`}
        renderCard={(enc, columnId) => (
          <KanbanCard
            {...cardProps(enc, columnId)}
            isDismissed={enc.isDismissed}
            onWorkerClick={handleWorkerClick}
            onReject={
              enc.encuadreId
                ? () => setShowRejectionSelect({ encuadreId: enc.encuadreId! })
                : enc.isBlocked && !enc.isDismissed
                  ? () => setShowRejectionSelect({ blockedId: enc.id })
                  : undefined
            }
            onUndismiss={
              enc.isBlocked && enc.isDismissed
                ? () => onUnrejectBlocked(enc.id)
                : undefined
            }
            onMoveTo={enc.encuadreId ? (target) => handleCardMoveTo(enc.encuadreId!, target) : undefined}
            onOpenNotes={
              enc.workerId
                ? () => setActiveNotes({ workerId: enc.workerId!, workerName: enc.workerName })
                : undefined
            }
            contactNotesCount={enc.contactNotesCount}
            selfAppliedAt={enc.selfAppliedAt}
            onResend={
              onResendInvite && enc.workerId && enc.encuadreId
                ? () => handleResend(enc.id, enc.workerId!)
                : undefined
            }
            resendStatus={resendByCard[enc.id]?.status ?? 'idle'}
            resendMessage={resendByCard[enc.id]?.message ?? null}
          />
        )}
        /* O card sob o cursor é só leitura: sem handlers, sem menu de mover. */
        renderDragOverlay={(enc, columnId) => <KanbanCard {...cardProps(enc, columnId)} />}
      />

      {showRejectionSelect && (
        <RejectionReasonSelect
          onSubmit={(category) => handleRejectionSubmit(showRejectionSelect, category)}
          onCancel={() => setShowRejectionSelect(null)}
        />
      )}

      {showRoleSelect && (
        <RoleSelect
          onSubmit={(role) => handleRoleSubmit(showRoleSelect.encuadreId, role)}
          onCancel={() => setShowRoleSelect(null)}
        />
      )}

      {showScheduleSelect && (
        <InterviewScheduleSelect
          onSubmit={(schedule) => handleScheduleSubmit(showScheduleSelect.encuadreId, schedule)}
          onCancel={() => setShowScheduleSelect(null)}
        />
      )}

      {activeNotes && (
        <ContactNotesModal
          vacancyId={vacancyId}
          workerId={activeNotes.workerId}
          workerName={activeNotes.workerName}
          onClose={() => setActiveNotes(null)}
        />
      )}
    </>
  );
}
