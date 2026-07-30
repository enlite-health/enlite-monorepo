import { useTranslation } from 'react-i18next';
import { Filter, Users, AlertTriangle, CalendarCheck, ShieldAlert } from 'lucide-react';
import { Text, MetricCard } from '@presentation/components/atoms';
import {
  FUNNEL_COLUMN_ORDER,
  type FunnelColumnId,
  type FunnelColumnCounts,
  type ManagementDashboardData,
} from '@domain/entities/ManagementDashboard';
import { SectionHeader } from './SectionHeader';

/**
 * Cor do "ponto" de cada coluna, para leitura de fluxo num relance:
 * quanto mais avançado, mais quente; cinza = fim de linha.
 * A ORDEM não mora aqui — vem de FUNNEL_COLUMN_ORDER (contrato do domínio).
 */
const COLUMN_DOT: Record<FunnelColumnId, { dot: string; value: string }> = {
  INVITED: { dot: 'bg-primary', value: 'text-primary' },
  INICIADO: { dot: 'bg-indigo-400', value: 'text-indigo-600' },
  PRE_SCREENING: { dot: 'bg-[#06ADDD]', value: 'text-[#0E7C9E]' },
  IN_PROGRESS: { dot: 'bg-[#8932FD]', value: 'text-[#6B21C7]' },
  COMPLETED: { dot: 'bg-[#8932FD]', value: 'text-[#6B21C7]' },
  CONFIRMED: { dot: 'bg-[#FFB607]', value: 'text-[#B45309]' },
  SELECTED: { dot: 'bg-[#10B981]', value: 'text-[#0F766E]' },
  REJECTED: { dot: 'bg-slate-400', value: 'text-slate-500' },
};

/**
 * Uma vista do funil por prestador. `somavel` vem do PAYLOAD, não de constante
 * local: quem publica o número é quem declara se ele soma (ver design D3).
 */
function FunnelView({
  testId,
  titleKey,
  hintKey,
  colunas,
  somavel,
  total,
}: {
  testId: string;
  titleKey: string;
  hintKey: string;
  colunas: FunnelColumnCounts;
  somavel: boolean;
  total: number;
}): JSX.Element {
  const { t } = useTranslation();
  const p = 'admin.managementDashboard.funnel.';

  return (
    <div data-testid={testId} className="space-y-3">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <Text as="p" size="sm" weight="semibold" className="text-slate-700 dark:text-slate-200">
          {t(titleKey)}
        </Text>
        <Text as="p" size="xs" className="text-slate-500">
          {t(hintKey)}
        </Text>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-8">
        {FUNNEL_COLUMN_ORDER.map((column) => (
          <div
            key={column}
            data-testid={`${testId}-${column}`}
            className="flex flex-col gap-1 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-700 dark:bg-slate-800"
          >
            <div className="flex items-center gap-1.5">
              <span className={`h-2 w-2 shrink-0 rounded-full ${COLUMN_DOT[column].dot}`} aria-hidden="true" />
              <Text as="p" size="xs" weight="medium" className="text-slate-500">
                {t(`${p}stage.${column}`)}
              </Text>
            </div>
            <p
              className={`font-poppins text-2xl font-bold leading-tight ${COLUMN_DOT[column].value} dark:text-slate-100`}
            >
              {colunas[column]}
            </p>
          </div>
        ))}
      </div>

      {/* A somabilidade é dita em texto, sempre — é o que impede somar errado. */}
      <Text as="p" size="xs" className="text-slate-500">
        {somavel ? t(`${p}sumsToTotal`, { total }) : t(`${p}doesNotSum`, { total })}
      </Text>
    </div>
  );
}

export function FunnelTotalsSection({
  funnelPorPrestador,
  encuadres,
}: {
  funnelPorPrestador: ManagementDashboardData['funnelPorPrestador'];
  encuadres: ManagementDashboardData['encuadres'];
}): JSX.Element {
  const { t } = useTranslation();
  const p = 'admin.managementDashboard.funnel.';

  return (
    <section data-testid="mgmt-funnel" className="space-y-6">
      <SectionHeader
        icon={Filter}
        accent="clinic"
        title={t('admin.managementDashboard.sections.funnel')}
        hint={t('admin.managementDashboard.sections.funnelHint')}
      />

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <MetricCard
          icon={Users}
          accent="primary"
          title={t(`${p}totalPrestadores`)}
          value={funnelPorPrestador.total}
          subtitle={t(`${p}totalPrestadoresSub`)}
        />
        {/*
          "Bloqueados" fica FORA das colunas de propósito: é tentativa barrada pelo gate de
          cadastro, sem candidatura — somá-la às colunas quebraria a invariante do total.
          É a coluna vermelha do Kanban, e a fila mais acionável do painel (a pessoa já quis).
        */}
        <MetricCard
          icon={ShieldAlert}
          accent="coordination"
          title={t(`${p}bloqueados`)}
          value={funnelPorPrestador.bloqueados}
          subtitle={t(`${p}bloqueadosSub`)}
        />
        {/*
          Entrevistas da semana + quantos cards estão em "Agendados" SEM data.
          O segundo número é a medida de ADOÇÃO da captura (a data passou a ser pedida ao
          mover o card em 30/07/2026; antes disso o sistema nunca registrava QUANDO a
          entrevista era). Enquanto ele for alto, o primeiro subestima — e isso fica à
          vista em vez de virar um zero mudo.
        */}
        <MetricCard
          icon={CalendarCheck}
          accent="cyan"
          title={t(`${p}agendadosSemana`)}
          value={encuadres.agendadosEstaSemana}
          subtitle={t(`${p}agendadosSemanaSub`)}
        />
        {encuadres.semDataRegistrada > 0 && (
          <div
            data-testid="mgmt-encuadres-sem-data"
            className="flex items-start gap-3 rounded-2xl border border-dashed border-amber-300 bg-amber-50/60 p-6 dark:border-amber-700/60 dark:bg-amber-900/10"
          >
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-[#FFB607]/16">
              <AlertTriangle className="h-5 w-5 text-[#D98A00]" aria-hidden="true" />
            </span>
            <div className="min-w-0">
              <Text as="p" size="sm" weight="medium" className="text-slate-700 dark:text-slate-200">
                {t(`${p}semData`, { count: encuadres.semDataRegistrada })}
              </Text>
              <Text as="p" size="xs" className="text-slate-600 dark:text-slate-400">
                {t(`${p}semDataSub`)}
              </Text>
            </div>
          </div>
        )}
      </div>

      <FunnelView
        testId="mgmt-funnel-consolidado"
        titleKey={`${p}views.consolidado`}
        hintKey={`${p}views.consolidadoHint`}
        colunas={funnelPorPrestador.consolidado.colunas}
        somavel={funnelPorPrestador.consolidado.somavel}
        total={funnelPorPrestador.total}
      />

      <FunnelView
        testId="mgmt-funnel-por-etapa"
        titleKey={`${p}views.porEtapa`}
        hintKey={`${p}views.porEtapaHint`}
        colunas={funnelPorPrestador.porEtapa.colunas}
        somavel={funnelPorPrestador.porEtapa.somavel}
        total={funnelPorPrestador.total}
      />
    </section>
  );
}
