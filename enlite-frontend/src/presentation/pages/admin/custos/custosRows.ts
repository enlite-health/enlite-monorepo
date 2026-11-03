/**
 * Linhas da tabela "Quem gasta" (RF-A9) — pura, sem React nem i18n: o componente traduz `kind` e os selos.
 * Regras de dado: no máx. TOP_ROWS_SHOWN linhas nomeadas (as que levam sinal entram mesmo fora do topo) + as linhas "sem …"
 * SEMPRE visíveis (nunca absorvidas por "demais" nem cortadas) + "demais" = total do mês − soma das exibidas.
 * A aba IA não parte o total do mês (é só a parte de IA, com custo desconhecido em alguns chamadores): mostra todas as linhas, sem "demais".
 */
import { COSTS_NONE_KEY, type CostAnomalyItem, type CostOverview } from '@infrastructure/http/AdminCostsApiService';
import { restOfTotal, sharePct, topContributor } from './custosDerive';

export const TOP_ROWS_SHOWN = 8;

export type TabId = 'service' | 'resource' | 'sector' | 'ai' | 'project';
export const TABS: readonly TabId[] = ['service', 'resource', 'sector', 'ai', 'project'];

export type Signal =
  | { kind: 'factor'; value: number }
  | { kind: 'share'; value: number }
  | { kind: 'new' }
  | { kind: 'estimated' };

export interface WhoRow {
  key: string;
  /** `none` = "sem setor/recurso/projeto/atribuição" (selo próprio); `rest` = "demais"; `normal` = nome real. */
  kind: 'normal' | 'none' | 'rest';
  /** Nome cru (vazio em `none`/`rest`: o componente traduz). */
  name: string;
  /** Serviço GCP da linha (só aba Recurso, linhas normais). */
  service?: string;
  /** `null` = custo desconhecido (IA estimada sem preço): "—", nunca 0. */
  total: number | null;
  /** Participação em pontos (0-100); `null` quando o total é desconhecido ou a linha está em outra moeda que a da conta. */
  pct: number | null;
  /** Moeda da LINHA (aba IA: `r.currency ?? ov.currency`; estimada = USD); `null` = a da conta. */
  currency: string | null;
  signals: Signal[];
  highlight: boolean;
}

interface Base { key: string; none: boolean; name: string; service?: string; total: number | null; currency?: string | null; signals: Signal[]; highlight: boolean }

function itemSignal(item: CostAnomalyItem | undefined): Signal[] {
  if (!item) return [];
  if (item.isNew) return [{ kind: 'new' }];
  return item.factor === null ? [] : [{ kind: 'factor', value: item.factor }];
}

function baseRows(tab: TabId, ov: CostOverview): Base[] {
  const items = ov.anomalies.items;
  switch (tab) {
    case 'service':
      return ov.byService.map((r) => ({
        key: r.service, none: false, name: r.service, total: r.total, highlight: false,
        signals: itemSignal(items.find((i) => i.kind === 'service' && i.name === r.service)),
      }));
    case 'resource': {
      const contribuintes = items
        .filter((i) => i.kind === 'service')
        .map((i) => ({ service: i.name, top: topContributor(i) }))
        .filter((c): c is { service: string; top: { resource: string; pct: number } } => c.top !== null);
      return ov.byResource.map((r) => {
        const none = r.resource === COSTS_NONE_KEY;
        const signals = none ? [] : itemSignal(items.find((i) => i.kind === 'resource' && i.name === r.resource));
        const c = contribuintes.find((x) => x.service === r.service && x.top.resource === r.resource);
        if (c) signals.push({ kind: 'share', value: c.top.pct });
        return { key: `${r.service}|${r.resource}`, none, name: r.resource, service: none ? undefined : r.service, total: r.total, signals, highlight: Boolean(c) };
      });
    }
    case 'sector':
      return ov.bySector.map((r) => ({ key: r.sector, none: r.sector === COSTS_NONE_KEY, name: r.sector, total: r.total, signals: [], highlight: false }));
    case 'project':
      return ov.byProject.map((r) => ({ key: r.project, none: r.project === COSTS_NONE_KEY, name: r.project, total: r.total, signals: [], highlight: false }));
    case 'ai':
      return ov.byAiCaller.map((r) => ({
        key: `${r.caller}|${r.funcao}|${r.source}`,
        none: r.source === 'unattributed' || r.caller === COSTS_NONE_KEY,
        name: r.funcao === COSTS_NONE_KEY ? r.caller : `${r.caller} / ${r.funcao}`,
        total: r.total,
        currency: r.currency ?? ov.currency,
        signals: r.source === 'estimated' ? [{ kind: 'estimated' }] : [],
        highlight: false,
      }));
  }
}

const byTotalDesc = (a: Base, b: Base) => (b.total ?? -1) - (a.total ?? -1);

export function buildRows(tab: TabId, ov: CostOverview): WhoRow[] {
  const all = baseRows(tab, ov).sort(byTotalDesc);
  const partitions = tab !== 'ai';
  const named = all.filter((r) => !r.none);
  const nones = all.filter((r) => r.none);
  let shown = named;
  if (partitions && named.length > TOP_ROWS_SHOWN) {
    const withSignal = named.filter((r) => r.signals.length > 0).slice(0, TOP_ROWS_SHOWN);
    const fill = named.filter((r) => !withSignal.includes(r)).slice(0, TOP_ROWS_SHOWN - withSignal.length);
    shown = [...withSignal, ...fill].sort(byTotalDesc);
  }
  const visible = [...shown, ...nones].sort(byTotalDesc);
  const rows: WhoRow[] = visible.map((r) => ({
    key: r.key,
    kind: r.none ? 'none' : 'normal',
    name: r.none ? '' : r.name,
    service: r.service,
    total: r.total,
    currency: r.currency ?? ov.currency,
    // O total do mês é na moeda da conta: linha em outra moeda não entra na participação.
    pct: r.total === null || (r.currency ?? ov.currency) !== ov.currency ? null : sharePct(r.total, ov.monthTotal),
    signals: r.signals,
    highlight: r.highlight,
  }));
  if (partitions) {
    const rest = restOfTotal(ov.monthTotal, visible.reduce((s, r) => s + (r.total ?? 0), 0));
    if (rest > 0) rows.push({ key: '__rest__', kind: 'rest', name: '', total: rest, currency: ov.currency, pct: sharePct(rest, ov.monthTotal), signals: [], highlight: false });
  }
  return rows;
}
