/**
 * countSuppression — supressão de célula pequena da contagem da Maria (change 085, spec §6, DD7).
 * Função pura aplicada DEPOIS da agregação. 1-4 -> {lt:5}; 0 e >=5 exatos; se qualquer grupo saiu {lt:5},
 * o total sai arredondado para baixo à dezena com `gte`, para que total − grupos visíveis não reconstitua a célula.
 */
export const COUNT_SUPPRESSION_FLOOR = 5;

export type SuppressedCount = { value: number } | { lt: number } | { gte: number };

export function suppress(n: number): { value: number } | { lt: number } {
  if (n >= 1 && n < COUNT_SUPPRESSION_FLOOR) return { lt: COUNT_SUPPRESSION_FLOOR };
  return { value: n };
}

export interface RawCountGroup {
  key: string;
  count: number;
}

export interface SuppressedGroup {
  key: string;
  count: { value: number } | { lt: number };
}

export function suppressResult(
  total: number,
  groups: readonly RawCountGroup[],
): { total: SuppressedCount; groups: SuppressedGroup[] } {
  const out = groups.map((g) => ({ key: g.key, count: suppress(g.count) }));
  const anySuppressed = out.some((g) => 'lt' in g.count);
  const outTotal: SuppressedCount = anySuppressed ? { gte: Math.floor(total / 10) * 10 } : suppress(total);
  return { total: outTotal, groups: out };
}
