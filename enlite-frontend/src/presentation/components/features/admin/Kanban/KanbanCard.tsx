import { useTranslation } from 'react-i18next';
import { Text } from '@presentation/components/atoms/Text';
import { CalendarClock, MapPin, Phone, Star } from 'lucide-react';
import { formatPhoneDisplay } from '@presentation/utils/recruitmentHelpers';

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
  funnelStage: string | null;
  acquisitionChannel?: string | null;
  internalStage?: string | null;
  onWorkerClick?: (workerId: string) => void;
  onReject?: () => void;
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
  funnelStage,
  acquisitionChannel,
  internalStage,
  onWorkerClick,
  onReject,
}: KanbanCardProps) {
  const { t } = useTranslation();
  const talentumStyle = talentumStatus ? TALENTUM_STATUS_STYLE[talentumStatus] : null;
  const formattedPhone = formatPhoneDisplay(workerPhone);

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
              {workerName ?? t('admin.kanban.noName')}
            </Text>
          </button>
        ) : (
          <Text as="span" size="sm" weight="semibold" className="text-[#180149] truncate">
            {workerName ?? t('admin.kanban.noName')}
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

      {funnelStage === 'REPROGRAM' && (
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
    </div>
  );
}
