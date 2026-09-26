import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { FunnelStages, MoveEncuadreError } from '@hooks/admin/useWJAFunnel';
import { KanbanBoardShell, type KanbanDropEvent } from './KanbanBoardShell';
import { KanbanCard } from './KanbanCard';
import { RejectionReasonSelect } from './RejectionReasonSelect';
import { RoleSelect } from './RoleSelect';
import { InterviewScheduleSelect, type InterviewSchedule } from './InterviewScheduleSelect';
import { ContactNotesModal } from '@presentation/components/features/admin/VacancyDetail/Funnel/ContactNotesModal';
import { VACANCY_FUNNEL_COLUMNS, columnItems } from '@presentation/components/features/admin/VacancyDetail/Funnel/funnelTabsConfig';
import { compareByDistanceKm } from '@domain/value-objects/candidateDistance';
import { useActionGate } from '@presentation/hooks/useCellAccess';
import type { EncuadreRole } from '@domain/entities/EncuadreRole';
import type { PresentationInviteResult } from '@infrastructure/http/AdminPresentationInviteApiService';
import { usePresentationInviteLast } from '@hooks/admin/usePresentationInviteLast';
import type { PresentationInviteState } from './KanbanCardPresentationInvite';

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
  /** "Promover" um card ELEGIBLE (D300). Devolve mensagem localizada de erro, ou null no sucesso. */
  onPromoteBlocked?: (blockedId: string) => Promise<string | null>;
  /**
   * "Reenviar" da tarjeta (REQ-08): redispara a mensagem para o worker. Devolve
   * null quando enviou, ou a mensagem localizada do motivo da recusa/falha.
   * Ausente = o board não mostra o botão.
   */
  onResendInvite?: (workerId: string) => Promise<string | null>;
  /**
   * REQ-09: "Invitar a reunión de presentación" da tarjeta. Devolve o resultado do backend
   * (enfileirado ou pulado com motivo); lança em falha. Ausente = o board não mostra o botão.
   */
  onPresentationInvite?: (workerId: string) => Promise<PresentationInviteResult>;
}

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
    lastStageMessage: enc.lastStageMessage ?? null,
    resendBlockedReason: enc.resendBlockedReason ?? null,
  };
}

export function KanbanBoard({ stages, vacancyId, onMove, onPromoteBlocked, onResendInvite, onPresentationInvite }: KanbanBoardProps) {
  const { t } = useTranslation();
  // PUT /encuadres/:id/move, /result
  // → todos funnel:write. Arrasto e menu de clique chamam a MESMA rota — D269
  // (correção: "esconder, não desabilitar") tira a OFERTA das duas com o
  // mesmo predicado: o drag não é oferecido (`isDragDisabled`, que já
  // significa "sem listener do dnd-kit" — não é um drag "travado") e os
  // callbacks de mover/rechazar viram `undefined`, então `KanbanCard`
  // nem monta o `MoveToMenu`/botão (mesmo `{onX && <.../>}` de sempre).
  const funnelWriteGate = useActionGate('funnel', 'update');
  /** Modal de motivo de rejeição: move o encuadre para REJECTED (onMove). */
  const [showRejectionSelect, setShowRejectionSelect] = useState<{ encuadreId: string } | null>(null);
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

  /** D300: estado do botão "Promover" por card — mesmo padrão do reenvio. */
  const [promoteByCard, setPromoteByCard] = useState<
    Record<string, { status: 'promoting' | 'promoted' | 'error'; message: string | null }>
  >({});

  /** REQ-09: estado do convite à reunión de presentación por card + último convite por worker. */
  const [presentationByCard, setPresentationByCard] = useState<Record<string, PresentationInviteState>>({});
  const [lastPresentationByWorker, setLastPresentationByWorker] = usePresentationInviteLast(
    Object.values(stages).flat().map((e) => e.workerId), !!onPresentationInvite,
  );

  async function handlePresentationInvite(cardId: string, workerId: string, invite: NonNullable<typeof onPresentationInvite>) {
    setPresentationByCard((prev) => ({ ...prev, [cardId]: { status: 'sending' } }));
    try {
      const r = await invite(workerId);
      if (r.status === 'queued') {
        setLastPresentationByWorker((prev) => ({ ...prev, [workerId]: { at: new Date().toISOString(), by: null } }));
        setPresentationByCard((prev) => ({ ...prev, [cardId]: { status: 'queued' } }));
      } else {
        setPresentationByCard((prev) => ({ ...prev, [cardId]: { status: 'skipped', detail: r.skipReason } }));
      }
    } catch (err) {
      setPresentationByCard((prev) => ({ ...prev, [cardId]: { status: 'error', detail: err instanceof Error ? err.message : null } }));
    }
  }

  async function handleResend(cardId: string, workerId: string) {
    if (!onResendInvite) return;
    setResendByCard((prev) => ({ ...prev, [cardId]: { status: 'sending', message: null } }));
    const failure = await onResendInvite(workerId);
    setResendByCard((prev) => ({
      ...prev,
      [cardId]: failure ? { status: 'error', message: failure } : { status: 'sent', message: null },
    }));
  }

  async function handlePromote(cardId: string) {
    if (!onPromoteBlocked) return;
    setPromoteByCard((prev) => ({ ...prev, [cardId]: { status: 'promoting', message: null } }));
    const failure = await onPromoteBlocked(cardId);
    setPromoteByCard((prev) => ({
      ...prev,
      [cardId]: failure ? { status: 'error', message: failure } : { status: 'promoted', message: null },
    }));
  }

  const columns = VACANCY_FUNNEL_COLUMNS.map((c) => ({
    id: c.id,
    color: c.color,
    droppable: c.droppable,
    title: t(`admin.kanban.columns.${c.id}`),
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


  async function handleRejectionSubmit(target: { encuadreId: string }, category: string) {
    setShowRejectionSelect(null);
    await onMove(target.encuadreId, 'REJECTED', category);
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
        itemsOf={(columnId) => {
          const col = VACANCY_FUNNEL_COLUMNS.find((c) => c.id === columnId);
          // FunnelStages não tem index signature; columnItems só lê por chave conhecida, e as 8
          // chaves de FunnelStages cobrem todo `sources` possível de VACANCY_FUNNEL_COLUMNS. Sem
          // mudança de comportamento — só o tipo que o tsc exige para a assinatura genérica.
          return col ? columnItems(col, stages as unknown as Partial<Record<string, FunnelCard[]>>).sort(compareByDistanceKm) : [];
        }}
        getItemId={(enc) => enc.id}
        isDragDisabled={(enc) => !enc.encuadreId || funnelWriteGate.denied}
        onDrop={handleDrop}
        collapseStorageKey={`kanban-collapsed-${vacancyId}`}
        renderCard={(enc, columnId) => (
          <KanbanCard
            {...cardProps(enc, columnId)}
            isDismissed={enc.isDismissed}
            onReject={
              funnelWriteGate.denied || !enc.encuadreId
                ? undefined
                : () => setShowRejectionSelect({ encuadreId: enc.encuadreId! })
            }
            onMoveTo={
              !funnelWriteGate.denied && enc.encuadreId
                ? (target) => handleCardMoveTo(enc.encuadreId!, target)
                : undefined
            }
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
            onPromote={
              onPromoteBlocked && enc.isBlocked && !enc.isDismissed && enc.blockedReason === 'eligible'
                ? () => handlePromote(enc.id)
                : undefined
            }
            promoteStatus={promoteByCard[enc.id]?.status ?? 'idle'}
            promoteMessage={promoteByCard[enc.id]?.message ?? null}
            resendStatus={resendByCard[enc.id]?.status ?? 'idle'}
            resendMessage={resendByCard[enc.id]?.message ?? null}
            presentationInvite={
              onPresentationInvite && enc.workerId
                ? { onInvite: () => handlePresentationInvite(enc.id, enc.workerId!, onPresentationInvite), state: presentationByCard[enc.id], lastInvitedAt: lastPresentationByWorker[enc.workerId]?.at ?? null }
                : undefined
            }
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
