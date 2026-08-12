import { useTranslation } from 'react-i18next';
import { Info, Clock, AlarmClock, Users, HelpCircle } from 'lucide-react';
import { MetricCard, Text } from '@presentation/components/atoms';
import type { ManagementDashboardData } from '@domain/entities/ManagementDashboard';
import { SectionHeader } from './SectionHeader';
import { useMetricHelp } from './useMetricHelp';

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
  const { helpProps, openHelp, helpAriaLabel, helpDrawer } = useMetricHelp();

  return (
    <section data-testid="mgmt-equipo-armada" className="space-y-4">
      <SectionHeader
        icon={Clock}
        accent="cyan"
        title={t('admin.managementDashboard.sections.equipoArmada')}
        hint={t('admin.managementDashboard.sections.equipoArmadaHint')}
      />

      <div className="grid grid-cols-1 gap-6 md:grid-cols-2 lg:grid-cols-3">
        <MetricCard
          icon={Clock}
          accent="cyan"
          title={t(`${p}horasTotais`)}
          {...helpProps('horasTotais')}
          value={horas.totais}
          subtitle={t(`${p}cobertura`, {
            con: horas.coberturaConSchedule,
            sin: horas.coberturaSinSchedule,
          })}
        />
        <MetricCard
          icon={AlarmClock}
          accent="learn"
          title={t(`${p}horasAPreencher`)}
          {...helpProps('horasAPreencher')}
          value={horas.aPreencher}
          subtitle={t(`${p}horasAPreencherSub`)}
        />

        <div
          data-testid="mgmt-armada-clasificacion"
          className="flex flex-col justify-center gap-3 rounded-2xl border border-dashed border-[#FFB607]/60 bg-[#FFB607]/10 p-6"
        >
          <div className="mb-1 flex items-center gap-2">
            <Users className="h-4 w-4 shrink-0 text-[#D98A00]" />
            <Text as="p" size="xs" weight="semibold" className="uppercase tracking-wide text-[#B45309]">
              {t(`${p}clasificacionTitulo`)}
            </Text>
            <button
              type="button"
              onClick={() => openHelp('casosSinMedir')}
              aria-label={helpAriaLabel}
              title={helpAriaLabel}
              data-testid="metric-help"
              className="ml-auto rounded-full p-1 text-[#D98A00]/60 transition-colors hover:bg-[#FFB607]/20 hover:text-[#B45309]"
            >
              <HelpCircle className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>
          <div className="flex items-start gap-2">
            <Info className="mt-0.5 h-4 w-4 shrink-0 text-[#D98A00]" />
            <Text as="p" size="sm" weight="medium" className="text-[#7A4A08] dark:text-amber-200">
              {t(`${p}pendenteClasificacao`, { count: equipoArmada.pendenteClasificacao })}
            </Text>
          </div>
          <div className="flex items-start gap-2">
            <Info className="mt-0.5 h-4 w-4 shrink-0 text-[#D98A00]" />
            <Text as="p" size="sm" weight="medium" className="text-[#7A4A08] dark:text-amber-200">
              {t(`${p}semConfig`, { count: equipoArmada.semConfig })}
            </Text>
          </div>
        </div>
      </div>

      {helpDrawer}
    </section>
  );
}
