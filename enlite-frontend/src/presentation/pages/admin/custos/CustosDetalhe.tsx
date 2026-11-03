/**
 * CustosDetalhe — A2, a anomalia aberta (RF-A12, DF-18): painel na MESMA página (estado do React), não rota; 0 chamadas à API.
 * Série do mês do serviço + "Quem explica o aumento do dia N". "No mês" do serviço = `byService[name].total` (o mesmo número do A1;
 * nunca a soma da série). "Voltar ao painel" devolve o foco ao "Ver detalhe" de origem (feito pela página). Maior contribuinte é uma pista, não a causa.
 */
import { useTranslation } from 'react-i18next';
import { ArrowLeft } from 'lucide-react';
import { Button } from '@presentation/components/atoms/Button';
import { Heading } from '@presentation/components/atoms/Heading';
import { Text } from '@presentation/components/atoms/Text';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@presentation/components/atoms/Table';
import { COSTS_NONE_KEY, type CostAnomalyItem, type CostOverview } from '@infrastructure/http/AdminCostsApiService';
import { CustosBarrasDiarias } from './CustosBarrasDiarias';
import { CustosChip } from './CustosChip';
import { impact, increase, shareOfIncrease } from './custosDerive';
import { formatDay, formatFactor, formatMoney, formatPercent, monthName } from './custosFormat';
import { CARD, Linha } from './custosUi';

const TH = 'text-primary';

export function CustosDetalhe({ ov, item, onVoltar }: { ov: CostOverview; item: CostAnomalyItem; onVoltar: () => void }): JSX.Element | null {
  const { t, i18n } = useTranslation();
  const lang = i18n?.language;
  const detail = item.detail;
  if (!detail) return null;
  const money = (v: number) => formatMoney(v, ov.currency, lang);
  const dia = ov.anomalies.day;
  const diaCurto = formatDay(dia);
  const diaNum = diaCurto.slice(0, 2);
  const impacto = impact(item);
  const noMes = ov.byService.find((s) => s.service === item.name)?.total ?? null;
  // O título é o mês do DIA da anomalia (a série do mês dele), não o mês escolhido no seletor.
  const mes = monthName(dia ? dia.slice(0, 7) : ov.month, lang);
  return (
    <div className="flex min-w-0 flex-col gap-6" data-testid="custos-detalhe">
      <div>
        <Button variant="ghost" size="lg" data-testid="custos-voltar" onClick={onVoltar} className="!px-0 hover:bg-transparent hover:underline">
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
          <span className="whitespace-nowrap" data-single-line="nome">{t('admin.custos.detail.back')}</span>
        </Button>
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-3">
        <Heading level={2} weight="semibold" className="min-w-0 truncate whitespace-nowrap" title={item.name} data-single-line="nome">{item.name}</Heading>
        <CustosChip tone="neutral">{t(`admin.custos.anomaly.kind.${item.kind}`)}</CustosChip>
        {item.factor !== null && <CustosChip tone="alert">{t('admin.custos.who.signal.factor', { factor: formatFactor(item.factor, lang) })}</CustosChip>}
      </div>
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <section className={`${CARD} flex flex-col gap-4`}>
          <Heading level={3} weight="semibold">{t('admin.custos.detail.dailyTitle', { month: mes, currency: ov.currency ?? '' })}</Heading>
          <CustosBarrasDiarias name={item.name} series={detail.monthSeries} median7={item.median7} windowDays={ov.anomalies.rule.windowDays} />
        </section>
        <section className={`${CARD} flex flex-col gap-4`} data-testid="custos-detalhe-dia">
          <div className="flex flex-col">
            <Linha tipo="data" color="tertiary">{t('admin.custos.detail.dayCard', { day: diaCurto })}</Linha>
            <Linha tipo="valor" size="xl" weight="bold" className="!text-3xl !leading-tight tabular-nums">{money(item.dayValue)}</Linha>
          </div>
          <dl className="m-0 grid grid-cols-[auto_minmax(0,1fr)] gap-x-5 gap-y-2">
            <dt><Linha tipo="cabecalho" color="tertiary">{t('admin.custos.anomaly.median', { days: ov.anomalies.rule.windowDays })}</Linha></dt>
            <dd className="m-0 text-right"><Linha tipo="valor" weight="semibold" className="tabular-nums">{money(item.median7)}</Linha></dd>
            <dt><Linha tipo="cabecalho" color="tertiary">{t('admin.custos.anomaly.factor')}</Linha></dt>
            <dd className="m-0 text-right"><Linha tipo="valor" weight="semibold">{item.factor === null ? t('admin.custos.kpi.noValue') : formatFactor(item.factor, lang)}</Linha></dd>
            <dt><Linha tipo="cabecalho" color="tertiary">{t('admin.custos.anomaly.impact')}</Linha></dt>
            <dd className="m-0 text-right"><Linha tipo="valor" weight="semibold" className="tabular-nums">{t('admin.custos.anomaly.impactValue', { value: money(impacto) })}</Linha></dd>
            <dt><Linha tipo="cabecalho" color="tertiary">{t('admin.custos.detail.inMonth')}</Linha></dt>
            <dd className="m-0 text-right"><Linha tipo="valor" weight="semibold" className="tabular-nums" data-testid="custos-detalhe-no-mes">{noMes === null ? t('admin.custos.kpi.noValue') : money(noMes)}</Linha></dd>
          </dl>
          <Text color="tertiary" size="xs">
            {t('admin.custos.verdict.rule', { factor: formatFactor(ov.anomalies.rule.factor, lang), days: ov.anomalies.rule.windowDays, amount: money(ov.anomalies.rule.minDelta) })}
          </Text>
        </section>
      </div>
      <section className={`${CARD} flex flex-col gap-4`} data-testid="custos-detalhe-recursos">
        <div>
          <Heading level={3} weight="semibold">{t('admin.custos.detail.explainsTitle', { day: diaNum })}</Heading>
          <Text color="tertiary" size="sm">{t('admin.custos.detail.explainsNote')}</Text>
        </div>
        <Table className="min-w-[1100px] table-fixed">
          <TableHeader>
            <TableHead className={TH} unwrapped><Linha tipo="cabecalho" weight="medium">{t('admin.custos.detail.cols.resource')}</Linha></TableHead>
            <TableHead className={`${TH} w-28`} align="right" unwrapped><Linha tipo="cabecalho" weight="medium">{t('admin.custos.detail.cols.day', { day: diaNum })}</Linha></TableHead>
            <TableHead className={`${TH} w-28`} align="right" unwrapped><Linha tipo="cabecalho" weight="medium">{t('admin.custos.detail.cols.median')}</Linha></TableHead>
            <TableHead className={`${TH} w-32`} align="right" unwrapped><Linha tipo="cabecalho" weight="medium">{t('admin.custos.detail.cols.increase')}</Linha></TableHead>
            <TableHead className={`${TH} w-48`} unwrapped><Linha tipo="cabecalho" weight="medium">{t('admin.custos.detail.cols.share')}</Linha></TableHead>
            <TableHead className={`${TH} w-44`} unwrapped><Linha tipo="cabecalho" weight="medium">{t('admin.custos.detail.cols.signal')}</Linha></TableHead>
            <TableHead className={`${TH} w-32`} align="right" unwrapped><Linha tipo="cabecalho" weight="medium">{t('admin.custos.detail.cols.month')}</Linha></TableHead>
          </TableHeader>
          <TableBody>
            {detail.resources.map((r, i) => {
              const aumento = increase(r);
              const parte = shareOfIncrease(r, impacto);
              return (
                <TableRow key={r.resource} data-testid="custos-detalhe-linha" className={`h-11 ${i === 0 ? 'bg-amber-50' : ''}`}>
                  <TableCell unwrapped className="min-w-0">
                    {r.resource === COSTS_NONE_KEY
                      ? <CustosChip tone="none">{t('admin.custos.who.none.resource')}</CustosChip>
                      : <Linha tipo="nome" truncar>{r.resource}</Linha>}
                  </TableCell>
                  <TableCell unwrapped align="right"><Linha tipo="valor" className="tabular-nums">{money(r.dayValue)}</Linha></TableCell>
                  <TableCell unwrapped align="right"><Linha tipo="valor" className="tabular-nums">{money(r.median7)}</Linha></TableCell>
                  <TableCell unwrapped align="right"><Linha tipo="valor" className="tabular-nums">{`${aumento < 0 ? '-' : '+'}${money(Math.abs(aumento))}`}</Linha></TableCell>
                  <TableCell unwrapped>
                    <div className="flex min-w-0 items-center gap-3">
                      <span className="block h-2 min-w-0 flex-1 rounded bg-gray-300" aria-hidden="true"><i className="block h-full rounded bg-primary" style={{ width: `${Math.min(parte, 100)}%` }} /></span>
                      <Linha tipo="valor" className="w-16 flex-none text-right tabular-nums">{formatPercent(parte, lang)}</Linha>
                    </div>
                  </TableCell>
                  <TableCell unwrapped>{i === 0 && parte > 0 && <CustosChip tone="alert" data-testid="custos-selo-maior">{t('admin.custos.detail.topContributor')}</CustosChip>}</TableCell>
                  <TableCell unwrapped align="right"><Linha tipo="valor" className="tabular-nums">{money(r.monthTotal)}</Linha></TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </section>
    </div>
  );
}
