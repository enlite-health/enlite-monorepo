/**
 * CustosSparkline — minigráfico de 14 dias do destaque do A1 (RF-A4). Gráfico de APOIO: o número importante vem em texto ao lado;
 * o `aria-label` diz o fato (UI-9). SVG com classes do Tailwind (sem hex): a linha da mediana é tracejada e o último ponto, marcado.
 */
import { useTranslation } from 'react-i18next';
import type { CostAnomalyItem } from '@infrastructure/http/AdminCostsApiService';
import { formatDay, formatPlain } from './custosFormat';

const W = 270;
const H = 150;
const X0 = 10;
const X1 = 256;
const Y_TOP = 24;
const Y_BASE = 120;

export function CustosSparkline({ item, windowDays }: { item: CostAnomalyItem; windowDays: number }): JSX.Element | null {
  const { t, i18n } = useTranslation();
  const lang = i18n?.language;
  const s = item.series;
  if (s.length < 2) return null;
  const max = Math.max(item.median7, ...s.map((p) => p.value), 0.0001);
  const x = (i: number) => X0 + (i * (X1 - X0)) / (s.length - 1);
  const y = (v: number) => Y_BASE - (v / max) * (Y_BASE - Y_TOP);
  const pts = s.map((p, i) => `${x(i).toFixed(2)} ${y(p.value).toFixed(2)}`);
  const line = `M${pts.join(' L')}`;
  const area = `${line} L${X1} ${Y_BASE} L${X0} ${Y_BASE} Z`;
  const yMed = y(item.median7);
  const last = s[s.length - 1];
  const prev = s[s.length - 2];
  const label = t('admin.custos.spark.label', {
    name: item.name,
    from: formatDay(s[0].day),
    to: formatDay(last.day),
    median: formatPlain(item.median7, lang),
    prevDay: formatDay(prev.day),
    prevValue: formatPlain(prev.value, lang),
    lastDay: formatDay(last.day),
    lastValue: formatPlain(last.value, lang),
  });
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="block h-auto w-full max-w-[270px]" role="img" aria-label={label} data-testid="custos-sparkline">
      <path d={area} className="fill-amber-950/15" />
      <line x1={X0} x2={X1} y1={yMed} y2={yMed} className="stroke-amber-950" strokeDasharray="4 3" />
      <text x={X0} y={yMed - 8} className="fill-amber-950 text-xs">{t('admin.custos.spark.median', { days: windowDays, value: formatPlain(item.median7, lang) })}</text>
      <path d={line} className="fill-none stroke-amber-950" strokeWidth={2} strokeLinejoin="round" />
      <circle cx={X1} cy={y(last.value)} r={6} className="fill-red-900 stroke-amber-50" strokeWidth={2.5} />
      <text x={X1 - 12} y={y(last.value) + 4} textAnchor="end" className="fill-amber-950 text-xs font-semibold">{formatPlain(last.value, lang)}</text>
      <text x={X0} y={142} className="fill-amber-950 text-xs">{formatDay(s[0].day)}</text>
      <text x={X1} y={142} textAnchor="end" className="fill-amber-950 text-xs">{formatDay(last.day)}</text>
    </svg>
  );
}
