import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Calendar } from 'lucide-react';
import { Card } from '@presentation/components/organisms/Card';
import { Heading } from '@presentation/components/atoms/Heading';
import { Text } from '@presentation/components/atoms/Text';
import { Input } from '@presentation/components/atoms/Input';
import { Select } from '@presentation/components/atoms/Select';
import { ActionButton } from '@presentation/components/features/access';
import { DetailSkeleton } from '@presentation/components/ui/skeletons';
import type { PatientItineraryEvent } from '@domain/entities/PatientItinerary';
import type { ServiceTeamMember } from '@domain/entities/ServiceTeam';
import { useItineraryEvents } from '@hooks/admin/useItineraryEvents';
import type { AllocationOptionsLoad } from '@hooks/admin/usePatientItinerary';
import { ItineraryEventCard } from './ItineraryEventCard';
import { addDaysToDate } from './substitutionDates';

/** Janela padrão do filtro (D445.3: até 62 dias no backend; 13 é só o valor inicial do painel). */
const DEFAULT_WINDOW_DAYS = 13;

interface ItineraryEventsPanelProps {
  patientId: string;
  asOf: string;
  /** `serviceId → { label, addressLabel }` (D445.6: endereço de entrada, resolvido pela aba). */
  servicesById: Map<string, { label: string; addressLabel: string }>;
  onNew: () => void;
  /** Injetados pela aba — os mesmos handlers do card do dia (trocar/cancelar reusam a Fase 13). */
  onChangeSubstitute: (serviceId: string, absenceId: string, workerId: string | null) => void;
  onCancelSubstitution: (serviceId: string, absenceId: string) => void;
  loadServiceOptions: (serviceId: string) => Promise<AllocationOptionsLoad>;
  /** Incrementado pela aba após qualquer escrita (registrar/trocar/cancelar/reemplazo) — refaz o GET. */
  refreshSignal: number;
}

/**
 * "Próximos eventos/Substitución" (D445.3; nó Figma 11340:76234) — a coluna esquerda da aba
 * Itinerario. Filtros Início/Fim disparam um NOVO GET (o backend limita a 62 dias); Localización
 * (mapeado a `serviceId` — invariante 8, um serviço = um endereço) e Prestador filtram em memória
 * sobre o que já veio (a lista cabe na tela: no máx. 62 dias × faixas do paciente).
 */
export function ItineraryEventsPanel({
  patientId,
  asOf,
  servicesById,
  onNew,
  onChangeSubstitute,
  onCancelSubstitution,
  loadServiceOptions,
  refreshSignal,
}: ItineraryEventsPanelProps): JSX.Element {
  const { t } = useTranslation();
  const te = (key: string, opts?: Record<string, unknown>) => t(`admin.patients.detail.itinerary.eventsPanel.${key}`, opts);
  const { events, status, filters, setFilters, refresh } = useItineraryEvents(patientId, {
    from: asOf,
    to: addDaysToDate(asOf, DEFAULT_WINDOW_DAYS),
  });

  useEffect(() => {
    if (refreshSignal > 0) refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshSignal]);
  const [locationFilter, setLocationFilter] = useState('');
  const [workerFilter, setWorkerFilter] = useState('');
  const [substituteOptionsByService, setSubstituteOptionsByService] = useState<Map<string, ServiceTeamMember[]>>(new Map());

  const workerOptionsFromEvents = useMemo(() => {
    const map = new Map<string, string>();
    (events ?? []).forEach((e) => {
      if (e.workerId) map.set(e.workerId, e.workerDisplayName ?? e.workerId.slice(-8));
      map.set(e.titularWorkerId, e.titularDisplayName ?? e.titularWorkerId.slice(-8));
    });
    return [...map.entries()].map(([value, label]) => ({ value, label }));
  }, [events]);

  const filteredEvents: PatientItineraryEvent[] = (events ?? []).filter((e) => {
    if (locationFilter && e.serviceId !== locationFilter) return false;
    if (workerFilter && e.workerId !== workerFilter && e.titularWorkerId !== workerFilter) return false;
    return true;
  });

  async function handleLoadSubstituteOptions(serviceId: string): Promise<void> {
    const result = await loadServiceOptions(serviceId);
    if (result.status === 'ok') {
      setSubstituteOptionsByService((prev) => new Map(prev).set(serviceId, result.options));
    }
  }

  return (
    // `organisms/Card` não repassa `data-*` (átomo intocável, molde `ItineraryDayCard`): o testid
    // mora no invólucro.
    <div data-testid="itinerario-eventos-painel">
    <Card rounded="lg" className="border-2 border-gray-600 p-6 flex flex-col gap-5">
      <div className="flex items-center justify-between">
        <div>
          <Heading level={2} as="h3" weight="semibold" color="secondary">
            {te('title')}
          </Heading>
          <Heading level={2} as="h3" weight="semibold" color="secondary">
            {te('titleSecondLine')}
          </Heading>
        </div>
        <ActionButton resource="patient_itinerary" action="update" variant="primary" size="sm" onClick={onNew} data-testid="itinerario-novo-btn">
          {te('newButton')}
        </ActionButton>
      </div>

      <div className="flex gap-3">
        <div className="flex flex-col gap-1 flex-1">
          <Text as="span" weight="semibold" color="secondary">
            {te('filterStart')}
          </Text>
          <Input
            type="date"
            value={filters.from}
            onChange={(e) => setFilters({ ...filters, from: e.target.value })}
            rightIcon={<Calendar size={18} />}
            data-testid="itinerario-eventos-filtro-inicio"
          />
        </div>
        <div className="flex flex-col gap-1 flex-1">
          <Text as="span" weight="semibold" color="secondary">
            {te('filterEnd')}
          </Text>
          <Input
            type="date"
            value={filters.to}
            onChange={(e) => setFilters({ ...filters, to: e.target.value })}
            rightIcon={<Calendar size={18} />}
            data-testid="itinerario-eventos-filtro-fim"
          />
        </div>
      </div>

      <div className="flex flex-col gap-1">
        <Text as="span" weight="semibold" color="secondary">
          {te('filterLocation')}
        </Text>
        <Select
          data-testid="itinerario-eventos-filtro-localizacao"
          options={[...servicesById.entries()].map(([id, v]) => ({ value: id, label: v.addressLabel }))}
          value={locationFilter}
          onValueChange={setLocationFilter}
          placeholder={te('filterLocationPlaceholder')}
        />
      </div>

      <div className="flex flex-col gap-1">
        <Text as="span" weight="semibold" color="secondary">
          {te('filterWorker')}
        </Text>
        <Select
          data-testid="itinerario-eventos-filtro-prestador"
          options={workerOptionsFromEvents}
          value={workerFilter}
          onValueChange={setWorkerFilter}
          placeholder={te('filterWorkerPlaceholder')}
        />
      </div>

      {status === 'loading' && <DetailSkeleton />}

      {status === 'error' && (
        <Text size="sm" role="alert" color="inherit" className="text-red-600" data-testid="itinerario-eventos-erro">
          {te('loadError')}
        </Text>
      )}

      {status === 'ok' && filteredEvents.length === 0 && (
        <Text size="sm" color="secondary" data-testid="itinerario-eventos-vazio">
          {te('empty')}
        </Text>
      )}

      {status === 'ok' &&
        filteredEvents.map((event) => (
          <ItineraryEventCard
            key={`${event.assignmentId}-${event.date}`}
            event={event}
            addressLabel={servicesById.get(event.serviceId)?.addressLabel ?? ''}
            substituteOptions={substituteOptionsByService.get(event.serviceId) ?? null}
            onLoadSubstituteOptions={() => void handleLoadSubstituteOptions(event.serviceId)}
            onChangeSubstitute={(workerId) => {
              if (event.absenceId) onChangeSubstitute(event.serviceId, event.absenceId, workerId);
            }}
            onCancel={() => {
              if (event.absenceId) onCancelSubstitution(event.serviceId, event.absenceId);
            }}
          />
        ))}
    </Card>
    </div>
  );
}
