import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Heading } from '@presentation/components/atoms/Heading';
import { Select } from '@presentation/components/atoms/Select';
import { Button } from '@presentation/components/atoms/Button';
import type { ServiceTeamAllocation, ServiceTeamMember } from '@domain/entities/ServiceTeam';
import type { AllocationOptionsLoad } from '@hooks/admin/usePatientItinerary';
import { SubstitutionDayModal } from './SubstitutionDayModal';

export interface NewSubstitutionServiceOption {
  serviceId: string;
  label: string;
  allocations: ServiceTeamAllocation[];
}

interface NewSubstitutionModalProps {
  services: NewSubstitutionServiceOption[];
  asOf: string;
  loadOptions: (serviceId: string) => Promise<AllocationOptionsLoad>;
  onSubmitComplementary: (serviceId: string, allocationId: string, date: string, substituteWorkerId: string | null) => void;
  onSubmitPermanent: (serviceId: string, allocationId: string, newWorkerId: string, fromDate: string) => void;
  onCancel: () => void;
}

/**
 * "Nuevo +" (D445.4/D445.5): escolhe o serviço (só quando o paciente tem mais de um serviço
 * contratado com faixa vigente), depois REUSA `SubstitutionDayModal` — o MESMO componente do
 * botão "Sustituir un día" em `ServiceTeamBoard` — com as faixas e os Seleccionados DAQUELE
 * serviço. `onSubmitPermanent` liga o modo "Entero" (D445.5); sem ele o modal seria só
 * "Complementar". Nenhuma segunda implementação do cascata faixa→data→substituto.
 */
export function NewSubstitutionModal({
  services,
  asOf,
  loadOptions,
  onSubmitComplementary,
  onSubmitPermanent,
  onCancel,
}: NewSubstitutionModalProps): JSX.Element {
  const { t } = useTranslation();
  const tn = (key: string) => t(`admin.patients.detail.itinerary.newSubstitutionModal.${key}`, key);
  const [serviceId, setServiceId] = useState(services.length === 1 ? services[0].serviceId : '');
  const [options, setOptions] = useState<ServiceTeamMember[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);

  useEffect(() => {
    if (!serviceId) return;
    let cancelled = false;
    setOptions(null);
    setLoadFailed(false);
    void loadOptions(serviceId).then((result) => {
      if (cancelled) return;
      if (result.status === 'ok') setOptions(result.options);
      else setLoadFailed(true);
    });
    return () => {
      cancelled = true;
    };
  }, [serviceId, loadOptions]);

  const service = services.find((s) => s.serviceId === serviceId) ?? null;

  if (!service) {
    return (
      <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50" data-testid="itinerario-novo-modal">
        <div className="bg-white rounded-2xl p-6 w-full max-w-sm shadow-xl flex flex-col gap-4">
          <Heading level={3} className="text-primary">
            {tn('title')}
          </Heading>
          <Select
            data-testid="itinerario-novo-servico"
            options={services.map((s) => ({ value: s.serviceId, label: s.label }))}
            value={serviceId}
            onValueChange={setServiceId}
            placeholder={tn('servicePlaceholder')}
          />
          <Button variant="outline" size="sm" onClick={onCancel} data-testid="itinerario-novo-cancelar">
            {tn('cancel')}
          </Button>
        </div>
      </div>
    );
  }

  if (loadFailed) {
    return (
      <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50" data-testid="itinerario-novo-modal">
        <div className="bg-white rounded-2xl p-6 w-full max-w-sm shadow-xl flex flex-col gap-4">
          <Heading level={3} className="text-primary">
            {tn('title')}
          </Heading>
          <p data-testid="itinerario-novo-erro">{tn('loadOptionsError')}</p>
          <Button variant="outline" size="sm" onClick={onCancel} data-testid="itinerario-novo-cancelar">
            {tn('cancel')}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <SubstitutionDayModal
      allocations={service.allocations}
      selected={options ?? []}
      asOf={asOf}
      onSubmit={(allocationId, date, substituteWorkerId) => onSubmitComplementary(service.serviceId, allocationId, date, substituteWorkerId)}
      onSubmitPermanent={(allocationId, newWorkerId, fromDate) => onSubmitPermanent(service.serviceId, allocationId, newWorkerId, fromDate)}
      onCancel={onCancel}
    />
  );
}
