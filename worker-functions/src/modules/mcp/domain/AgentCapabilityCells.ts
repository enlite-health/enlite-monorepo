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

/** Id do tenant do vínculo do agente (o único hoje; igual a `ENLITE_TENANT_ID` do módulo de permissões). */
export const AGENT_TENANT_ID = '00000000-0000-0000-0000-000000000001';

/** Teto de ESCRITAS por minuto por agente (exemplo do parecer; o número é decisão do Gabriel, constante num arquivo só). */
export const AGENT_WRITE_LIMIT_PER_MIN = 10;

/**
 * CLASSE (a) — ação de negócio: a capability exige a célula do grupo espelho do agente e roda como ATOR `agent:luz`
 * (RLS por `iam.effective_countries`, `app.system_context` vazio). Célula = a que o código exige hoje na operação equivalente
 * (evidencias/M2-capabilities-celulas.txt + "Decisões do lote 0" item 1).
 * `worker.account.deactivate` NÃO está aqui: decisão do Gabriel (03/11/2026), a Luz não desativa conta de prestadora — a capability segue viva só para a porta legada; para o agente cai em `no_cell_declared`. Capability fora deste mapa e da classe (b) => `no_cell_declared`.
 */
export const AGENT_CAPABILITY_CELLS: Readonly<Record<string, string>> = {
  'worker.vacancies.list': 'vacancy:read',
  'worker.vacancies.nearby': 'vacancy:read',
  'worker.interview.get': 'interview:read',
  // AMBÍGUA (M2.0.5): a rota REST irmã exige `worker:read`, mas o catálogo põe nome/telefone em `worker_contact:read`. Segue `worker:read` ("ficam como lá").
  'worker.profile.get': 'worker:read',
  'worker.documents.list': 'worker_document:read',
  'worker.profile.proposeUpdate': 'worker:update',
  'worker.profile.confirmUpdate': 'worker:update',
  'worker.applications.list': 'match:read',
  'worker.availability.get': 'worker:read',
  'worker.availability.set': 'worker:update',
  'worker.optOut.register': 'worker:update',
  'worker.application.register': 'worker_application:create',
  'handover.notify': 'handover:create',
  'worker.byPhone': 'worker_pii:read',
};

/** As chaves de `AGENT_CAPABILITY_CELLS` em ordem estável (o relatório de cobertura itera por aqui; teste de paridade garante que são as mesmas). */
export const AGENT_CAPABILITY_NAMES: readonly string[] = [
  'worker.vacancies.list',
  'worker.vacancies.nearby',
  'worker.interview.get',
  'worker.profile.get',
  'worker.documents.list',
  'worker.profile.proposeUpdate',
  'worker.profile.confirmUpdate',
  'worker.applications.list',
  'worker.availability.get',
  'worker.availability.set',
  'worker.optOut.register',
  'worker.application.register',
  'handover.notify',
  'worker.byPhone',
];

/**
 * CLASSE (b) — runtime do operador (telemetria/dossiê, não ação sobre a plataforma): EXCEÇÃO NOMEADA. Continua pelo principal em contexto de
 * SISTEMA (RLS por agente), sem célula do grupo espelho e NUNCA em grupo humano (uma recrutadora não pode forjar nota no placar).
 * O par recurso:ação abaixo NÃO é célula do catálogo: serve só para a trilha (1 linha por chamada) e para o limitador separar escrita de leitura.
 */
export const AGENT_SYSTEM_CAPABILITIES: Readonly<Record<string, { resource: string; action: string }>> = {
  'worker.caseMemory.get': { resource: 'worker_case_memory', action: 'read' },
  'worker.caseMemory.put': { resource: 'worker_case_memory', action: 'update' },
  'agentes.veredicto.registrar': { resource: 'assistant_verdict', action: 'register' },
};

/** Capabilities que o principal do agente enxerga (classe a + b). */
export const AGENT_ALLOWED_CAPABILITIES: readonly string[] = [
  ...Object.keys(AGENT_CAPABILITY_CELLS),
  ...Object.keys(AGENT_SYSTEM_CAPABILITIES),
];

/** Escrita = ação diferente de `read` (contrato §5). */
export function isAgentWrite(action: string): boolean {
  return action !== 'read';
}
