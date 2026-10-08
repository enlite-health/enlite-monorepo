import { z } from 'zod';

/**
 * parseSort — ordenação por parâmetro de query, genérica (spec 046 §3.2).
 *
 * A allowlist mapeia chave PÚBLICA → extrator/expressão definido pelo endpoint
 * (`T`: função em memória, fragmento SQL fixo, etc.). O valor vindo da requisição
 * NUNCA é interpolado em lugar nenhum: só serve para PROCURAR a chave na allowlist;
 * a direção só pode ser `asc` ou `desc`. Qualquer outra coisa vira `SortParamError`
 * (o controller responde 400 — parâmetro novo, sem cliente legado para proteger).
 */
export type SortOrder = 'asc' | 'desc';

export interface SortSpec {
  key: string;
  order: SortOrder;
}

export interface ParsedSort<T> extends SortSpec {
  /** O valor da allowlist para `key` (extrator ou expressão do endpoint). */
  value: T;
}

export class SortParamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SortParamError';
  }
}

/** Só `sort` e `order`: os demais params do endpoint não são tocados por este schema. */
export const sortQuerySchema = z.object({
  sort: z.string().optional(),
  order: z.enum(['asc', 'desc']).optional(),
});

export function parseSort<T>(
  query: Record<string, unknown>,
  allowlist: Readonly<Record<string, T>>,
  defaultSort: SortSpec | null = null,
): ParsedSort<T> | null {
  const parsed = sortQuerySchema.safeParse({ sort: query.sort, order: query.order });
  if (!parsed.success) {
    throw new SortParamError(`Parâmetros de ordenação inválidos: ${parsed.error.issues.map((i) => i.path.join('.')).join(', ')}`);
  }
  const { sort, order } = parsed.data;

  if (sort === undefined) {
    if (order !== undefined) throw new SortParamError('order exige sort');
    if (defaultSort === null) return null;
    return { ...defaultSort, value: allowlist[defaultSort.key] };
  }

  // hasOwn: `__proto__`/`constructor`/`toString` não são chaves públicas.
  if (!Object.prototype.hasOwnProperty.call(allowlist, sort)) {
    throw new SortParamError(`sort fora da allowlist: permitidos ${Object.keys(allowlist).join(', ')}`);
  }
  return { key: sort, order: order ?? 'asc', value: allowlist[sort] };
}
