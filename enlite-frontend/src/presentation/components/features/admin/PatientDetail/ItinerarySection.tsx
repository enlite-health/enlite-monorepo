import { useTranslation } from 'react-i18next';
import { Heading } from '@presentation/components/atoms/Heading';
import { Text } from '@presentation/components/atoms/Text';
import { coverageHoursPair, type ItineraryOverlapSide, type PatientItineraryService } from '@domain/entities/PatientItinerary';
import type { ItineraryActionError } from '@hooks/admin/usePatientItinerary';
import { ItineraryDayCard } from './ItineraryDayCard';
import { weekdayName } from './substitutionDates';

interface ItinerarySectionProps {
  service: PatientItineraryService;
  /** Código do serviço (o GET do itinerário não traz) — resolvido pela aba em `patient.contractedServices`. */
  serviceCode: string;
  /** Endereço do serviço (D445.6: só entrada) — resolvido pela aba em `patient.addresses`. */
  addressLabel: string;
  asOf: string;
  /** Erro da última ação NESTE serviço (a aba só passa o do serviço em que a ação foi feita). */
  actionError: ItineraryActionError | null;
  onEditSlot: (slotId: string) => void;
}

/** 0 = domingo … 6 = sábado — a ordem do nó (Domingo → Sábado). */
const WEEKDAYS = [0, 1, 2, 3, 4, 5, 6];

/**
 * Uma seção por serviço contratado na aba "Itinerario" (Fase 12, DX-12.10): o MESMO rótulo do
 * quadro C (`serviceTypes.<code>`), o par cobertas/contratadas (`coverageHoursPair`, fonte única),
 * a recusa DITA da última ação (o 409 de sobreposição mostra os 2 horários e, quando a API manda
 * `minGapMinutes`, a folga — o número vem sempre da API) e os 7 cards de dia. Só desenha: o estado
 * mora na aba.
 */
export function ItinerarySection({ service, serviceCode, addressLabel, asOf, actionError, onEditSlot }: ItinerarySectionProps): JSX.Element {
  const { t, i18n } = useTranslation();
  const ti = (key: string, opts?: Record<string, unknown>) => t(`admin.patients.detail.itinerary.${key}`, opts);
  const serviceId = service.contractedServiceId;
  const serviceLabel = t(`admin.patients.detail.contractedServicesCard.serviceTypes.${serviceCode}`, serviceCode);
  const sideLabel = (side: ItineraryOverlapSide) => `${weekdayName(side.weekday, i18n.language)} ${side.startTime}-${side.endTime}`;
  const overlap = actionError?.overlap;

  return (
    <section data-testid={`itinerario-servico-${serviceId}`} className="flex flex-col gap-4">
      <Heading level={2} as="h4" weight="semibold" color="primary">
        {serviceLabel}
      </Heading>
      <Text data-testid={`itinerario-servico-par-${serviceId}`} size="sm" color="secondary">
        {ti('hoursPair', { pair: coverageHoursPair(service.cobertas, service.contratadas.weekly) })}
      </Text>

      {overlap && (
        <Text as="p" size="sm" role="alert" color="inherit" className="text-red-600" data-testid="itinerario-sobreposicao-erro">
          {ti('overlap', { existing: sideLabel(overlap.existing), requested: sideLabel(overlap.requested) })}
          {overlap.minGapMinutes !== null && ` ${ti('overlapGap', { minutes: overlap.minGapMinutes })}`}
        </Text>
      )}
      {actionError && !overlap && (
        <Text as="p" size="sm" role="alert" color="inherit" className="text-red-600" data-testid="itinerario-acao-erro">
          {t(`admin.patients.detail.itinerary.actionErrors.${actionError.code}`, ti('actionErrors.generic'))}
        </Text>
      )}

      <div className="flex flex-col gap-5">
        {WEEKDAYS.map((weekday) => (
          <ItineraryDayCard
            key={weekday}
            serviceId={serviceId}
            weekday={weekday}
            slots={service.slots.filter((slot) => slot.weekday === weekday)}
            asOf={asOf}
            addressLabel={addressLabel}
            onEditSlot={onEditSlot}
          />
        ))}
      </div>
    </section>
  );
}
