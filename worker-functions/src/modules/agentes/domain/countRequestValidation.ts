/**
 * countRequestValidation — valida o pedido de contagem da Maria contra o cardápio (change 085, spec §3).
 * Campo/valor fora do cardápio = erro estruturado com a lista válida; nada é aproximado em silêncio.
 * Devolve a forma canônica: filtros ordenados por campo, valores sem duplicata e ordenados, atalhos expandidos,
 * e `literalValues` = os valores que a pessoa nomeou DIRETAMENTE (não via atalho) — a rota de pacientes usa isso
 * para saber se ALTA/DISCHARGED foi pedido literalmente.
 */
import { canonicalProvince } from '@shared/utils/normalizeLocationValue';
import { COUNT_ENTITIES, COUNT_MENU, CountEntity, CountFieldDef } from './assistantCountMenu';

export type CountRequestError =
  | { code: 'invalid_request'; message: string }
  | { code: 'invalid_entity'; entity: unknown; valid_entities: string[] }
  | { code: 'invalid_field'; field: unknown; valid_fields: string[] }
  | { code: 'invalid_value'; field: string; value: unknown; valid_values: string[] }
  | { code: 'invalid_group_by'; group_by: unknown; valid_fields: string[]; message: string }
  | { code: 'duplicate_field'; field: string }
  | { code: 'empty_values'; field: string };

export interface CanonicalFilter {
  field: string;
  /** Valores do enum já expandidos (atalhos resolvidos), sem duplicata, ordenados. */
  values: string[];
  /** Subconjunto de `values` que veio nomeado literalmente (não via atalho), ordenado. */
  literalValues: string[];
}

export interface CanonicalCountRequest {
  entity: CountEntity;
  filters: CanonicalFilter[];
  group_by: string | null;
}

export type CountValidation =
  | { ok: true; request: CanonicalCountRequest }
  | { ok: false; error: CountRequestError };

const fail = (error: CountRequestError): CountValidation => ({ ok: false, error });
const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const sorted = (xs: Iterable<string>): string[] => [...new Set(xs)].sort();

function resolveValue(
  def: CountFieldDef,
  raw: string,
): { literal: string[]; expanded: string[] } | null {
  const text = raw.trim();
  const candidate = def.field === 'zone' ? (canonicalProvince(text) ?? text) : text;
  if (def.values.includes(candidate)) return { literal: [candidate], expanded: [candidate] };
  const shortcuts = def.shortcuts ?? {};
  const key = Object.keys(shortcuts).find((k) => k.toLowerCase() === text.toLowerCase());
  if (key) return { literal: [], expanded: [...shortcuts[key]] };
  return null;
}

export function validateCountRequest(input: unknown): CountValidation {
  if (!isObj(input)) return fail({ code: 'invalid_request', message: 'el pedido debe ser un objeto' });

  const entity = input.entity;
  if (typeof entity !== 'string' || !(COUNT_ENTITIES as readonly string[]).includes(entity)) {
    return fail({ code: 'invalid_entity', entity, valid_entities: [...COUNT_ENTITIES] });
  }
  const ent = entity as CountEntity;
  const fields = COUNT_MENU[ent].fields;
  const validFields = Object.keys(fields);

  const rawFilters = input.filters === undefined || input.filters === null ? [] : input.filters;
  if (!Array.isArray(rawFilters)) return fail({ code: 'invalid_request', message: 'filters debe ser una lista' });

  const seen = new Set<string>();
  const filters: CanonicalFilter[] = [];
  for (const f of rawFilters) {
    if (!isObj(f)) return fail({ code: 'invalid_request', message: 'cada filtro debe ser {field, values}' });
    const name = f.field;
    if (typeof name !== 'string' || !Object.prototype.hasOwnProperty.call(fields, name)) {
      return fail({ code: 'invalid_field', field: name, valid_fields: validFields });
    }
    if (seen.has(name)) return fail({ code: 'duplicate_field', field: name });
    seen.add(name);
    if (!Array.isArray(f.values) || f.values.length === 0) return fail({ code: 'empty_values', field: name });

    const def = fields[name];
    const expanded: string[] = [];
    const literal: string[] = [];
    for (const v of f.values) {
      const r = typeof v === 'string' ? resolveValue(def, v) : null;
      if (!r) return fail({ code: 'invalid_value', field: name, value: v, valid_values: [...def.values] });
      expanded.push(...r.expanded);
      literal.push(...r.literal);
    }
    filters.push({ field: name, values: sorted(expanded), literalValues: sorted(literal) });
  }
  filters.sort((a, b) => (a.field < b.field ? -1 : a.field > b.field ? 1 : 0));

  let groupBy: string | null = null;
  const gb = input.group_by;
  if (gb !== undefined && gb !== null) {
    if (typeof gb !== 'string') {
      return fail({ code: 'invalid_group_by', group_by: gb, valid_fields: validFields, message: 'group_by admite un solo campo (texto), no una lista' });
    }
    if (!Object.prototype.hasOwnProperty.call(fields, gb)) {
      return fail({ code: 'invalid_group_by', group_by: gb, valid_fields: validFields, message: 'group_by no es un campo de la entidad' });
    }
    groupBy = gb;
  }

  return { ok: true, request: { entity: ent, filters, group_by: groupBy } };
}
