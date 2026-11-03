/**
 * CustosMeses — "Últimos 6 meses" (RF-A11, DF-7): barras CSS, sem biblioteca; o valor de cada mês é TEXTO acima da barra.
 * O mês corrente é "parcial" e leva, empilhada, a barra hachurada da PREVISÃO ("prev. <valor>"). A hachura distingue sem depender
 * de cor. Altura normalizada pelo maior valor entre meses e previsão.
 */
import { useTranslation } from 'react-i18next';
import type { CostOverview } from '@infrastructure/http/AdminCostsApiService';
import { currentMonthKey, formatMoney, monthName } from './custosFormat';
import { CARD, Linha } from './custosUi';
import { Heading } from '@presentation/components/atoms/Heading';

const ALTURA_MAX = 96;
const HACHURA = { backgroundImage: 'repeating-linear-gradient(45deg, currentColor 0 1px, transparent 1px 4px)' } as const;

export function CustosMeses({ ov }: { ov: CostOverview }): JSX.Element {
  const { t, i18n } = useTranslation();
  const lang = i18n?.language;
  const money = (v: number) => formatMoney(v, ov.currency, lang);
  const corrente = currentMonthKey();
  const previsao = ov.forecast.value;
  const max = Math.max(0, ...ov.months.map((m) => m.total), previsao ?? 0);
  const alt = (v: number) => (max > 0 ? Math.max(2, Math.round((v / max) * ALTURA_MAX)) : 2);
  return (
    <section data-testid="custos-meses" className={`${CARD} flex flex-col gap-4`}>
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
        <Heading level={2} weight="semibold">{t('admin.custos.months.title')}</Heading>
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
          <span className="inline-flex items-center gap-2 whitespace-nowrap">
            <i className="block h-3 w-3 flex-none rounded-sm bg-primary" aria-hidden="true" />
            <Linha tipo="selo" size="xs">{t('admin.custos.months.real')}</Linha>
          </span>
          <span className="inline-flex items-center gap-2 whitespace-nowrap">
            <i className="block h-3 w-3 flex-none rounded-sm border border-gray-800 text-gray-800" style={HACHURA} aria-hidden="true" />
            <Linha tipo="selo" size="xs">{t('admin.custos.months.forecast')}</Linha>
          </span>
        </div>
      </div>
      <div className="overflow-x-auto">
        <ul className="grid min-w-[620px] list-none grid-cols-6 items-end gap-3 p-0" style={{ minHeight: `${ALTURA_MAX + 80}px` }}>
          {ov.months.map((m) => {
            const parcial = m.month === corrente && m.month === ov.month;
            const prev = parcial && previsao !== null ? Math.max(previsao - m.total, 0) : 0;
            return (
              <li key={m.month} data-testid={`custos-mes-${m.month}`} className="flex min-w-0 flex-col items-center justify-end gap-1.5">
                {parcial && previsao !== null && <Linha tipo="valor" size="xs" color="tertiary" data-testid={`custos-mes-previsao-${m.month}`}>{t('admin.custos.months.forecastLabel', { value: money(previsao) })}</Linha>}
                <Linha tipo="valor" size="xs" weight="semibold" className="tabular-nums">{money(m.total)}</Linha>
                <div className="flex w-12 flex-col justify-end" aria-hidden="true">
                  {prev > 0 && <i className="block w-full rounded-t border border-dashed border-gray-800 text-gray-800" data-testid={`custos-mes-barra-previsao-${m.month}`} style={{ ...HACHURA, height: `${alt(prev)}px` }} />}
                  <i className={`block w-full bg-primary ${prev > 0 ? '' : 'rounded-t'}`} data-testid={`custos-mes-barra-${m.month}`} style={{ height: `${alt(m.total)}px` }} />
                </div>
                <Linha tipo="data" size="xs" color="tertiary">{`${monthName(m.month, lang, 'short')}${parcial ? ` ${t('admin.custos.months.partial')}` : ''}`}</Linha>
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}
