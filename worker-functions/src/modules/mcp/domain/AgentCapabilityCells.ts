/**
 * Porta MCP do agente (spec 078, M2) — constantes da identidade. O mapa capability -> célula entra na M2.2.5, neste arquivo.
 * Contrato: `contratos-M2/porta-mcp-agente.md` §1.
 */

/** Header próprio do agente. O `Authorization: Bearer` NÃO é lido para o agente (header presente => só o caminho do agente). */
export const AGENT_IDENTITY_HEADER = 'x-enlite-agent-identity';

/**
 * Audiência fixa do ID token da conta de serviço do agente. String estável e DISTINTA da porta das assistentes
 * (`ASSISTANTS_AUDIENCE`): token de uma porta não serve na outra.
 */
export const AGENT_AUDIENCE = 'https://api.enlite.health/mcp-agente';
