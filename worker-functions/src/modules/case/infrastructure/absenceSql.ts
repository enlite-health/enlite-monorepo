/**
 * absenceSql — fonte ÚNICA dos fragmentos SQL da ausência pontual do titular (Fase 13; gate
 * parcial #1, molde `liveVacancySql.ts`).
 *
 * `liveAbsencePredicate` é a condição de "ausência que conta": não cancelada E sobre alocação do
 * titular `ACTIVE` e vigente NA DATA da ausência. Ausência presa numa alocação encerrada/cancelada
 * (ou fora da vigência dela) deixa de gerar alerta, chip e trava — a MESMA condição do ramo da
 * substituição em `itinerary_worker_conflict()` (migration 484).
 *
 * `uncoveredAbsenceSelect` é a consulta de "ausência descoberta" (sem substituto) que antes tinha
 * 2 cópias (`PatientItineraryReader.ts` e `PatientKanbanServicesReader.ts` — achado D2 do mesmo
 * gate). `extraJoin`/`whereExtra` são a única parte que varia entre os dois chamadores (QUAIS
 * pacientes entram); colunas, junções da cadeia, predicado e ordenação são fixos. Nenhuma coluna
 * de nome/telefone.
 */
export function liveAbsencePredicate(ab: string, a: string): string {
  return `${ab}.cancelled_at IS NULL AND ${a}.status = 'ACTIVE'
          AND ${a}.valid_from <= ${ab}.on_date
          AND (${a}.valid_to IS NULL OR ${a}.valid_to >= ${ab}.on_date)`;
}

export function uncoveredAbsenceSelect(whereExtra: string, extraJoin = ''): string {
  return `SELECT pcs.patient_id, s.contracted_service_id,
              to_char(ab.on_date, 'YYYY-MM-DD') AS on_date,
              to_char(s.start_time, 'HH24:MI') AS start_time,
              to_char(s.end_time, 'HH24:MI') AS end_time
         FROM patient_itinerary_absence ab
         JOIN patient_itinerary_assignment a ON a.id = ab.assignment_id
         JOIN patient_itinerary_slot s ON s.id = a.slot_id
         JOIN patient_contracted_services pcs ON pcs.id = s.contracted_service_id
         ${extraJoin}
        WHERE ${whereExtra}
          AND ${liveAbsencePredicate('ab', 'a')} AND ab.substitute_worker_id IS NULL
        ORDER BY pcs.patient_id, ab.on_date, s.start_time, s.contracted_service_id`;
}
