import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Text } from '@presentation/components/atoms/Text';
import { DetailSkeleton } from '@presentation/components/ui/skeletons';
import { usePatientItinerary, type ItineraryActionError } from '@hooks/admin/usePatientItinerary';
import type { PatientDetail } from '@domain/entities/PatientDetail';
import type { PatientItinerarySlot } from '@domain/entities/PatientItinerary';
import type { ServiceTeamMember } from '@domain/entities/ServiceTeam';
import { ItinerarySection } from './ItinerarySection';
import { AllocateSlotModal } from './AllocateSlotModal';

interface PatientItineraryTabProps {
  patient: PatientDetail;
}

interface PendingAssign {
  serviceId: string;
  slot: PatientItinerarySlot;
}

/** Código sintético quando as opções do modal não carregam — cai no texto `actionErrors.generic`. */
const OPTIONS_LOAD_FAILED: ItineraryActionError = { code: 'OPTIONS_LOAD_FAILED' };

/**
 * Aba "Itinerario" da ficha do paciente (Fase 12, DX-12.10): 1 GET pelo hook, uma seção por
 * serviço na ordem da API. "Asignar" num slot → busca as opções (`loadOptions`, os Seleccionados
 * do serviço) e abre o modal; confirmar → `allocate` (o hook refaz o GET e o card volta ao estado
 * do banco). O erro da ação só aparece na seção do serviço em que a ação foi feita.
 */
export function PatientItineraryTab({ patient }: PatientItineraryTabProps): JSX.Element {
  const { t } = useTranslation();
  const ti = (key: string) => t(`admin.patients.detail.itinerary.${key}`);
  const { itinerary, status, loadOptions, allocate, actionError, refreshError } = usePatientItinerary(patient.id);
  const [pending, setPending] = useState<PendingAssign | null>(null);
  const [options, setOptions] = useState<ServiceTeamMember[] | null>(null);
  const [actedServiceId, setActedServiceId] = useState<string | null>(null);
  const [optionsFailed, setOptionsFailed] = useState(false);
  const openRef = useRef(0);

  if (status === 'idle' || status === 'loading') return <DetailSkeleton />;

  if (status !== 'ok' || !itinerary) {
    return (
      <Text data-testid="itinerario-erro" size="sm" role="alert" color="inherit" className="text-red-600">
        {ti('loadError')}
      </Text>
    );
  }

  if (itinerary.services.length === 0) {
    return (
      <Text data-testid="itinerario-sem-servicos" size="sm" color="secondary">
        {ti('noServices')}
      </Text>
    );
  }

  const codeById = new Map(patient.contractedServices.map((s) => [s.id, s.serviceCode]));

  function openAssign(serviceId: string, slot: PatientItinerarySlot): void {
    const openId = ++openRef.current;
    setPending({ serviceId, slot });
    setOptions(null);
    setActedServiceId(serviceId);
    setOptionsFailed(false);
    void loadOptions(serviceId).then((result) => {
      if (openRef.current !== openId) return;
      if (result.status === 'ok') {
        setOptions(result.options);
        return;
      }
      setPending(null);
      setOptionsFailed(true);
    });
  }

  function closeModal(): void {
    openRef.current += 1;
    setPending(null);
  }

  function confirm({ serviceId, slot }: PendingAssign, workerId: string): void {
    closeModal();
    void allocate(serviceId, slot.id, workerId);
  }

  return (
    <div data-testid="itinerario-aba" className="flex flex-col gap-6">
      {refreshError && (
        <Text data-testid="itinerario-refresh-erro" size="sm" role="alert" color="inherit" className="text-red-600">
          {ti('refreshError')}
        </Text>
      )}

      {itinerary.services.map((service) => {
        const serviceId = service.contractedServiceId;
        const isActed = actedServiceId === serviceId;
        return (
          <ItinerarySection
            key={serviceId}
            service={service}
            serviceCode={codeById.get(serviceId) ?? ''}
            asOf={itinerary.asOf}
            actionError={isActed ? (optionsFailed ? OPTIONS_LOAD_FAILED : actionError) : null}
            onAssign={(slotId) => {
              const slot = service.slots.find((s) => s.id === slotId);
              if (slot) openAssign(serviceId, slot);
            }}
          />
        );
      })}

      {pending && (
        <AllocateSlotModal slot={pending.slot} options={options} onSubmit={(workerId) => confirm(pending, workerId)} onCancel={closeModal} />
      )}
    </div>
  );
}
