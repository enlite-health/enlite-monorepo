import { useTranslation } from 'react-i18next';
import { Filter, CalendarCheck } from 'lucide-react';
import { Text, MetricCard } from '@presentation/components/atoms';
import type { ManagementDashboardData } from '@domain/entities/ManagementDashboard';
import { SectionHeader } from './SectionHeader';

/**
 * Ordem canônica das colunas do funil (rótulos via i18n, nunca enum cru).
 * Cada etapa tem uma cor de "ponto" pra leitura de fluxo num relance: verde =
 * avançou bem, vermelho = travou, cinza = fim de linha.
 */
const FUNNEL_ORDER: Array<{ key: keyof ManagementDashboardData['funnel']; dot: string; value: string }> = [
  { key: 'invitados', dot: 'bg-primary', value: 'text-primary' },
  { key: 'bloqueados', dot: 'bg-[#FF575C]', value: 'text-[#D42B30]' },
  { key: 'preScreening', dot: 'bg-[#06ADDD]', value: 'text-[#0E7C9E]' },
  { key: 'completos', dot: 'bg-[#8932FD]', value: 'text-[#6B21C7]' },
  { key: 'agendados', dot: 'bg-[#FFB607]', value: 'text-[#B45309]' },
  { key: 'seleccionados', dot: 'bg-[#10B981]', value: 'text-[#0F766E]' },
  { key: 'rechazados', dot: 'bg-slate-400', value: 'text-slate-500' },
];

export function FunnelTotalsSection({
  funnel,
  encuadres,
}: {
  funnel: ManagementDashboardData['funnel'];
  encuadres: ManagementDashboardData['encuadres'];
}): JSX.Element {
  const { t } = useTranslation();
  const p = 'admin.managementDashboard.funnel.';

  return (
    <section data-testid="mgmt-funnel" className="space-y-4">
      <SectionHeader
        icon={Filter}
        accent="clinic"
        title={t('admin.managementDashboard.sections.funnel')}
        hint={t('admin.managementDashboard.sections.funnelHint')}
      />

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <MetricCard
          icon={CalendarCheck}
          accent="primary"
          title={t(`${p}agendadosSemana`)}
          value={encuadres.agendadosEstaSemana}
          subtitle={t(`${p}agendadosSemanaSub`)}
          className="lg:col-span-1"
        />
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:col-span-2 lg:grid-cols-4">
          {FUNNEL_ORDER.map(({ key, dot, value }) => (
            <div
              key={key}
              data-testid={`mgmt-funnel-${key}`}
              className="flex flex-col gap-1 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-700 dark:bg-slate-800"
            >
              <div className="flex items-center gap-1.5">
                <span className={`h-2 w-2 shrink-0 rounded-full ${dot}`} aria-hidden="true" />
                <Text as="p" size="xs" weight="medium" className="text-slate-500">
                  {t(`${p}stage.${key}`)}
                </Text>
              </div>
              <p className={`font-poppins text-2xl font-bold leading-tight ${value} dark:text-slate-100`}>
                {funnel[key]}
              </p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
