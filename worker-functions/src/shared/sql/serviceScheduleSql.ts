/**
 * Fragmentos SQL únicos do horário do serviço (spec 056, plan.md §4.1). O horário mora em
 * `patient_itinerary_slot` (início + duração + vigência `valid`); todo leitor SQL usa estes
 * fragmentos — nenhum reescreve `valid @> CURRENT_DATE` nem a conta do fim do turno.
 */

/** Fim do turno (derivado; nunca gravado). */
export function slotEndTimeSql(alias: string): string {
  return `to_char(${alias}.start_time + make_interval(mins => ${alias}.duration_minutes), 'HH24:MI')`;
}

/** Faixa vigente hoje (prova da equivalência com operationDateOf: plan.md §1.3). */
export function slotVigenteSql(alias: string): string {
  return `${alias}.valid @> CURRENT_DATE`;
}

/** Serviço ativo SEM nenhuma faixa vigente — o antigo `pcs.schedule IS NULL OR jsonb_array_length = 0`. */
export function serviceWithoutScheduleSql(pcsAlias: string): string {
  return `NOT EXISTS (SELECT 1 FROM patient_itinerary_slot s_ws WHERE s_ws.contracted_service_id = ${pcsAlias}.id AND s_ws.valid @> CURRENT_DATE)`;
}
