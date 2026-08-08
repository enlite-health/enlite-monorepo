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
import type { FunnelBucket } from '@domain/entities/Funnel';
import { VacancyFunnelTableRow } from './VacancyFunnelTableRow';
import { ContactNotesModal } from './ContactNotesModal';

interface VacancyFunnelTableProps {
  vacancyId: string;
  rows: FunnelTableRow[];
  isLoading: boolean;
  activeBucket: FunnelBucket;
}

interface ActiveNotesModal {
  workerId: string;
  workerName: string | null;
}

export function VacancyFunnelTable({
  vacancyId,
  rows,
  isLoading,
  activeBucket,
}: VacancyFunnelTableProps): JSX.Element {
  const { t } = useTranslation();
  const [activeNotes, setActiveNotes] = useState<ActiveNotesModal | null>(null);

  const headers = [
    t('admin.vacancyDetail.funnelTable.headers.notes'),
    t('admin.vacancyDetail.funnelTable.headers.name'),
    // "Origen": distingue quem levantou a mão de quem foi convidado numa lista fria.
    // Vive aqui além do Kanban porque a vista LISTA é o default do funil — deixar
    // só no card escondia o sinal de quem nunca troca de vista.
    t('admin.vacancyDetail.funnelTable.headers.origin'),
    t('admin.vacancyDetail.funnelTable.headers.phone'),
    t('admin.vacancyDetail.funnelTable.headers.inviteDate'),
    t('admin.vacancyDetail.funnelTable.headers.whatsapp'),
    t('admin.vacancyDetail.funnelTable.headers.accepted'),
    t('admin.vacancyDetail.funnelTable.headers.registration'),
  ];

  function handleOpenNotes(workerId: string) {
    const row = rows.find((r) => r.workerId === workerId);
    setActiveNotes({ workerId, workerName: row?.workerName ?? null });
  }

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
    <>
      <Table
        role="table"
        aria-label={`${t('admin.vacancyDetail.funnelTabs.' + activeBucket.toLowerCase().replace('_', ''))} funnel`}
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
          {rows.map((row, index) => (
            <VacancyFunnelTableRow
              key={row.id}
              row={row}
              isLast={index === rows.length - 1}
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
