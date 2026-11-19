/** EnquadresTable — cabeçalho + linhas da lista global de enquadres (spec 076). Só apresenta; o estado vive na página. */
import type { JSX } from 'react';
import { useTranslation } from 'react-i18next';
import { Table, TableBody, TableHead, TableHeader } from '@presentation/components/atoms/Table';
import type { EnquadreGlobalListItem } from '@domain/entities/EnquadreEvent';
import { EnquadresListRow } from './EnquadresListRow';
import { ENQUADRES_CELL_PAD, ENQUADRES_HOST_COLUMN, ENQUADRES_NUMERIC_COLUMN } from './enquadresNumericColumn';

const NUMERIC_KEYS: ReadonlySet<string> = new Set([
  'admin.enquadres.columns.convoked',
  'admin.kanban.columns.SELECTED',
  'admin.kanban.columns.QUICK_RESPONSE_TEAM',
  'admin.kanban.columns.REJECTED',
]);

/** Rótulo de cada coluna: as de desfecho reaproveitam `admin.kanban.columns.*` (as MESMAS palavras do Kanban do evento). */
const COLUMNS = [
  'admin.enquadres.columns.dateTime',
  'admin.enquadres.columns.host',
  'admin.enquadres.columns.case',
  'admin.enquadres.columns.convoked',
  'admin.kanban.columns.SELECTED',
  'admin.kanban.columns.QUICK_RESPONSE_TEAM',
  'admin.kanban.columns.REJECTED',
  'admin.enquadres.columns.state',
  'admin.enquadres.columns.import',
] as const;

export function EnquadresTable({ items }: { items: readonly EnquadreGlobalListItem[] }): JSX.Element {
  const { t } = useTranslation();
  return (
    <Table>
      <TableHeader>
        {COLUMNS.map((key) =>
          NUMERIC_KEYS.has(key) ? (
            <TableHead key={key} align="center" className={`${ENQUADRES_NUMERIC_COLUMN} ${ENQUADRES_CELL_PAD} whitespace-normal break-words`}>{t(key)}</TableHead>
          ) : (
            <TableHead key={key} className={`${ENQUADRES_CELL_PAD} whitespace-nowrap ${key === 'admin.enquadres.columns.host' ? ENQUADRES_HOST_COLUMN : ''}`}>{t(key)}</TableHead>
          ),
        )}
      </TableHeader>
      <TableBody>
        {items.map((e) => (
          <EnquadresListRow key={e.id} event={e} />
        ))}
      </TableBody>
    </Table>
  );
}
