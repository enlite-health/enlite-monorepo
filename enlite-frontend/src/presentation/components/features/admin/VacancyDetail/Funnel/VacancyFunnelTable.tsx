import { useTranslation } from 'react-i18next';
import { Typography } from '@presentation/components/atoms/Typography';
import type { FunnelTableRow } from '@domain/entities/Funnel';
import type { FunnelBucket } from '@domain/entities/Funnel';
import { VacancyFunnelTableRow } from './VacancyFunnelTableRow';

interface VacancyFunnelTableProps {
  rows: FunnelTableRow[];
  isLoading: boolean;
  activeBucket: FunnelBucket;
}

export function VacancyFunnelTable({
  rows,
  isLoading,
  activeBucket,
}: VacancyFunnelTableProps): JSX.Element {
  const { t } = useTranslation();

  const headers = [
    t('admin.vacancyDetail.funnelTable.headers.name'),
    t('admin.vacancyDetail.funnelTable.headers.phone'),
    t('admin.vacancyDetail.funnelTable.headers.inviteDate'),
    t('admin.vacancyDetail.funnelTable.headers.whatsapp'),
    t('admin.vacancyDetail.funnelTable.headers.accepted'),
  ];

  if (isLoading && rows.length === 0) {
    return (
      <div className="py-12 flex flex-col items-center gap-2">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <div
        role="status"
        className="py-12 flex flex-col items-center gap-2"
      >
        <Typography variant="body" className="text-gray-800">
          {t('admin.vacancyDetail.funnelTable.emptyState')}
        </Typography>
      </div>
    );
  }

  return (
    <div className="overflow-x-auto rounded-tl-[12px] rounded-tr-[12px]">
      <table
        role="table"
        aria-label={`${t('admin.vacancyDetail.funnelTabs.' + activeBucket.toLowerCase().replace('_', ''))} funnel`}
        className="w-full border-collapse"
      >
        <thead>
          <tr
            className="bg-gray-300 h-[52px] rounded-tl-[12px] rounded-tr-[12px]"
          >
            {headers.map((header) => (
              <th
                key={header}
                scope="col"
                className="text-left px-6 whitespace-nowrap font-lexend font-medium text-base text-gray-800 first:rounded-tl-[12px] last:rounded-tr-[12px]"
              >
                {header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <VacancyFunnelTableRow
              key={row.id}
              row={row}
              isLast={index === rows.length - 1}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}
