/**
 * CustosBarrasDiarias — barras do custo diário do mês até o dia da anomalia (A2, RF-A12). Gráfico de APOIO: o número do dia vem
 * em texto no cartão ao lado e no rótulo do último dia. Mediana dos 7 dias anteriores em linha tracejada com rótulo; dia da anomalia
 * destacado (cor + rótulo "dd/mm · valor"). `role="img"` com `aria-label` que diz o fato (UI-9). SVG só com classes do Tailwind.
 */
import { useTranslation } from 'react-i18next';
import type { CostDayValue } from '@infrastructure/http/AdminCostsApiService';
import { niceMax } from './custosDerive';
import { formatDay, formatPlain } from './custosFormat';

const W = 760;
const H = 300;
const X0 = 44;
const X1 = 748;
const Y_TOP = 28;
const Y_BASE = 270;

export function CustosBarrasDiarias({ name, series, median7, windowDays }: { name: string; series: CostDayValue[]; median7: number; windowDays: number }): JSX.Element | null {
  const { t, i18n } = useTranslation();
  const lang = i18n?.language;
  const n = series.length;
  if (n === 0) return null;
  const top = niceMax(Math.max(median7, ...series.map((p) => p.value)));
  const y = (v: number) => Y_BASE - (v / top) * (Y_BASE - Y_TOP);
  const slot = (X1 - X0) / n;
  const bw = Math.min(30, slot * 0.72);
  const cx = (i: number) => X0 + slot * i + slot / 2;
  const last = series[n - 1];
  const prev = n > 1 ? series[n - 2] : null;
  const ticks = [0, 1, 2, 3].map((k) => (top / 3) * k);
  const mostrarRotulo = (i: number) => i === n - 1 || i === 0 || ((i + 1) % 5 === 0 && n - 1 - i > 2);
  const label = t('admin.custos.detail.chartLabel', { name, from: formatDay(series[0].day), to: formatDay(last.day), median: formatPlain(median7, lang), value: formatPlain(last.value, lang) });
  const yMed = y(median7);
  return (
    <div className="overflow-x-auto">
      <svg viewBox={`0 0 ${W} ${H}`} className="block h-auto w-full min-w-[640px]" role="img" aria-label={label} data-testid="custos-barras-diarias">
        {ticks.map((v) => (
          <g key={v}>
            <line x1={X0} x2={X1} y1={y(v)} y2={y(v)} className={v === 0 ? 'stroke-gray-800' : 'stroke-gray-600'} />
            <text x={X0 - 8} y={y(v) + 4} textAnchor="end" className="fill-primary text-xs">{Number.isInteger(v) ? v : formatPlain(v, lang).replace(/[.,]00$/, '')}</text>
          </g>
        ))}
        {series.map((p, i) => (
          <rect key={p.day} x={cx(i) - bw / 2} y={y(p.value)} width={bw} height={Math.max(Y_BASE - y(p.value), 0)} rx={2} className={i === n - 1 ? 'fill-red-900' : 'fill-primary'} data-day={p.day} />
        ))}
        <line x1={X0} x2={X1} y1={yMed} y2={yMed} className="stroke-primary" strokeDasharray="4 3" />
        <text x={X0 + 8} y={yMed - 8} className="fill-primary text-xs">{t('admin.custos.detail.medianLabel', { days: windowDays, value: formatPlain(median7, lang) })}</text>
        <text x={cx(n - 1)} y={y(last.value) - 8} textAnchor="end" className="fill-primary text-xs font-semibold">{`${formatDay(last.day)} · ${formatPlain(last.value, lang)}`}</text>
        {prev && n > 2 && <text x={cx(n - 2)} y={y(prev.value) - 8} textAnchor="end" className="fill-primary text-xs">{formatPlain(prev.value, lang)}</text>}
        {series.map((p, i) => (mostrarRotulo(i) ? <text key={`l${p.day}`} x={cx(i)} y={290} textAnchor="middle" className="fill-primary text-xs">{formatDay(p.day)}</text> : null))}
      </svg>
    </div>
  );
}
