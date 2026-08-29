import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Eye } from 'lucide-react';
import { Text } from '@presentation/components/atoms/Text';
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from '@presentation/components/atoms/Table';
import { getPlatformLabel } from '@presentation/pages/admin/workersData';
import { DocsStatusBadge } from '@presentation/components/atoms/DocsStatusBadge';

export interface WorkerRow {
  id: string;
  name: string;
  email: string;
  casesCount: number;
  documentsComplete: boolean;
  documentsStatus: string;
  platform: string;
  createdAt: string;
}

interface WorkersTableProps {
  /** REQ-09: célula de ação por linha (ex.: convite à reunión de presentación). Ausente = sem coluna. */
  renderAction?: (row: WorkerRow) => ReactNode;
  workers: WorkerRow[];
  onRowClick?: (id: string) => void;
}

const COLUMNS = [
  { key: 'name', hiddenClass: '' },
  { key: 'cases', hiddenClass: '' },
  { key: 'documents', hiddenClass: '' },
  { key: 'registeredAt', hiddenClass: 'hidden md:table-cell' },
  { key: 'platform', hiddenClass: 'hidden md:table-cell' },
] as const;

function formatDate(iso: string, locale: string): string {
  if (!iso) return '—';
  const dateLocale = locale === 'es' ? 'es-AR' : 'pt-BR';
  return new Date(iso).toLocaleDateString(dateLocale, {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  });
}

export function WorkersTable({ workers, onRowClick, renderAction }: WorkersTableProps): JSX.Element {
  const { t, i18n } = useTranslation();
  const safeWorkers = workers ?? [];

  return (
    <div className="w-full rounded-xl overflow-hidden border border-gray-400">
      <Table className="min-w-[500px]">
        <TableHeader>
          <TableHead className="w-10" />
          {COLUMNS.map(({ key, hiddenClass }) => (
            <TableHead key={key} className={`whitespace-nowrap ${hiddenClass}`}>
              {t(`admin.workers.table.${key}`)}
            </TableHead>
          ))}
          {renderAction && <TableHead className="whitespace-nowrap">{t('admin.workers.table.actions')}</TableHead>}
        </TableHeader>
        <TableBody>
          {safeWorkers.length === 0 ? (
            <TableRow>
              <TableCell unwrapped colSpan={COLUMNS.length + (renderAction ? 2 : 1)} className="h-[200px] bg-white text-center">
                <Text as="span" size="sm" color="secondary">
                  {t('admin.workers.noWorkers')}
                </Text>
              </TableCell>
            </TableRow>
          ) : (
            safeWorkers.map((row) => (
              <TableRow
                key={row.id}
                onClick={onRowClick ? () => onRowClick(row.id) : undefined}
                className="bg-white h-[72px]"
              >
                <TableCell unwrapped className="w-10">
                  <Eye className="w-5 h-5 text-gray-800" aria-label={t('admin.workers.table.view')} />
                </TableCell>
                <TableCell unwrapped>
                  <div className="flex flex-col">
                    <Text as="span" size="sm" weight="medium" color="secondary">
                      {row.name}
                    </Text>
                    <Text as="span" size="xs" color="muted">
                      {row.email}
                    </Text>
                  </div>
                </TableCell>
                <TableCell weight="medium" className="whitespace-nowrap">
                  {row.casesCount}
                </TableCell>
                <TableCell unwrapped className="whitespace-nowrap">
                  <DocsStatusBadge complete={row.documentsComplete} status={row.documentsStatus} />
                </TableCell>
                <TableCell weight="medium" className="whitespace-nowrap hidden md:table-cell">
                  {formatDate(row.createdAt, i18n.language)}
                </TableCell>
                <TableCell weight="medium" className="whitespace-nowrap hidden md:table-cell">
                  {getPlatformLabel(t, row.platform)}
                </TableCell>
                {renderAction && (
                  <TableCell unwrapped className="whitespace-nowrap min-w-[190px]" onClick={(e) => e.stopPropagation()}>
                    {renderAction(row)}
                  </TableCell>
                )}
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </div>
  );
}
