import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, MapPin, Plus } from 'lucide-react';
import { Card } from '@presentation/components/organisms/Card';
import { Heading } from '@presentation/components/atoms/Heading';
import { Text } from '@presentation/components/atoms/Text';
import { ProgressBar } from '@presentation/components/atoms/ProgressBar';
import { ActionButton } from '@presentation/components/features/access';
import { useServiceOccurrences } from '@hooks/admin/useServiceOccurrences';
import type { PatientItineraryEvent, PatientItineraryService } from '@domain/entities/PatientItinerary';
import type { SubstitutionFlowIntent } from '@domain/entities/SubstitutionRequest';
import type { ItineraryActionError } from '@hooks/admin/usePatientItinerary';
import { workerLabel } from '../workerLabel';
import { FixedScheduleTab } from './FixedScheduleTab';
import { UpcomingDaysTable } from './UpcomingDaysTable';
import { WeekPicker } from './WeekPicker';
import { mondayOf } from './weekRange';

interface ItineraryServiceScreenProps {
  patientId: string;
  service: PatientItineraryService;
  serviceCode: string;
  label: string;
  addressLabel: string;
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
  serviceCode,
  label,
  addressLabel,
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

  const cobertas = hoursLabel(service.cobertas);
  const total = hoursLabel(service.scheduleHours);
  const percentage = total > 0 ? (cobertas / total) * 100 : 0;
  const people = events ? peopleOf(events, t) : [];
  const visible = events ? events.filter((e) => !workerFilter || [e.titularWorkerId, e.substituteWorkerId, e.workerId].includes(workerFilter)) : [];

  return (
    <div data-testid={`itinerario-servico-tela-${serviceId}`}>
      <Card rounded="lg" className="border-2 border-gray-600 p-6 flex flex-col gap-5">
        {canGoBack && (
          <button type="button" onClick={onBack} data-testid="itinerario-voltar-servicos" className="flex items-center gap-2 self-start text-primary">
            <ArrowLeft size={16} aria-hidden="true" />
            <Text as="span" size="sm" weight="medium" color="primary">
              {ts('back')}
            </Text>
          </button>
        )}

        <div className="flex items-start justify-between gap-6 flex-wrap">
          <div className="flex flex-col gap-1 min-w-0">
            <Heading level={1} as="h3" weight="semibold" color="primary" data-testid="itinerario-servico-nome">
              {label}
            </Heading>
            <div className="flex items-center gap-2 min-w-0">
              <MapPin size={16} className="text-primary shrink-0" aria-hidden="true" />
              <Text as="span" size="sm" color="tertiary" className="break-words min-w-0">
                {addressLabel}
              </Text>
            </div>
            <Text size="sm" color="tertiary" data-testid="itinerario-servico-reserva">
              {service.reserve === null
                ? t('admin.patients.detail.itinerary.reserveNoVacancy')
                : t('admin.patients.detail.itinerary.reserve', { count: service.reserve.count, minimum: service.reserve.minimum })}
            </Text>
          </div>
          <div className="flex flex-col items-end gap-3 min-w-[240px]">
            <ActionButton
              resource="patient_itinerary"
              action="update"
              size="sm"
              onClick={() => onSubstitutionFlow({ kind: 'new' })}
              data-testid="itinerario-nova-substituicao"
            >
              <span className="inline-flex items-center gap-2">
                <Plus size={16} aria-hidden="true" />
                {ts('newSubstitution')}
              </span>
            </ActionButton>
            <div className="w-full flex flex-col gap-1">
              <Text size="sm" weight="medium" color="primary" data-testid="itinerario-servico-horas">
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
              className={`rounded-full border px-5 py-2 ${tab === id ? 'bg-primary border-primary' : 'bg-white border-gray-800'}`}
            >
              <Text as="span" size="sm" weight="semibold" color={tab === id ? 'white' : 'primary'}>
                {ts(`tabs.${id}`)}
              </Text>
            </button>
          ))}
        </div>

        {tab === 'upcoming' && (
          <div className="flex flex-col gap-4" role="tabpanel" data-testid="itinerario-proximos-painel">
            <WeekPicker weekStart={weekStart} currentWeekStart={currentWeekStart} onChange={(week) => {
                setWeekStart(week);
                setWorkerFilter('');
              }} />
            <div className="flex items-center gap-2">
              <label htmlFor={`itinerario-filtro-prestador-${serviceId}`}>
                <Text as="span" size="sm" weight="medium" color="primary">
                  {ts('workerFilter')}
                </Text>
              </label>
              <select
                id={`itinerario-filtro-prestador-${serviceId}`}
                value={workerFilter}
                onChange={(e) => setWorkerFilter(e.target.value)}
                data-testid="itinerario-filtro-prestador"
                className="rounded-input border border-gray-800 bg-white px-3 py-1.5 font-lexend text-sm text-primary"
              >
                <option value="">{ts('workerFilterAll')}</option>
                {people.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </select>
            </div>

            {status === 'loading' || status === 'idle' ? (
              <Text size="sm" color="tertiary" data-testid="itinerario-proximos-carregando">
                {ts('loading')}
              </Text>
            ) : status === 'ok' ? (
              <UpcomingDaysTable
                events={visible}
                onChange={(event) => onSubstitutionFlow({ kind: 'change', event })}
                onAssign={(event) => onSubstitutionFlow({ kind: 'assign', event })}
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
            <FixedScheduleTab service={service} serviceCode={serviceCode} addressLabel={addressLabel} asOf={asOf} actionError={actionError} onEditSlot={onEditSlot} />
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
