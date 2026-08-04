import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { HeartPulse, Users, CheckCircle, AlertTriangle, HelpCircle } from 'lucide-react';
import { Text, MetricCard } from '@presentation/components/atoms';
import { Select } from '@presentation/components/atoms/Select';
import { usePatientStats } from '@hooks/admin/usePatientStats';
import { usePatientFunnel } from '@hooks/admin/usePatientFunnel';
import { getCountryOptions, getFunnelPeriodOptions } from '@presentation/pages/admin/patientsData';
import { SectionHeader } from './SectionHeader';
import { useMetricHelp } from './useMetricHelp';
import type { ManagementHelpKey } from './helpKeys';

/** Conversão inteira entre duas etapas consecutivas do embudo. */
function conversionRate(prev: number, next: number): number {
  return prev > 0 ? Math.round((next / prev) * 100) : 0;
}

/** Etapas do embudo, na ordem canônica. `dot`/`value` = cor de leitura rápida. */
const STAGE_HELP: Record<string, ManagementHelpKey> = {
  solicitantes: 'embudoSolicitantes',
  admision: 'embudoAdmision',
  agendadas: 'embudoAgendadas',
  vacantes: 'embudoVacantes',
};

const STAGES = [
  { key: 'solicitantes', dot: 'bg-primary', value: 'text-primary' },
  { key: 'admision', dot: 'bg-[#8932FD]', value: 'text-[#6B21C7]' },
  { key: 'agendadas', dot: 'bg-[#FFB607]', value: 'text-[#B45309]' },
  { key: 'vacantes', dot: 'bg-[#10B981]', value: 'text-[#0F766E]' },
] as const;

/**
 * Pacientes na Gestão à Vista: estado atual da base + embudo de admissão.
 *
 * Saiu da tela /admin/patients (que é operação: lista, filtros, kanban) e passou
 * a viver aqui, junto dos demais indicadores da coordenação.
 *
 * Duas fontes distintas, ambas escopadas pelo MESMO filtro de país:
 *   - estado  → GET /patients/stats  (snapshot, sem janela de tempo)
 *   - embudo  → GET /patients/funnel (janela relativa: 7/30/90 dias)
 * O período só se aplica ao embudo — por isso o seletor fica no cabeçalho dele.
 *
 * Cada número traz a definição embaixo (subtítulo): sem isso o rótulo curto
 * engana — "Solicitantes" conta pacientes CRIADOS no período, não quem está
 * parado na etapa Solicitantes do kanban.
 */
export function PacientesSection(): JSX.Element {
  const { t } = useTranslation();
  const { helpProps, openHelp, helpAriaLabel, helpDrawer } = useMetricHelp();
  const [country, setCountry] = useState('');
  const [periodDays, setPeriodDays] = useState('30');

  const { stats, error: statsError } = usePatientStats(country);
  const { funnel, isLoading, error: funnelError } = usePatientFunnel(country, parseInt(periodDays, 10));

  const countryOptions = getCountryOptions(t);
  const periodOptions = getFunnelPeriodOptions(t);

  const values: Record<(typeof STAGES)[number]['key'], number> = {
    solicitantes: funnel?.solicitantes ?? 0,
    admision: funnel?.admision ?? 0,
    agendadas: funnel?.agendadas ?? 0,
    vacantes: funnel?.vacantes ?? 0,
  };

  const conversions = [
    { from: 'solicitantes', to: 'admision' },
    { from: 'admision', to: 'agendadas' },
    { from: 'agendadas', to: 'vacantes' },
  ] as const;

  return (
    <section data-testid="mgmt-pacientes" className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <SectionHeader
          icon={HeartPulse}
          accent="care"
          title={t('admin.managementDashboard.sections.pacientes')}
          hint={t('admin.managementDashboard.sections.pacientesHint')}
        />
        <div className="w-[210px]" data-testid="mgmt-pacientes-country">
          <Select
            inputSize="compact"
            options={countryOptions}
            value={country}
            onValueChange={setCountry}
            placeholder={t('admin.patients.countryOptions.all')}
          />
        </div>
      </div>

      {/* Estado atual da base (snapshot; o período não se aplica) */}
      {statsError ? (
        <Text as="p" size="sm" color="inherit" className="text-red-600">
          {t('admin.patients.errorLoading')}
        </Text>
      ) : (
        <div className="grid grid-cols-1 gap-6 md:grid-cols-3">
          <div data-testid="patient-stats-total">
            <MetricCard
              icon={Users}
              accent="primary"
              title={t('admin.patients.stats.total')}
              {...helpProps('pacTotal')}
              value={stats?.total ?? 0}
              subtitle={t('admin.patients.stats.totalSub')}
            />
          </div>
          <div data-testid="patient-stats-complete">
            <MetricCard
              icon={CheckCircle}
              accent="success"
              title={t('admin.patients.stats.complete')}
              {...helpProps('pacCompletos')}
              value={stats?.complete ?? 0}
              subtitle={t('admin.patients.stats.completeSub')}
            />
          </div>
          <div data-testid="patient-stats-needs-attention">
            <MetricCard
              icon={AlertTriangle}
              accent="coordination"
              title={t('admin.patients.stats.needsAttention')}
              {...helpProps('pacAtencion')}
              value={stats?.needsAttention ?? 0}
              subtitle={t('admin.patients.stats.needsAttentionSub')}
            />
          </div>
        </div>
      )}

      {/* Embudo de admissão (janela relativa) */}
      <div
        className="space-y-3 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-700 dark:bg-slate-800"
        data-testid="patient-funnel-section"
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Text as="p" weight="semibold" color="inherit" className="text-slate-700 dark:text-slate-200">
            {t('admin.patients.funnel.title')}
          </Text>
          <div className="w-[180px]" data-testid="funnel-period-filter">
            <Select
              inputSize="compact"
              options={periodOptions}
              value={periodDays}
              onValueChange={setPeriodDays}
            />
          </div>
        </div>

        {funnelError ? (
          <Text as="p" size="sm" color="inherit" className="text-red-600">
            {t('admin.patients.funnel.error')}
          </Text>
        ) : (
          <>
            <div className={`grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4 ${isLoading ? 'opacity-60' : ''}`}>
              {STAGES.map(({ key, dot, value }) => (
                <div
                  key={key}
                  data-testid={`funnel-${key}`}
                  className="flex flex-col gap-1 rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-800"
                >
                  <div className="flex items-center gap-1.5">
                    <span className={`h-2 w-2 shrink-0 rounded-full ${dot}`} aria-hidden="true" />
                    <Text as="p" size="xs" weight="medium" color="inherit" className="text-slate-500">
                      {t(`admin.patients.funnel.${key}`)}
                    </Text>
                    <button
                      type="button"
                      onClick={() => openHelp(STAGE_HELP[key])}
                      aria-label={helpAriaLabel}
                      title={helpAriaLabel}
                      data-testid="metric-help"
                      className="ml-auto rounded-full p-0.5 text-slate-300 transition-colors hover:bg-slate-100 hover:text-slate-600 dark:text-slate-500 dark:hover:bg-slate-700 dark:hover:text-slate-200"
                    >
                      <HelpCircle className="h-3.5 w-3.5" aria-hidden="true" />
                    </button>
                  </div>
                  <p className={`font-poppins text-2xl font-bold leading-tight ${value} dark:text-slate-100`}>
                    {values[key]}
                  </p>
                  <Text as="p" size="xs" color="inherit" className="text-slate-400">
                    {t(`admin.patients.funnel.sub.${key}`)}
                  </Text>
                </div>
              ))}
            </div>

            <div className="flex flex-wrap gap-x-8 gap-y-1">
              {conversions.map(({ from, to }) => (
                <div key={`${from}-${to}`} data-testid={`funnel-conv-${from}-${to}`}>
                  <Text as="p" size="sm" color="inherit" className="text-slate-500">
                    {t('admin.patients.funnel.conversion', {
                      from: t(`admin.patients.funnel.${from}`),
                      to: t(`admin.patients.funnel.${to}`),
                      rate: conversionRate(values[from], values[to]),
                    })}
                  </Text>
                </div>
              ))}
            </div>
          </>
        )}
      </div>

      {helpDrawer}
    </section>
  );
}
