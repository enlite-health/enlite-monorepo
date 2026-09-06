/**
 * matching.ts — spec 016 F4, Parte 2 (backfill). Casamento em memória, PURO (sem `pg`, sem
 * HTTP), entre um texto livre (`patients.diagnosis`) e os candidatos que
 * `TerminologyPort.search()` devolveu para ele.
 *
 * "Alta confiança" = exatamente UM candidato cujo título normalizado é IGUAL ao texto
 * normalizado (trim + minúsculas + sem diacrítico). Nunca aproximado: a busca tolerante a
 * erro (`pg_trgm`, US-1) já existe para achar candidatos — o papel desta função é decidir se o
 * casamento é forte o bastante para ESCREVER sem supervisão, e "parecido" não é.
 */

export interface MatchableCandidate {
  readonly uri: string;
  readonly title: string;
}

export type MatchResult =
  | { readonly matched: true; readonly uri: string }
  | { readonly matched: false };

function normalize(s: string): string {
  return s.trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

export function matchByExactTitle(text: string, candidates: readonly MatchableCandidate[]): MatchResult {
  const norm = normalize(text);
  if (norm === '') return { matched: false };

  const exact = candidates.filter(c => normalize(c.title) === norm);
  if (exact.length === 1) return { matched: true, uri: exact[0].uri };
  return { matched: false };
}
