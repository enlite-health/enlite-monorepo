import { useTranslation } from 'react-i18next';
import { MetricCard, Heading } from '@presentation/components/atoms';
import type { ManagementDashboardData } from '@domain/entities/ManagementDashboard';

export function PrioridadesSection({
  data,
}: {
  data: ManagementDashboardData['prioridades'];
}): JSX.Element {
  const { t } = useTranslation();
  const p = 'admin.managementDashboard.prioridades.';

  return (
    <section data-testid="mgmt-prioridades" className="space-y-4">
      <Heading level={2} weight="semibold">
        {t('admin.managementDashboard.sections.prioridades')}
      </Heading>
      <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
        <MetricCard
          title={t(`${p}esperandoAgendamiento`)}
          value={data.completosEsperandoAgendamiento}
          subtitle={t(`${p}esperandoAgendamientoSub`)}
        />
        <MetricCard
          title={t(`${p}bloqueados`)}
          value={data.profesionalesBloqueados}
          subtitle={t(`${p}bloqueadosSub`)}
        />
      </div>
    </section>
  );
}
