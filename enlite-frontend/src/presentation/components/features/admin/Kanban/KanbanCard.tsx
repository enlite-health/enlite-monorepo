import { useTranslation } from 'react-i18next';
import { Text } from '@presentation/components/atoms/Text';
import { CalendarClock, Hand, MapPin, MessageSquare, Phone, Star } from 'lucide-react';
import { formatPhoneDisplay } from '@presentation/utils/recruitmentHelpers';
import { NotesCountBadge } from '@presentation/components/features/admin/VacancyDetail/Funnel/NotesCountBadge';
import { MoveToMenu } from './MoveToMenu';

interface KanbanCardProps {
  id: string;
  workerId: string | null;
  workerName: string | null;
  workerPhone: string | null;
  occupation: string | null;
  workZone: string | null;
  matchScore: number | null;
  talentumStatus: string | null;
  rejectionReasonCategory: string | null;
  interviewDate: string | null;
  interviewTime: string | null;
  stage: string;
  /** F7.b: interview_response from WJA — 'awaiting_reschedule' triggers the reschedule badge */
  interviewResponse?: string | null;
  /** F7.b: meet link assigned to the WJA — null means no slot assigned yet */
  meetLink?: string | null;
  acquisitionChannel?: string | null;
  internalStage?: string | null;
  /** INICIADO column: true when worker was blocked by the postulation gate */
  isBlocked?: boolean;
  /** Reason the gate blocked the attempt: worker_not_found | registration_incomplete | worker_disabled */
  blockedReason?: string;
  /** Fields that need to be completed (only relevant when blockedReason='registration_incomplete') */
  missingFields?: string[];
  /** How many times this worker attempted to apply */
  attemptCount?: number;
  /** Blocked card "rechazado" (soft-dismiss) — aparece em RECHAZADOS com botão de voltar. */
  isDismissed?: boolean;
  onWorkerClick?: (workerId: string) => void;
  onReject?: () => void;
  /** "Voltar a bloqueados": desfaz o rechazo de um card bloqueado (só para isDismissed). */
  onUndismiss?: () => void;
  /** Move o card para outro stage via menu de clique (alternativa ao arrasto).
   *  Só é passado para cards movíveis (com encuadre) — orphans/BLOQUEADO ficam sem. */
  onMoveTo?: (targetStage: string) => void;
  /** Opens the contact-notes modal for the VACANCY — same thread on every card, including BLOQUEADO. */
  onOpenNotes?: () => void;
  /** Number of contact notes registered for the vacancy — same count on every card, shown on the notes button. */
  contactNotesCount?: number;
  /**
   * ISO de quando o PRÓPRIO prestador entrou nesta vaga pelo link público —
   * levantou a mão sozinho, é lead quente. null/undefined = não sabemos
   * (a autoria só é gravada desde 06/08): ausência NÃO significa desinteresse.
   */
  selfAppliedAt?: string | null;
}

const ACQUISITION_CHANNEL_STYLE: Record<string, { bg: string; text: string }> = {
  facebook: { bg: 'bg-blue-100', text: 'text-blue-700' },
  instagram: { bg: 'bg-pink-100', text: 'text-pink-700' },
  whatsapp: { bg: 'bg-green-100', text: 'text-green-700' },
  linkedin: { bg: 'bg-sky-100', text: 'text-sky-700' },
  site: { bg: 'bg-slate-200', text: 'text-slate-700' },
};

const TALENTUM_STATUS_STYLE: Record<string, { bg: string; text: string }> = {
  INITIATED: { bg: 'bg-slate-100', text: 'text-slate-600' },
  PRE_SCREENING: { bg: 'bg-indigo-50', text: 'text-indigo-700' },
  IN_PROGRESS: { bg: 'bg-amber-50', text: 'text-amber-700' },
  COMPLETED: { bg: 'bg-blue-50', text: 'text-blue-700' },
  PENDING: { bg: 'bg-violet-50', text: 'text-violet-700' },
  QUALIFIED: { bg: 'bg-green-50', text: 'text-green-700' },
  IN_DOUBT: { bg: 'bg-orange-50', text: 'text-orange-700' },
  NOT_QUALIFIED: { bg: 'bg-red-50', text: 'text-red-600' },
};

const COMPLETADO_BADGE_STYLE: Record<string, string> = {
  QUALIFIED: 'bg-green-50 text-green-700',
  IN_DOUBT: 'bg-orange-50 text-orange-700',
  COMPLETED: 'bg-blue-50 text-blue-700',
};

function completadoBadgeStyle(internalStage: string): string {
  return COMPLETADO_BADGE_STYLE[internalStage] ?? '';
}

export function KanbanCard({
  id,
  workerId,
  workerName,
  workerPhone,
  occupation,
  workZone,
  matchScore,
  talentumStatus,
  rejectionReasonCategory,
  interviewDate,
  interviewTime,
  stage,
  interviewResponse,
  meetLink,
  acquisitionChannel,
  internalStage,
  isBlocked,
  blockedReason,
  missingFields,
  attemptCount,
  isDismissed,
  onWorkerClick,
  onReject,
  onUndismiss,
  onMoveTo,
  onOpenNotes,
  contactNotesCount = 0,
  selfAppliedAt,
}: KanbanCardProps) {
  const { t } = useTranslation();
  const talentumStyle = talentumStatus ? TALENTUM_STATUS_STYLE[talentumStatus] : null;
  const formattedPhone = formatPhoneDisplay(workerPhone);
  // BLOQUEADO (worker_not_found): o nome não pôde ser decriptado — usar um
  // label curto e específico em vez do fallback genérico "Sin nombre".
  const nameLabel =
    workerName ??
    (isBlocked ? t('admin.kanban.blockedNoName') : t('admin.kanban.noName'));

  const handleNameClick = (e: React.MouseEvent) => {
    if (workerId && onWorkerClick) {
      e.stopPropagation();
      onWorkerClick(workerId);
    }
  };

  const interviewLabel = interviewDate
    ? `${new Date(interviewDate).toLocaleDateString('es-AR', { day: 'numeric', month: 'short' })}${interviewTime ? ` ${interviewTime}` : ''}`
    : null;

  return (
    <div
      data-testid={`kanban-card-${id}`}
      data-stage={stage}
      className="bg-white rounded-xl border border-slate-200 p-3 shadow-sm hover:shadow-md transition-shadow cursor-grab active:cursor-grabbing"
    >
      <div className="flex items-start justify-between gap-2">
        {workerId && onWorkerClick ? (
          <button
            type="button"
            className="text-left truncate"
            onClick={handleNameClick}
          >
            <Text as="span" size="sm" weight="semibold" className="text-[#180149] truncate hover:underline">
              {nameLabel}
            </Text>
          </button>
        ) : (
          <Text as="span" size="sm" weight="semibold" className="text-[#180149] truncate">
            {nameLabel}
          </Text>
        )}
        {matchScore !== null && (
          <div className="flex items-center gap-0.5 shrink-0">
            <Star className="w-3 h-3 text-yellow-500 fill-yellow-500" />
            <span className="text-xs font-medium text-slate-600">{matchScore}</span>
          </div>
        )}
      </div>

      {occupation && (
        <span className="inline-block mt-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-purple-50 text-purple-700">
          {occupation}
        </span>
      )}

      {/* "Se postuló sola": a pessoa clicou no link da vaga por conta própria.
          Sem este selo o card é idêntico a um convite frio que ninguém pediu —
          foi assim que a Carina ficou 3 semanas esperando em 14 vagas. */}
      {selfAppliedAt && (
        <span
          data-testid="self-applied-badge"
          title={t('admin.kanban.selfAppliedTitle', {
            date: new Date(selfAppliedAt).toLocaleDateString('es-AR'),
          })}
          className="inline-flex items-center gap-1 mt-1 px-1.5 py-0.5 rounded text-[10px] font-semibold bg-emerald-100 text-emerald-800"
        >
          <Hand className="w-3 h-3" />
          {t('admin.kanban.selfApplied')}
        </span>
      )}

      {acquisitionChannel && ACQUISITION_CHANNEL_STYLE[acquisitionChannel] && (
        <span
          data-testid="acquisition-channel-badge"
          className={`inline-block mt-1 ml-1 px-1.5 py-0.5 rounded text-[10px] font-medium ${ACQUISITION_CHANNEL_STYLE[acquisitionChannel].bg} ${ACQUISITION_CHANNEL_STYLE[acquisitionChannel].text}`}
        >
          {t(`admin.kanban.acquisitionChannel.${acquisitionChannel}`)}
        </span>
      )}

      {talentumStyle && (
        <span data-testid="talentum-badge" className={`inline-block mt-1 px-1.5 py-0.5 rounded text-[10px] font-medium ${talentumStyle.bg} ${talentumStyle.text}`}>
          {t(`admin.kanban.talentumStatus.${talentumStatus}`)}
        </span>
      )}

      {stage === 'COMPLETED' && internalStage && completadoBadgeStyle(internalStage) && (
        <span
          data-testid="completado-badge"
          className={`inline-block mt-1 px-1.5 py-0.5 rounded text-[10px] font-medium ${completadoBadgeStyle(internalStage)}`}
        >
          {t(`admin.kanban.completadoBadge.${internalStage}`)}
        </span>
      )}

      {stage === 'CONFIRMED' && interviewLabel && (
        <div className="mt-1">
          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-cyan-50 text-cyan-700">
            <CalendarClock className="w-3 h-3" />
            {interviewLabel}
          </span>
        </div>
      )}

      <div className="mt-2 flex flex-col gap-1">
        {formattedPhone && (
          <div className="flex items-center gap-1 text-slate-500">
            <Phone className="w-3 h-3" />
            <span className="text-xs">{formattedPhone}</span>
          </div>
        )}
        {workZone && (
          <div className="flex items-center gap-1 text-slate-500">
            <MapPin className="w-3 h-3" />
            <span className="text-xs">{workZone}</span>
          </div>
        )}
        {stage !== 'CONFIRMED' && interviewDate && (
          <span className="text-[10px] text-slate-400">
            {new Date(interviewDate).toLocaleDateString('es-AR')}
            {interviewTime ? ` ${interviewTime}` : ''}
          </span>
        )}
      </div>

      {/* F7.b: REPROGRAM substituído por (interviewResponse='awaiting_reschedule' && meetLink === null) */}
      {interviewResponse === 'awaiting_reschedule' && !meetLink && (
        <div className="mt-2">
          <span data-testid="reprogram-badge" className="inline-block px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-amber-50 text-amber-700">
            {t('admin.kanban.reprogramBadge')}
          </span>
        </div>
      )}

      {rejectionReasonCategory && (
        <div className="mt-2">
          <span data-testid="rejection-badge" className="inline-block px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-red-50 text-red-600">
            {t(`admin.kanban.rejectionLabels.${rejectionReasonCategory}`, rejectionReasonCategory)}
          </span>
        </div>
      )}

      {isBlocked && (
        <div className="mt-2 flex flex-col gap-1" data-testid="blocked-section">
          <span data-testid="blocked-badge" className="inline-block px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-red-100 text-red-700">
            {t('admin.kanban.blockedBadge')}
          </span>
          {blockedReason && (
            <span data-testid="blocked-reason" className="text-[10px] text-slate-500">
              {t(`admin.blockedAttempts.reason.${blockedReason}`, { defaultValue: blockedReason })}
            </span>
          )}
          {missingFields && missingFields.length > 0 && (
            <div data-testid="blocked-missing-fields" className="flex flex-wrap gap-1 mt-0.5">
              {missingFields.map((field) => (
                <span
                  key={field}
                  className="inline-block px-1 py-0.5 rounded text-[9px] font-medium bg-amber-50 text-amber-700"
                >
                  {t(`admin.blockedAttempts.missingField.${field}`, { defaultValue: field })}
                </span>
              ))}
            </div>
          )}
          {attemptCount !== undefined && attemptCount > 0 && (
            <span data-testid="blocked-attempt-count" className="text-[10px] text-slate-400">
              {t('admin.kanban.blockedAttemptCount', { count: attemptCount })}
            </span>
          )}
        </div>
      )}

      {onOpenNotes && (
        <button
          data-testid="notes-button"
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onOpenNotes();
          }}
          className="mt-2 w-full flex items-center gap-1 px-2 py-1 rounded-lg text-[10px] font-medium text-slate-600 hover:bg-slate-100 hover:text-primary transition-colors border border-transparent hover:border-slate-200"
        >
          <MessageSquare className="w-3 h-3" />
          {t('admin.kanban.notesButton')}
          <NotesCountBadge count={contactNotesCount} />
        </button>
      )}

      {onMoveTo && <MoveToMenu currentStage={stage} onMove={onMoveTo} />}

      {onReject && stage !== 'REJECTED' && (
        <button
          data-testid="reject-button"
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onReject();
          }}
          className="mt-2 w-full text-left px-2 py-1 rounded-lg text-[10px] font-medium text-red-500 hover:bg-red-50 hover:text-red-700 transition-colors border border-transparent hover:border-red-100"
        >
          {t('admin.kanban.rejectButton')}
        </button>
      )}

      {isDismissed && onUndismiss && (
        <button
          data-testid="undismiss-button"
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onUndismiss();
          }}
          className="mt-2 w-full text-left px-2 py-1 rounded-lg text-[10px] font-medium text-slate-500 hover:bg-slate-100 hover:text-primary transition-colors border border-transparent hover:border-slate-200"
        >
          {t('admin.kanban.undismissButton')}
        </button>
      )}
    </div>
  );
}
