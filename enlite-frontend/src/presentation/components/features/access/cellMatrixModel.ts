import type { PermissionCell } from '@infrastructure/http/AdminPermissionsApiService';

/**
 * A ordem canônica das colunas — o poder crescendo da esquerda para a direita:
 * ver, mexer, apagar, levar embora, e depois as ações de operação.
 *
 * NÃO é a lista fechada de ações: é só a ordem. Ação que não estiver aqui ganha
 * coluna própria no fim, em ordem alfabética. O catálogo é derivado do código e
 * cresce sem passar por este arquivo — uma lista fechada faria a célula nova
 * SUMIR da tela, e célula que não aparece é célula que ninguém concede.
 */
export const ORDEM_ACOES = ['read', 'write', 'delete', 'export', 'validate', 'execute', 'send', 'disable'] as const;

/** Chave canônica da célula — o formato que `iam.effective_permissions` devolve. */
export const cellKey = (c: Pick<PermissionCell, 'resource' | 'action'>): string =>
  `${c.resource}:${c.action}`;

export interface Linha {
  resource: string;
  /** A célula de cada ação — ausente quando o recurso não tem aquela ação. */
  porAcao: Record<string, PermissionCell>;
}

/**
 * As colunas que este catálogo REALMENTE usa, na ordem canônica. Só por isto a
 * tela do desenho (Trabajadores + Vacantes) rende exatamente 5 colunas — Ver,
 * Crear y editar, Eliminar, Exportar, Validar — sem que a lista seja fechada.
 */
export function colunasDe(cells: readonly PermissionCell[]): string[] {
  const usadas = new Set(cells.map((c) => c.action));
  const conhecidas = ORDEM_ACOES.filter((a) => usadas.has(a));
  const novas = [...usadas].filter((a) => !ORDEM_ACOES.includes(a as never)).sort();
  return [...conhecidas, ...novas];
}

/**
 * Uma linha por RECURSO, na ordem em que o catálogo veio — não alfabética.
 * Ordenar por chave crua jogaria `worker_pii` (o dossiê, a linha perigosa) para
 * depois de `worker_document`, enterrando justamente o que precisa de atenção.
 */
export function agrupaPorRecurso(cells: PermissionCell[]): Linha[] {
  const porRecurso = new Map<string, Linha>();
  for (const c of cells) {
    const linha = porRecurso.get(c.resource) ?? { resource: c.resource, porAcao: {} };
    linha.porAcao[c.action] = c;
    porRecurso.set(c.resource, linha);
  }
  return [...porRecurso.values()];
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
