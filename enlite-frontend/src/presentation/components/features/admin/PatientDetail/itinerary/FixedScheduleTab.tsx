import { useTranslation } from 'react-i18next';
import { ArrowLeftRight } from 'lucide-react';
import { PersonAvatar } from '@presentation/components/atoms/PersonAvatar';
import { Text } from '@presentation/components/atoms/Text';
import { useActionGate } from '@presentation/hooks/useCellAccess';
import { isVigenteAt, type ItineraryOverlapSide, type PatientItinerarySlot, type PatientItineraryService } from '@domain/entities/PatientItinerary';
import type { ItineraryActionError } from '@hooks/admin/usePatientItinerary';
import { weekdayName } from '../substitutionDates';
import { workerLabel } from '../workerLabel';
import { NOWRAP, SingleLine } from './SingleLine';
import { shiftHours } from './weekRange';

interface FixedScheduleTabProps {
  service: PatientItineraryService;
  asOf: string;
  actionError: ItineraryActionError | null;
  onEditSlot: (slotId: string) => void;
}

/** Domingo → sábado: a ordem do nó da agenda (e do mockup `B2b`). */
const WEEKDAYS = [0, 1, 2, 3, 4, 5, 6];

/**
 * "Horario fijo" (spec 069, US2; pt-BR "Horário fixo"; mockup B2b): só as linhas dos dias COM atenção — dia · chip do horário · "8 h" ·
 * prestador (avatar + nome) · ⇄ — e, no fim, "Sin atención: …" com os dias sem faixa. O título, "Horas cubiertas" e a reserva moram no
 * cabeçalho da tela do serviço (uma vez só). O comportamento é o de sempre (P1): clicar no ⇄ abre "Editar agendamiento" (o "Quitar del
 * itinerario" mora lá dentro) e a recusa da última ação (sobreposição, capacidade…) aparece aqui, traduzida por CÓDIGO.
 */
export function FixedScheduleTab({ service, asOf, actionError, onEditSlot }: FixedScheduleTabProps): JSX.Element {
  const { t, i18n } = useTranslation();
  const tf = (key: string, opts?: Record<string, unknown>) => t(`admin.patients.detail.itinerary.${key}`, opts);
  // A régua D269: sem a célula, a faixa é só de LEITURA (sem ⇄), mas o dado segue visível.
  const { allowed: canEdit } = useActionGate('patient_itinerary', 'update');
  const serviceId = service.contractedServiceId;
  const dayName = (weekday: number): string => weekdayName(weekday, i18n.language);
  const sideLabel = (side: ItineraryOverlapSide): string => `${dayName(side.weekday)} ${side.startTime}-${side.endTime}`;
  const overlap = actionError?.overlap;

  const slotsOf = (weekday: number): PatientItinerarySlot[] =>
    service.slots.filter((slot) => slot.weekday === weekday).sort((a, b) => a.startTime.localeCompare(b.startTime));
  const withoutAttention = WEEKDAYS.filter((weekday) => slotsOf(weekday).length === 0);
  const names = withoutAttention.map((weekday) => dayName(weekday).toLowerCase());
  // "miércoles, jueves, viernes y sábado" — a conjunção é do i18n (es "y", pt-BR "e"), nunca fixa no componente.
  const daysText = names.length < 2 ? names.join('') : tf('fixed.listLast', { head: names.slice(0, -1).join(', '), last: names[names.length - 1] });

  return (
    <div data-testid="itinerario-horario-fijo" className="flex flex-col gap-3">
      {overlap && (
        <Text as="p" size="sm" role="alert" color="inherit" className="text-red-800" data-testid="itinerario-sobreposicao-erro">
          {tf('overlap', { existing: sideLabel(overlap.existing), requested: sideLabel(overlap.requested) })}
          {overlap.minGapMinutes !== null && ` ${tf('overlapGap', { minutes: overlap.minGapMinutes })}`}
        </Text>
      )}
      {actionError && !overlap && (
        <Text as="p" size="sm" role="alert" color="inherit" className="text-red-800" data-testid="itinerario-acao-erro">
          {t(`admin.patients.detail.itinerary.actionErrors.${actionError.code}`, tf('actionErrors.generic'))}
        </Text>
      )}

      <div>
        {WEEKDAYS.flatMap((weekday) =>
          slotsOf(weekday).map((slot, index) => {
            const vigentes = slot.assignments.filter((a) => isVigenteAt(a, asOf));
            const { hours, endsNextDay } = shiftHours(slot.startTime, slot.endTime);
            return (
              <div
                key={slot.id}
                data-testid={`itinerario-dia-${serviceId}-${weekday}-${slot.id}`}
                className="grid grid-cols-[104px_230px_minmax(0,1fr)_40px] items-center gap-3 border-b border-[#D6CDE0] py-3"
              >
                <Text as="span" weight="semibold" color="primary" className="whitespace-nowrap capitalize" {...NOWRAP}>
                  {index === 0 ? dayName(weekday) : <span className="sr-only">{dayName(weekday)}</span>}
                </Text>
                <div className="flex flex-col gap-1">
                  <div className="flex items-center gap-2">
                    <span className="flex h-9 w-[130px] shrink-0 items-center justify-center whitespace-nowrap rounded-full bg-primary" data-testid={`itinerario-slot-horario-${slot.id}`} {...NOWRAP}>
                      <Text as="span" size="sm" weight="medium" color="white">
                        {`${slot.startTime} – ${slot.endTime}`}
                      </Text>
                    </span>
                    <Text as="span" size="xs" color="tertiary" className="whitespace-nowrap" data-testid={`itinerario-slot-duracao-${slot.id}`} {...NOWRAP}>
                      {t('admin.patients.detail.itinerary.upcoming.hours', { hours })}
                    </Text>
                  </div>
                  {endsNextDay && (
                    <Text as="span" size="xs" color="tertiary" className="whitespace-nowrap pl-3" {...NOWRAP}>
                      {tf('fixed.endsNextDay')}
                    </Text>
                  )}
                </div>
                <div className="flex min-w-0 flex-col gap-1.5">
                  {vigentes.length === 0 ? (
                    <Text as="span" weight="semibold" color="primary" className="whitespace-nowrap" data-testid={`itinerario-slot-sem-prestador-${slot.id}`} {...NOWRAP}>
                      {tf('unassigned')}
                    </Text>
                  ) : (
                    vigentes.map((a) => {
                      const name = workerLabel(t, a.workerId, a.displayName);
                      return (
                        <div key={a.allocationId} className="flex min-w-0 items-center gap-2.5" data-testid={`itinerario-slot-prestador-${slot.id}-${a.workerId}`}>
                          <PersonAvatar uid={a.workerId} name={name} size={32} />
                          <SingleLine weight="semibold" color="primary">
                            {name}
                          </SingleLine>
                        </div>
                      );
                    })
                  )}
                </div>
                {canEdit ? (
                  <button
                    type="button"
                    onClick={() => onEditSlot(slot.id)}
                    aria-label={tf('fixed.changeProvider')}
                    data-testid={`itinerario-slot-editar-${slot.id}`}
                    className="flex h-10 w-10 items-center justify-center rounded-full border-[1.5px] border-gray-600 text-primary"
                  >
                    <ArrowLeftRight size={18} aria-hidden="true" />
                  </button>
                ) : (
                  <span data-testid={`itinerario-slot-somente-leitura-${slot.id}`} />
                )}
              </div>
            );
          }),
        )}
      </div>

      {withoutAttention.length > 0 && (
        <SingleLine size="sm" color="tertiary" data-testid="itinerario-sin-atencion">
          {tf('fixed.noAttention', { days: daysText })}
        </SingleLine>
      )}
    </div>
  );
}
