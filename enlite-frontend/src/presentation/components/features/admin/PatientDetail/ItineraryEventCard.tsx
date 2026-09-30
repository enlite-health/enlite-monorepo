import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { MapPin, User, ArrowLeftRight } from 'lucide-react';
import { Card } from '@presentation/components/organisms/Card';
import { Text } from '@presentation/components/atoms/Text';
import { ActionButton } from '@presentation/components/features/access';
import { SearchableSelect } from '@presentation/components/molecules/SearchableSelect/SearchableSelect';
import type { PatientItineraryEvent } from '@domain/entities/PatientItinerary';
import type { ServiceTeamMember } from '@domain/entities/ServiceTeam';
import { weekdayName, formatDDMM } from './substitutionDates';
import { workerLabel } from './workerLabel';

interface ItineraryEventCardProps {
  event: PatientItineraryEvent;
  addressLabel: string;
  /** Os Seleccionados do serviço deste evento — só carregados quando o card abre o seletor de troca. */
  substituteOptions: ServiceTeamMember[] | null;
  onLoadSubstituteOptions: () => void;
  onChangeSubstitute: (workerId: string | null) => void;
  onCancel: () => void;
}

const NO_SUBSTITUTE_VALUE = '__NO_SUBSTITUTE__';

/**
 * Um evento (faixa × data) do "Próximos eventos/Substitución" (D445.3/D445.4; nó Figma
 * 11340:76255). Data + dia da semana, horário (badge do Figma), endereço de ENTRADA (D445.6: sem
 * "endereço de saída"), prestador que cobre de fato, e a marca de substituto/descoberto. Só
 * eventos com `absenceId` (uma ausência aberta) ganham "Cambiar sustituto"/"Cancelar" — a MESMA
 * rota da Fase 13 (`setAbsenceSubstitute`/`cancelAbsence`), nenhuma 2ª implementação.
 */
export function ItineraryEventCard({
  event,
  addressLabel,
  substituteOptions,
  onLoadSubstituteOptions,
  onChangeSubstitute,
  onCancel,
}: ItineraryEventCardProps): JSX.Element {
  const { t, i18n } = useTranslation();
  const te = (key: string, opts?: Record<string, unknown>) => t(`admin.patients.detail.itinerary.eventsPanel.${key}`, opts);
  const [changing, setChanging] = useState(false);

  const statusLabel = event.status === 'substituted' ? te('statusSubstituted') : event.status === 'uncovered' ? te('statusUncovered') : null;

  const workerOptions = [
    { value: NO_SUBSTITUTE_VALUE, label: te('noSubstitute') },
    ...(substituteOptions ?? []).map((member) => ({ value: member.workerId, label: workerLabel(t, member.workerId, member.displayName) })),
  ];

  return (
    <div data-testid={`itinerario-evento-${event.assignmentId}-${event.date}`}>
      <Card rounded="lg" className="border-2 border-gray-600 p-5 flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <ArrowLeftRight size={16} className="text-primary shrink-0" aria-hidden="true" />
            <Text as="span" size="sm" weight="medium" color="secondary">
              {te('dateLabel', { date: formatDDMM(event.date), weekday: weekdayName(event.weekday, i18n.language) })}
            </Text>
          </div>
          <div className="bg-primary text-white rounded-lg px-3 py-1" data-testid={`itinerario-evento-horario-${event.assignmentId}-${event.date}`}>
            <Text as="span" size="sm" weight="medium" color="inherit">
              {`${event.startTime} - ${event.endTime}`}
            </Text>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <MapPin size={16} className="text-primary shrink-0" />
          <Text as="span" size="sm" weight="medium" color="primary">
            {addressLabel}
          </Text>
        </div>

        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <User size={16} className="text-primary shrink-0" />
            <Text as="span" size="sm" weight="medium" color="primary" data-testid={`itinerario-evento-prestador-${event.assignmentId}-${event.date}`}>
              {event.workerId ? workerLabel(t, event.workerId, event.workerDisplayName) : te('uncoveredLabel')}
            </Text>
          </div>
          {statusLabel && (
            <span
              className={`rounded-full px-2 py-0.5 ${event.status === 'uncovered' ? 'bg-red-100' : 'bg-primary/10'}`}
              data-testid={`itinerario-evento-status-${event.assignmentId}-${event.date}`}
            >
              <Text as="span" size="xs" weight="medium" color={event.status === 'uncovered' ? 'inherit' : 'primary'} className={event.status === 'uncovered' ? 'text-red-600' : ''}>
                {statusLabel}
              </Text>
            </span>
          )}
        </div>

        {event.absenceId && !changing && (
          <div className="flex gap-3">
            <ActionButton
              resource="patient_itinerary"
              action="update"
              variant="outline"
              size="sm"
              className="flex-1"
              onClick={() => {
                setChanging(true);
                onLoadSubstituteOptions();
              }}
              data-testid={`itinerario-evento-trocar-${event.absenceId}`}
            >
              {te('changeSubstitute')}
            </ActionButton>
            <ActionButton
              resource="patient_itinerary"
              action="update"
              variant="outline"
              size="sm"
              className="flex-1"
              onClick={onCancel}
              data-testid={`itinerario-evento-cancelar-${event.absenceId}`}
            >
              {te('cancelSubstitution')}
            </ActionButton>
          </div>
        )}

        {event.absenceId && changing && (
          <SearchableSelect
            data-testid={`itinerario-evento-select-substituto-${event.absenceId}`}
            options={workerOptions}
            value=""
            disabled={substituteOptions === null}
            onChange={(value) => {
              onChangeSubstitute(value === NO_SUBSTITUTE_VALUE ? null : value);
              setChanging(false);
            }}
            label={te('changeSubstitute')}
          />
        )}
      </Card>
    </div>
  );
}
