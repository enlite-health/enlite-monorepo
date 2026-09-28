import { useTranslation } from 'react-i18next';
import { Heading } from '@presentation/components/atoms/Heading';
import { Text } from '@presentation/components/atoms/Text';
import { TableSkeleton } from '@presentation/components/ui/skeletons';
import { useServiceTeam } from '@hooks/admin/useServiceTeam';
import { patientAddressLabel } from '@domain/entities/PatientContractedService';
import type { PatientAddressDetail, PatientContractedServiceDetail } from '@domain/entities/PatientDetail';
import { ServiceTeamBoard } from './ServiceTeamBoard';

interface ServiceTeamSectionProps {
  patientId: string;
  service: PatientContractedServiceDetail | null;
  address: PatientAddressDetail | null;
  selectionNonce: number;
}

/**
 * Quadro C — DX-10.10 (1). Vive DENTRO do `ServicosContratadosCard` (a MESMA aba "Servicio
 * Contratado", critério 20: `patientTabs.ts`/`screenRegistry.ts` intocados), logo depois da
 * `<Table>`. `service`/`address` vêm da linha SELECIONADA (o card já resolveu esse par —
 * critério "lido do dado da linha, nunca de outra chamada"); este componente só busca o TIME
 * (via `useServiceTeam`, P18) e o renderiza (via `ServiceTeamBoard`, P20).
 */
export function ServiceTeamSection({ patientId, service, address, selectionNonce }: ServiceTeamSectionProps): JSX.Element {
  const { t } = useTranslation();
  const tc = (key: string, options?: Record<string, unknown>) => t(`admin.patients.detail.serviceTeam.${key}`, options);
  const { team, status, reject, revert, substitute, actionError, refreshError } = useServiceTeam(patientId, service?.id ?? null, selectionNonce);

  if (!service) {
    return (
      <div data-testid="quadro-c-secao" className="flex flex-col gap-3">
        <Text data-testid="quadro-c-sem-selecao" size="sm" color="secondary">
          {tc('emptySelection')}
        </Text>
      </div>
    );
  }

  // O MESMO rótulo que a linha mostra (`serviceTypes.<code>`) — nunca outra fonte.
  const serviceLabel = t(`admin.patients.detail.contractedServicesCard.serviceTypes.${service.serviceCode}`, service.serviceCode);
  const addressLabel = address ? patientAddressLabel(address) : tc('noAddress');

  return (
    <div data-testid="quadro-c-secao" className="flex flex-col gap-3">
      {status === 'loading' && <TableSkeleton />}

      {status === 'error' && (
        <Text data-testid="quadro-c-erro" size="sm" role="alert" color="inherit" className="text-red-600">
          {tc('loadError')}
        </Text>
      )}

      {/* forbidden: nada — o card inteiro já é `ContainerGate resource="patient_services"`. */}

      {status === 'ok' && team && (
        <>
          <Heading level={2} as="h4" weight="semibold" color="primary" data-testid="quadro-c-titulo">
            {tc('title', { service: serviceLabel, address: addressLabel })}
          </Heading>
          {refreshError && (
            <Text data-testid="quadro-c-refresh-erro" size="sm" role="alert" color="inherit" className="text-red-600">
              {tc('refreshError')}
            </Text>
          )}
          {team.vacancyId === null ? (
            <Text data-testid="quadro-c-sem-vaga" size="sm" color="secondary">
              {tc('noVacancy')}
            </Text>
          ) : (
            <ServiceTeamBoard team={team} onReject={reject} onRevert={revert} onSubstitute={substitute} actionError={actionError} />
          )}
        </>
      )}
    </div>
  );
}
