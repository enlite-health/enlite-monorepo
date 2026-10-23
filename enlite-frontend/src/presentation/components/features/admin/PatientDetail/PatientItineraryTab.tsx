import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router-dom';
import { Text } from '@presentation/components/atoms/Text';
import { DetailSkeleton } from '@presentation/components/ui/skeletons';
import { AdminContractedServicesApiService } from '@infrastructure/http/AdminContractedServicesApiService';
import { usePatientItinerary, type ItineraryActionError } from '@hooks/admin/usePatientItinerary';
import type { PatientDetail } from '@domain/entities/PatientDetail';
import { patientAddressLabel } from '@domain/entities/PatientContractedService';
import { isVigenteAt, type PatientItineraryService } from '@domain/entities/PatientItinerary';
import type { ExitDestination, ServiceTeamMember } from '@domain/entities/ServiceTeam';
import type { SubstitutionFlowIntent } from '@domain/entities/SubstitutionRequest';
import { AssembleItineraryButton } from './AssembleItineraryButton';
import { ItineraryEditAppointmentModal } from './ItineraryEditAppointmentModal';
import { ItineraryServiceList } from './itinerary/ItineraryServiceList';
import { ItineraryServiceScreen } from './itinerary/ItineraryServiceScreen';

interface PatientItineraryTabProps {
  patient: PatientDetail;
}

interface EditingSlot {
  serviceId: string;
  slot: { id: string; weekday: number; startTime: string; endTime: string };
  /** Todos os prestadores vigentes da faixa; cada um tem a SUA alocação (o que o "Quitar del itinerario" encerra). */
  vigentes: Array<{ workerId: string; allocationId: string }>;
  providersNeeded: number | null;
}

/** Código sintético quando as opções do modal não carregam — cai no texto `actionErrors.generic`. */
const OPTIONS_LOAD_FAILED: ItineraryActionError = { code: 'OPTIONS_LOAD_FAILED' };

/**
 * Aba "Itinerario" da ficha do paciente (spec 069) — o ROTEADOR da aba: "Itinerario listo" no topo e,
 * embaixo, a lista de serviços (B1) ou a tela de UM serviço (B2). O serviço aberto vem da URL
 * (`?serviceId=`, o atalho da vacante e o link do e-mail): um só serviço pula a lista; `serviceId`
 * que não é de um serviço ATIVO deste paciente cai na lista, sem erro. A escrita de alocação segue
 * sendo SÓ pelo modal "Editar agendamiento" (Horario fijo); a substituição é o fluxo "Nueva
 * sustitución" (F6) — aqui só sobe a intenção.
 */
export function PatientItineraryTab({ patient }: PatientItineraryTabProps): JSX.Element {
  const { t } = useTranslation();
  const ti = (key: string) => t(`admin.patients.detail.itinerary.${key}`);
  const { itinerary, status, loadOptions, allocate, actionError, refreshError, refresh } = usePatientItinerary(patient.id);
  const [editing, setEditing] = useState<EditingSlot | null>(null);
  const [editOptions, setEditOptions] = useState<ServiceTeamMember[] | null>(null);
  const [editVacancyId, setEditVacancyId] = useState<string | null>(null);
  const [editOptionsFailed, setEditOptionsFailed] = useState(false);
  const [actedServiceId, setActedServiceId] = useState<string | null>(null);
  const [refreshSignal, setRefreshSignal] = useState(0);
  const [removing, setRemoving] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const [removeScheduled, setRemoveScheduled] = useState<{ substitutionDates: string[]; futureEntryFrom: string | null } | null>(null);
  const [flowIntent, setFlowIntent] = useState<SubstitutionFlowIntent | null>(null);
  const [searchParams, setSearchParams] = useSearchParams();
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

  const { asOf } = itinerary;
  const codeById = new Map(patient.contractedServices.map((s) => [s.id, s.serviceCode]));
  const addressById = new Map((patient.addresses ?? []).map((a) => [a.id, a]));
  const servicesById = new Map(
    patient.contractedServices.map((s) => [
      s.id,
      {
        label: t(`admin.patients.detail.contractedServicesCard.serviceTypes.${s.serviceCode}`, s.serviceCode),
        addressLabel: s.addressId && addressById.has(s.addressId) ? patientAddressLabel(addressById.get(s.addressId)!) : ti('editModal.noVacancy'),
      },
    ]),
  );

  /** `serviceId` da URL: só vale se for de um serviço ATIVO deste paciente (o GET só traz os ativos); um serviço só pula a lista. */
  const serviceParam = searchParams.get('serviceId');
  const selected =
    itinerary.services.length === 1
      ? itinerary.services[0]
      : (itinerary.services.find((s) => s.contractedServiceId === serviceParam) ?? null);

  function setServiceParam(serviceId: string | null): void {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      if (serviceId) next.set('serviceId', serviceId);
      else next.delete('serviceId');
      return next;
    });
  }

  /** `slotId` vem de uma faixa que a própria tela desenhou: sempre existe em `service.slots`. */
  function openEdit(service: PatientItineraryService, slotId: string): void {
    const serviceId = service.contractedServiceId;
    const slot = service.slots.find((s) => s.id === slotId)!;
    const vigentes = slot.assignments.filter((a) => isVigenteAt(a, asOf)).map((a) => ({ workerId: a.workerId, allocationId: a.allocationId }));
    const openId = ++openRef.current;
    setEditing({
      serviceId,
      slot: { id: slot.id, weekday: slot.weekday, startTime: slot.startTime, endTime: slot.endTime },
      vigentes,
      providersNeeded: service.providersNeeded,
    });
    setRemoveError(null);
    setEditOptions(null);
    setEditVacancyId(null);
    setEditOptionsFailed(false);
    setActedServiceId(serviceId);
    void loadOptions(serviceId).then((result) => {
      if (openRef.current !== openId) return;
      if (result.status === 'ok') {
        setEditOptions(result.options);
        return;
      }
      setEditOptionsFailed(true);
    });
    void AdminContractedServicesApiService.getAllocationOptions(patient.id, serviceId).then(
      (r) => {
        if (openRef.current === openId) setEditVacancyId(r.vacancyId);
      },
      () => {
        // O link "ir a la vacante" só some — a alocação continua funcionando sem ele.
      },
    );
  }

  function closeEdit(): void {
    openRef.current += 1;
    setEditing(null);
    setRemoveError(null);
    setRemoveScheduled(null);
  }

  function confirmEdit({ serviceId, slot }: EditingSlot, workerId: string): void {
    closeEdit();
    void allocate(serviceId, slot.id, workerId);
  }

  /** "Quitar del itinerario" (Fase 4): motivo + destino; erro fica no painel (traduzido por CÓDIGO), sucesso fecha o modal. */
  async function removeFromItinerary({ serviceId }: EditingSlot, reasonCategory: string, destination: ExitDestination, allocationId: string, cancelScheduled?: boolean): Promise<void> {
    setRemoving(true);
    setRemoveError(null);
    setRemoveScheduled(null);
    try {
      await AdminContractedServicesApiService.endAllocation(patient.id, serviceId, allocationId, {
        reasonCategory,
        destination,
        ...(cancelScheduled ? { cancelScheduled: true } : {}),
      });
      closeEdit();
    } catch (err) {
      const code = (err as { code?: string } | null)?.code;
      if (code === 'WORKER_HAS_SCHEDULED_ATTENDANCES') {
        const d = (err as { details?: { substitutionDates?: string[]; futureEntryFrom?: string | null } }).details;
        setRemoveScheduled({ substitutionDates: d?.substitutionDates ?? [], futureEntryFrom: d?.futureEntryFrom ?? null });
        return;
      }
      setRemoveError(
        code ? t(`admin.patients.detail.itinerary.actionErrors.${code}`, ti('removePanel.submitError')) : ti('removePanel.submitError'),
      );
    } finally {
      setRemoving(false);
      refresh();
      setRefreshSignal((n) => n + 1);
    }
  }

  return (
    <div data-testid="itinerario-aba" className="flex flex-col gap-6">
      {refreshError && (
        <Text data-testid="itinerario-refresh-erro" size="sm" role="alert" color="inherit" className="text-red-600">
          {ti('refreshError')}
        </Text>
      )}

      <AssembleItineraryButton patientId={patient.id} assembledAt={itinerary.assembledAt} onAssembled={refresh} />

      {selected ? (
        <ItineraryServiceScreen
          patientId={patient.id}
          service={selected}
          serviceCode={codeById.get(selected.contractedServiceId) ?? ''}
          label={servicesById.get(selected.contractedServiceId)?.label ?? selected.contractedServiceId}
          addressLabel={servicesById.get(selected.contractedServiceId)?.addressLabel ?? ''}
          asOf={asOf}
          canGoBack={itinerary.services.length > 1}
          onBack={() => setServiceParam(null)}
          onSubstitutionFlow={setFlowIntent}
          actionError={actedServiceId === selected.contractedServiceId ? (editOptionsFailed ? OPTIONS_LOAD_FAILED : actionError) : null}
          onEditSlot={(slotId) => openEdit(selected, slotId)}
          refreshKey={refreshSignal}
        />
      ) : (
        <ItineraryServiceList
          items={itinerary.services.map((service) => ({
            service,
            label: servicesById.get(service.contractedServiceId)?.label ?? service.contractedServiceId,
            addressLabel: servicesById.get(service.contractedServiceId)?.addressLabel ?? '',
          }))}
          horizonDays={itinerary.horizonDays}
          onOpen={setServiceParam}
        />
      )}

      {/* F6 monta aqui o fluxo "Nueva sustitución" a partir da intenção (novo · cambiar · asignar). */}
      {flowIntent && <div hidden data-testid="itinerario-fluxo-ponto-de-montagem" data-intent={flowIntent.kind} />}

      {editing && (
        <ItineraryEditAppointmentModal
          slot={editing.slot}
          addressLabel={servicesById.get(editing.serviceId)?.addressLabel ?? ''}
          options={editOptions}
          vacancyId={editVacancyId}
          vigentes={editing.vigentes}
          providersNeeded={editing.providersNeeded}
          onSubmit={(workerId) => confirmEdit(editing, workerId)}
          onCancel={closeEdit}
          onRemove={(reasonCategory, destination, allocationId, cancelScheduled) => void removeFromItinerary(editing, reasonCategory, destination, allocationId, cancelScheduled)}
          removeScheduled={removeScheduled}
          onRemoveScheduledDismiss={() => setRemoveScheduled(null)}
          removing={removing}
          removeError={removeError}
        />
      )}
    </div>
  );
}
