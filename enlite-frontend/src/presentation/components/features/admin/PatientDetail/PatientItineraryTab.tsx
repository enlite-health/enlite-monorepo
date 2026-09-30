import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Heading } from '@presentation/components/atoms/Heading';
import { Text } from '@presentation/components/atoms/Text';
import { Card } from '@presentation/components/organisms/Card';
import { DetailSkeleton } from '@presentation/components/ui/skeletons';
import { AdminContractedServicesApiService } from '@infrastructure/http/AdminContractedServicesApiService';
import { usePatientItinerary, type ItineraryActionError } from '@hooks/admin/usePatientItinerary';
import type { PatientDetail } from '@domain/entities/PatientDetail';
import { patientAddressLabel } from '@domain/entities/PatientContractedService';
import { isVigenteAt } from '@domain/entities/PatientItinerary';
import type { ServiceTeamAllocation, ServiceTeamMember } from '@domain/entities/ServiceTeam';
import { ItinerarySection } from './ItinerarySection';
import { ItineraryEditAppointmentModal } from './ItineraryEditAppointmentModal';
import { ItineraryEventsPanel } from './ItineraryEventsPanel';
import { NewSubstitutionModal, type NewSubstitutionServiceOption } from './NewSubstitutionModal';

interface PatientItineraryTabProps {
  patient: PatientDetail;
}

interface EditingSlot {
  serviceId: string;
  slot: { id: string; weekday: number; startTime: string; endTime: string };
  currentWorkerId: string | null;
}

/** Código sintético quando as opções do modal não carregam — cai no texto `actionErrors.generic`. */
const OPTIONS_LOAD_FAILED: ItineraryActionError = { code: 'OPTIONS_LOAD_FAILED' };

/**
 * Aba "Itinerario" da ficha do paciente (D445 — layout de 2 colunas conforme o Figma, nó
 * 11340:76163). Coluna direita: "Agenda de Atenciones" — uma `ItinerarySection` por serviço
 * (D445.3). Coluna esquerda: "Próximos eventos/Substitución" (D445.3), com "Nuevo +" (D445.4) e
 * reemplazo permanente (D445.5). A escrita de alocação continua sendo SÓ pelo modal "Editar
 * agendamiento" (D445.3) — o mesmo `allocate` da Fase 12; ausência/substituto/reemplazo usam as
 * rotas da Fase 13 e a D445.5, direto pelo `AdminContractedServicesApiService` (o hook do
 * itinerário cobre só a leitura + `allocate`).
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
  const [showNew, setShowNew] = useState(false);
  const [newSubstitutionError, setNewSubstitutionError] = useState<string | null>(null);
  const [refreshSignal, setRefreshSignal] = useState(0);
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

  const newSubstitutionServices: NewSubstitutionServiceOption[] = itinerary.services.map((service) => {
    const allocations: ServiceTeamAllocation[] = service.slots
      .filter((slot) => slot.active)
      .flatMap((slot) =>
        slot.assignments
          .filter((a) => isVigenteAt(a, itinerary.asOf))
          .map((a) => ({ allocationId: a.allocationId, weekday: slot.weekday, startTime: slot.startTime, endTime: slot.endTime })),
      );
    return {
      serviceId: service.contractedServiceId,
      label: servicesById.get(service.contractedServiceId)?.label ?? service.contractedServiceId,
      allocations,
    };
  });

  function openEdit(serviceId: string, slotId: string): void {
    const service = itinerary!.services.find((s) => s.contractedServiceId === serviceId);
    const slot = service?.slots.find((s) => s.id === slotId);
    if (!slot) return;
    const covering = slot.assignments.find((a) => isVigenteAt(a, itinerary!.asOf)) ?? null;
    const openId = ++openRef.current;
    setEditing({
      serviceId,
      slot: { id: slot.id, weekday: slot.weekday, startTime: slot.startTime, endTime: slot.endTime },
      currentWorkerId: covering?.workerId ?? null,
    });
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
  }

  function confirmEdit(workerId: string): void {
    if (!editing) return;
    const { serviceId, slot } = editing;
    closeEdit();
    void allocate(serviceId, slot.id, workerId);
  }

  async function submitComplementary(serviceId: string, allocationId: string, date: string, substituteWorkerId: string | null, reasonCategory: string): Promise<void> {
    setNewSubstitutionError(null);
    try {
      await AdminContractedServicesApiService.registerAbsence(patient.id, serviceId, allocationId, {
        date,
        substituteWorkerId: substituteWorkerId ?? undefined,
        reasonCategory,
      });
      setShowNew(false);
    } catch {
      setNewSubstitutionError(ti('newSubstitutionModal.submitError'));
      return;
    } finally {
      refresh();
      setRefreshSignal((n) => n + 1);
    }
  }

  async function submitPermanent(serviceId: string, allocationId: string, newWorkerId: string, fromDate: string): Promise<void> {
    setNewSubstitutionError(null);
    try {
      await AdminContractedServicesApiService.replaceAllocation(patient.id, serviceId, allocationId, newWorkerId, fromDate);
      setShowNew(false);
    } catch {
      setNewSubstitutionError(ti('newSubstitutionModal.submitError'));
      return;
    } finally {
      refresh();
      setRefreshSignal((n) => n + 1);
    }
  }

  async function changeSubstitute(serviceId: string, absenceId: string, workerId: string | null): Promise<void> {
    try {
      await AdminContractedServicesApiService.setAbsenceSubstitute(patient.id, serviceId, absenceId, workerId);
    } finally {
      refresh();
      setRefreshSignal((n) => n + 1);
    }
  }

  async function cancelSubstitution(serviceId: string, absenceId: string): Promise<void> {
    try {
      await AdminContractedServicesApiService.cancelAbsence(patient.id, serviceId, absenceId);
    } finally {
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

      <div className="flex gap-5 items-start" data-testid="itinerario-colunas">
        <div className="flex-1 min-w-0">
          <ItineraryEventsPanel
            patientId={patient.id}
            asOf={itinerary.asOf}
            servicesById={servicesById}
            onNew={() => setShowNew(true)}
            onChangeSubstitute={(sid, aid, wid) => void changeSubstitute(sid, aid, wid)}
            onCancelSubstitution={(sid, aid) => void cancelSubstitution(sid, aid)}
            loadServiceOptions={loadOptions}
            refreshSignal={refreshSignal}
          />
        </div>

        <div className="flex-1 min-w-0" data-testid="itinerario-agenda-coluna">
          <Card rounded="lg" className="border-2 border-gray-600 !rounded-[20px] p-6 flex flex-col gap-4">
            <Heading level={1} as="h3" weight="semibold" color="secondary">
              {ti('scheduleColumnTitle')}
            </Heading>
            {itinerary.services.map((service) => {
              const serviceId = service.contractedServiceId;
              const isActed = actedServiceId === serviceId;
              return (
                <ItinerarySection
                  key={serviceId}
                  service={service}
                  serviceCode={codeById.get(serviceId) ?? ''}
                  addressLabel={servicesById.get(serviceId)?.addressLabel ?? ''}
                  asOf={itinerary.asOf}
                  actionError={isActed ? (editOptionsFailed ? OPTIONS_LOAD_FAILED : actionError) : null}
                  onEditSlot={(slotId) => openEdit(serviceId, slotId)}
                />
              );
            })}
          </Card>
        </div>
      </div>

      {editing && (
        <ItineraryEditAppointmentModal
          slot={editing.slot}
          addressLabel={servicesById.get(editing.serviceId)?.addressLabel ?? ''}
          options={editOptions}
          vacancyId={editVacancyId}
          currentWorkerId={editing.currentWorkerId}
          onSubmit={confirmEdit}
          onCancel={closeEdit}
        />
      )}

      {showNew && (
        <>
          <NewSubstitutionModal
            services={newSubstitutionServices}
            asOf={itinerary.asOf}
            loadOptions={loadOptions}
            onSubmitComplementary={(sid, aid, date, wid, reason) => void submitComplementary(sid, aid, date, wid, reason)}
            onSubmitPermanent={(sid, aid, wid, date) => void submitPermanent(sid, aid, wid, date)}
            onCancel={() => {
              setShowNew(false);
              setNewSubstitutionError(null);
            }}
          />
          {newSubstitutionError && (
            <Text
              size="sm"
              role="alert"
              color="inherit"
              className="text-red-600 fixed bottom-4 left-1/2 -translate-x-1/2 z-[60] bg-white rounded-lg px-4 py-2 shadow-lg"
              data-testid="itinerario-novo-erro-submit"
            >
              {newSubstitutionError}
            </Text>
          )}
        </>
      )}
    </div>
  );
}
