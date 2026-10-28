/** EnquadresTable — cabeçalho + linhas da lista global de enquadres (spec 076). Só apresenta; o estado vive na página. */
import type { JSX } from 'react';
import { useTranslation } from 'react-i18next';
import { Table, TableBody, TableHead, TableHeader } from '@presentation/components/atoms/Table';
import type { EnquadreGlobalListItem } from '@domain/entities/EnquadreEvent';
import { EnquadresListRow } from './EnquadresListRow';

const COLUMNS = ['dateTime', 'host', 'case', 'convoked', 'state', 'import'] as const;

export function EnquadresTable({ items }: { items: readonly EnquadreGlobalListItem[] }): JSX.Element {
  const { t } = useTranslation();
  return (
    <Table>
      <TableHeader>
        {COLUMNS.map((c) => (
          <TableHead key={c}>{t(`admin.enquadres.columns.${c}`)}</TableHead>
        ))}
      </TableHeader>
      <TableBody>
        {items.map((e) => (
          <EnquadresListRow key={e.id} event={e} />
        ))}
      </TableBody>
    </Table>
  );
}
