import type { TemplateCatalogRow } from '@infrastructure/http/AdminTemplateCatalogApiService';
import type { FilterKey } from './templateCatalogView';

/**
 * templateCatalogPairs — a listagem por MENSAGEM, não por template.
 *
 * 🔒 A ARQUITETURA DE INFORMAÇÃO QUE ESTAVA ERRADA. O desenho canônico pede
 * uma linha por mensagem, com duas colunas de idioma lado a lado — a mesma
 * mensagem em duas versões. O que existia era uma linha por template, então
 * `admission_confirmation_es` e `admission_confirmation_pt` apareciam como
 * duas coisas sem relação nenhuma, e ninguém via que eram a mesma mensagem.
 *
 * 🔒 O PAR VEM DO BANCO, NUNCA DE PARSEAR O SLUG. Medido contra produção em
 * 01/09/2026, as 28 linhas usam TRÊS convenções — prefixo `ar_` (12), nenhum
 * marcador (12), sufixo `_es`/`_pt` (4) — e os únicos dois pares que já
 * existem usam SUFIXO, a convenção oposta à de prefixo que a tela nova aplica.
 * Não há regex que acerte os três grupos. Por isso `baseName` é coluna,
 * preenchida por enumeração humana na migration 300, e este módulo só agrupa.
 *
 * 🔒 AS APROVAÇÕES SÃO INDEPENDENTES, e a tela não pode fingir o contrário.
 * Para a Twilio e para a Meta são dois Contents, dois pedidos e dois
 * resultados possíveis: o espanhol pode estar aprovado com o português ainda
 * em revisão. Por isso o par NÃO tem estado próprio — cada lado carrega o seu.
 * Um par com estado único deixaria a tela sem como representar a primeira
 * rejeição de um dos lados.
 */

export const ES = 'es-AR';
export const PT = 'pt-BR';

/** Uma MENSAGEM: a mesma coisa em até dois idiomas. */
export interface MessagePair {
  /** A chave que une as versões. Nunca vazia — o backend faz COALESCE com o slug. */
  baseName: string;
  /** A versão espanhola, se existir. */
  es: TemplateCatalogRow | null;
  /** A versão portuguesa, se existir. */
  pt: TemplateCatalogRow | null;
  /**
   * Linhas que não cabem em nenhuma das duas colunas de idioma: `language`
   * NULL **ou** um valor que este código não conhece.
   *
   * 🔒 OS DOIS CASOS VÃO PARA CÁ, e o segundo é o que importa. `language` é
   * um `VARCHAR(10)` livre; a conferência de 01/09 contra a Content API achou
   * 3 Contents com `es` puro em vez de `es_AR`. Se um valor desconhecido não
   * caísse em lugar nenhum, a linha sumiria da tela inteira — sem erro, sem
   * aviso, sem ninguém saber. É exatamente o modo de falha que escondeu
   * `PAUSED` de nós até 31/08: descartar o que o código não reconhece.
   *
   * E nenhum dos dois vira `es` por omissão: "não sei" e "espanhol" são
   * coisas diferentes, e chutar produziria uma tela que afirma o que ninguém
   * mediu.
   */
  semIdioma: TemplateCatalogRow[];
  /**
   * A linha que CRIOU o grupo.
   *
   * Existe para que "a versão que representa a mensagem" nunca seja `null`:
   * todo par nasce de uma linha, então sempre há uma. Sem este campo o tipo
   * admitiria um par vazio que `agruparEmPares` não consegue produzir, e o
   * ramo morto ficaria para sempre sem teste.
   */
  primeira: TemplateCatalogRow;
}

/**
 * Agrupa as linhas soltas em mensagens.
 *
 * A ordem de saída é a de PRIMEIRA APARIÇÃO, e não alfabética por `baseName`:
 * o backend já ordena por slug, e reordenar aqui faria a tela mudar de ordem
 * sozinha quando alguém classificasse um `baseName` — movimento sem causa
 * visível para quem olha.
 */
/**
 * A versão que representa a mensagem quando a tela precisa de UMA: o texto da
 * listagem, a data da última verificação, o detalhe que abre no clique.
 *
 * O espanhol lidera porque é o idioma da operação hoje; cai no português e
 * depois na linha sem idioma registrado, para que uma mensagem que só existe
 * de um lado ainda tenha o que mostrar.
 */
export function versaoPrincipal(p: MessagePair): TemplateCatalogRow {
  return p.es ?? p.pt ?? p.primeira;
}

export function agruparEmPares(rows: readonly TemplateCatalogRow[]): MessagePair[] {
  const porBase = new Map<string, MessagePair>();
  for (const r of rows) {
    let par = porBase.get(r.baseName);
    if (par === undefined) {
      par = { baseName: r.baseName, es: null, pt: null, semIdioma: [], primeira: r };
      porBase.set(r.baseName, par);
    }
    if (r.language === ES && par.es === null) par.es = r;
    else if (r.language === PT && par.pt === null) par.pt = r;
    // Tudo o mais cai aqui — inclusive o idioma DESCONHECIDO e o segundo
    // template do mesmo idioma no mesmo `baseName`. Nada é descartado: uma
    // linha que não aparece em coluna nenhuma é uma mensagem que some da tela
    // sem nada ficar vermelho.
    else par.semIdioma.push(r);
  }
  return [...porBase.values()];
}

/**
 * As mensagens que existem num idioma e não no outro.
 *
 * 🔒 Exige que o par tenha EXATAMENTE um dos dois lados. Uma mensagem que não
 * caiu em coluna de idioma nenhuma não conta como "falta versão" — o que falta
 * ali é classificar, não traduzir, e são pedidos diferentes.
 */
export function faltaUmaVersao(pares: readonly MessagePair[]): MessagePair[] {
  return pares.filter((p) => (p.es === null) !== (p.pt === null));
}

/** O idioma que falta num par incompleto, ou `null` se não falta nenhum. */
export function idiomaQueFalta(p: MessagePair): string | null {
  if (p.es === null && p.pt !== null) return ES;
  if (p.pt === null && p.es !== null) return PT;
  return null;
}


/**
 * Filtra MENSAGENS pelo filtro da faixa.
 *
 * 🔒 FILTRA O PAR, NÃO O LADO. Se filtrasse as linhas soltas e só depois
 * agrupasse, um par com espanhol aprovado e português em revisão apareceria,
 * sob "Aprobadas", como uma mensagem que só tem espanhol — ou seja, a tela
 * diria "falta una versión" para uma mensagem cuja versão existe e está em
 * revisão. Aqui o par inteiro passa ou não passa, e os dois lados continuam
 * desenhados.
 *
 * Um par entra num grupo de estado se QUALQUER lado dele estiver nesse grupo —
 * porque as aprovações são independentes e a mensagem realmente tem algo
 * aprovado e algo pendente ao mesmo tempo.
 */
export function filtrarPares(
  pares: readonly MessagePair[],
  key: string,
  grupoDe: (status: string | null) => string,
): MessagePair[] {
  if (key === 'all') return [...pares];
  if (key === MISSING) return faltaUmaVersao(pares);
  return pares.filter((p) =>
    [p.es, p.pt, ...p.semIdioma].some((r) => r !== null && grupoDe(r.metaStatus) === key),
  );
}

/**
 * A chave do filtro "Falta una versión".
 *
 * ⚠️ A UNIDADE DESTE NÚMERO É DIFERENTE DA DOS OUTROS, e a tela precisa dizer
 * isso. Os filtros de estado contam TEMPLATES (é o que sempre contaram, e
 * mudar a conta seria trocar o significado de números que já estão na tela);
 * este conta MENSAGENS, porque "falta uma versão" é uma afirmação sobre o par,
 * não sobre um template. Somar os dois daria um total que não existe.
 */
export const MISSING = 'missing';

/**
 * O filtro da faixa: os grupos de estado que já existiam MAIS o de par
 * incompleto.
 *
 * 🔒 Tipo próprio em vez de acrescentar `missing` ao `FilterKey`: aquele tipo
 * governa o `GroupCounts`, um `Record` construído a partir do `FILTER_ORDER`.
 * Alargá-lo obrigaria `countByGroup` a devolver uma contagem de `missing` em
 * templates — que é justamente a unidade errada.
 */
export type CatalogFilter = FilterKey | typeof MISSING;
