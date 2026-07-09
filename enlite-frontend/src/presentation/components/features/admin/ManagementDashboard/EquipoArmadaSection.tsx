import { useTranslation } from 'react-i18next';
import { Info } from 'lucide-react';
import { MetricCard, Heading, Text } from '@presentation/components/atoms';
import type { ManagementDashboardData } from '@domain/entities/ManagementDashboard';

/**
 * Seção "Equipe Armada" — leitura honesta do quadro (nunca um 0 falso):
 * horas totais/a cobrir + cobertura de horário, e os casos que NÃO dá pra
 * julgar (sem configuração de dotação / sem classificação de papel).
 */
export function EquipoArmadaSection({
  equipoArmada,
  horas,
}: {
  equipoArmada: ManagementDashboardData['equipoArmada'];
  horas: ManagementDashboardData['horas'];
}): JSX.Element {
  const { t } = useTranslation();
  const p = 'admin.managementDashboard.equipoArmada.';

  return (
    <section data-testid="mgmt-equipo-armada" className="space-y-4">
      <Heading level={2} weight="semibold">
        {t('admin.managementDashboard.sections.equipoArmada')}
      </Heading>

      <div className="grid grid-cols-1 gap-6 md:grid-cols-2 lg:grid-cols-3">
        <MetricCard
          title={t(`${p}horasTotais`)}
          value={horas.totais}
          subtitle={t(`${p}cobertura`, {
            con: horas.coberturaConSchedule,
            sin: horas.coberturaSinSchedule,
          })}
        />
        <MetricCard title={t(`${p}horasAPreencher`)} value={horas.aPreencher} subtitle={t(`${p}horasAPreencherSub`)} />

        <div
          data-testid="mgmt-armada-clasificacion"
          className="flex flex-col justify-center gap-3 rounded-2xl border border-dashed border-amber-300 bg-amber-50 p-6 dark:border-amber-500/50 dark:bg-amber-500/10"
        >
          <div className="flex items-start gap-2">
            <Info className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
            <Text as="p" size="sm" weight="medium" className="text-amber-800 dark:text-amber-200">
              {t(`${p}pendenteClasificacao`, { count: equipoArmada.pendenteClasificacao })}
            </Text>
          </div>
          <div className="flex items-start gap-2">
            <Info className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
            <Text as="p" size="sm" weight="medium" className="text-amber-800 dark:text-amber-200">
              {t(`${p}semConfig`, { count: equipoArmada.semConfig })}
            </Text>
          </div>
        </div>
      </div>
    </section>
  );
}
