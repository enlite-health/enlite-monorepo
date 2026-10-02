/**
 * Contador de requests HTTP por MÉTODO (só método + contagem; nunca path com id, corpo ou header).
 * Prova de "0 escritas" de um script que só deve LER: embrulha o `fetch` global e conta. O único POST
 * tolerado em leitura é o login (`/auth/login`), que abre a sessão e não altera nada na Talentum.
 */

export interface FetchStats {
  byMethod: Record<string, number>;
  /** Requests que não são GET e não são o login: em dry-run tem de ser 0. */
  writes: number;
}

export function installFetchMethodCounter(target: { fetch: typeof fetch } = globalThis): {
  stats(): FetchStats;
  restore(): void;
} {
  const original = target.fetch;
  const byMethod: Record<string, number> = {};
  let writes = 0;

  target.fetch = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const method = (init?.method ?? (typeof input === 'object' && 'method' in input ? input.method : 'GET')).toUpperCase();
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
    byMethod[method] = (byMethod[method] ?? 0) + 1;
    if (method !== 'GET' && !new URL(url).pathname.endsWith('/auth/login')) writes++;
    return original(input, init);
  }) as typeof fetch;

  return {
    stats: () => ({ byMethod: { ...byMethod }, writes }),
    restore: () => {
      target.fetch = original;
    },
  };
}
