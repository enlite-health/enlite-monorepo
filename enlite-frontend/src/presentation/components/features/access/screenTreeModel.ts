import type { CatalogCategory, PermissionCell } from '@infrastructure/http/AdminPermissionsApiService';
import { SCREEN_REGISTRY, screensByCell, type ScreenDef } from '@presentation/config/screenRegistry';
import { normalizeText } from '@presentation/utils/normalizeText';
import { cellKey, colunasDe, type Bloco, type Linha } from './cellMatrixModel';

/**
 * screenTreeModel — a seção de células do grupo organizada por TELA → CONTAINER → ações (D286).
 *
 * Substitui a matriz por categoria (recurso × ação): o time pensa "o que a Sofia vê na tela de
 * paciente", não "quais recursos ela acessa". Cada tela do `SCREEN_REGISTRY` vira um bloco; cada
 * container (ou cada recurso das ações da própria tela) vira uma linha; as colunas são as ações
 * que AQUELA tela usa.
 *
 * Três decisões que são contrato:
 *  1. A célula é UMA só. `patient:read` aparece em Pacientes: Lista e em Pacientes: Detalhes —
 *     as duas linhas apontam para a MESMA chave, então marcar num lugar marca no outro. A linha
 *     diz "também em: …" para a pessoa não achar que são duas.
 *  2. O catálogo do back é a verdade de EXISTÊNCIA. Célula do registro que o back não conhece
 *     não desenha caixa (e o teste de paridade reprova antes). Célula do back que nenhuma tela
 *     lista cai no bloco "Outras células", por recurso — nunca some: célula que não aparece é
 *     célula que ninguém concede.
 *  3. O modelo é PURO (sem React, sem i18n): recebe os rótulos por injeção, como `montaBlocos`.
 */

export interface RotulosDeTela {
  tela: (screenId: string) => string;
  container: (screenId: string, containerId: string) => string;
  recurso: (resource: string) => string;
  /** "também em: X, Y" — recebe os NOMES das outras telas já traduzidos. */
  tambemEm: (telas: readonly string[]) => string;
  outras: string;
}

export const ROTULOS_CRUS: RotulosDeTela = {
  tela: (s) => s,
  container: (_s, c) => c,
  recurso: (r) => r,
  tambemEm: (telas) => telas.join(', '),
  outras: 'outras',
};

/** Linha da árvore: a linha da matriz + as outras telas que consomem a mesma célula. */
export interface LinhaDeTela extends Linha {
  /** ids das OUTRAS telas que consomem alguma célula desta linha (a `nota` é o texto disso). */
  tambemEm: readonly string[];
}

export interface BlocoDeTela extends Bloco {
  grade: LinhaDeTela[];
  /** `true` no bloco final, das células que nenhuma tela lista. */
  outras?: true;
}

function indexaCatalogo(catalog: readonly CatalogCategory[]): Map<string, PermissionCell> {
  const m = new Map<string, PermissionCell>();
  for (const cat of catalog) for (const c of cat.cells) m.set(cellKey(c), c);
  return m;
}

/**
 * Monta os blocos por tela. `catalog` é o do back (`GET /permissions/catalog`); `registry` só é
 * parâmetro para o teste — em produção é o `SCREEN_REGISTRY`.
 */
export function montaBlocosPorTela(
  catalog: readonly CatalogCategory[],
  rotulos: RotulosDeTela,
  registry: readonly ScreenDef[] = SCREEN_REGISTRY,
): BlocoDeTela[] {
  const porChave = indexaCatalogo(catalog);
  const telasPorCelula = screensByCell(registry);
  const listadas = new Set<string>();
  const blocos: BlocoDeTela[] = [];

  for (const screen of registry) {
    // Linhas: uma por container; as ações da PRÓPRIA tela agrupadas por recurso.
    const linhas = new Map<string, LinhaDeTela>();
    const poe = (chaveLinha: string, rotulo: string, cellKeys: readonly string[]) => {
      for (const key of cellKeys) {
        const cell = porChave.get(key);
        if (!cell) continue; // o back não conhece — o teste de paridade acusa; a tela não inventa caixa
        listadas.add(key);
        const linha = linhas.get(chaveLinha) ?? { resource: cell.resource, rotulo, porAcao: {}, tambemEm: [] };
        linha.porAcao[cell.action] = cell;
        const outras = (telasPorCelula.get(key) ?? []).filter((s) => s !== screen.id);
        linha.tambemEm = [...new Set([...linha.tambemEm, ...outras])];
        linhas.set(chaveLinha, linha);
      }
    };
    for (const ct of screen.containers ?? []) poe(`c:${ct.id}`, rotulos.container(screen.id, ct.id), ct.cells);
    // Ações da própria tela: agrupadas por recurso, rotuladas pelo recurso.
    const porRecurso = new Map<string, string[]>();
    for (const key of screen.cells ?? []) {
      const r = key.split(':')[0];
      porRecurso.set(r, [...(porRecurso.get(r) ?? []), key]);
    }
    for (const [r, keys] of porRecurso) poe(`r:${r}`, rotulos.recurso(r), keys);

    const grade = [...linhas.values()].map((l) => ({
      ...l,
      nota: l.tambemEm.length > 0 ? rotulos.tambemEm(l.tambemEm.map((id) => rotulos.tela(id))) : undefined,
    }));
    if (grade.length === 0) continue; // tela cujas células o back ainda não tem
    const cells = grade.flatMap((l) => Object.values(l.porAcao));
    blocos.push({ category: screen.id, rotulo: rotulos.tela(screen.id), grade, colunas: colunasDe(cells) });
  }

  // O que sobrou: célula do back que nenhuma tela lista — por recurso, no fim.
  const sobras = [...porChave.entries()].filter(([key]) => !listadas.has(key)).map(([, c]) => c);
  if (sobras.length > 0) {
    const porRecurso = new Map<string, LinhaDeTela>();
    for (const c of sobras) {
      const linha = porRecurso.get(c.resource) ?? { resource: c.resource, rotulo: rotulos.recurso(c.resource), porAcao: {}, tambemEm: [] };
      linha.porAcao[c.action] = c;
      porRecurso.set(c.resource, linha);
    }
    const grade = [...porRecurso.values()].sort((a, b) => a.rotulo.localeCompare(b.rotulo, 'es-AR'));
    blocos.push({ category: '__outras__', rotulo: rotulos.outras, grade, colunas: colunasDe(sobras), outras: true });
  }
  return blocos;
}

/** As células do catálogo que NENHUMA tela lista — o que o teste de paridade vigia. */
export function celulasForaDasTelas(catalog: readonly CatalogCategory[], registry: readonly ScreenDef[] = SCREEN_REGISTRY): string[] {
  const listadas = screensByCell(registry);
  return [...indexaCatalogo(catalog).keys()].filter((k) => !listadas.has(k)).sort();
}

const normaliza = (s: string): string => normalizeText(s.trim());

/**
 * Busca/filtro da tela do grupo (US-21, FR-720, contracts/permissions-split.md §Busca).
 *
 * Filtra no CLIENTE, sobre a árvore já montada — nada muda no que é gravado (a `cells` marcada
 * fica no `Set` da página, intacta; esta função só decide o que a grade DESENHA). Casa por três
 * campos, com `normalizeText` (minúsculo + sem diacrítico — o MESMO util do `SearchableSelect`,
 * D209 do gate `revisao-pr`: 32 dos 96 rótulos do painel têm acento — "Gestión a la Vista",
 * "Mensajería", "Dirección", "Diagnóstico", "Preselección", "Números clave", "Analítica",
 * "Importación" — e `toLowerCase()` sozinho não casa "gestion" com "Gestión"):
 *   1. o rótulo da TELA (bloco.rotulo) — bate a tela inteira, mostra TODAS as linhas dela;
 *   2. o rótulo da LINHA (container ou recurso) — filtra só as linhas que baterem;
 *   3. a chave TÉCNICA de cada célula da linha (`patient_family:read`) — para quem já sabe o nome
 *      do recurso e busca por ele.
 *
 * Sem query, devolve os blocos como vieram (mesma referência de array, nova cópia rasa).
 */
export function filtraBlocosPorTexto(blocos: readonly BlocoDeTela[], query: string): BlocoDeTela[] {
  const q = normaliza(query);
  if (!q) return [...blocos];

  const bate = (texto: string): boolean => normaliza(texto).includes(q);
  const linhaBate = (linha: LinhaDeTela): boolean =>
    bate(linha.rotulo)
    || bate(linha.resource)
    || Object.keys(linha.porAcao).some((acao) => bate(`${linha.resource}:${acao}`));

  const filtrados: BlocoDeTela[] = [];
  for (const bloco of blocos) {
    if (bate(bloco.rotulo)) {
      filtrados.push(bloco);
      continue;
    }
    const grade = bloco.grade.filter(linhaBate);
    if (grade.length > 0) filtrados.push({ ...bloco, grade });
  }
  return filtrados;
}
