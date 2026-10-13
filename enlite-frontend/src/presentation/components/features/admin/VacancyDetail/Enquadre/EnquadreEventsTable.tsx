/**
 * EnquadreEventsTable — a tabela de eventos (spec 052): Data · Hora · Entrevistador · Convocados · Resultado · Estado.
 * Ordem: pendente de encerrar → próximos (mais cedo primeiro) → encerrados (mais recente primeiro) → cancelados no fim.
 * A ordenação usa só a fase que o servidor derivou e o instante de início; nada é recalculado a partir do relógio.
 */
import type { JSX } from 'react';
import { useTranslation } from 'react-i18next';
import { Table, TableBody, TableHead, TableHeader } from '@presentation/components/atoms/Table';
import type { EnquadreEventListItem } from '@domain/entities/EnquadreEvent';
import { EnquadreEventRow } from './EnquadreEventRow';
import { ENQUADRE_PHASE_ORDER } from './enquadreEventPhase';

interface Props {
  events: readonly EnquadreEventListItem[];
  now: Date;
  onSelect: (eventId: string) => void;
}

const COLUMN_KEYS = ['date', 'time', 'host', 'convoked', 'outcome', 'status'] as const;

function byListOrder(a: EnquadreEventListItem, b: EnquadreEventListItem): number {
  const phase = ENQUADRE_PHASE_ORDER[a.phase] - ENQUADRE_PHASE_ORDER[b.phase];
  if (phase !== 0) return phase;
  const diff = new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime();
  return a.phase === 'closed' ? -diff : diff;
}

export function EnquadreEventsTable({ events, now, onSelect }: Props): JSX.Element {
  const { t } = useTranslation();
  const sorted = [...events].sort(byListOrder);
  return (
    <Table data-testid="enquadre-events-table">
      <TableHeader>
        {COLUMN_KEYS.map((key) => (
          <TableHead key={key}>{t(`admin.vacancyDetail.enquadre.columns.${key}`)}</TableHead>
        ))}
      </TableHeader>
      <TableBody>
        {sorted.map((e) => (
          <EnquadreEventRow key={e.id} event={e} now={now} onSelect={onSelect} />
        ))}
      </TableBody>
    </Table>
  );
}
