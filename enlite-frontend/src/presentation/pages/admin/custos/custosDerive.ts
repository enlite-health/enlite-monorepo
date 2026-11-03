/**
 * Derivações do painel de custos (spec 082, DF-19): tudo que a tela mostra e NÃO vem gravado no payload —
 * impacto, aumento, parte do aumento, maior contribuinte, "demais", participação. Puras, sem React.
 * O payload traz só o dado bruto (D514/D516: derivado é calculado no leitor, nunca copiado).
 */
import type { CostAnomalyItem, CostAnomalyResourceDetail } from '@infrastructure/http/AdminCostsApiService';

/** Impacto do item = custo do dia − mediana dos 7 dias anteriores. */
export function impact(item: Pick<CostAnomalyItem, 'dayValue' | 'median7'>): number {
  return item.dayValue - item.median7;
}

/** Aumento de um recurso no dia (dayValue − median7), mesmo cálculo do impacto. */
export function increase(r: Pick<CostAnomalyResourceDetail, 'dayValue' | 'median7'>): number {
  return r.dayValue - r.median7;
}

/** Participação em pontos percentuais (0-100). Total do mês ≤ 0 → 0 (nunca NaN/Infinity). */
export function sharePct(total: number, monthTotal: number): number {
  return monthTotal > 0 ? (total / monthTotal) * 100 : 0;
}

/** "Parte do aumento" do recurso: max(aumento, 0) ÷ impacto do serviço, em pontos. Impacto ≤ 0 → 0. */
export function shareOfIncrease(r: Pick<CostAnomalyResourceDetail, 'dayValue' | 'median7'>, itemImpact: number): number {
  return itemImpact > 0 ? (Math.max(increase(r), 0) / itemImpact) * 100 : 0;
}

/** Maior contribuinte = `detail.resources[0]` (o backend ordena por aumento desc) com a parte do aumento. */
export function topContributor(item: CostAnomalyItem): { resource: string; pct: number } | null {
  const top = item.detail?.resources[0];
  if (!top) return null;
  return { resource: top.resource, pct: shareOfIncrease(top, impact(item)) };
}

/** "demais" = total do mês − soma das linhas exibidas; resíduo de arredondamento (< 0,005) não vira linha. */
export function restOfTotal(monthTotal: number, shownSum: number): number {
  const rest = monthTotal - shownSum;
  return rest > 0.005 ? rest : 0;
}

/** Destaque (A1) = 1º item, na ordem de impacto do backend, que NÃO seja "novo"; os demais são compactos. */
export function splitAnomalies(items: CostAnomalyItem[]): { main: CostAnomalyItem | null; others: CostAnomalyItem[] } {
  const main = items.find((i) => !i.isNew) ?? null;
  return { main, others: items.filter((i) => i !== main) };
}

/** Teto "redondo" do eixo (15, 30, 45…): o menor múltiplo de `passo` que cobre o máximo. */
export function niceMax(max: number): number {
  if (max <= 0) return 1;
  const passo = max <= 5 ? 1 : max <= 20 ? 5 : max <= 100 ? 15 : Math.pow(10, Math.floor(Math.log10(max)));
  return Math.ceil(max / passo) * passo;
}
