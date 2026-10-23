import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, MapPin, Plus } from 'lucide-react';
import { Card } from '@presentation/components/organisms/Card';
import { Heading } from '@presentation/components/atoms/Heading';
import { Text } from '@presentation/components/atoms/Text';
import { ProgressBar } from '@presentation/components/atoms/ProgressBar';
import { Select } from '@presentation/components/atoms/Select';
import { ActionButton } from '@presentation/components/features/access';
import { useServiceExitReasonOptions } from '@hooks/admin/useServiceExitReasonOptions';
import { useServiceOccurrences } from '@hooks/admin/useServiceOccurrences';
import { useSubstitutionRequests } from '@hooks/admin/useSubstitutionRequests';
import type { PatientItineraryEvent, PatientItineraryService } from '@domain/entities/PatientItinerary';
import type { SubstitutionFlowIntent } from '@domain/entities/SubstitutionRequest';
import type { ItineraryActionError } from '@hooks/admin/usePatientItinerary';
import { workerLabel } from '../workerLabel';
import { NOWRAP, SingleLine } from './SingleLine';
import { ServiceVacancyTag, type ServiceVacancyRef } from './ServiceVacancyTag';
import { FixedScheduleTab } from './FixedScheduleTab';
import { UpcomingDaysTable } from './UpcomingDaysTable';
import { WeekPicker } from './WeekPicker';
import { mondayOf } from './weekRange';

interface ItineraryServiceScreenProps {
  patientId: string;
  service: PatientItineraryService;
  label: string;
  addressLabel: string;
  /** A vaga viva do serviço (a ficha a conhece); `null` = redigida para este ator. */
  vacancy: ServiceVacancyRef | null;
  asOf: string;
  /** "Volver a los servicios" some quando o paciente só tem um serviço (a lista é pulada). */
  canGoBack: boolean;
  onBack: () => void;
  /** Abre o fluxo "Nueva sustitución" (a F6 monta o fluxo; aqui só a intenção sobe). */
  onSubstitutionFlow: (intent: SubstitutionFlowIntent) => void;
  actionError: ItineraryActionError | null;
  onEditSlot: (slotId: string) => void;
  /** Muda a cada escrita da aba (alocar, quitar): a semana mostrada refaz o GET. */
  refreshKey: number;
  /** Ponto de montagem da aba "Sustituciones" (F6). */
  substitutionsSlot?: ReactNode;
}

type ServiceTab = 'upcoming' | 'fixed' | 'substitutions';
const TABS: ServiceTab[] = ['upcoming', 'fixed', 'substitutions'];

const hoursLabel = (value: number): number => Number(value.toFixed(2));

/** As pessoas que aparecem na semana (titular, substituto ou quem atende), uma vez cada, para o filtro por prestador (N7). */
function peopleOf(events: PatientItineraryEvent[], t: Parameters<typeof workerLabel>[0]): Array<{ id: string; label: string }> {
  const byId = new Map<string, string>();
  for (const e of events) {
    for (const [id, name] of [[e.titularWorkerId, e.titularDisplayName], [e.substituteWorkerId, e.substituteDisplayName], [e.workerId, e.workerDisplayName]] as const) {
      if (id && !byId.has(id)) byId.set(id, workerLabel(t, id, name));
    }
  }
  return [...byId.entries()].map(([id, label]) => ({ id, label })).sort((a, b) => a.label.localeCompare(b.label));
}

/**
 * B2 (spec 069, US2; mockup `b2a.png`): "Volver a los servicios", nome/endereço/vaga do serviço,
 * "Nueva sustitución", "Horas cubiertas: X de Y h" e as três abas internas — Próximos días (padrão) ·
 * Horario fijo · Sustituciones. Tudo dentro do container da aba Itinerario.
 */
export function ItineraryServiceScreen({
  patientId,
  service,
  label,
  addressLabel,
  vacancy,
  asOf,
  canGoBack,
  onBack,
  onSubstitutionFlow,
  actionError,
  onEditSlot,
  refreshKey,
  substitutionsSlot,
}: ItineraryServiceScreenProps): JSX.Element {
  const { t } = useTranslation();
  const ts = (key: string, opts?: Record<string, unknown>) => t(`admin.patients.detail.itinerary.serviceScreen.${key}`, opts);
  const serviceId = service.contractedServiceId;
  const currentWeekStart = mondayOf(asOf);
  const [tab, setTab] = useState<ServiceTab>('upcoming');
  const [weekStart, setWeekStart] = useState(currentWeekStart);
  const [workerFilter, setWorkerFilter] = useState('');
  const { events, status } = useServiceOccurrences(patientId, serviceId, weekStart, refreshKey);
  // O MOTIVO da falta mora no PEDIDO (o dono), não no turno: "Nadie asignado — Lucía no viene · Enfermedad" lê o pedido pelo `requestId`.
  const upcomingRequests = useSubstitutionRequests(patientId, serviceId, 'upcoming', refreshKey);
  const { options: reasonOptions } = useServiceExitReasonOptions();
  const reasonOf = (event: PatientItineraryEvent): string | null => {
    const code = upcomingRequests.requests?.find((r) => event.requestId !== null && r.requestId === event.requestId)?.reasonCode ?? null;
    return reasonOptions.find((o) => o.code === code)?.label ?? null;
  };

  const cobertas = hoursLabel(service.cobertas);
  const total = hoursLabel(service.scheduleHours);
  const percentage = total > 0 ? (cobertas / total) * 100 : 0;
  const people = events ? peopleOf(events, t) : [];
  const visible = events ? events.filter((e) => !workerFilter || [e.titularWorkerId, e.substituteWorkerId, e.workerId].includes(workerFilter)) : [];

  return (
    <div data-testid={`itinerario-servico-tela-${serviceId}`}>
      <Card rounded="lg" className="border-2 border-gray-600 p-6 flex flex-col gap-5">
        {canGoBack && (
          <button type="button" onClick={onBack} data-testid="itinerario-voltar-servicos" className="flex items-center gap-2 self-start whitespace-nowrap text-primary" {...NOWRAP}>
            <ArrowLeft size={16} aria-hidden="true" />
            <Text as="span" size="sm" weight="medium" color="primary" className="whitespace-nowrap">
              {ts('back')}
            </Text>
          </button>
        )}

        <div className="flex items-start justify-between gap-6">
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <Heading level={1} as="h3" weight="semibold" color="primary" className="min-w-0 truncate" title={label} data-single-line="" data-testid="itinerario-servico-nome">
              {label}
            </Heading>
            <div className="flex items-center gap-2 min-w-0">
              <MapPin size={16} className="text-primary shrink-0" aria-hidden="true" />
              <SingleLine size="sm" color="tertiary">
                {addressLabel}
              </SingleLine>
            </div>
            <ServiceVacancyTag reserve={service.reserve} vacancy={vacancy} variant="chip" data-testid="itinerario-servico-reserva" />
          </div>
          <div className="flex w-[240px] shrink-0 flex-col items-end gap-3">
            <ActionButton
              resource="patient_itinerary"
              action="update"
              size="sm"
              className="whitespace-nowrap"
              onClick={() => onSubstitutionFlow({ kind: 'new' })}
              data-testid="itinerario-nova-substituicao"
              {...NOWRAP}
            >
              <span className="inline-flex items-center gap-2 whitespace-nowrap">
                <Plus size={16} aria-hidden="true" />
                {ts('newSubstitution')}
              </span>
            </ActionButton>
            <div className="w-full flex flex-col gap-1">
              <Text size="sm" weight="medium" color="primary" className="whitespace-nowrap" data-testid="itinerario-servico-horas" {...NOWRAP}>
                {ts('coveredHours', { covered: cobertas, total })}
              </Text>
              <ProgressBar percentage={percentage} height="sm" animated={false} />
            </div>
          </div>
        </div>

        <div role="tablist" aria-label={ts('tabsLabel')} className="flex items-center gap-2 flex-wrap">
          {TABS.map((id) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={tab === id}
              onClick={() => setTab(id)}
              data-testid={`itinerario-aba-${id}`}
              className={`whitespace-nowrap rounded-full border px-5 py-2 ${tab === id ? 'bg-primary border-primary' : 'bg-white border-gray-800'}`}
              {...NOWRAP}
            >
              <Text as="span" size="sm" weight="semibold" color={tab === id ? 'white' : 'primary'} className="whitespace-nowrap">
                {ts(`tabs.${id}`)}
              </Text>
            </button>
          ))}
        </div>

        {tab === 'upcoming' && (
          <div className="flex flex-col gap-4" role="tabpanel" data-testid="itinerario-proximos-painel">
            <WeekPicker
              weekStart={weekStart}
              currentWeekStart={currentWeekStart}
              onChange={(week) => {
                setWeekStart(week);
                setWorkerFilter('');
              }}
              filter={
                <div className="flex items-center gap-2">
                  <label htmlFor={`itinerario-filtro-prestador-${serviceId}`}>
                    <Text as="span" size="sm" weight="medium" color="primary" className="whitespace-nowrap" {...NOWRAP}>
                      {ts('workerFilter')}
                    </Text>
                  </label>
                  <Select
                    id={`itinerario-filtro-prestador-${serviceId}`}
                    inputSize="compact"
                    className="w-[200px] [&_select]:!text-primary"
                    data-testid="itinerario-filtro-prestador"
                    value={workerFilter}
                    onValueChange={setWorkerFilter}
                    options={[{ value: '', label: ts('workerFilterAll') }, ...people.map((p) => ({ value: p.id, label: p.label }))]}
                  />
                </div>
              }
            />

            {status === 'loading' || status === 'idle' ? (
              <Text size="sm" color="tertiary" data-testid="itinerario-proximos-carregando">
                {ts('loading')}
              </Text>
            ) : status === 'ok' ? (
              <UpcomingDaysTable
                events={visible}
                onChange={(event) => onSubstitutionFlow({ kind: 'change', event })}
                onAssign={(event) => onSubstitutionFlow({ kind: 'assign', event })}
                reasonOf={reasonOf}
              />
            ) : (
              <Text size="sm" role="alert" color="inherit" className="text-red-800" data-testid="itinerario-proximos-erro">
                {status === 'forbidden' ? ts('forbidden') : ts('loadError')}
              </Text>
            )}
          </div>
        )}

        {tab === 'fixed' && (
          <div role="tabpanel">
            <FixedScheduleTab service={service} asOf={asOf} actionError={actionError} onEditSlot={onEditSlot} />
          </div>
        )}

        {tab === 'substitutions' && (
          <div role="tabpanel" data-testid="itinerario-sustituciones-aba">
            {substitutionsSlot}
          </div>
        )}
      </Card>
    </div>
  );
}
