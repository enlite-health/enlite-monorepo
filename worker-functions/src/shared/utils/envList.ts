/**
 * src/shared/utils/envList.ts
 *
 * Lê uma env de LISTA (`ALLOWED_MEDIA_HOSTS`, `MCP_PRINCIPAL_NAMES`,
 * `CORS_ALLOWED_ORIGINS`…) aceitando `,`, `;` ou espaço como separador.
 *
 * Por que aceitar mais que vírgula: o `google-github-actions/deploy-cloudrun`
 * separa `env_vars` por VÍRGULA sem escapar valores — `A=x,y` vira `A=x` + uma
 * env fantasma `y=` (achado de 14-16/08: `MCP_PRINCIPAL_NAMES=triage-service,
 * claude-code` deixou o principal claude-code sem autenticar no MCP de prod por
 * semanas; `ALLOWED_MEDIA_HOSTS` só valia o 1º host). Os workflows passam a
 * declarar listas com `;`; o código continua aceitando `,` para env local /
 * `.env` antigos não quebrarem.
 */

/** Itens não-vazios, aparados, na ordem. `undefined`/'' → []. */
export function parseEnvList(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(/[,;\s]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}
