/**
 * countResponseShape — monta a resposta de SHAPE FECHADO da contagem (change 085, spec §3/§6).
 * Construção explícita, campo a campo: nenhuma chave da entrada que não esteja aqui chega à saída
 * (sem id, nome, telefone nem linha). Recebe valores JÁ suprimidos.
 */
import { SuppressedCount } from './countSuppression';

export interface CountResponseInput {
  entity: string;
  filters: ReadonlyArray<{ field: string; values: readonly string[] }>;
  group_by: string | null;
  total: SuppressedCount;
  groups: ReadonlyArray<{ key: string; count: { value: number } | { lt: number } }>;
  scope: string;
  as_of: string;
}

export interface CountResponse {
  entity: string;
  filters: Array<{ field: string; values: string[] }>;
  group_by: string | null;
  total: SuppressedCount;
  groups: Array<{ key: string } & ({ value: number } | { lt: number })>;
  scope: string;
  as_of: string;
}

function pickCount(c: SuppressedCount): SuppressedCount {
  if ('lt' in c) return { lt: c.lt };
  if ('gte' in c) return { gte: c.gte };
  return { value: c.value };
}

export function buildCountResponse(input: CountResponseInput): CountResponse {
  return {
    entity: input.entity,
    filters: input.filters.map((f) => ({ field: f.field, values: [...f.values] })),
    group_by: input.group_by,
    total: pickCount(input.total),
    groups: input.groups.map((g) => ({ key: g.key, ...pickCount(g.count) }) as { key: string } & ({ value: number } | { lt: number })),
    scope: input.scope,
    as_of: input.as_of,
  };
}
