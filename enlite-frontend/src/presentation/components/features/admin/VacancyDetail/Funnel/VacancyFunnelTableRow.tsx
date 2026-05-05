import { useTranslation } from 'react-i18next';
import { WorkerAvatar } from '@presentation/components/atoms/WorkerAvatar';
import { WhatsappStatusBadge } from '@presentation/components/atoms/WhatsappStatusBadge';
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

  const rowClass = `bg-white h-[60px] border-b border-gray-400${isLast ? ' rounded-bl-[12px] rounded-br-[12px]' : ''}`;

  return (
    <tr className={rowClass}>
      {/* NOME */}
      <td className="px-6">
        <div className="flex items-center gap-2 max-w-[280px]">
          <WorkerAvatar name={row.workerName} avatarUrl={row.workerAvatarUrl} size={32} />
          <div className="flex flex-col min-w-0 flex-1">
            <span
              className="font-lexend font-medium text-base text-gray-800 truncate"
              title={row.workerName ?? undefined}
            >
              {row.workerName ?? '—'}
            </span>
            <span
              className="font-lexend font-normal text-[10px] text-gray-800/50 truncate"
              title={row.workerEmail ?? undefined}
            >
              {row.workerEmail ?? ''}
            </span>
          </div>
        </div>
      </td>

      {/* TELEFONE */}
      <td className="px-6">
        <span className="font-lexend font-medium text-base text-gray-800">
          {row.workerPhone ?? '—'}
        </span>
      </td>

      {/* DATA DO CONVITE */}
      <td className="px-6 whitespace-nowrap">
        <span className="font-lexend font-medium text-base text-gray-800">
          {formattedDate}
        </span>
      </td>

      {/* WHATSAPP */}
      <td className="px-6">
        <WhatsappStatusBadge status={row.whatsappStatus} />
      </td>

      {/* ACEITO */}
      <td className="px-6">
        <span className="font-lexend font-medium text-sm text-gray-800">
          {acceptedLabel}
        </span>
      </td>
    </tr>
  );
}
