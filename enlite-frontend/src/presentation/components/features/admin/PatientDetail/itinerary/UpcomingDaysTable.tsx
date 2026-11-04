import { useTranslation } from 'react-i18next';
import { ArrowLeftRight, UserRound } from 'lucide-react';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@presentation/components/atoms/Table';
import { PersonAvatar } from '@presentation/components/atoms/PersonAvatar';
import { Text } from '@presentation/components/atoms/Text';
import { ActionButton } from '@presentation/components/features/access';
import { formatCalendarDate } from '@presentation/utils/dateTimeFormat';
import type { PatientItineraryEvent } from '@domain/entities/PatientItinerary';
import { addDaysToDate, weekdayName } from '../substitutionDates';
import { workerLabel } from '../workerLabel';
import { occurrenceKey } from './occurrenceKey';
import { NOWRAP, SingleLine } from './SingleLine';
import { dateLocaleOf, shiftHours, weekdayOfDate } from './weekRange';
import { shiftRangeLabel } from './shiftRange';

interface UpcomingDaysTableProps {
  /** SÓ os turnos da semana selecionada (a janela do GET é a semana; a tabela nunca emenda outra). */
  events: PatientItineraryEvent[];
  /** "Cambiar": abre o fluxo "Nueva sustitución" com a pessoa e o dia do turno (F6 monta o fluxo). */
  onChange: (event: PatientItineraryEvent) => void;
  /** "Asignar"/"Elegir quién entra": o turno "Sin cubrir" (F6 monta o fluxo). */
  onAssign: (event: PatientItineraryEvent) => void;
  /** O motivo da falta do turno (do PEDIDO — o dono do motivo), ou `null`: "Lucía Fernández no viene · Enfermedad". */
  reasonOf?: (event: PatientItineraryEvent) => string | null;
}

const byDateThenStart = (a: PatientItineraryEvent, b: PatientItineraryEvent): number =>
  a.date.localeCompare(b.date) || a.startTime.localeCompare(b.startTime) || a.slotId.localeCompare(b.slotId);

/**
 * Tabela "Próximos días" (spec 069, US2; mockup `b2a.png`): Día · Horario · Quién atiende · Acción,
 * uma linha por turno da semana, todas da mesma altura. "Quién atiende": o titular; o substituto com
 * o selo "Sustitución" e "Cubre a <titular>"; ou "Nadie asignado" em vermelho (FR-12: ausência sem
 * substituto OU faixa sem alocação). A ação é gateada por `patient_itinerary:update` (some sem a célula).
 */
export function UpcomingDaysTable({ events, onChange, onAssign, reasonOf }: UpcomingDaysTableProps): JSX.Element {
  const { t, i18n } = useTranslation();
  const tu = (key: string, opts?: Record<string, unknown>) => t(`admin.patients.detail.itinerary.upcoming.${key}`, opts);
  const locale = dateLocaleOf(i18n.language);
  const rows = [...events].sort(byDateThenStart);

  const personRow = (workerId: string, displayName: string | null, caption: string, badge?: string) => {
    const label = workerLabel(t, workerId, displayName);
    return (
      <div className="flex items-center gap-3 min-w-0">
        <PersonAvatar uid={workerId} name={label} size={32} />
        <div className="flex flex-col min-w-0">
          <div className="flex min-w-0 items-center gap-2">
            <SingleLine weight="semibold" color="primary">
              {label}
            </SingleLine>
            {badge && (
              <span className="shrink-0 whitespace-nowrap rounded-full bg-blue-100 px-2 py-0.5 text-blue-900" {...NOWRAP}>
                <Text as="span" size="xs" weight="medium" color="inherit" className="whitespace-nowrap">
                  {badge}
                </Text>
              </span>
            )}
          </div>
          <SingleLine size="xs" color="tertiary">
            {caption}
          </SingleLine>
        </div>
      </div>
    );
  };

  const attendant = (e: PatientItineraryEvent) => {
    if (e.status === 'covered' && e.workerId) return personRow(e.workerId, e.workerDisplayName, tu('holder'));
    if (e.status === 'substituted' && e.workerId) {
      const holder = e.titularWorkerId ? workerLabel(t, e.titularWorkerId, e.titularDisplayName) : tu('noHolder');
      return personRow(e.workerId, e.workerDisplayName, tu('covers', { holder }), tu('substitutionBadge'));
    }
    const reason = reasonOf?.(e) ?? null;
    const holder = e.titularWorkerId ? workerLabel(t, e.titularWorkerId, e.titularDisplayName) : null;
    const caption = holder === null ? tu('slotWithoutProvider') : reason === null ? tu('holderAbsent', { holder }) : tu('holderAbsentWithReason', { holder, reason });
    return (
      <div className="flex items-center gap-3 min-w-0" data-testid={`itinerario-proximo-sem-cobertura-${occurrenceKey(e)}`}>
        <span aria-hidden="true" className="h-8 w-8 shrink-0 rounded-full border-2 border-dashed border-gray-800" />
        <div className="flex flex-col min-w-0">
          <Text as="span" weight="semibold" color="inherit" className="whitespace-nowrap text-red-800" {...NOWRAP}>
            {tu('nobodyAssigned')}
          </Text>
          <SingleLine size="xs" color="tertiary">
            {caption}
          </SingleLine>
        </div>
      </div>
    );
  };

  if (rows.length === 0) {
    return (
      <Text size="sm" color="tertiary" data-testid="itinerario-proximos-vazio">
        {tu('empty')}
      </Text>
    );
  }

  return (
    <div data-testid="itinerario-proximos-tabela">
      <Table className="min-w-[640px] table-auto">
        <TableHeader>
          <TableHead className="w-px whitespace-nowrap !text-primary">{tu('columns.day')}</TableHead>
          <TableHead className="w-px whitespace-nowrap !text-primary">{tu('columns.schedule')}</TableHead>
          <TableHead className="!text-primary">{tu('columns.attends')}</TableHead>
          <TableHead align="right" className="w-px whitespace-nowrap !text-primary">
            {tu('columns.action')}
          </TableHead>
        </TableHeader>
        <TableBody>
          {rows.map((e) => {
            const key = occurrenceKey(e);
            const { hours, endsNextDay } = shiftHours(e.startTime, e.endTime);
            const nextDate = addDaysToDate(e.date, 1);
            const endsOn = `${weekdayName(weekdayOfDate(nextDate), i18n.language)} ${Number(nextDate.slice(8, 10))}`;
            const uncovered = e.status === 'uncovered';
            return (
              <TableRow key={key} data-testid={`itinerario-proximo-${key}`} className="h-[76px] align-middle">
                <TableCell unwrapped className="whitespace-nowrap">
                  <div className="flex flex-col">
                    <Text as="span" weight="semibold" color="primary" className="whitespace-nowrap capitalize" {...NOWRAP}>
                      {weekdayName(e.weekday, i18n.language)}
                    </Text>
                    <Text as="span" size="xs" color="tertiary" className="whitespace-nowrap" {...NOWRAP}>
                      {formatCalendarDate(e.date, { day: 'numeric', month: 'long' }, locale)}
                    </Text>
                  </div>
                </TableCell>
                <TableCell unwrapped className="whitespace-nowrap">
                  <div className="flex items-center gap-2">
                    <span className="whitespace-nowrap rounded-full bg-primary px-4 py-1.5" data-testid={`itinerario-proximo-horario-${key}`} {...NOWRAP}>
                      <Text as="span" size="sm" weight="semibold" color="white">
                        {shiftRangeLabel(t, e)}
                      </Text>
                    </span>
                    <Text as="span" size="xs" color="tertiary" className="whitespace-nowrap" {...NOWRAP}>
                      {endsNextDay ? tu('hoursEndsOn', { hours, day: endsOn }) : tu('hours', { hours })}
                    </Text>
                  </div>
                </TableCell>
                <TableCell unwrapped className="w-full max-w-0">
                  {attendant(e)}
                </TableCell>
                <TableCell unwrapped align="right" className="whitespace-nowrap">
                  {uncovered ? (
                    <ActionButton
                      resource="patient_itinerary"
                      action="update"
                      size="sm"
                      className="whitespace-nowrap"
                      onClick={() => onAssign(e)}
                      data-testid={`itinerario-proximo-asignar-${key}`}
                      {...NOWRAP}
                    >
                      <span className="inline-flex items-center gap-2 whitespace-nowrap">
                        <UserRound size={16} aria-hidden="true" />
                        {tu('assign')}
                      </span>
                    </ActionButton>
                  ) : (
                    <ActionButton
                      resource="patient_itinerary"
                      action="update"
                      size="sm"
                      variant="outline"
                      className="whitespace-nowrap"
                      onClick={() => onChange(e)}
                      data-testid={`itinerario-proximo-cambiar-${key}`}
                      {...NOWRAP}
                    >
                      <span className="inline-flex items-center gap-2 whitespace-nowrap">
                        <ArrowLeftRight size={16} aria-hidden="true" />
                        {tu('change')}
                      </span>
                    </ActionButton>
                  )}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
