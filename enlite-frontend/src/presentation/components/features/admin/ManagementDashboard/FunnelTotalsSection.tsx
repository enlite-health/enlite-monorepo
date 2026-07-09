import { useTranslation } from 'react-i18next';
import { Heading, Text, MetricCard } from '@presentation/components/atoms';
import type { ManagementDashboardData } from '@domain/entities/ManagementDashboard';

/** Ordem canônica das colunas do funil (rótulos via i18n, nunca enum cru). */
const FUNNEL_ORDER: Array<keyof ManagementDashboardData['funnel']> = [
  'invitados',
  'bloqueados',
  'preScreening',
  'completos',
  'agendados',
  'seleccionados',
  'rechazados',
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
      <Heading level={2} weight="semibold">
        {t('admin.managementDashboard.sections.funnel')}
      </Heading>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <MetricCard
          title={t(`${p}agendadosSemana`)}
          value={encuadres.agendadosEstaSemana}
          subtitle={t(`${p}agendadosSemanaSub`)}
          className="lg:col-span-1"
        />
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:col-span-2 lg:grid-cols-4">
          {FUNNEL_ORDER.map((key) => (
            <div
              key={key}
              data-testid={`mgmt-funnel-${key}`}
              className="flex flex-col justify-between rounded-2xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-700 dark:bg-slate-800"
            >
              <Text as="p" size="xs" weight="medium" className="text-slate-500">
                {t(`${p}stage.${key}`)}
              </Text>
              <Heading level={2} weight="bold">
                {funnel[key]}
              </Heading>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
