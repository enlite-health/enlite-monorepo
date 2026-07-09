import { useTranslation } from 'react-i18next';
import { MetricCard, Heading } from '@presentation/components/atoms';
import type { ManagementDashboardData } from '@domain/entities/ManagementDashboard';
import { GapNotice } from './GapNotice';

export function BigNumbersSection({
  data,
}: {
  data: ManagementDashboardData['bigNumbers'];
}): JSX.Element {
  const { t } = useTranslation();
  const p = 'admin.managementDashboard.bigNumbers.';

  return (
    <section data-testid="mgmt-big-numbers" className="space-y-4">
      <Heading level={2} weight="semibold">
        {t('admin.managementDashboard.sections.bigNumbers')}
      </Heading>
      <div className="grid grid-cols-1 gap-6 md:grid-cols-2 lg:grid-cols-3">
        <MetricCard title={t(`${p}equiposArmados`)} value={data.equiposArmados} subtitle={t(`${p}equiposArmadosSub`)} />
        <MetricCard title={t(`${p}equiposPorArmar`)} value={data.equiposPorArmar} subtitle={t(`${p}equiposPorArmarSub`)} />
        <MetricCard title={t(`${p}pacientesActivos`)} value={data.pacientesActivos} />
        <MetricCard title={t(`${p}vacantesAbiertas`)} value={data.vacantesAbiertas} />
        <MetricCard title={t(`${p}vacantesPausadas`)} value={data.vacantesPausadas} />
        <GapNotice labelKey={`${p}ubicaciones`} />
        <GapNotice labelKey={`${p}horas`} />
      </div>
    </section>
  );
}
