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
import type { AdmissionAppointment, ResendKind } from '@infrastructure/http/AdminAdmissionApiService';
import { AdmissionSeals, SealChip } from './AdmissionSeals';
import type { SealTone } from './sealTones';
import { formatSlotIn, formatTimeIn, isFuture } from './admissionTime';

const STATUS_TONE: Record<string, SealTone> = {
  booked: 'neutral',
  completed: 'ok',
  cancelled: 'neutral',
  no_show: 'warn',
};

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
      <AdmissionSeals appointment={a} canResendCell={canResendCell} onOpenDocuments={onOpenDocuments} onResend={onResend} canRetryCell={canRetryCell} onRetrySummary={onRetrySummary} />
    </div>
  );
}
