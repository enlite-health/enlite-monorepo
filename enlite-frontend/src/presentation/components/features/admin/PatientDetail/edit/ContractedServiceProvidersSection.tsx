import { useTranslation } from 'react-i18next';
import type { PatientContractedServiceProvider } from '@domain/entities/PatientDetail';
import { Text } from '@presentation/components/atoms/Text';
import { workerLabel } from '../workerLabel';

interface Props {
  serviceId: string;
  providers: PatientContractedServiceProvider[];
}

/**
 * Alocação anterior ao itinerário — SÓ LEITURA (Fase 14, DX-14.2). Desde a Fase 14 nenhuma rota
 * escreve nesta alocação: a alocação é pela aba do itinerário. A seção só existe quando o serviço
 * tem linha antiga; sem linha, não renderiza nada. Nenhum botão, nenhum input.
 */
export function ContractedServiceProvidersSection({ serviceId, providers }: Props): JSX.Element | null {
  const { t } = useTranslation();
  const te = (k: string) => t(`admin.patients.editDrawer.${k}`);

  if (providers.length === 0) return null;

  return (
    <div className="flex flex-col gap-3 pt-3 border-t border-slate-100" data-testid={`providers-section-${serviceId}`}>
      <Text size="sm" weight="semibold" color="secondary">{te('legacyProvidersTitle')}</Text>
      <ul className="flex flex-col gap-2">
        {providers.map((p) => (
          <li key={p.id} className="flex items-center justify-between gap-2 text-sm" data-testid={`provider-row-${p.id}`}>
            <Text as="span" size="sm">
              {workerLabel(t, p.workerId, p.workerName)} ·{p.weeklyHours ?? '—'}h/sem ·{' '}
              {p.active ? te('providerActive') : te('providerInactive')}
            </Text>
          </li>
        ))}
      </ul>
    </div>
  );
}
