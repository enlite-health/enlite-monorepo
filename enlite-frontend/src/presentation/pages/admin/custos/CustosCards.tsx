import { useTranslation } from 'react-i18next';
import type { CostOverview } from '@infrastructure/http/AdminCostsApiService';
import { formatMoney, formatVariation } from './custosFormat';

const CARD = 'rounded-[20px] border-2 border-[#595959] bg-white p-4 sm:p-5';

function Referencia({ testId, label, base, valor, currency }: {
  testId: string; label: string; base: number | null; valor: number; currency: string | null;
}): JSX.Element {
  const { t, i18n } = useTranslation();
  const variacao = formatVariation(valor, base, i18n?.language);
  return (
    <div data-testid={testId} className="flex flex-wrap items-baseline justify-between gap-x-3 text-sm text-[#262626]">
      <span>{label}</span>
      <span className="font-semibold">
        {base === null ? t('admin.custos.cards.noValue') : formatMoney(base, currency, i18n?.language)}
        {variacao && (
          <span data-testid={`${testId}-variacao`} className="ml-2 text-[#404040]">
            ({t('admin.custos.cards.variation', { pct: variacao })})
          </span>
        )}
      </span>
    </div>
  );
}

function Cartao({ testId, titulo, nota, valor, ov }: {
  testId: string; titulo: string; nota?: string; valor: number | null; ov: CostOverview;
}): JSX.Element {
  const { t, i18n } = useTranslation();
  return (
    <section data-testid={testId} className={`${CARD} space-y-2`}>
      <h2 className="text-sm font-semibold text-[#404040]">
        {titulo}
        {nota && <span className="ml-2 font-normal">({nota})</span>}
      </h2>
      <p data-testid={`${testId}-valor`} className="text-3xl font-semibold text-[#1A1A1A]">
        {valor === null ? t('admin.custos.cards.noValue') : formatMoney(valor, ov.currency, i18n?.language)}
      </p>
      {valor === null && <p className="text-xs text-[#404040]">{t('admin.custos.cards.forecastUnavailable')}</p>}
      {valor !== null && (
        <div className="space-y-1 border-t border-[#595959] pt-2">
          <Referencia testId={`${testId}-ref-ate-dia`} label={t('admin.custos.cards.prevToDate')} base={ov.prevMonthToDate} valor={valor} currency={ov.currency} />
          <Referencia testId={`${testId}-ref-fechado`} label={t('admin.custos.cards.prevClosed')} base={ov.prevMonthTotal} valor={valor} currency={ov.currency} />
        </div>
      )}
    </section>
  );
}

/** Mês corrente e previsão, cada um ao lado do mês anterior (até o mesmo dia e fechado) com a variação %. Sem teto, sem cor de "estourou". */
export function CustosCards({ ov }: { ov: CostOverview }): JSX.Element {
  const { t } = useTranslation();
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <Cartao testId="custos-card-mes" titulo={t('admin.custos.cards.month')} valor={ov.monthTotal} ov={ov} />
      <Cartao testId="custos-card-previsao" titulo={t('admin.custos.cards.forecast')} nota={t('admin.custos.cards.forecastBasis')} valor={ov.forecast.value} ov={ov} />
    </div>
  );
}

/** Últimos 6 meses em barras CSS (DF-7): sem biblioteca; o valor vem escrito embaixo de cada barra. */
export function CustosMeses({ ov }: { ov: CostOverview }): JSX.Element {
  const { t, i18n } = useTranslation();
  const max = Math.max(0, ...ov.months.map((m) => m.total));
  return (
    <section data-testid="custos-meses" className={CARD}>
      <h2 className="mb-3 text-sm font-semibold text-[#404040]">{t('admin.custos.months.title')}</h2>
      <ul className="flex items-end gap-2 sm:gap-4" style={{ minHeight: '10rem' }}>
        {ov.months.map((m) => (
          <li key={m.month} data-testid={`custos-mes-${m.month}`} className="flex min-w-0 flex-1 flex-col items-center justify-end gap-1">
            <div
              data-testid={`custos-mes-barra-${m.month}`}
              className="w-full max-w-[3.5rem] rounded-t bg-[#0B2E6B]"
              style={{ height: `${max > 0 ? Math.max(2, Math.round((m.total / max) * 100)) : 2}px`, minHeight: '2px' }}
              aria-hidden="true"
            />
            <span className="text-xs font-semibold text-[#1A1A1A]">{formatMoney(m.total, ov.currency, i18n?.language)}</span>
            <span className="text-xs text-[#404040]">{m.month}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
