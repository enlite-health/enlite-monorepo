/**
 * PatientItinerarySlotSync — deriva os slots do `schedule` do serviço contratado (via
 * `scheduleToSlots`, `CASE/domain/ItinerarySchedule.ts`) e os grava de forma idempotente na
 * MESMA transação da criação/edição do serviço (`PatientContractedServiceRepository.create`/
 * `update`, dentro do `withActorContext` de cada um — a derivação falha e o serviço não é
 * gravado; uma transação só).
 *
 * Nunca `DELETE`: a alocação (Fase 11) aponta para o slot, e o app não tem privilégio de DELETE
 * nas tabelas de itinerário (migration 480, `REVOKE DELETE ... FROM app_runtime, app_system`).
 * Slot que sai do schedule vira `active = false`; se o mesmo horário voltar depois, a UNIQUE
 * `pis_service_slot_uq (contracted_service_id, weekday, start_time, end_time)` reativa a MESMA
 * linha em vez de criar outra — é essa reativação que preserva a alocação antiga apontando para
 * o slot certo.
 */
import type { PoolClient } from 'pg';
import { scheduleToSlots, type ScheduleEntry } from '../domain/ItinerarySchedule';

export async function syncItinerarySlots(
  cli: PoolClient,
  serviceId: string,
  schedule: readonly ScheduleEntry[] | null,
  actorUid: string,
): Promise<{ upserted: number; deactivated: number }> {
  // Entrada fora da forma esperada (dia fora de 0-6, `HH:MM` inválido, `end <= start`) lança
  // ANTES de qualquer query — nenhum slot parcial grava.
  const desired = scheduleToSlots(schedule);

  let upserted = 0;
  for (const { weekday, startTime, endTime } of desired) {
    const res = await cli.query(
      `INSERT INTO patient_itinerary_slot (contracted_service_id, weekday, start_time, end_time, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, $5)
       ON CONFLICT (contracted_service_id, weekday, start_time, end_time)
       DO UPDATE SET active = true, updated_by = EXCLUDED.updated_by, updated_at = now()
       WHERE patient_itinerary_slot.active = false`,
      [serviceId, weekday, startTime, endTime, actorUid],
    );
    upserted += res.rowCount ?? 0;
  }

  // Desativa (nunca apaga) os slots hoje ativos que não estão mais no schedule desejado. Com
  // `desired` vazio (schedule null/[]), não há chave para excluir — todos os ativos do serviço
  // caem.
  const params: unknown[] = [serviceId, actorUid];
  let notInClause = '';
  if (desired.length > 0) {
    const tuples = desired.map(({ weekday, startTime, endTime }) => {
      params.push(weekday, startTime, endTime);
      const last = params.length;
      return `($${last - 2}, $${last - 1}, $${last})`;
    });
    notInClause = ` AND NOT ((weekday, start_time, end_time) IN (${tuples.join(', ')}))`;
  }
  const deactivate = await cli.query(
    `UPDATE patient_itinerary_slot SET active = false, updated_by = $2, updated_at = now()
     WHERE contracted_service_id = $1 AND active${notInClause}`,
    params,
  );

  return { upserted, deactivated: deactivate.rowCount ?? 0 };
}
