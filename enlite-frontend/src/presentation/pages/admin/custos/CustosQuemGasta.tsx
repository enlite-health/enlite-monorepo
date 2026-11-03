/**
 * CustosQuemGasta — "Quem gasta" (RF-A9, DF-21): UMA tabela com 5 abas (Serviço, Recurso, Setor, IA, Projeto), padrão ARIA
 * `tablist`/`tab`/`tabpanel` com ←/→/Home/End. Colunas: nome · No mês · Participação (barra + %) · Sinal. As linhas "sem …" nunca somem.
 * Átomos do DS: `Button` nas abas, `Table` na grade; o cabeçalho leva `text-primary` (o `text-gray-800` do `TableHeader` dá 4,09:1, UI-4).
 */
import { useRef, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@presentation/components/atoms/Button';
import { Heading } from '@presentation/components/atoms/Heading';
import { Text } from '@presentation/components/atoms/Text';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@presentation/components/atoms/Table';
import type { CostOverview } from '@infrastructure/http/AdminCostsApiService';
import { CustosChip } from './CustosChip';
import { formatFactor, formatMoney, formatPercent } from './custosFormat';
import { buildRows, TABS, type Signal, type TabId, type WhoRow } from './custosRows';
import { CARD, Linha } from './custosUi';

const PANEL_TESTID: Record<TabId, string> = {
  service: 'custos-por-servico', resource: 'custos-por-recurso', sector: 'custos-por-setor', ai: 'custos-por-chamador', project: 'custos-por-projeto',
};
const TH = 'text-primary';

function SignalChip({ signal }: { signal: Signal }): JSX.Element {
  const { t, i18n } = useTranslation();
  const lang = i18n?.language;
  switch (signal.kind) {
    case 'factor': return <CustosChip tone="alert">{t('admin.custos.who.signal.factor', { factor: formatFactor(signal.value, lang) })}</CustosChip>;
    case 'share': return <CustosChip tone="alert" data-testid="custos-selo-aumento">{t('admin.custos.who.signal.share', { pct: formatPercent(signal.value, lang, 0) })}</CustosChip>;
    case 'new': return <CustosChip tone="new" data-testid="custos-selo-novo">{t('admin.custos.anomaly.new')}</CustosChip>;
    case 'estimated': return <CustosChip tone="estimated" data-testid="custos-selo-estimado">{t('admin.custos.who.signal.estimated')}</CustosChip>;
  }
}

function NomeCelula({ row, tab }: { row: WhoRow; tab: TabId }): JSX.Element {
  const { t } = useTranslation();
  if (row.kind === 'none') {
    const testId = tab === 'ai' ? 'custos-selo-nao-atribuido' : 'custos-selo-sem';
    return <div className="flex min-w-0 items-center gap-2"><CustosChip tone="none" data-testid={testId}>{t(`admin.custos.who.none.${tab}`)}</CustosChip></div>;
  }
  const nome = row.kind === 'rest' ? t(tab === 'resource' ? 'admin.custos.who.rest.resource' : 'admin.custos.who.rest.other') : row.name;
  return (
    <div className="flex min-w-0 items-center gap-2">
      {row.service && <CustosChip tone="neutral">{row.service}</CustosChip>}
      <Linha tipo="nome" truncar>{nome}</Linha>
    </div>
  );
}

function Linhas({ rows, tab, lang, currency }: { rows: WhoRow[]; tab: TabId; lang: string | undefined; currency: string | null }): JSX.Element {
  const { t } = useTranslation();
  return (
    <>
      {rows.map((r) => (
        <TableRow key={r.key} data-testid="custos-linha" data-kind={r.kind} className={`h-11 ${r.highlight ? 'bg-amber-50' : ''}`}>
          <TableCell unwrapped className="min-w-0"><NomeCelula row={r} tab={tab} /></TableCell>
          <TableCell unwrapped align="right"><Linha tipo="valor" className="tabular-nums">{r.total === null ? t('admin.custos.kpi.noValue') : formatMoney(r.total, r.currency ?? currency, lang)}</Linha></TableCell>
          <TableCell unwrapped>
            <div className="flex min-w-0 items-center gap-3">
              <span className="block h-2 min-w-0 flex-1 rounded bg-gray-300" aria-hidden="true">
                <i className="block h-full rounded bg-primary" style={{ width: `${Math.min(Math.max(r.pct ?? 0, 0), 100)}%` }} />
              </span>
              <Linha tipo="valor" className="w-16 flex-none text-right tabular-nums">{r.pct === null ? t('admin.custos.kpi.noValue') : formatPercent(r.pct, lang)}</Linha>
            </div>
          </TableCell>
          <TableCell unwrapped><div className="flex min-w-0 items-center gap-2">{r.signals.map((s) => <SignalChip key={s.kind} signal={s} />)}</div></TableCell>
        </TableRow>
      ))}
    </>
  );
}

export function CustosQuemGasta({ ov }: { ov: CostOverview }): JSX.Element {
  const { t, i18n } = useTranslation();
  const lang = i18n?.language;
  const [tab, setTab] = useState<TabId>('service');
  const listRef = useRef<HTMLDivElement>(null);
  const rows = buildRows(tab, ov);

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = TABS.indexOf(tab);
    const next = e.key === 'ArrowRight' ? (i + 1) % TABS.length : e.key === 'ArrowLeft' ? (i - 1 + TABS.length) % TABS.length : e.key === 'Home' ? 0 : e.key === 'End' ? TABS.length - 1 : -1;
    if (next < 0) return;
    e.preventDefault();
    setTab(TABS[next]);
    listRef.current?.querySelectorAll<HTMLElement>('[role="tab"]')[next]?.focus();
  };

  return (
    <section data-testid="custos-quem-gasta" className={`${CARD} flex flex-col gap-4`}>
      <div>
        <Heading level={2} weight="semibold">{t('admin.custos.who.title')}</Heading>
        <Text color="tertiary" size="sm">{t('admin.custos.who.subtitle', { total: formatMoney(ov.monthTotal, ov.currency, lang) })}</Text>
      </div>
      <div ref={listRef} role="tablist" aria-label={t('admin.custos.who.tabsLabel')} onKeyDown={onKey} className="flex w-fit max-w-full flex-wrap gap-1 rounded-full bg-gray-300 p-1">
        {TABS.map((id) => (
          <Button
            key={id}
            role="tab"
            id={`custos-tab-${id}`}
            aria-selected={tab === id}
            aria-controls={`custos-painel-${id}`}
            tabIndex={tab === id ? 0 : -1}
            data-testid={`custos-aba-${id}`}
            variant={tab === id ? 'primary' : 'ghost'}
            size="lg"
            onClick={() => setTab(id)}
            className="!h-11 !px-5"
          >
            <span className="whitespace-nowrap" data-single-line="selo">{t(`admin.custos.who.tabs.${id}`)}</span>
          </Button>
        ))}
      </div>
      <div role="tabpanel" id={`custos-painel-${tab}`} aria-labelledby={`custos-tab-${tab}`} data-testid={PANEL_TESTID[tab]} className="min-w-0">
        {rows.length === 0 ? (
          <Text color="tertiary" size="sm" data-testid={`${PANEL_TESTID[tab]}-vazio`}>{t('admin.custos.who.empty')}</Text>
        ) : (
          <Table className="min-w-[760px] table-fixed">
            <TableHeader>
              <TableHead className={TH} unwrapped><Linha tipo="cabecalho" weight="medium">{t(`admin.custos.who.first.${tab}`)}</Linha></TableHead>
              <TableHead className={`${TH} w-32`} align="right" unwrapped><Linha tipo="cabecalho" weight="medium">{t('admin.custos.who.cols.month')}</Linha></TableHead>
              <TableHead className={`${TH} w-56`} unwrapped><Linha tipo="cabecalho" weight="medium">{t('admin.custos.who.cols.share')}</Linha></TableHead>
              <TableHead className={`${TH} w-44`} unwrapped><Linha tipo="cabecalho" weight="medium">{t('admin.custos.who.cols.signal')}</Linha></TableHead>
            </TableHeader>
            <TableBody><Linhas rows={rows} tab={tab} lang={lang} currency={ov.currency} /></TableBody>
          </Table>
        )}
        {tab === 'ai' && rows.length > 0 && <Text color="tertiary" size="xs" className="mt-3">{t('admin.custos.who.aiNote')}</Text>}
      </div>
    </section>
  );
}
