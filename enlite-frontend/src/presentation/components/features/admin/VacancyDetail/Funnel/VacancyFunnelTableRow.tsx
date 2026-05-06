import { useTranslation } from 'react-i18next';
import { WorkerAvatar } from '@presentation/components/atoms/WorkerAvatar';
import { WhatsappStatusBadge } from '@presentation/components/atoms/WhatsappStatusBadge';
import { Text } from '@presentation/components/atoms/Text';
import {
  TableRow,
  TableCell,
} from '@presentation/components/atoms/Table';
import type { FunnelTableRow } from '@domain/entities/Funnel';

interface VacancyFunnelTableRowProps {
  row: FunnelTableRow;
  isLast: boolean;
}

export function VacancyFunnelTableRow({
  row,
  isLast,
}: VacancyFunnelTableRowProps): JSX.Element {
  const { t } = useTranslation();

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

  return (
    <TableRow className={`bg-white${isLast ? ' rounded-bl-[12px] rounded-br-[12px]' : ''}`}>
      <TableCell unwrapped className="px-6">
        <div className="flex items-center gap-2 max-w-[280px]">
          <WorkerAvatar name={row.workerName} avatarUrl={row.workerAvatarUrl} size={32} />
          <div className="flex flex-col min-w-0 flex-1">
            <Text
              as="span"
              size="sm"
              weight="medium"
              color="secondary"
              title={row.workerName ?? undefined}
              className="truncate"
            >
              {row.workerName ?? '—'}
            </Text>
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
      <TableCell weight="medium" className="px-6">
        {row.workerPhone ?? '—'}
      </TableCell>
      <TableCell weight="medium" className="px-6 whitespace-nowrap">
        {formattedDate}
      </TableCell>
      <TableCell unwrapped className="px-6">
        <WhatsappStatusBadge status={row.whatsappStatus} />
      </TableCell>
      <TableCell weight="medium" className="px-6">
        {acceptedLabel}
      </TableCell>
    </TableRow>
  );
}
