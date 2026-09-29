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
 *
 * D442 (Fase 12): desativar slot com alocação `ACTIVE` vigente em `hoje` (data da operação do país)
 * é recusado com `SlotHasActiveAllocationError` — a MESMA régua da rota do itinerário.
 */
import type { PoolClient } from 'pg';
import { scheduleToSlots, type ScheduleEntry, type ItinerarySlotKey } from '../domain/ItinerarySchedule';
import { operationDateOf } from '../application/itineraryCoverage';
import { SlotHasActiveAllocationError } from '../application/ItinerarySlotWriteUseCase';

/**
 * ` AND NOT ((weekday, start_time, end_time) IN (...))` com os placeholders a partir de
 * `firstIndex` — a MESMA exclusão para a checagem de alocação e para a desativação. Com `desired`
 * vazio (schedule null/[]) não há chave para excluir: cláusula vazia, todos os ativos entram.
 */
function keyTuples(
  desired: readonly ItinerarySlotKey[],
  firstIndex: number,
): { clause: string; params: unknown[] } {
  if (desired.length === 0) return { clause: '', params: [] };
  const params: unknown[] = [];
  const tuples = desired.map(({ weekday, startTime, endTime }) => {
    params.push(weekday, startTime, endTime);
    const last = firstIndex + params.length - 1;
    return `($${last - 2}, $${last - 1}, $${last})`;
  });
  return { clause: ` AND NOT ((weekday, start_time, end_time) IN (${tuples.join(', ')}))`, params };
}

/**
 * Recusa (D442) se algum slot ativo que vai sair do schedule tem alocação `ACTIVE` vigente em
 * `hoje` — o predicado de `ItinerarySlotWriter.slotHasActiveAllocation`. Mesmo client e transação
 * (RLS do `withActorContext` do chamador). Serviço sem país legível → nenhuma checagem (o `UPDATE`
 * de desativação também não alcança a linha).
 */
async function assertNoActiveAllocationLeaving(
  cli: PoolClient,
  serviceId: string,
  desired: readonly ItinerarySlotKey[],
  now: Date,
): Promise<void> {
  const country = await cli.query<{ country: string }>(
    `SELECT p.country FROM patient_contracted_services pcs JOIN patients p ON p.id = pcs.patient_id WHERE pcs.id = $1`,
    [serviceId],
  );
  if (country.rows.length === 0) return;
  const hoje = operationDateOf(country.rows[0].country, now);
  const { clause, params } = keyTuples(desired, 3);
  const blocked = await cli.query<{ id: string }>(
    `SELECT s.id FROM patient_itinerary_slot s
      WHERE s.contracted_service_id = $1 AND s.active${clause}
        AND EXISTS (
          SELECT 1 FROM patient_itinerary_assignment a
           WHERE a.slot_id = s.id AND a.status = 'ACTIVE' AND (a.valid_to IS NULL OR a.valid_to >= $2::date)
        )
      ORDER BY s.weekday, s.start_time
      LIMIT 1`,
    [serviceId, hoje, ...params],
  );
  if (blocked.rows.length > 0) throw new SlotHasActiveAllocationError(serviceId, blocked.rows[0].id);
}

export async function syncItinerarySlots(
  cli: PoolClient,
  serviceId: string,
  schedule: readonly ScheduleEntry[] | null,
  actorUid: string,
  now: Date = new Date(),
): Promise<{ upserted: number; deactivated: number }> {
  // Entrada fora da forma esperada (dia fora de 0-6, `HH:MM` inválido, `end <= start`) lança
  // ANTES de qualquer query — nenhum slot parcial grava.
  const desired = scheduleToSlots(schedule);

  // D442: recusa ANTES de qualquer escrita — nenhum INSERT/UPDATE emitido se a recusa vale.
  await assertNoActiveAllocationLeaving(cli, serviceId, desired, now);

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
  const { clause: notInClause, params: keyParams } = keyTuples(desired, 3);
  const deactivate = await cli.query(
    `UPDATE patient_itinerary_slot SET active = false, updated_by = $2, updated_at = now()
     WHERE contracted_service_id = $1 AND active${notInClause}`,
    [serviceId, actorUid, ...keyParams],
  );

  return { upserted, deactivated: deactivate.rowCount ?? 0 };
}
