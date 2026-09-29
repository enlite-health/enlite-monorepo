import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, ChevronUp, MapPin, User, ArrowLeftRight } from 'lucide-react';
import { Card } from '@presentation/components/organisms/Card';
import { Text } from '@presentation/components/atoms/Text';
import { useActionGate } from '@presentation/hooks/useCellAccess';
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
  /** Endereço do serviço (D445.6: só o de ENTRADA — "endereço de saída" está fora). */
  addressLabel: string;
  /** Clicar na faixa abre o modal "Editar agendamiento" (D445.2) — com ou sem prestador vigente. */
  onEditSlot: (slotId: string) => void;
}

/**
 * Card de um dia da "Agenda de Atendimentos" (D445.2; nó Figma 11340-76163): título = nome do
 * dia, expansível/colapsável (padrão: aberto quando há faixa ativa, fechado quando não há — o
 * MESMO padrão do print do Figma, onde só "Domingo" chega aberto). Por faixa ativa, UMA linha
 * horizontal (o "adicionais" do Figma — badge, endereço e prestador lado a lado, `flex-wrap` só
 * no responsivo estreito): o chip de horário em DUAS linhas (`09:00` sobre `13:00`), o endereço
 * de ENTRADA do serviço com ícone (D445.6: sem a 2ª linha de "endereço de saída"/"Regular-Fin de
 * semana" que o Figma tinha ali), o prestador vigente (ou "Sin asignar") com ícone, e o ícone ⇄
 * — a linha inteira é clicável e abre "Editar agendamiento" (D445.2), estado atribuído ou não.
 */
export function ItineraryDayCard({ serviceId, weekday, slots, asOf, addressLabel, onEditSlot }: ItineraryDayCardProps): JSX.Element {
  const { t, i18n } = useTranslation();
  const ti = (key: string) => t(`admin.patients.detail.itinerary.${key}`);
  const activeSlots = slots.filter((slot) => slot.active);
  const isEmpty = activeSlots.length === 0;
  const [expanded, setExpanded] = useState(!isEmpty);
  // A régua D269 (hide, não disable): sem a célula, a faixa fica só de LEITURA — sem swap, sem
  // clique — mas o dado (endereço/prestador) continua visível (é `patient_services:read`, já
  // concedida a quem vê a aba).
  const { allowed: canEdit } = useActionGate('patient_itinerary', 'update');

  return (
    // `organisms/Card` não repassa `data-*` (átomo intocável): o testid mora no invólucro, e o Card é o filho direto.
    <div data-testid={`itinerario-dia-${serviceId}-${weekday}`}>
      <Card rounded="lg" className="border-2 border-gray-600 p-5 flex flex-col gap-3">
        <button
          type="button"
          className="flex items-center justify-between w-full text-left"
          onClick={() => setExpanded((prev) => !prev)}
          data-testid={`itinerario-dia-toggle-${serviceId}-${weekday}`}
          aria-expanded={expanded}
        >
          <Text weight="medium" color="secondary" className="capitalize">
            {weekdayName(weekday, i18n.language)}
          </Text>
          {!isEmpty && (expanded ? <ChevronUp size={18} className="text-gray-800" /> : <ChevronDown size={18} className="text-gray-800" />)}
        </button>

        {isEmpty && (
          <Text size="sm" color="secondary" data-testid={`itinerario-dia-vazio-${serviceId}-${weekday}`}>
            {ti('emptyDay')}
          </Text>
        )}

        {expanded &&
          activeSlots.map((slot) => {
            const covering = slot.assignments.find((a) => isVigenteAt(a, asOf)) ?? null;
            const rowContent = (
              <>
                <div className="bg-primary text-white rounded-lg px-3 py-1 flex flex-col items-center shrink-0" data-testid={`itinerario-slot-horario-${slot.id}`}>
                  <Text as="span" size="sm" weight="medium" color="inherit">
                    {slot.startTime}
                  </Text>
                  <Text as="span" size="sm" weight="medium" color="inherit">
                    {slot.endTime}
                  </Text>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <MapPin size={16} className="text-primary shrink-0" />
                  <Text as="span" size="sm" weight="medium" color="primary">
                    {addressLabel}
                  </Text>
                </div>
                <div className="flex items-center gap-2">
                  <User size={16} className="text-primary shrink-0" />
                  <Text
                    as="span"
                    size="sm"
                    weight="medium"
                    color="primary"
                    data-testid={covering ? `itinerario-slot-prestador-${slot.id}-${covering.workerId}` : `itinerario-slot-sem-prestador-${slot.id}`}
                  >
                    {covering ? workerLabel(t, covering.workerId, covering.displayName) : ti('unassigned')}
                  </Text>
                  {canEdit && <ArrowLeftRight size={16} className="text-primary shrink-0" aria-hidden="true" />}
                </div>
              </>
            );

            if (!canEdit) {
              return (
                <div key={slot.id} data-testid={`itinerario-slot-somente-leitura-${slot.id}`} className="flex flex-wrap items-center gap-3 w-full p-2 -m-2">
                  {rowContent}
                </div>
              );
            }

            return (
              <button
                key={slot.id}
                type="button"
                onClick={() => onEditSlot(slot.id)}
                data-testid={`itinerario-slot-editar-${slot.id}`}
                className="flex flex-wrap items-center gap-3 w-full text-left rounded-lg hover:bg-gray-300/40 p-2 -m-2"
              >
                {rowContent}
              </button>
            );
          })}
      </Card>
    </div>
  );
}
