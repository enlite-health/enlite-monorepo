import { useTranslation } from 'react-i18next';
import { MetricCard, Heading } from '@presentation/components/atoms';
import type { ManagementDashboardData } from '@domain/entities/ManagementDashboard';

export function CadastrosSection({
  data,
}: {
  data: ManagementDashboardData['cadastros'];
}): JSX.Element {
  const { t } = useTranslation();
  const p = 'admin.managementDashboard.cadastros.';

  return (
    <section data-testid="mgmt-cadastros" className="space-y-4">
      <Heading level={2} weight="semibold">
        {t('admin.managementDashboard.sections.cadastros')}
      </Heading>
      <div className="grid grid-cols-2 gap-6 md:grid-cols-3 lg:grid-cols-5">
        <MetricCard title={t(`${p}leads`)} value={data.leads} />
        <MetricCard title={t(`${p}completos`)} value={data.completos} />
        <MetricCard title={t(`${p}alocados`)} value={data.alocados} />
        <MetricCard title={t(`${p}incompletos`)} value={data.incompletos} />
        <MetricCard title={t(`${p}nuevosMes`)} value={data.nuevosCompletosMes} subtitle={t(`${p}nuevosMesSub`)} />
      </div>
    </section>
  );
}
