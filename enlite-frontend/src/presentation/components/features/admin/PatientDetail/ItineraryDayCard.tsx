import { useTranslation } from 'react-i18next';
import { Card } from '@presentation/components/organisms/Card';
import { Text } from '@presentation/components/atoms/Text';
import { ActionButton } from '@presentation/components/features/access/ActionButton';
import { isVigenteAt, type PatientItinerarySlot } from '@domain/entities/PatientItinerary';
import { weekdayName } from './substitutionDates';
import { workerLabel } from './workerLabel';

interface ItineraryDayCardProps {
  serviceId: string;
  /** 0 = domingo … 6 = sábado (a convenção do `weekday` do slot). */
  weekday: number;
  /** Os slots do serviço NESTE dia — os inativos são descartados aqui. */
  slots: PatientItinerarySlot[];
  /** Data de operação vinda da API — a vigência se mede contra ela, nunca contra o relógio. */
  asOf: string;
  onAssign: (slotId: string) => void;
}

/**
 * Card de um dia da "Agenda de Atendimentos" (Fase 12, DX-12.10; nó Figma 11340-75913): título =
 * nome do dia, sem data. Por slot ativo: o chip do horário (DX-12.7 — `Text` com token, não
 * `atoms/Badge`), quem cobre HOJE (`isVigenteAt`, DX-12.11) e, só no slot sem ninguém vigente,
 * "Asignar prestador" (`ActionButton` da célula `patient_itinerary:update`). Sem slot ativo no dia
 * → o card com o dia e o texto de vazio (testid próprio).
 */
export function ItineraryDayCard({ serviceId, weekday, slots, asOf, onAssign }: ItineraryDayCardProps): JSX.Element {
  const { t, i18n } = useTranslation();
  const ti = (key: string) => t(`admin.patients.detail.itinerary.${key}`);
  const activeSlots = slots.filter((slot) => slot.active);
  const isEmpty = activeSlots.length === 0;

  return (
    // `organisms/Card` não repassa `data-*` (átomo intocável): o testid mora no invólucro, e o Card é o filho direto.
    <div data-testid={`itinerario-dia-${serviceId}-${weekday}`}>
      <Card rounded="lg" className="border-2 border-gray-600 p-5 flex flex-col gap-3">
        <Text weight="medium" color="secondary" className="capitalize">
          {weekdayName(weekday, i18n.language)}
        </Text>

        {isEmpty && (
          <Text size="sm" color="secondary" data-testid={`itinerario-dia-vazio-${serviceId}-${weekday}`}>
            {ti('emptyDay')}
          </Text>
        )}

        {activeSlots.map((slot) => {
          const covering = slot.assignments.filter((a) => isVigenteAt(a, asOf));
          return (
            <div key={slot.id} className="flex flex-wrap items-center gap-3">
              <Text
                as="span"
                size="sm"
                weight="medium"
                color="inherit"
                className="bg-primary text-white rounded-lg px-3 py-1"
                data-testid={`itinerario-slot-horario-${slot.id}`}
              >
                {`${slot.startTime} - ${slot.endTime}`}
              </Text>
              {covering.map((a) => (
                <Text
                  key={a.allocationId}
                  as="span"
                  size="sm"
                  weight="medium"
                  color="primary"
                  data-testid={`itinerario-slot-prestador-${slot.id}-${a.workerId}`}
                >
                  {workerLabel(t, a.workerId, a.displayName)}
                </Text>
              ))}
              {covering.length === 0 && (
                <ActionButton
                  resource="patient_itinerary"
                  action="update"
                  variant="ghost"
                  size="sm"
                  onClick={() => onAssign(slot.id)}
                  data-testid={`itinerario-slot-asignar-${slot.id}`}
                >
                  {ti('assign')}
                </ActionButton>
              )}
            </div>
          );
        })}
      </Card>
    </div>
  );
}
