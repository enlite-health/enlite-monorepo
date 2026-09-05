import type { PermissionCell } from '@infrastructure/http/AdminPermissionsApiService';

/**
 * A ordem canônica das colunas — o poder crescendo da esquerda para a direita:
 * ver, mexer, apagar, levar embora, e depois as ações de operação.
 *
 * NÃO é a lista fechada de ações: é só a ordem. Ação que não estiver aqui ganha
 * coluna própria no fim, em ordem alfabética. O catálogo é derivado do código e
 * cresce sem passar por este arquivo — uma lista fechada faria a célula nova
 * SUMIR da tela, e célula que não aparece é célula que ninguém concede.
 * (Prova de que isso acontece: `messaging:write`, criada pela D128, é declarada
 * por duas rotas e não está no fixture do frontend.)
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

/** Uma categoria já dividida em quem merece grade e quem não. */
export interface Bloco {
  category: string;
  /** Recursos com 2+ ações: viram grade, com as colunas DESTA categoria. */
  grade: Linha[];
  /** Colunas da grade — só as ações que os recursos acima realmente usam. */
  colunas: string[];
  /**
   * Recursos com UMA ação só. Fora da grade: numa matriz, viram uma linha com
   * uma caixa e N travessões, e o pior é que os travessões pertencem às colunas
   * de OUTRO recurso. `worker_pii` (o dossiê) é um deles — a célula mais
   * sensível do catálogo aparecia como quase-vazio.
   */
  avulsos: PermissionCell[];
}

/** As ações usadas por um conjunto de células, na ordem canônica. */
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
export function agrupaPorRecurso(cells: readonly PermissionCell[]): Linha[] {
  const porRecurso = new Map<string, Linha>();
  for (const c of cells) {
    const linha = porRecurso.get(c.resource) ?? { resource: c.resource, porAcao: {} };
    linha.porAcao[c.action] = c;
    porRecurso.set(c.resource, linha);
  }
  return [...porRecurso.values()];
}

/**
 * Divide a categoria em grade e avulsos, e calcula as colunas DA CATEGORIA.
 *
 * Colunas por categoria, e não do catálogo inteiro, é o que mata o vazio: com
 * as 8 colunas globais são 22 recursos × 8 = 176 posições e 129 travessões
 * (73%). Por categoria, com os avulsos fora, cai para ~51 posições e ~10
 * travessões — e 5 das 9 categorias ficam sem nenhum. (D271)
 */
export function montaBloco(category: string, cells: readonly PermissionCell[]): Bloco {
  const linhas = agrupaPorRecurso(cells);
  const grade = linhas.filter((l) => Object.keys(l.porAcao).length > 1);
  const avulsos = linhas
    .filter((l) => Object.keys(l.porAcao).length === 1)
    .map((l) => Object.values(l.porAcao)[0]);
  return {
    category,
    grade,
    colunas: colunasDe(grade.flatMap((l) => Object.values(l.porAcao))),
    avulsos,
  };
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
