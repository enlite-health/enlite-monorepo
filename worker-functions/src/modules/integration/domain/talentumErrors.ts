/**
 * Spec 040: o `talentum_project_id` gravado antes da migração para a API v2 (01/10/2026) não existe
 * mais na Talentum (404). Mensagem única, clara e acionável — usada pelos use cases em vez de um 502
 * "transitório" (o cliente já marca o 404 com "HTTP 404" no texto do erro).
 */
export const DEAD_PROJECT_MESSAGE =
  'El proyecto no existe en Talentum v2; ejecutá la reconciliación (proyecto não existe na Talentum v2; rode a reconciliação).';

/** O erro do `TalentumApiClient` carrega `HTTP <status>` no texto (formato estável, ver `request`). */
export function isDeadProjectError(err: unknown): boolean {
  return err instanceof Error && err.message.includes('HTTP 404');
}
