import { useTranslation } from 'react-i18next';
import { Flame, CalendarClock, Ban } from 'lucide-react';
import { MetricCard } from '@presentation/components/atoms';
import type { ManagementDashboardData } from '@domain/entities/ManagementDashboard';
import { SectionHeader } from './SectionHeader';

export function PrioridadesSection({
  data,
}: {
  data: ManagementDashboardData['prioridades'];
}): JSX.Element {
  const { t } = useTranslation();
  const p = 'admin.managementDashboard.prioridades.';

  return (
    <section data-testid="mgmt-prioridades" className="space-y-4">
      <SectionHeader
        icon={Flame}
        accent="coordination"
        title={t('admin.managementDashboard.sections.prioridades')}
        hint={t('admin.managementDashboard.sections.prioridadesHint')}
      />
      <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
        <MetricCard
          icon={CalendarClock}
          accent="cyan"
          title={t(`${p}esperandoAgendamiento`)}
          value={data.completosEsperandoAgendamiento}
          subtitle={t(`${p}esperandoAgendamientoSub`)}
        />
        <MetricCard
          icon={Ban}
          accent="coordination"
          title={t(`${p}bloqueados`)}
          value={data.profesionalesBloqueados}
          subtitle={t(`${p}bloqueadosSub`)}
        />
      </div>
    </section>
  );
}
