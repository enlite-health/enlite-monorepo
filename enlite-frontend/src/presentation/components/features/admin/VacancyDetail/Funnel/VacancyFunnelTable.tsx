import { useTranslation } from 'react-i18next';
import { Text } from '@presentation/components/atoms/Text';
import {
  Table,
  TableHeader,
  TableBody,
  TableHead,
} from '@presentation/components/atoms/Table';
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
      <div role="status" className="py-12 flex flex-col items-center gap-2">
        <Text size="sm" color="secondary">
          {t('admin.vacancyDetail.funnelTable.emptyState')}
        </Text>
      </div>
    );
  }

  return (
    <Table
      role="table"
      aria-label={`${t('admin.vacancyDetail.funnelTabs.' + activeBucket.toLowerCase().replace('_', ''))} funnel`}
      className="border-collapse"
    >
      <TableHeader>
        {headers.map((header) => (
          <TableHead key={header} className="px-6 whitespace-nowrap">
            {header}
          </TableHead>
        ))}
      </TableHeader>
      <TableBody>
        {rows.map((row, index) => (
          <VacancyFunnelTableRow
            key={row.id}
            row={row}
            isLast={index === rows.length - 1}
          />
        ))}
      </TableBody>
    </Table>
  );
}
