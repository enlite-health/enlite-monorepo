/**
 * absenceSql — fonte ÚNICA dos fragmentos SQL da ausência pontual do titular (Fase 13; gate
 * parcial #1, molde `liveVacancySql.ts`).
 *
 * `liveAbsencePredicate` é a condição de "ausência que conta": não cancelada E sobre alocação do
 * titular `ACTIVE` e vigente NA DATA da ausência. Ausência presa numa alocação encerrada/cancelada
 * (ou fora da vigência dela) deixa de gerar alerta, chip e trava — a MESMA condição do ramo da
 * substituição em `itinerary_worker_conflict()` (migration 484).
 *
 * Spec 069: a consulta antiga de "ausência descoberta" (só ausência sem substituto) SAIU — "Sin cubrir" agora é uma ocorrência
 * (`serviceOccurrences.ts`), lida por `occurrenceInputs.ts`, que usa este predicado.
 */
export function liveAbsencePredicate(ab: string, a: string): string {
  return `${ab}.cancelled_at IS NULL AND ${a}.status = 'ACTIVE'
          AND ${a}.valid_from <= ${ab}.on_date
          AND (${a}.valid_to IS NULL OR ${a}.valid_to >= ${ab}.on_date)`;
}
