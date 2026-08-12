/**
 * Escopos OAuth aceitos pelo MCP e o mapa escopo → capabilities.
 * O conector claude.ai (Fase 2) só recebe capabilities de leitura;
 * escrita continua exclusiva de service principals internos (ex: triage-service).
 */
export const MCP_OAUTH_SCOPE = 'worker:read';

export const OAUTH_SCOPE_CAPABILITIES: Readonly<Record<string, readonly string[]>> = {
  [MCP_OAUTH_SCOPE]: [
    'worker.profile.get',
    'worker.documents.list',
    'worker.vacancies.list',
    'worker.interview.get',
    'worker.stats.get',
    'worker.search',
    'db.query.readonly',
  ],
};

/** Capabilities agregadas de uma lista de escopos (dedup, ignora escopo desconhecido). */
export function capabilitiesForScopes(scopes: readonly string[]): string[] {
  const caps = new Set<string>();
  for (const scope of scopes) {
    for (const cap of OAUTH_SCOPE_CAPABILITIES[scope] ?? []) {
      caps.add(cap);
    }
  }
  return [...caps];
}
