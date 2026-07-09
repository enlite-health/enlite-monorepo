import { useTranslation } from 'react-i18next';
import { ShieldCheck, Hammer, HeartPulse, Briefcase, PauseCircle, LayoutGrid } from 'lucide-react';
import { MetricCard } from '@presentation/components/atoms';
import type { ManagementDashboardData } from '@domain/entities/ManagementDashboard';
import { SectionHeader } from './SectionHeader';
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
      <SectionHeader
        icon={LayoutGrid}
        accent="primary"
        title={t('admin.managementDashboard.sections.bigNumbers')}
        hint={t('admin.managementDashboard.sections.bigNumbersHint')}
      />
      <div className="grid grid-cols-1 gap-6 md:grid-cols-2 lg:grid-cols-3">
        <MetricCard icon={ShieldCheck} accent="success" title={t(`${p}equiposArmados`)} value={data.equiposArmados} subtitle={t(`${p}equiposArmadosSub`)} />
        <MetricCard icon={Hammer} accent="learn" title={t(`${p}equiposPorArmar`)} value={data.equiposPorArmar} subtitle={t(`${p}equiposPorArmarSub`)} />
        <MetricCard icon={HeartPulse} accent="care" title={t(`${p}pacientesActivos`)} value={data.pacientesActivos} subtitle={t(`${p}pacientesActivosSub`)} />
        <MetricCard icon={Briefcase} accent="clinic" title={t(`${p}vacantesAbiertas`)} value={data.vacantesAbiertas} subtitle={t(`${p}vacantesAbiertasSub`)} />
        <MetricCard icon={PauseCircle} accent="neutral" title={t(`${p}vacantesPausadas`)} value={data.vacantesPausadas} subtitle={t(`${p}vacantesPausadasSub`)} />
        <GapNotice labelKey={`${p}ubicaciones`} />
      </div>
    </section>
  );
}
