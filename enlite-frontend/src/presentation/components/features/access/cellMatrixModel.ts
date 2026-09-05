import type { PermissionCell } from '@infrastructure/http/AdminPermissionsApiService';

/**
 * As colunas da matriz, na ordem em que uma pessoa lê o poder crescendo: ver,
 * mexer, apagar, levar embora, e o resto. `other` junta as ações raras
 * (`execute`, `send`, `validate`, `disable`) numa coluna só — separar cada uma
 * daria 8 colunas quase vazias.
 */
export const COLUNAS = ['read', 'write', 'delete', 'export', 'other'] as const;
export type Coluna = (typeof COLUNAS)[number];

const ACAO_COLUNA: Readonly<Record<string, Coluna>> = {
  read: 'read', write: 'write', delete: 'delete', export: 'export',
};

export const colunaDe = (acao: string): Coluna => ACAO_COLUNA[acao] ?? 'other';

/** Chave canônica da célula — o formato que `iam.effective_permissions` devolve. */
export const cellKey = (c: Pick<PermissionCell, 'resource' | 'action'>): string =>
  `${c.resource}:${c.action}`;

export interface Linha {
  resource: string;
  /** A ação que ocupa cada coluna — `undefined` quando a célula não existe. */
  porColuna: Partial<Record<Coluna, PermissionCell>>;
}

/** Uma linha por RECURSO; cada ação cai na sua coluna. */
export function agrupaPorRecurso(cells: PermissionCell[]): Linha[] {
  const porRecurso = new Map<string, Linha>();
  for (const c of cells) {
    const linha = porRecurso.get(c.resource) ?? { resource: c.resource, porColuna: {} };
    linha.porColuna[colunaDe(c.action)] = c;
    porRecurso.set(c.resource, linha);
  }
  return [...porRecurso.values()].sort((a, b) => a.resource.localeCompare(b.resource, 'es-AR'));
}

/**
 * O que muda ao salvar: quantas entram, quantas saem. Sem isto, desmarcar sem
 * querer é silencioso — `setGroupPermissions` manda o conjunto INTEIRO.
 */
export function cellDiff(
  saved: readonly string[],
  selected: ReadonlySet<string>,
): { added: string[]; removed: string[]; dirty: boolean } {
  const salvas = new Set(saved);
  const added = [...selected].filter((k) => !salvas.has(k)).sort();
  const removed = saved.filter((k) => !selected.has(k)).sort();
  return { added, removed, dirty: added.length > 0 || removed.length > 0 };
}
