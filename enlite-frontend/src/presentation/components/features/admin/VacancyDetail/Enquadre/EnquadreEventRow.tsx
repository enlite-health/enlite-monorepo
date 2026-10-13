/**
 * EnquadreEventRow — uma linha da tabela de eventos (spec 052): data, hora, entrevistador, convocados, resultado e a
 * fase. A fase vem derivada do servidor; a tela só traduz. O link do Meet é decidido duas vezes (molde de
 * AdmissionAppointmentRow): o servidor manda `null` quando não cabe, e a tela confere a fase aberta e o relógio.
 */
import type { JSX, KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Video } from 'lucide-react';
import { Text } from '@presentation/components/atoms/Text';
import { TableCell, TableRow } from '@presentation/components/atoms/Table';
import type { EnquadreEventListItem, EnquadreOutcomeCounts } from '@domain/entities/EnquadreEvent';
import { SealChip } from '../../PatientDetail/admission/AdmissionSeals';
import { isFuture, wallClockIn } from '../../PatientDetail/admission/admissionTime';
import { ENQUADRE_PHASE_KEY, ENQUADRE_PHASE_OPEN, ENQUADRE_PHASE_TONE } from './enquadreEventPhase';

interface Props {
  event: EnquadreEventListItem;
  timeZone: string;
  now: Date;
  onSelect: (eventId: string) => void;
}

const OUTCOME_KEYS: ReadonlyArray<readonly [keyof EnquadreOutcomeCounts, string]> = [
  ['selected', 'outcome.selected'],
  ['quickResponse', 'outcome.quickResponse'],
  ['rejected', 'outcome.rejected'],
  ['returned', 'outcome.returned'],
];

/** "2026-10-16T14:00" → ["16/10", "14:00"] (relógio de parede do fuso, sem depender do navegador). */
function dateAndTime(iso: string, timeZone: string): [string, string] {
  const wall = wallClockIn(iso, timeZone);
  if (!wall) return [iso, ''];
  const [date, time] = wall.split('T');
  const [, month, day] = date.split('-');
  return [`${day}/${month}`, time];
}

export function EnquadreEventRow({ event: e, timeZone, now, onSelect }: Props): JSX.Element {
  const { t } = useTranslation();
  const te = (key: string, opts?: Record<string, unknown>): string => t(`admin.vacancyDetail.enquadre.${key}`, opts);
  const [date, time] = dateAndTime(e.startsAt, timeZone);
  const showMeet = ENQUADRE_PHASE_OPEN[e.phase] && isFuture(e.endsAt, now) && Boolean(e.meetLink);
  const outcomeParts = e.phase === 'closed'
    ? OUTCOME_KEYS.filter(([field]) => e.outcome[field] > 0).map(([field, key]) => te(key, { count: e.outcome[field] }))
    : [];

  const onKeyDown = (ev: KeyboardEvent<HTMLTableRowElement>): void => {
    if (ev.key === 'Enter' && ev.target === ev.currentTarget) onSelect(e.id);
  };

  return (
    <TableRow
      data-testid={`enquadre-event-row-${e.id}`}
      data-phase={e.phase}
      tabIndex={0}
      onClick={() => onSelect(e.id)}
      onKeyDown={onKeyDown}
      className={e.phase === 'pending_close' ? 'bg-amber-50' : undefined}
    >
      <TableCell data-testid={`enquadre-event-date-${e.id}`}>{date}</TableCell>
      <TableCell data-testid={`enquadre-event-time-${e.id}`}>{time}</TableCell>
      <TableCell data-testid={`enquadre-event-host-${e.id}`} data-clarity-mask="True">{e.hostName}</TableCell>
      <TableCell data-testid={`enquadre-event-convoked-${e.id}`}>{e.convokedCount}</TableCell>
      <TableCell data-testid={`enquadre-event-outcome-${e.id}`}>
        {outcomeParts.length > 0 ? outcomeParts.join(' · ') : te('outcome.none')}
      </TableCell>
      <TableCell unwrapped>
        <div className="flex flex-wrap items-center gap-3">
          <SealChip tone={ENQUADRE_PHASE_TONE[e.phase]} testId={`enquadre-event-phase-${e.id}`}>
            {te(ENQUADRE_PHASE_KEY[e.phase])}
          </SealChip>
          {showMeet && (
            <a
              href={e.meetLink ?? undefined}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(ev) => ev.stopPropagation()}
              className="inline-flex items-center gap-1 text-primary underline"
              data-testid={`enquadre-event-meet-${e.id}`}
            >
              <Video size={14} aria-hidden="true" />
              <Text as="span" size="xs" weight="medium" color="inherit">{te('row.meet')}</Text>
            </a>
          )}
        </div>
      </TableCell>
    </TableRow>
  );
}
