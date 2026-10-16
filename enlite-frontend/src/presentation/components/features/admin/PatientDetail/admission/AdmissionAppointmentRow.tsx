/**
 * AdmissionAppointmentRow — uma reunião de admissão na lista (spec 049 §4.5): data, hora (no fuso do país do
 * paciente), responsável, link do Meet SÓ se futura, estado, os quatro selos e o "Cancelar".
 *
 * O link do Meet é decidido duas vezes de propósito: o servidor já devolve `meetLink: null` para reunião encerrada,
 * e a tela também confere o relógio (`isFuture`) e o estado `booked` — um link nunca aparece para reunião passada,
 * mesmo que a resposta chegue velha.
 */
import type { JSX } from 'react';
import { useTranslation } from 'react-i18next';
import { Video, CalendarX } from 'lucide-react';
import { Text } from '@presentation/components/atoms/Text';
import type { AdmissionAppointment, AdmissionCallProgressState, ResendKind } from '@infrastructure/http/AdminAdmissionApiService';
import { AdmissionSeals, SealChip } from './AdmissionSeals';
import type { SealTone } from './sealTones';
import { formatSlotIn, formatTimeIn, isFuture } from './admissionTime';

const STATUS_TONE: Record<string, SealTone> = {
  booked: 'neutral',
  completed: 'ok',
  cancelled: 'neutral',
  no_show: 'warn',
};

/** Estado do andamento (decidido no servidor) → chave do texto. `none` não tem linha. A reabertura NÃO promete botão de refazer. */
const PROGRESS_KEY: Partial<Record<AdmissionCallProgressState, string>> = {
  in_progress: 'callInProgress',
  ended: 'callEnded',
  summary_preparing: 'summaryPreparing',
  summary_ready: 'summaryReady',
  reopened_after_summary: 'reopenedAfterSummary',
};
/** Estados cujo texto termina numa hora (a hora "sabida" do R-48 nunca aparece). */
const PROGRESS_WITH_TIME: ReadonlySet<AdmissionCallProgressState> = new Set(['in_progress', 'ended', 'summary_ready']);

interface Props {
  appointment: AdmissionAppointment;
  timeZone: string;
  canResendCell: boolean;
  canCancel: boolean;
  canRetryCell?: boolean;
  now: Date;
  onOpenDocuments?: () => void;
  onResend: (kind: ResendKind) => void;
  onCancel: () => void;
  onRetrySummary?: () => void;
}

export function AdmissionAppointmentRow({ appointment: a, timeZone, canResendCell, canCancel, canRetryCell, now, onOpenDocuments, onResend, onCancel, onRetrySummary }: Props): JSX.Element {
  const { t, i18n } = useTranslation();
  const ta = (key: string): string => t(`admin.patients.detail.admissionTab.${key}`);
  const upcoming = a.status === 'booked' && isFuture(a.slotEnd, now);
  const showMeet = upcoming && Boolean(a.meetLink);
  const progressKey = a.callProgress ? PROGRESS_KEY[a.callProgress.state] : undefined; // estado desconhecido/vazio → sem linha
  const progress = a.callProgress && progressKey ? a.callProgress : null;

  return (
    <div
      data-testid={`admission-row-${a.id}`}
      data-status={a.status}
      className="flex flex-col gap-3 px-4 py-3 rounded-lg border border-gray-600 bg-white"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 min-w-0">
          <Text color="inherit" as="span" size="sm" weight="semibold" className="text-gray-900" data-testid={`admission-when-${a.id}`}>
            {formatSlotIn(a.slotStart, timeZone, i18n.language)}
            <span className="font-normal text-slate-600"> – {formatTimeIn(a.slotEnd, timeZone)}</span>
          </Text>
          <Text color="inherit" as="span" size="xs" className="text-slate-600 truncate" data-clarity-mask="True" data-testid={`admission-host-${a.id}`}>
            {ta('row.host')}: {a.hostEmail}
          </Text>
          {a.createdVia === 'site' && (
            <Text color="inherit" as="span" size="xs" className="text-slate-600" data-testid={`admission-via-site-${a.id}`}>{ta('row.viaSite')}</Text>
          )}
          {a.admissionCode && (
            <Text color="inherit" as="span" size="xs" className="text-slate-600" data-testid={`admission-code-${a.id}`}>{a.admissionCode}</Text>
          )}
          {a.conferenceStartedAt && (
            <Text color="inherit" as="span" size="xs" className="text-slate-600" data-testid={`admission-conference-start-${a.id}`}>
              {ta('row.conferenceStart')} {formatTimeIn(a.conferenceStartedAt, timeZone)}
            </Text>
          )}
          {a.conferenceEndedAt && (
            <Text color="inherit" as="span" size="xs" className="text-slate-600" data-testid={`admission-conference-end-${a.id}`}>
              {ta('row.conferenceEnd')} {formatTimeIn(a.conferenceEndedAt, timeZone)}
            </Text>
          )}
        </div>
        <div className="flex items-center gap-3 shrink-0">
          {showMeet && (
            <a
              href={a.meetLink ?? undefined}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-primary underline"
              data-testid={`admission-meet-${a.id}`}
            >
              <Video size={14} aria-hidden="true" />
              <Text as="span" size="xs" weight="medium" color="inherit">{ta('row.meet')}</Text>
            </a>
          )}
          <SealChip tone={STATUS_TONE[a.status] ?? 'neutral'} testId={`admission-status-${a.id}`}>
            {ta(`status.${a.status}`)}
          </SealChip>
          {a.status === 'cancelled' && a.calendarEventPending && (
            <SealChip tone="warn" testId={`admission-calendar-pending-${a.id}`}>
              {ta('row.calendarEventPending')}
            </SealChip>
          )}
          {canCancel && upcoming && (
            <button
              type="button"
              onClick={onCancel}
              className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-red-800 underline hover:bg-gray-200 transition-colors"
              data-testid={`admission-cancel-${a.id}`}
            >
              <CalendarX size={14} aria-hidden="true" />
              <Text as="span" size="xs" weight="medium" color="inherit">{ta('row.cancel')}</Text>
            </button>
          )}
        </div>
      </div>
      {progress && (
        <Text color="inherit" as="span" size="xs" className="text-slate-600" data-testid={`admission-call-progress-${a.id}`} data-state={progress.state}>
          {ta(`row.${progressKey}`)}
          {PROGRESS_WITH_TIME.has(progress.state) && progress.at ? ` ${formatTimeIn(progress.at, timeZone)}` : ''}
        </Text>
      )}
      <AdmissionSeals appointment={a} canResendCell={canResendCell} onOpenDocuments={onOpenDocuments} onResend={onResend} canRetryCell={canRetryCell} onRetrySummary={onRetrySummary} />
    </div>
  );
}
