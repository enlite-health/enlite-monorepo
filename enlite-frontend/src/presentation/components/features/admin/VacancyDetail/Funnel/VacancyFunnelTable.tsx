import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Text } from '@presentation/components/atoms/Text';
import {
  Table,
  TableHeader,
  TableBody,
  TableHead,
} from '@presentation/components/atoms/Table';
import type { FunnelTableRow } from '@domain/entities/Funnel';
import { compareByDistanceKm } from '@domain/value-objects/candidateDistance';
import { VacancyFunnelTableRow } from './VacancyFunnelTableRow';
import { ContactNotesModal } from './ContactNotesModal';

interface VacancyFunnelTableProps {
  vacancyId: string;
  rows: FunnelTableRow[];
  isLoading: boolean;
  /** true quando há busca/registro aplicados: o vazio vira "nenhum resultado", não "a vaga não tem prestadores". */
  isFiltered?: boolean;
}

interface ActiveNotesModal {
  workerId: string;
  workerName: string | null;
}

export function VacancyFunnelTable({
  vacancyId,
  rows,
  isLoading,
  isFiltered = false,
}: VacancyFunnelTableProps): JSX.Element {
  const { t } = useTranslation();
  const [activeNotes, setActiveNotes] = useState<ActiveNotesModal | null>(null);

  const headers = [
    t('admin.vacancyDetail.funnelTable.headers.notes'),
    t('admin.vacancyDetail.funnelTable.headers.name'),
    t('admin.vacancyDetail.funnelTable.headers.registration'),
    t('admin.vacancyDetail.funnelTable.headers.stage'),
    t('admin.vacancyDetail.funnelTable.headers.phone'),
    t('admin.vacancyDetail.funnelTable.headers.inviteDate'),
    t('admin.vacancyDetail.funnelTable.headers.whatsapp'),
  ];

  function handleOpenNotes(workerId: string) {
    const row = rows.find((r) => r.workerId === workerId);
    setActiveNotes({ workerId, workerName: row?.workerName ?? null });
  }

  // Modo lista ordena por km crescente (DX-3.11) — mesmo comparador do Kanban e do match.
  // `handleOpenNotes` acima continua procurando em `rows`, não em `orderedRows`.
  const orderedRows = [...rows].sort(compareByDistanceKm);

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
        data-testid={isFiltered ? 'funnel-empty-filtered' : undefined}
        className="py-12 flex flex-col items-center gap-2"
      >
        <Text size="sm" color="secondary">
          {isFiltered
            ? t('admin.vacancyDetail.funnelTable.emptyFiltered')
            : t('admin.vacancyDetail.funnelTable.emptyState')}
        </Text>
      </div>
    );
  }

  return (
    <>
      <Table
        role="table"
        aria-label={t('admin.vacancyDetail.funnelTable.ariaLabel')}
        className="border-collapse"
      >
        <TableHeader>
          {headers.map((header, i) => (
            <TableHead
              key={header}
              className={`${i === 0 ? 'pl-6 pr-2' : i === 1 ? 'pl-2 pr-6' : 'px-6'} whitespace-nowrap`}
            >
              {header}
            </TableHead>
          ))}
        </TableHeader>
        <TableBody>
          {orderedRows.map((row, index) => (
            <VacancyFunnelTableRow
              key={row.id}
              row={row}
              isLast={index === orderedRows.length - 1}
              onOpenNotes={handleOpenNotes}
            />
          ))}
        </TableBody>
      </Table>

      {activeNotes && (
        <ContactNotesModal
          vacancyId={vacancyId}
          workerId={activeNotes.workerId}
          workerName={activeNotes.workerName}
          onClose={() => setActiveNotes(null)}
        />
      )}
    </>
  );
}
