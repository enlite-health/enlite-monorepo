/**
 * Quebra a consulta do catálogo CID-11 em palavras de busca.
 *
 * Regra (decidida com o Gabriel, 03/11/2026): minúsculas e sem acento; separa por espaço/pontuação;
 * descarta stopwords do espanhol e palavras de 1 caractere; se não sobrar nenhuma palavra, a busca
 * usa a frase inteira (o comportamento de antes). A comparação no banco usa
 * `terminology.f_norm` (migration 561) — aqui só se decide QUAIS palavras entram.
 */

/** Stopwords do ES descartadas da busca. Lista fechada, de propósito: ampliar muda o que a clínica acha. */
export const SEARCH_STOPWORDS: ReadonlySet<string> = new Set([
  'de', 'del', 'la', 'las', 'el', 'los', 'y', 'e', 'o', 'con', 'sin', 'por', 'para', 'en', 'a', 'al',
]);

/** Piso de tamanho da palavra (caracteres, depois de normalizar). */
export const MIN_TOKEN_LENGTH = 2;

/** Teto de palavras por consulta — limita o tamanho do SQL gerado (uma condição por palavra). */
export const MAX_SEARCH_TOKENS = 8;

/** Minúsculas, sem acento e com espaços colapsados. */
export function foldText(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Palavras que efetivamente filtram a busca. Vazio quando a consulta só tem stopwords/pontuação —
 * quem chama cai então na frase inteira.
 */
export function tokenizeQuery(query: string): string[] {
  const tokens = foldText(query)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length >= MIN_TOKEN_LENGTH && !SEARCH_STOPWORDS.has(t));
  return [...new Set(tokens)].slice(0, MAX_SEARCH_TOKENS);
}
