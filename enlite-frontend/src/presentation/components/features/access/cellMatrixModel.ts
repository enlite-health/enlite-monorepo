import type { CatalogCategory, PermissionCell } from '@infrastructure/http/AdminPermissionsApiService';

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
  /** O texto VISÍVEL do recurso — o que a pessoa lê, e por onde a grade ordena. */
  rotulo: string;
  /** A célula de cada ação — ausente quando o recurso não tem aquela ação. */
  porAcao: Record<string, PermissionCell>;
}

/** Uma categoria: as linhas e as colunas QUE ELA usa. */
export interface Bloco {
  category: string;
  /** O texto VISÍVEL da categoria — o que a pessoa lê, e por onde os blocos ordenam. */
  rotulo: string;
  grade: Linha[];
  /** Só as ações que os recursos DESTA categoria usam. */
  colunas: string[];
}

/**
 * Como a tela resolve o texto visível. Injetado para o modelo continuar puro —
 * ele ordena, não sabe o que é i18n.
 */
export interface Rotulos {
  categoria: (chave: string) => string;
  recurso: (chave: string) => string;
}

/** A identidade: sem resolvedor, o rótulo É a chave crua (o que os testes de modelo usam). */
export const ROTULO_CRU: Rotulos = { categoria: (c) => c, recurso: (r) => r };

/**
 * Alfabético pelo texto VISÍVEL, sempre na collation `es-AR`.
 *
 * `es-AR` é FIXO de propósito, não é "o idioma ativo": é o idioma primário do
 * painel (a mesma escolha de `MemberTransfer.byName`), e entre pt-BR e es-AR a
 * collation destes rótulos latinos não difere.
 *
 * Ordenar pela chave crua desenharia uma ordem aleatória na tela: em
 * `Operaciones` as chaves `dashboard · dedup · integration · test_fixtures`
 * estão em ordem, e o que a pessoa lê é `Tablero · Duplicados · Integraciones ·
 * Datos de prueba` — nada. Empate cai na chave, para a ordem ser determinística.
 */
const alfabetico = (
  [rotuloA, chaveA]: readonly [string, string],
  [rotuloB, chaveB]: readonly [string, string],
): number => rotuloA.localeCompare(rotuloB, 'es-AR') || chaveA.localeCompare(chaveB);

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
 * Uma linha por RECURSO, em ordem ALFABÉTICA do rótulo visível.
 *
 * Decisão do Gabriel (05/09), olhando a tela: "quero que tudo fique em ordem
 * alfabética". Antes a grade saía na ordem em que o catálogo veio — que é
 * alfabética pela CHAVE, e a chave não é o que a pessoa lê.
 *
 * O que isso custa, dito por inteiro: o dossiê (`worker_pii`, "Dossier: DNI,
 * domicilio, datos sensibles") sobe de 4ª para 3ª linha em Trabajadores. A ordem
 * do catálogo nunca o destacou de fato — ele já vinha depois de `worker`, no
 * meio da lista. Se a linha perigosa precisar de destaque, o destaque é visual
 * (cor, ícone, aviso do `lex`), não posicional: posição não avisa ninguém.
 */
export function agrupaPorRecurso(cells: readonly PermissionCell[], rotulo: Rotulos['recurso']): Linha[] {
  const porRecurso = new Map<string, Linha>();
  for (const c of cells) {
    const linha = porRecurso.get(c.resource)
      ?? { resource: c.resource, rotulo: rotulo(c.resource), porAcao: {} };
    linha.porAcao[c.action] = c;
    porRecurso.set(c.resource, linha);
  }
  return [...porRecurso.values()].sort((a, b) => alfabetico([a.rotulo, a.resource], [b.rotulo, b.resource]));
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
export function montaBloco(
  category: string,
  cells: readonly PermissionCell[],
  rotulos: Rotulos = ROTULO_CRU,
): Bloco {
  return {
    category,
    rotulo: rotulos.categoria(category),
    grade: agrupaPorRecurso(cells, rotulos.recurso),
    colunas: colunasDe(cells),
  };
}

/**
 * O catálogo inteiro: um bloco por categoria, as categorias em ordem ALFABÉTICA
 * do rótulo visível.
 *
 * A ordem do backend é alfabética pelo nome PORTUGUÊS da categoria, e a tela
 * mostra o espanhol — as duas listas coincidem hoje por sorte, e divergem no
 * primeiro nome que traduz para outra letra (`Não categorizado` → `Sin
 * categoría` já diverge). Ordenar aqui é ordenar pelo que se lê.
 */
export function montaBlocos(catalog: readonly CatalogCategory[], rotulos: Rotulos = ROTULO_CRU): Bloco[] {
  return catalog
    .map((cat) => montaBloco(cat.category, cat.cells, rotulos))
    .sort((a, b) => alfabetico([a.rotulo, a.category], [b.rotulo, b.category]));
}

/**
 * A ação que todas as outras pressupõem: quem pode MEXER tem de poder VER.
 *
 * A regra é a *implied permission* clássica (o `matrix-auth` do Jenkins é a
 * referência: `Job/Configure` implica `Job/Read`). Aqui ela é deliberadamente
 * estreita — só `read`, e só dentro do MESMO recurso. Nada de `delete` implicar
 * `write`, nada de nível: a D128 separou `send` de `write` e a D131 separou
 * `export` de `read` por motivo medido, e uma cadeia mais longa reconstruiria
 * o "nível por recurso" que o CTO recusou.
 */
export const ACAO_BASE = 'read';

/** As ações mais fortes do recurso que estão marcadas AGORA. */
export function exigemLeitura(linha: Linha, selected: ReadonlySet<string>): string[] {
  return Object.entries(linha.porAcao)
    .filter(([acao, c]) => acao !== ACAO_BASE && selected.has(cellKey(c)))
    .map(([acao]) => acao);
}

/**
 * `Ver` fica TRAVADA enquanto qualquer ação mais forte estiver marcada.
 *
 * Decisão do Gabriel (05/09), contra a minha recomendação: ele preferiu travar
 * a cascata para baixo. O preço é o que a NN/g documenta — caixa que não
 * responde ao clique lê como "marcada e proibida" —, e é por isso que a trava
 * NÃO pode ser muda: quem trava aparece no `title` e no rótulo acessível.
 */
export function leituraTravada(linha: Linha, selected: ReadonlySet<string>): boolean {
  return Boolean(linha.porAcao[ACAO_BASE]) && exigemLeitura(linha, selected).length > 0;
}

/**
 * O toggle COM a implicação: marcar uma ação mais forte marca `Ver` junto.
 *
 * Recurso SEM `read` declarado não ganha nada — não dá para marcar o que não
 * existe. Hoje isso vale para `integration` e `test_fixtures`, que só têm
 * `execute`: ali dá para conceder operação sem nenhuma leitura, e o buraco é do
 * CATÁLOGO, não desta tela.
 */
export function alternaCelula(
  catalog: readonly CatalogCategory[],
  selected: ReadonlySet<string>,
  key: string,
): Set<string> {
  const proximo = new Set(selected);
  if (proximo.has(key)) {
    proximo.delete(key);
    return proximo;
  }
  proximo.add(key);
  const [resource, action] = key.split(':');
  if (action === ACAO_BASE) return proximo;
  for (const cat of catalog) {
    for (const c of cat.cells) {
      if (c.resource === resource && c.action === ACAO_BASE) proximo.add(cellKey(c));
    }
  }
  return proximo;
}

/**
 * Quantas células o grupo dá — contadas na GRADE, não no conjunto.
 *
 * O número tem de bater com o que a pessoa vê marcado. Uma célula que o grupo
 * guarda e o catálogo não declara mais (o sync descontinua chave) não desenha
 * checkbox nenhum: contá-la faria o cabeçalho dizer 11 numa tela com 10 ✓.
 */
export function contaSelecionadas(
  catalog: readonly CatalogCategory[],
  selected: ReadonlySet<string>,
): number {
  let total = 0;
  for (const cat of catalog) {
    for (const c of cat.cells) if (selected.has(cellKey(c))) total += 1;
  }
  return total;
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
