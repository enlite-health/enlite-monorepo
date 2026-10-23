import { useTranslation } from 'react-i18next';
import { ArrowRight, MapPin, TriangleAlert } from 'lucide-react';
import { Card } from '@presentation/components/organisms/Card';
import { Button } from '@presentation/components/atoms/Button';
import { Heading } from '@presentation/components/atoms/Heading';
import { Text } from '@presentation/components/atoms/Text';
import type { PatientItineraryService } from '@domain/entities/PatientItinerary';
import { weekdayName } from '../substitutionDates';
import { ServiceVacancyTag, type ServiceVacancyRef } from './ServiceVacancyTag';
import { NOWRAP, SingleLine } from './SingleLine';

export interface ItineraryServiceCardProps {
  service: PatientItineraryService;
  /** Nome do serviço (o mesmo rótulo do quadro C), resolvido pela aba. */
  label: string;
  addressLabel: string;
  /** A vaga viva do serviço (a ficha a conhece); `null` = redigida para este ator. */
  vacancy: ServiceVacancyRef | null;
  /** Horizonte do aviso, em dias, vindo do GET — nenhum texto leva "7" fixo. */
  horizonDays: number;
  onOpen: (serviceId: string) => void;
}

/** Domingo → sábado: a ordem do mockup (`desktop-light.png`: "Dom · Lun · Mar") e da agenda de "Horario fijo". */
const WEEK_ORDER = [0, 1, 2, 3, 4, 5, 6];

const hoursLabel = (value: number): number => Number(value.toFixed(2));

type StructuralTone = 'red' | 'amber' | 'green' | 'neutral';

/**
 * Cor do estado estrutural (mockup `.svc-state`): vermelho = falta tudo, âmbar = falta parte, verde = completo. O texto usa os
 * tons -900/-800 do Tailwind (red-800 #991B1B 8,3:1 · amber-900 #78350F 9,1:1 · green-900 #14532D 9,1:1 sobre branco — todos ≥ 7:1);
 * a bolinha é só reforço visual (o sentido está no TEXTO, nunca só na cor).
 */
const TONE_CLASSES: Record<StructuralTone, { text: string; dot: string }> = {
  red: { text: 'text-red-800', dot: 'bg-[#E5354F]' },
  amber: { text: 'text-amber-900', dot: 'bg-[#FFB607]' },
  green: { text: 'text-green-900', dot: 'bg-[#1FA45B]' },
  neutral: { text: 'text-[#374151]', dot: 'bg-gray-800' },
};

function structuralToneOf(scheduleHours: number, cobertas: number): StructuralTone {
  if (scheduleHours === 0) return 'neutral';
  if (cobertas <= 0) return 'red';
  return scheduleHours - cobertas <= 0 ? 'green' : 'amber';
}

/**
 * Cartão B1 (spec 069, US1; mockup `desktop-light.png`): nome, endereço, dias, o estado ESTRUTURAL
 * ("Faltan cubrir X h de Y" / "Completo", `cobertas`/`scheduleHours` — a mesma conta do Kanban) e,
 * em faixa SEPARADA e visualmente distinta, o aviso TEMPORÁRIO de turnos sin cubrir nos próximos
 * `horizonDays` dias (só com n > 0). Só desenha: o estado mora na aba.
 */
export function ItineraryServiceCard({ service, label, addressLabel, vacancy, horizonDays, onOpen }: ItineraryServiceCardProps): JSX.Element {
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
    service.scheduleHours === 0 ? tc('noSlots') : missing <= 0 ? tc('complete', { total: hoursLabel(service.scheduleHours) }) : tc('missing', { missing, total: hoursLabel(service.scheduleHours) });

  const tone = structuralToneOf(service.scheduleHours, service.cobertas);

  return (
    <div data-testid={`itinerario-cartao-${serviceId}`}>
      <Card rounded="lg" className="border-2 border-gray-600 p-5 flex flex-col gap-3">
        <div className="flex items-start justify-between gap-4">
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <Heading level={2} as="h4" weight="semibold" color="primary" className="min-w-0 truncate" title={label} data-single-line="">
              {label}
            </Heading>
            <div className="flex items-center gap-2 min-w-0">
              <MapPin size={16} className="text-primary shrink-0" aria-hidden="true" />
              <SingleLine size="sm" color="tertiary">
                {addressLabel}
              </SingleLine>
            </div>
            {days && (
              <SingleLine size="sm" color="tertiary" data-testid={`itinerario-cartao-dias-${serviceId}`}>
                {days}
              </SingleLine>
            )}
            <div className={`flex min-w-0 items-center gap-2 ${TONE_CLASSES[tone].text}`} data-testid={`itinerario-cartao-estado-${serviceId}`} data-tone={tone}>
              <span aria-hidden="true" className={`h-2.5 w-2.5 shrink-0 rounded-full ${TONE_CLASSES[tone].dot}`} />
              <Text as="span" size="sm" weight="medium" color="inherit" className="whitespace-nowrap" {...NOWRAP}>
                {structural}
              </Text>
            </div>
            <ServiceVacancyTag reserve={service.reserve} vacancy={vacancy} variant="text" data-testid={`itinerario-cartao-reserva-${serviceId}`} />
          </div>
          <Button size="sm" className="shrink-0 whitespace-nowrap" onClick={() => onOpen(serviceId)} data-testid={`itinerario-cartao-abrir-${serviceId}`} {...NOWRAP}>
            <span className="inline-flex items-center gap-2 whitespace-nowrap">
              {tc('organize')}
              <ArrowRight size={16} aria-hidden="true" />
            </span>
          </Button>
        </div>

        {/* O aviso TEMPORÁRIO: UMA linha com o ícone de alerta âmbar (mockup `.warn`: #FFF1D1 / borda #D99A1B / texto #4A2F00, 12,6:1). */}
        {service.uncoveredShifts > 0 && (
          <div
            role="status"
            data-testid={`itinerario-cartao-sem-cobrir-${serviceId}`}
            className="flex items-center gap-2 rounded-xl border-[1.5px] border-[#D99A1B] bg-[#FFF1D1] px-3.5 py-2.5 text-[#4A2F00]"
          >
            <TriangleAlert size={16} className="shrink-0 text-[#8A5200]" aria-hidden="true" />
            <SingleLine size="sm" weight="medium" color="inherit">
              {tc('uncoveredShifts', { count: service.uncoveredShifts, days: horizonDays })}
            </SingleLine>
          </div>
        )}
      </Card>
    </div>
  );
}
