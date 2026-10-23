import { useTranslation } from 'react-i18next';
import { Text } from '@presentation/components/atoms/Text';
import type { SubstitutionRequestItem } from '@domain/entities/SubstitutionRequest';
import { workerLabel } from '../workerLabel';
import { NOWRAP, SingleLine } from './SingleLine';
import { fullDayLabel } from './substitutionLabels';

interface SubstitutionDaysListProps {
  request: SubstitutionRequestItem;
}

const hhmm = (value: string): string => value.slice(0, 5);

/** "Ver días": os turnos do pedido, um por linha, com quem entra em cada um (ou "Nadie todavía") — o `shiftDisplayNames` já vem do servidor, na ordem de `shifts`. */
export function SubstitutionDaysList({ request }: SubstitutionDaysListProps): JSX.Element {
  const { t, i18n } = useTranslation();
  const td = (key: string) => t(`admin.patients.detail.itinerary.substitutions.${key}`);
  return (
    <ul className="flex flex-col gap-1.5 rounded-xl bg-[#FBF7FF] px-4 py-3" aria-label={td('daysListLabel')} data-testid={`sustituciones-dias-${request.requestId ?? 'legacy'}`}>
      {request.shifts.map((shift, index) => {
        const name = shift.workerId === null ? null : workerLabel(t, shift.workerId, request.shiftDisplayNames[index] ?? null);
        return (
          <li key={`${shift.date}|${shift.assignmentId ?? index}`} className="flex items-center gap-x-3" data-testid="sustituciones-dia">
            <Text as="span" size="sm" weight="semibold" color="primary" className="whitespace-nowrap" {...NOWRAP}>
              {fullDayLabel(shift.date, i18n.language)}
            </Text>
            {shift.startTime !== null && shift.endTime !== null && (
              <Text as="span" size="sm" color="tertiary" className="whitespace-nowrap" {...NOWRAP}>
                {`${hhmm(shift.startTime)}–${hhmm(shift.endTime)}`}
              </Text>
            )}
            {name === null ? (
              <Text as="span" size="sm" weight="semibold" color="inherit" className="whitespace-nowrap text-red-900" {...NOWRAP}>
                {td('nobodyYet')}
              </Text>
            ) : (
              <SingleLine size="sm" color="primary">
                {name}
              </SingleLine>
            )}
          </li>
        );
      })}
    </ul>
  );
}
