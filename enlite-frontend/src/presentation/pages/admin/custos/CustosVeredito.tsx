/**
 * CustosVeredito — 1º bloco da tela (direção A, RF-A3 a RF-A7): "tem algo fora do normal?" respondido sem rolar.
 * Três faces, nunca confundidas (contagem zero é "não medi"): N coisas fora do normal (destaque + compactos),
 * "nada fora do normal" (dia calmo, só com `status="ok"`) e "histórico insuficiente" (a regra não foi calculada).
 * Impacto, maior contribuinte e participação são derivados aqui, não vêm no payload (DF-19).
 */
import { useTranslation } from 'react-i18next';
import { ArrowRight, CircleCheck, Info, TriangleAlert } from 'lucide-react';
import { Button } from '@presentation/components/atoms/Button';
import { Heading } from '@presentation/components/atoms/Heading';
import { Text } from '@presentation/components/atoms/Text';
import { COSTS_NONE_KEY, type CostAnomalyItem, type CostOverview } from '@infrastructure/http/AdminCostsApiService';
import { CustosChip } from './CustosChip';
import { CustosSparkline } from './CustosSparkline';
import { impact, splitAnomalies, topContributor } from './custosDerive';
import { formatDay, formatFactor, formatMoney, formatPercent } from './custosFormat';
import { Linha } from './custosUi';

interface Props {
  ov: CostOverview;
  /** "Ver detalhe" (RF-A13): o pai troca o estado `detalhe`; nenhuma chamada à API. */
  onDetalhe: (item: CostAnomalyItem) => void;
}

function useFmt(ov: CostOverview) {
  const { t, i18n } = useTranslation();
  const lang = i18n?.language;
  return { t, lang, money: (v: number) => formatMoney(v, ov.currency, lang) };
}

/** Linha da regra (RF-A3): as constantes vêm do payload, a tela não as duplica. */
function RegraTexto({ ov, comDia }: { ov: CostOverview; comDia: boolean }): JSX.Element {
  const { t, lang, money } = useFmt(ov);
  const { rule, day } = ov.anomalies;
  return (
    <Text color="tertiary" data-testid="custos-regra" size="sm" className="mt-1">
      {comDia && day ? `${t('admin.custos.verdict.lastDay', { day: formatDay(day, 'long') })} ` : ''}
      {t('admin.custos.verdict.rule', { factor: formatFactor(rule.factor, lang), days: rule.windowDays, amount: money(rule.minDelta) })}
    </Text>
  );
}

function Selos({ item }: { item: CostAnomalyItem }): JSX.Element {
  const { t } = useTranslation();
  return (
    <>
      <CustosChip tone="neutral">{t(`admin.custos.anomaly.kind.${item.kind}`)}</CustosChip>
      {item.isNew && <CustosChip tone="new" data-testid="custos-selo-novo">{t('admin.custos.anomaly.new')}</CustosChip>}
    </>
  );
}

function VerDetalhe({ item, onDetalhe }: { item: CostAnomalyItem; onDetalhe: Props['onDetalhe'] }): JSX.Element | null {
  const { t } = useTranslation();
  if (item.kind !== 'service' || !item.detail) return null;
  return (
    <div>
      <Button
        variant="ghost"
        size="lg"
        data-testid="custos-ver-detalhe"
        data-ver-detalhe={item.name}
        onClick={() => onDetalhe(item)}
        className="!px-0 text-amber-950 hover:bg-transparent hover:underline"
      >
        <span className="whitespace-nowrap" data-single-line="nome">{t('admin.custos.anomaly.seeDetail')}</span>
        <ArrowRight className="h-4 w-4" aria-hidden="true" />
      </Button>
    </div>
  );
}

function Destaque({ ov, item, onDetalhe }: { ov: CostOverview; item: CostAnomalyItem; onDetalhe: Props['onDetalhe'] }): JSX.Element {
  const { t, lang, money } = useFmt(ov);
  const top = topContributor(item);
  const topName = top ? (top.resource === COSTS_NONE_KEY ? t('admin.custos.who.none.resource') : top.resource) : null;
  return (
    <article data-testid="custos-anomalia" data-kind={item.kind} className="min-w-0 rounded-2xl border border-amber-800 bg-amber-50 p-4 md:p-6">
      <div className="grid grid-cols-1 items-center gap-6 md:grid-cols-[max-content_minmax(0,1fr)] md:gap-8">
        <div className="flex min-w-0 flex-col gap-4">
          <div className="flex min-w-0 items-center gap-3">
            <Heading level={3} weight="semibold" className="min-w-0 truncate whitespace-nowrap !text-xl" title={item.name} data-single-line="nome">{item.name}</Heading>
            <Selos item={item} />
          </div>
          <div className="flex flex-col">
            <Linha tipo="valor" size="xl" weight="bold" className="!text-3xl !leading-tight tabular-nums text-amber-950" data-testid="custos-destaque-valor">{money(item.dayValue)}</Linha>
            <Linha tipo="data" size="xs" color="tertiary">{t('admin.custos.anomaly.onDay', { day: formatDay(ov.anomalies.day) })}</Linha>
          </div>
          <dl className="m-0 grid grid-cols-[auto_minmax(0,1fr)] gap-x-5 gap-y-2">
            <dt><Linha tipo="cabecalho" color="tertiary">{t('admin.custos.anomaly.median', { days: ov.anomalies.rule.windowDays })}</Linha></dt>
            <dd className="m-0"><Linha tipo="valor" weight="semibold" className="tabular-nums">{money(item.median7)}</Linha></dd>
            <dt><Linha tipo="cabecalho" color="tertiary">{t('admin.custos.anomaly.factor')}</Linha></dt>
            <dd className="m-0"><Linha tipo="valor" weight="semibold">{item.factor === null ? t('admin.custos.kpi.noValue') : formatFactor(item.factor, lang)}</Linha></dd>
            <dt><Linha tipo="cabecalho" color="tertiary">{t('admin.custos.anomaly.impact')}</Linha></dt>
            <dd className="m-0"><Linha tipo="valor" weight="semibold" className="tabular-nums">{t('admin.custos.anomaly.impactValue', { value: money(impact(item)) })}</Linha></dd>
          </dl>
          {top && topName && (
            <div className="flex min-w-0 flex-col gap-0.5" data-testid="custos-maior-contribuinte">
              <Linha tipo="cabecalho" color="tertiary">{t('admin.custos.anomaly.topContributor', { pct: formatPercent(top.pct, lang, 0) })}</Linha>
              <Linha tipo="nome" truncar weight="semibold">{topName}</Linha>
            </div>
          )}
          <VerDetalhe item={item} onDetalhe={onDetalhe} />
        </div>
        <div className="min-w-0"><CustosSparkline item={item} windowDays={ov.anomalies.rule.windowDays} /></div>
      </div>
    </article>
  );
}

function Compacto({ ov, item, onDetalhe }: { ov: CostOverview; item: CostAnomalyItem; onDetalhe: Props['onDetalhe'] }): JSX.Element {
  const { t, lang, money } = useFmt(ov);
  return (
    <article data-testid="custos-anomalia" data-kind={item.kind} className="flex min-w-0 flex-col gap-4 rounded-2xl border border-amber-800 bg-amber-50 p-4 md:p-6">
      <Heading level={4} weight="semibold" className="min-w-0 truncate whitespace-nowrap" title={item.name} data-single-line="nome">{item.name}</Heading>
      <div className="flex min-w-0 items-center gap-3"><Selos item={item} /></div>
      <div className="flex flex-col">
        <Linha tipo="valor" size="xl" weight="bold" className="tabular-nums text-amber-950">{money(item.dayValue)}</Linha>
        <Linha tipo="data" size="xs" color="tertiary">{t('admin.custos.anomaly.onDay', { day: formatDay(ov.anomalies.day) })}</Linha>
      </div>
      {item.isNew ? (
        <Text color="tertiary" size="sm">{t('admin.custos.anomaly.noHistory', { days: ov.anomalies.rule.windowDays })}</Text>
      ) : (
        <dl className="m-0 grid grid-cols-[auto_minmax(0,1fr)] gap-x-5 gap-y-1">
          <dt><Linha tipo="cabecalho" color="tertiary">{t('admin.custos.anomaly.median', { days: ov.anomalies.rule.windowDays })}</Linha></dt>
          <dd className="m-0"><Linha tipo="valor" weight="semibold" className="tabular-nums">{money(item.median7)}</Linha></dd>
          <dt><Linha tipo="cabecalho" color="tertiary">{t('admin.custos.anomaly.factor')}</Linha></dt>
          <dd className="m-0"><Linha tipo="valor" weight="semibold">{item.factor === null ? t('admin.custos.kpi.noValue') : formatFactor(item.factor, lang)}</Linha></dd>
        </dl>
      )}
      <VerDetalhe item={item} onDetalhe={onDetalhe} />
    </article>
  );
}

export function CustosVeredito({ ov, onDetalhe }: Props): JSX.Element {
  const { t, lang } = useFmt(ov);
  const { status, items } = ov.anomalies;

  // DF-22: mês FECHADO — nada foi calculado; uma linha neutra, nunca "nada fora do normal" nem "histórico insuficiente".
  if (status === 'not_applicable') {
    return (
      <section aria-label={t('admin.custos.verdict.region')} data-testid="custos-anomalias" data-status="not_applicable">
        <div data-testid="custos-anomalias-mes-fechado" role="status" className="flex min-w-0 items-center gap-2 rounded-xl border border-gray-600 bg-white px-4 py-3">
          <Info className="h-5 w-5 flex-none text-primary" aria-hidden="true" />
          <Linha tipo="nome" truncar weight="medium" title={t('admin.custos.verdict.closedMonth')}>{t('admin.custos.verdict.closedMonth')}</Linha>
        </div>
      </section>
    );
  }

  if (status === 'insufficient_history') {
    return (
      <section aria-label={t('admin.custos.verdict.region')} data-testid="custos-anomalias" data-status="insufficient_history">
        <div data-testid="custos-anomalias-insuficiente" role="status" className="flex min-w-0 items-start gap-3 rounded-xl border border-blue-900 bg-blue-50 p-4">
          <Info className="mt-1 h-5 w-5 flex-none text-blue-950" aria-hidden="true" />
          <div className="flex min-w-0 flex-col gap-0.5">
            <Heading level={3} weight="semibold" className="!text-blue-950">{t('admin.custos.verdict.insufficient', { days: ov.anomalies.rule.windowDays })}</Heading>
            <Text size="sm" color="inherit" className="text-blue-950">{t('admin.custos.verdict.insufficientText')}</Text>
          </div>
        </div>
      </section>
    );
  }

  if (items.length === 0) {
    return (
      <section aria-label={t('admin.custos.verdict.region')} data-testid="custos-anomalias" data-status="ok">
        <div data-testid="custos-anomalias-vazio" role="status" className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border border-gray-600 bg-white px-4 py-3">
          <div className="flex items-center gap-2">
            <CircleCheck className="h-5 w-5 flex-none text-primary" aria-hidden="true" />
            <Heading level={3} weight="medium" className="min-w-0">{t('admin.custos.verdict.calm', { day: formatDay(ov.anomalies.day, 'long') })}</Heading>
          </div>
          <Text color="tertiary" size="sm" className="min-w-0 flex-1 basis-72">
            {t('admin.custos.verdict.rule', { factor: formatFactor(ov.anomalies.rule.factor, lang), days: ov.anomalies.rule.windowDays, amount: formatMoney(ov.anomalies.rule.minDelta, ov.currency, lang) })}
          </Text>
        </div>
      </section>
    );
  }

  const { main, others } = splitAnomalies(items);
  return (
    <section aria-label={t('admin.custos.verdict.region')} data-testid="custos-anomalias" data-status="ok" className="flex min-w-0 flex-col gap-4">
      <div>
        <Heading level={2} weight="semibold" className="flex items-center gap-3" data-testid="custos-veredito-titulo">
          <TriangleAlert className="h-6 w-6 flex-none" aria-hidden="true" />
          <span>{items.length === 1 ? t('admin.custos.verdict.one') : t('admin.custos.verdict.many', { n: items.length })}</span>
        </Heading>
        <RegraTexto ov={ov} comDia />
      </div>
      {main ? (
        <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
          <Destaque ov={ov} item={main} onDetalhe={onDetalhe} />
          {others.length > 0 && (
            <div className="flex min-w-0 flex-col gap-4">
              {others.map((i) => <Compacto key={`${i.kind}|${i.name}`} ov={ov} item={i} onDetalhe={onDetalhe} />)}
            </div>
          )}
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {others.map((i) => <Compacto key={`${i.kind}|${i.name}`} ov={ov} item={i} onDetalhe={onDetalhe} />)}
        </div>
      )}
    </section>
  );
}
