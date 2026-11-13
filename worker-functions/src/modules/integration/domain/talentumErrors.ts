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

/**
 * Achado em prod (27/07): o Talentum tem dono por projeto. Projetos criados por OUTRA conta (recrutadora direto
 * na UI, entram via sync inbound) são legíveis mas NÃO graváveis pela nossa conta → 403. Mensagem acionável (409,
 * condição permanente) em vez de um 502 transitório. Compartilhada por todo caminho que escreve no Talentum.
 */
export const OTHER_ACCOUNT_MESSAGE =
  'Esta vacante fue creada directamente en Talentum por otra cuenta, así que su ' +
  'descripción no puede editarse desde el panel. Editala en Talentum.';

export function isOtherAccountError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes('HTTP 403') || msg.toLowerCase().includes('not allowed to access');
}
