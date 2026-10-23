import type { PatientItineraryService } from '@domain/entities/PatientItinerary';
import type { ItineraryActionError } from '@hooks/admin/usePatientItinerary';
import { ItinerarySection } from '../ItinerarySection';

interface FixedScheduleTabProps {
  service: PatientItineraryService;
  serviceCode: string;
  addressLabel: string;
  asOf: string;
  actionError: ItineraryActionError | null;
  onEditSlot: (slotId: string) => void;
}

/**
 * "Horario fijo" (spec 069, US2; pt-BR "Horário fixo"): o padrão semanal editável de HOJE, filtrado
 * ao serviço — a `ItinerarySection` (7 cards de dia, "Editar agendamiento", "Quitar del itinerario")
 * sem nenhuma mudança de comportamento (P1: faixa com alocação ativa segue recusando edição).
 */
export function FixedScheduleTab({ service, serviceCode, addressLabel, asOf, actionError, onEditSlot }: FixedScheduleTabProps): JSX.Element {
  return (
    <div data-testid="itinerario-horario-fijo">
      <ItinerarySection service={service} serviceCode={serviceCode} addressLabel={addressLabel} asOf={asOf} actionError={actionError} onEditSlot={onEditSlot} />
    </div>
  );
}
