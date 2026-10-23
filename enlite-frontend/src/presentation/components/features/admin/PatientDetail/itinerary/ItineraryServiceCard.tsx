import { useTranslation } from 'react-i18next';
import { ArrowRight, MapPin, TriangleAlert } from 'lucide-react';
import { Card } from '@presentation/components/organisms/Card';
import { Button } from '@presentation/components/atoms/Button';
import { Heading } from '@presentation/components/atoms/Heading';
import { Text } from '@presentation/components/atoms/Text';
import type { PatientItineraryService } from '@domain/entities/PatientItinerary';
import { weekdayName } from '../substitutionDates';

export interface ItineraryServiceCardProps {
  service: PatientItineraryService;
  /** Nome do serviço (o mesmo rótulo do quadro C), resolvido pela aba. */
  label: string;
  addressLabel: string;
  /** Horizonte do aviso, em dias, vindo do GET — nenhum texto leva "7" fixo. */
  horizonDays: number;
  onOpen: (serviceId: string) => void;
}

/** Segunda → domingo (a ordem do calendário do seletor de semana). */
const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];

const hoursLabel = (value: number): number => Number(value.toFixed(2));

/**
 * Cartão B1 (spec 069, US1; mockup `desktop-light.png`): nome, endereço, dias, o estado ESTRUTURAL
 * ("Faltan cubrir X h de Y" / "Completo", `cobertas`/`scheduleHours` — a mesma conta do Kanban) e,
 * em faixa SEPARADA e visualmente distinta, o aviso TEMPORÁRIO de turnos sin cubrir nos próximos
 * `horizonDays` dias (só com n > 0). Só desenha: o estado mora na aba.
 */
export function ItineraryServiceCard({ service, label, addressLabel, horizonDays, onOpen }: ItineraryServiceCardProps): JSX.Element {
  const { t, i18n } = useTranslation();
  const tc = (key: string, opts?: Record<string, unknown>) => t(`admin.patients.detail.itinerary.serviceCard.${key}`, opts);
  const serviceId = service.contractedServiceId;
  const weekdays = new Set(service.slots.map((s) => s.weekday));
  const days = WEEK_ORDER.filter((d) => weekdays.has(d))
    .map((d) => {
      const name = weekdayName(d, i18n.language).slice(0, 3);
      return name.charAt(0).toUpperCase() + name.slice(1);
    })
    .join(' · ');
  const missing = hoursLabel(service.scheduleHours - service.cobertas);
  const structural =
    service.scheduleHours === 0 ? tc('noSlots') : missing <= 0 ? tc('complete') : tc('missing', { missing, total: hoursLabel(service.scheduleHours) });

  return (
    <div data-testid={`itinerario-cartao-${serviceId}`}>
      <Card rounded="lg" className="border-2 border-gray-600 p-5 flex flex-col gap-3">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div className="flex flex-col gap-1 min-w-0">
            <Heading level={2} as="h4" weight="semibold" color="primary">
              {label}
            </Heading>
            <div className="flex items-center gap-2 min-w-0">
              <MapPin size={16} className="text-primary shrink-0" aria-hidden="true" />
              <Text as="span" size="sm" color="tertiary" className="break-words min-w-0">
                {addressLabel}
              </Text>
            </div>
            {days && (
              <Text size="sm" color="tertiary" data-testid={`itinerario-cartao-dias-${serviceId}`}>
                {days}
              </Text>
            )}
            <Text size="sm" weight="semibold" color="primary" data-testid={`itinerario-cartao-estado-${serviceId}`}>
              {structural}
            </Text>
            <Text size="xs" color="tertiary" data-testid={`itinerario-cartao-reserva-${serviceId}`}>
              {service.reserve === null
                ? t('admin.patients.detail.itinerary.reserveNoVacancy')
                : t('admin.patients.detail.itinerary.reserve', { count: service.reserve.count, minimum: service.reserve.minimum })}
            </Text>
          </div>
          <Button size="sm" onClick={() => onOpen(serviceId)} data-testid={`itinerario-cartao-abrir-${serviceId}`}>
            <span className="inline-flex items-center gap-2">
              {tc('organize')}
              <ArrowRight size={16} aria-hidden="true" />
            </span>
          </Button>
        </div>

        {service.uncoveredShifts > 0 && (
          <div
            role="status"
            data-testid={`itinerario-cartao-sem-cobrir-${serviceId}`}
            className="flex items-center gap-2 rounded-lg border border-yellow-700 bg-yellow-100 px-3 py-2 text-yellow-900"
          >
            <TriangleAlert size={16} className="shrink-0" aria-hidden="true" />
            <Text as="span" size="sm" weight="medium" color="inherit">
              {tc('uncoveredShifts', { count: service.uncoveredShifts, days: horizonDays })}
            </Text>
          </div>
        )}
      </Card>
    </div>
  );
}
