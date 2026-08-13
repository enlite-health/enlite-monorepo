import { useTranslation } from 'react-i18next';
import { Flame, CalendarClock, Ban, UserX } from 'lucide-react';
import { MetricCard } from '@presentation/components/atoms';
import type { ManagementDashboardData } from '@domain/entities/ManagementDashboard';
import { SectionHeader } from './SectionHeader';
import { useMetricHelp } from './useMetricHelp';

export function PrioridadesSection({
  data,
}: {
  data: ManagementDashboardData['prioridades'];
}): JSX.Element {
  const { t } = useTranslation();
  const p = 'admin.managementDashboard.prioridades.';
  const { helpProps, helpDrawer } = useMetricHelp();

  return (
    <section data-testid="mgmt-prioridades" className="space-y-4">
      <SectionHeader
        icon={Flame}
        accent="coordination"
        title={t('admin.managementDashboard.sections.prioridades')}
        hint={t('admin.managementDashboard.sections.prioridadesHint')}
      />
      <div className="grid grid-cols-1 gap-6 md:grid-cols-3">
        <MetricCard
          icon={CalendarClock}
          accent="cyan"
          title={t(`${p}esperandoAgendamiento`)}
          {...helpProps('esperandoAgendamiento')}
          value={data.completosEsperandoAgendamiento}
          subtitle={t(`${p}esperandoAgendamientoSub`)}
        />
        <MetricCard
          icon={UserX}
          accent="coordination"
          title={t(`${p}bloqueadosAlPostularse`)}
          value={data.bloqueadosAlPostularse}
          subtitle={t(`${p}bloqueadosAlPostularseSub`)}
        />
        <MetricCard
          icon={Ban}
          accent="neutral"
          title={t(`${p}registrosIncompletos`)}
          {...helpProps('profesionalesBloqueados')}
          value={data.registrosIncompletos}
          subtitle={t(`${p}registrosIncompletosSub`)}
        />
      </div>

      {helpDrawer}
    </section>
  );
}
