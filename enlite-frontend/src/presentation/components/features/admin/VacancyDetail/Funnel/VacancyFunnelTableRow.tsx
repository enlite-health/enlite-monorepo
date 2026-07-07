import { useTranslation } from 'react-i18next';
import { MessageSquare } from 'lucide-react';
import { useNavigate, useLocation } from 'react-router-dom';
import { WorkerAvatar } from '@presentation/components/atoms/WorkerAvatar';
import { WhatsappStatusBadge } from '@presentation/components/atoms/WhatsappStatusBadge';
import { Text } from '@presentation/components/atoms/Text';
import { NotesCountBadge } from './NotesCountBadge';
import {
  TableRow,
  TableCell,
} from '@presentation/components/atoms/Table';
import type { FunnelTableRow } from '@domain/entities/Funnel';

interface VacancyFunnelTableRowProps {
  row: FunnelTableRow;
  isLast: boolean;
  /** Abre o modal de comentários da VAGA — thread única, igual em toda linha. */
  onOpenNotes: () => void;
}

export function VacancyFunnelTableRow({
  row,
  isLast,
  onOpenNotes,
}: VacancyFunnelTableRowProps): JSX.Element {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();

  const handleWorkerClick = (): void => {
    if (!row.workerId) return;
    navigate(`/admin/workers/${row.workerId}`, {
      state: { from: `${location.pathname}${location.search}` },
    });
  };

  const formattedDate = row.invitedAt
    ? new Intl.DateTimeFormat('es-AR', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
      }).format(new Date(row.invitedAt))
    : '—';

  const acceptedLabel =
    row.accepted === true
      ? t('admin.vacancyDetail.funnelTable.acceptedYes')
      : row.accepted === false
        ? t('admin.vacancyDetail.funnelTable.acceptedNo')
        : '—';

  function handleNotesClick(e: React.MouseEvent) {
    e.stopPropagation();
    onOpenNotes();
  }

  return (
    <TableRow className={`bg-white${isLast ? ' rounded-bl-[12px] rounded-br-[12px]' : ''}`}>
      {/* Contact notes */}
      <TableCell unwrapped className="pl-6 pr-2">
        <button
          type="button"
          onClick={handleNotesClick}
          aria-label={t('admin.vacancyDetail.funnelTable.headers.notes')}
          data-testid="funnel-notes-button"
          className="inline-flex items-center gap-1.5 text-gray-800 hover:text-primary transition-colors"
        >
          <MessageSquare size={16} aria-hidden="true" />
          <NotesCountBadge count={row.contactNotesCount} />
        </button>
      </TableCell>

      {/* Name + email */}
      <TableCell unwrapped className="pl-2 pr-6">
        <div className="flex items-center gap-2 max-w-[280px]">
          <WorkerAvatar name={row.workerName} avatarUrl={row.workerAvatarUrl} size={32} />
          <div className="flex flex-col min-w-0 flex-1">
            <button
              type="button"
              onClick={handleWorkerClick}
              disabled={!row.workerId}
              data-testid="funnel-worker-link"
              title={row.workerName ?? undefined}
              className="min-w-0 text-left truncate rounded-sm hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:cursor-default disabled:no-underline"
            >
              <Text
                as="span"
                size="sm"
                weight="medium"
                color="secondary"
                className="truncate"
              >
                {row.workerName ?? '—'}
              </Text>
            </button>
            <Text
              as="span"
              size="xs"
              color="muted"
              title={row.workerEmail ?? undefined}
              className="truncate"
            >
              {row.workerEmail ?? ''}
            </Text>
          </div>
        </div>
      </TableCell>

      {/* Phone */}
      <TableCell weight="medium" className="px-6">
        {row.workerPhone ?? '—'}
      </TableCell>

      {/* Invite date */}
      <TableCell weight="medium" className="px-6 whitespace-nowrap">
        {formattedDate}
      </TableCell>

      {/* WhatsApp status */}
      <TableCell unwrapped className="px-6">
        <WhatsappStatusBadge status={row.whatsappStatus} />
      </TableCell>

      {/* Accepted */}
      <TableCell weight="medium" className="px-6">
        {acceptedLabel}
      </TableCell>

      {/* Registration badge */}
      <TableCell unwrapped className="px-6">
        {row.registrationComplete ? (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-green-100 text-green-700">
            <Text as="span" size="xs" weight="medium" color="inherit">
              {t('admin.vacancyDetail.funnelTable.registration.complete')}
            </Text>
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-red-100 text-red-700">
            <Text as="span" size="xs" weight="medium" color="inherit">
              {t('admin.vacancyDetail.funnelTable.registration.incomplete')}
            </Text>
          </span>
        )}
      </TableCell>
    </TableRow>
  );
}
