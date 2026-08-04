import { useTranslation } from 'react-i18next';
import { UserPlus, UserCheck, UserCog, UserX, Sparkles, ClipboardList } from 'lucide-react';
import { MetricCard } from '@presentation/components/atoms';
import type { ManagementDashboardData } from '@domain/entities/ManagementDashboard';
import { SectionHeader } from './SectionHeader';
import { useMetricHelp } from './useMetricHelp';

export function CadastrosSection({
  data,
}: {
  data: ManagementDashboardData['cadastros'];
}): JSX.Element {
  const { t } = useTranslation();
  const p = 'admin.managementDashboard.cadastros.';
  const { helpProps, helpDrawer } = useMetricHelp();

  return (
    <section data-testid="mgmt-cadastros" className="space-y-4">
      <SectionHeader
        icon={ClipboardList}
        accent="primary"
        title={t('admin.managementDashboard.sections.cadastros')}
        hint={t('admin.managementDashboard.sections.cadastrosHint')}
      />
      <div className="grid grid-cols-2 gap-6 md:grid-cols-3 lg:grid-cols-5">
        <MetricCard icon={UserPlus} accent="primary" title={t(`${p}leads`)} {...helpProps('leads')} value={data.leads} subtitle={t(`${p}leadsSub`)} />
        <MetricCard icon={UserCheck} accent="success" title={t(`${p}completos`)} {...helpProps('completosRegistros')} value={data.completos} subtitle={t(`${p}completosSub`)} />
        <MetricCard
          icon={UserCog}
          accent="clinic"
          title={t(`${p}alocados`)}
          {...helpProps('alocados')}
          value={data.alocados}
          subtitle={t(`${p}alocadosSub`, {
            activos: data.alocadosActivos,
            guardias: data.alocadosCubriendoGuardias,
          })}
        />
        <MetricCard icon={UserX} accent="coordination" title={t(`${p}incompletos`)} {...helpProps('incompletos')} value={data.incompletos} subtitle={t(`${p}incompletosSub`)} />
        <MetricCard icon={Sparkles} accent="learn" title={t(`${p}nuevosMes`)} {...helpProps('nuevosMes')} value={data.nuevosCompletosMes} subtitle={t(`${p}nuevosMesSub`)} />
      </div>

      {helpDrawer}
    </section>
  );
}
