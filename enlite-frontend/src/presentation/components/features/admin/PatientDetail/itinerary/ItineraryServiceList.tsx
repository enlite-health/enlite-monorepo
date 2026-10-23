import { useTranslation } from 'react-i18next';
import { Heading } from '@presentation/components/atoms/Heading';
import type { PatientItineraryService } from '@domain/entities/PatientItinerary';
import { ItineraryServiceCard } from './ItineraryServiceCard';

export interface ItineraryServiceListItem {
  service: PatientItineraryService;
  label: string;
  addressLabel: string;
}

interface ItineraryServiceListProps {
  items: ItineraryServiceListItem[];
  horizonDays: number;
  onOpen: (serviceId: string) => void;
}

/** B1 (spec 069, US1): "¿Qué servicio querés organizar?" e um cartão por serviço contratado ativo (N3: inativo não aparece). */
export function ItineraryServiceList({ items, horizonDays, onOpen }: ItineraryServiceListProps): JSX.Element {
  const { t } = useTranslation();
  return (
    <section data-testid="itinerario-lista-servicos" className="flex flex-col gap-4">
      <Heading level={2} as="h3" weight="semibold" color="primary">
        {t('admin.patients.detail.itinerary.serviceList.title')}
      </Heading>
      {items.map((item) => (
        <ItineraryServiceCard
          key={item.service.contractedServiceId}
          service={item.service}
          label={item.label}
          addressLabel={item.addressLabel}
          horizonDays={horizonDays}
          onOpen={onOpen}
        />
      ))}
    </section>
  );
}
