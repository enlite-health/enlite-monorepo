import { useTranslation } from 'react-i18next';
import { Heading } from '@presentation/components/atoms/Heading';
import { Text } from '@presentation/components/atoms/Text';
import { TableSkeleton } from '@presentation/components/ui/skeletons';
import { useServiceTeam } from '@hooks/admin/useServiceTeam';
import { patientAddressLabel } from '@domain/entities/PatientContractedService';
import type { PatientAddressDetail, PatientContractedServiceDetail } from '@domain/entities/PatientDetail';
import { ServiceTeamBoard } from './ServiceTeamBoard';
import type { ServiceTeamPatientHeader } from './ServiceTeamProviderModal';

interface ServiceTeamSectionProps {
  patientId: string;
  patientHeader?: ServiceTeamPatientHeader;
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
export function ServiceTeamSection({ patientId, patientHeader, service, address, selectionNonce }: ServiceTeamSectionProps): JSX.Element {
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

  // Rodada 2 (decisão A, DIV-6): título "Enquadre Terapêutico: <local>" no formato do Figma — o
  // MESMO rótulo `careLocationOptions.<code>` que a tabela seletora da aba mostra, nunca outra
  // fonte. `address` (a prop) segue existindo — usado só se `careLocation` vier vazio (serviço
  // sem local informado, mas com endereço vinculado).
  const localLabel = service.careLocation
    ? t(`admin.patients.detail.contractedServicesCard.careLocationOptions.${service.careLocation}`, service.careLocation)
    : address
      ? patientAddressLabel(address)
      : tc('noAddress');

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
            {tc('title', { local: localLabel })}
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
            <ServiceTeamBoard
              patientId={patientId}
              patientHeader={patientHeader}
              serviceId={service.id}
              team={team}
              onReject={reject}
              onRevert={revert}
              onSubstitute={substitute}
              actionError={actionError}
            />
          )}
        </>
      )}
    </div>
  );
}
