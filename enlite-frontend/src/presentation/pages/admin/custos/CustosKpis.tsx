/**
 * CustosKpis — "Números do mês" (RF-A8): 3 cartões lado a lado — gasto até agora, previsão de fechamento e variação contra o
 * mês anterior no mesmo dia. Valor `null` mostra "—" com a razão, NUNCA 0. Variações e o "1 a N de <mês>" são derivados aqui.
 */
import { useTranslation } from 'react-i18next';
import { Text } from '@presentation/components/atoms/Text';
import type { CostOverview } from '@infrastructure/http/AdminCostsApiService';
import { CustosChip } from './CustosChip';
import { capitalize, daysInMonth, formatMoney, formatVariation, monthName, previousMonth } from './custosFormat';
import { CARD, Linha } from './custosUi';

function Cartao({ testId, titulo, children }: { testId: string; titulo: string; children: React.ReactNode }): JSX.Element {
  return (
    <section data-testid={testId} className={`${CARD} flex flex-col gap-1`}>
      <Linha tipo="cabecalho" color="tertiary">{titulo}</Linha>
      {children}
    </section>
  );
}

function Valor({ testId, children }: { testId: string; children: React.ReactNode }): JSX.Element {
  return <Linha tipo="valor" size="xl" weight="bold" className="!text-3xl !leading-tight tabular-nums" data-testid={testId}>{children}</Linha>;
}

export function CustosKpis({ ov }: { ov: CostOverview }): JSX.Element {
  const { t, i18n } = useTranslation();
  const lang = i18n?.language;
  const money = (v: number) => formatMoney(v, ov.currency, lang);
  const mes = monthName(ov.month, lang);
  const dias = ov.forecast.daysCounted;
  const fechado = ov.anomalies.status === 'not_applicable';
  // O "1 a N" segue o dia do DADO: `monthTotal` inclui o dia parcial de `dataUntil` (bate com o console); `daysCounted` só tem os completos.
  const diaDado = ov.dataUntil && ov.dataUntil.slice(0, 7) === ov.month ? Number(ov.dataUntil.slice(8, 10)) : dias;
  const faixa = fechado || diaDado <= 0 ? capitalize(mes) : diaDado === 1 ? t('admin.custos.kpi.rangeOne', { month: mes }) : diaDado === 2 ? t('admin.custos.kpi.rangeTwo', { month: mes }) : t('admin.custos.kpi.range', { day: diaDado, month: mes });
  const previsao = ov.forecast.value;
  const varPrev = previsao !== null ? formatVariation(previsao, ov.prevMonthTotal, lang) : null;
  const varMes = formatVariation(ov.monthTotal, ov.prevMonthToDate, lang);
  return (
    <section aria-label={t('admin.custos.kpi.region')} className={`grid grid-cols-1 gap-6 ${fechado ? 'md:grid-cols-2' : 'md:grid-cols-3'}`} data-testid="custos-kpis">
      <Cartao testId="custos-card-mes" titulo={t(fechado ? 'admin.custos.kpi.monthClosed' : 'admin.custos.kpi.month')}>
        <Valor testId="custos-card-mes-valor">{money(ov.monthTotal)}</Valor>
        <Linha tipo="data" size="xs" color="tertiary">{faixa}</Linha>
      </Cartao>

      {!fechado && (
      <Cartao testId="custos-card-previsao" titulo={t('admin.custos.kpi.forecast')}>
        <Valor testId="custos-card-previsao-valor">{previsao === null ? t('admin.custos.kpi.noValue') : money(previsao)}</Valor>
        {previsao === null ? (
          <Text size="xs" color="tertiary">{t('admin.custos.kpi.forecastUnavailable')}</Text>
        ) : (
          <>
            <Text size="xs" color="tertiary" data-testid="custos-card-previsao-base">
              {t('admin.custos.kpi.forecastBasis', { n: dias, d: daysInMonth(ov.month) })}
              {varPrev && ov.prevMonthTotal !== null ? ` ${t('admin.custos.kpi.forecastVsPrev', { pct: varPrev, value: money(ov.prevMonthTotal) })}` : ''}
            </Text>
            {dias > 0 && dias < ov.anomalies.rule.windowDays && (
              <div className="mt-1 flex"><CustosChip tone="estimated" data-testid="custos-selo-estimativa">{t('admin.custos.kpi.estimateWith', { n: dias })}</CustosChip></div>
            )}
          </>
        )}
      </Cartao>
      )}

      <Cartao testId="custos-card-variacao" titulo={t(fechado ? 'admin.custos.kpi.vsPrevClosed' : 'admin.custos.kpi.vsPrev')}>
        <Valor testId="custos-card-variacao-valor">{varMes ?? t('admin.custos.kpi.noValue')}</Valor>
        {varMes && ov.prevMonthToDate !== null ? (
          <Text size="xs" color="tertiary">
            {fechado
              ? t('admin.custos.kpi.prevWhole', { month: capitalize(monthName(previousMonth(ov.month), lang)), value: money(ov.prevMonthToDate) })
              : t('admin.custos.kpi.prevRange', { month: capitalize(monthName(previousMonth(ov.month), lang)), day: diaDado, value: money(ov.prevMonthToDate) })}
          </Text>
        ) : (
          <Text size="xs" color="tertiary" data-testid="custos-card-variacao-razao">{t('admin.custos.kpi.noPrev')}</Text>
        )}
      </Cartao>
    </section>
  );
}
