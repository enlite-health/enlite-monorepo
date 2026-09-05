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

/** Uma categoria: as linhas e as colunas QUE ELA usa. */
export interface Bloco {
  category: string;
  grade: Linha[];
  /** Só as ações que os recursos DESTA categoria usam. */
  colunas: string[];
}

/**
 * As três ações que TODA categoria mostra, tenha ou não célula nelas.
 *
 * Decisão do Gabriel (05/09), olhando a tela: "deixar por padrão Ver, Criar e
 * Elim., e caso a linha não tenha essa opção deixa o travessão. Fica algo
 * simétrico." Sem elas, cada categoria terminava num x diferente — 495px na
 * Analítica, 750 na Administración — e a página inteira ficava com o lado
 * direito serrilhado e vazio.
 *
 * O custo é travessão: 24 → 41. É a troca aceita, e ela compra 5 das 9
 * categorias terminando exatamente no mesmo lugar.
 */
export const COLUNAS_BASE = ['read', 'write', 'delete'] as const;

/**
 * As colunas da categoria: as três base SEMPRE, mais as ações que ela de fato
 * usa. Ação fora da ordem canônica ganha coluna própria no fim — o catálogo é
 * derivado do código e cresce sem passar por aqui, e célula que não aparece é
 * célula que ninguém concede.
 */
export function colunasDe(cells: readonly PermissionCell[]): string[] {
  const usadas = new Set<string>(cells.map((c) => c.action));
  for (const a of COLUNAS_BASE) usadas.add(a);
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
 * A categoria inteira numa grade só — TODO recurso é linha, inclusive o de uma
 * célula.
 *
 * Tirar o recurso de célula única da grade (o que foi ao ar no #296) reduzia o
 * travessão de 24 para 10, e o Gabriel abriu a tela: "está horrível. Espaços em
 * branco. Um checkbox em uma linha que nem se sabe o que faz." Ele tinha razão
 * e o número escondia: fora da grade, a caixa perde o CABEÇALHO — não dá para
 * saber se aquele checkbox é "Ver" ou outra coisa —, e fica na margem enquanto
 * a caixa da grade fica na coluna, dois alinhamentos no mesmo bloco.
 *
 * O que mata o vazio é a coluna por CATEGORIA, não tirar linha da grade:
 *   colunas globais   176 posições · 129 travessões (73%)
 *   por categoria      71 posições ·  24 travessões (33%), 6 das 9 sem nenhum
 * `Analytics` vira 1×1 — uma linha, uma coluna nomeada, uma caixa embaixo dela.
 */
export function montaBloco(category: string, cells: readonly PermissionCell[]): Bloco {
  const grade = agrupaPorRecurso(cells);
  return { category, grade, colunas: colunasDe(cells) };
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
