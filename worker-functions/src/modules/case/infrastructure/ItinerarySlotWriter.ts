/**
 * ItinerarySlotWriter — Fase 11, DX-11.5 (parte do escritor).
 *
 * Slots têm UMA fonte hoje: o `schedule` JSONB do serviço contratado (ressalva a', DX-11.5). Este
 * escritor NUNCA grava `patient_itinerary_slot` direto — ele reescreve `schedule` e reusa
 * `syncItinerarySlots` (`PatientItinerarySlotSync.ts`, Fase 7, nunca copiado) na MESMA transação
 * (`writeSchedule`), o mesmo molde de `PatientContractedServiceRepository.create`/`update`
 * (linhas 299-304, 351-355): a derivação injetável no construtor só para o unitário.
 *
 * `findServiceForWrite` serializa duas edições do mesmo serviço (`FOR UPDATE OF pcs`) e traz o
 * país do paciente (para `operationDateOf`, no caso de uso) na MESMA query. `slotHasActiveAllocation`
 * recebe `hoje` por parâmetro (nunca calcula data aqui — `NOW()`/`CURRENT_DATE` no SQL, ou `Date`
 * no TS, seriam um 2º relógio; quem decide o "hoje" é o caso de uso, via `operationDateOf`).
 */
import type { PoolClient } from 'pg';
import { syncItinerarySlots } from './PatientItinerarySlotSync';
import type { ScheduleEntry, ItinerarySlotKey } from '../domain/ItinerarySchedule';

export interface ServiceForWrite {
  id: string;
  addressId: string | null;
  schedule: ScheduleEntry[] | null;
  country: string;
}

export interface ItinerarySlotRow {
  id: string;
  weekday: number;
  startTime: string;
  endTime: string;
  active: boolean;
}

interface ServiceForWriteRow {
  id: string;
  address_id: string | null;
  schedule: ScheduleEntry[] | null;
  country: string;
}

interface ItinerarySlotDbRow {
  id: string;
  weekday: number;
  start_time: string;
  end_time: string;
  active: boolean;
}

function toSlotRow(row: ItinerarySlotDbRow): ItinerarySlotRow {
  return { id: row.id, weekday: row.weekday, startTime: row.start_time, endTime: row.end_time, active: row.active };
}

const SLOT_SELECT = `SELECT id, weekday, to_char(start_time, 'HH24:MI') AS start_time, to_char(end_time, 'HH24:MI') AS end_time, active
                        FROM patient_itinerary_slot`;

export class ItinerarySlotWriter {
  constructor(
    /** Injeção só para o unitário; os call sites de produção não mudam — o default é a derivação real. */
    private readonly syncSlots: typeof syncItinerarySlots = syncItinerarySlots,
  ) {}

  /** `null` = serviço inexistente, de outro paciente, ou inativo (`patients.deleted_at`/`pcs.active` decidem). */
  async findServiceForWrite(client: PoolClient, patientId: string, serviceId: string): Promise<ServiceForWrite | null> {
    const { rows } = await client.query<ServiceForWriteRow>(
      `SELECT pcs.id, pcs.address_id, pcs.schedule, p.country
         FROM patient_contracted_services pcs
         JOIN patients p ON p.id = pcs.patient_id AND p.deleted_at IS NULL
        WHERE pcs.id = $2 AND pcs.patient_id = $1 AND pcs.active
        FOR UPDATE OF pcs`,
      [patientId, serviceId],
    );
    if (rows.length === 0) return null;
    const row = rows[0];
    return { id: row.id, addressId: row.address_id, schedule: row.schedule, country: row.country };
  }

  /** `null` = slot inexistente, ou de outro serviço (a cláusula `contracted_service_id = $1` decide). */
  async findSlot(client: PoolClient, serviceId: string, slotId: string): Promise<ItinerarySlotRow | null> {
    const { rows } = await client.query<ItinerarySlotDbRow>(
      `${SLOT_SELECT} WHERE id = $2 AND contracted_service_id = $1`,
      [serviceId, slotId],
    );
    if (rows.length === 0) return null;
    return toSlotRow(rows[0]);
  }

  /** Alocação `ACTIVE` vigente em `hoje` (`valid_to IS NULL` ou ainda não vencida) — `hoje` é parâmetro, nunca relógio do banco. */
  async slotHasActiveAllocation(client: PoolClient, slotId: string, hoje: string): Promise<boolean> {
    const { rows } = await client.query<{ exists: boolean }>(
      `SELECT EXISTS (
          SELECT 1 FROM patient_itinerary_assignment
           WHERE slot_id = $1 AND status = 'ACTIVE' AND (valid_to IS NULL OR valid_to >= $2::date)
       ) AS exists`,
      [slotId, hoje],
    );
    return rows[0]?.exists ?? false;
  }

  /** Reescreve `schedule` e reusa `syncItinerarySlots` no MESMO client e transação (DX-11.5). */
  async writeSchedule(client: PoolClient, serviceId: string, schedule: ScheduleEntry[] | null, actorUid: string): Promise<void> {
    await client.query(
      `UPDATE patient_contracted_services SET schedule = $2::jsonb, updated_by = $3, updated_at = now() WHERE id = $1`,
      [serviceId, JSON.stringify(schedule ?? []), actorUid],
    );
    await this.syncSlots(client, serviceId, schedule, actorUid);
  }

  /** A linha que `writeSchedule`/`syncItinerarySlots` acabou de criar ou reativar por chave. */
  async findSlotByKey(client: PoolClient, serviceId: string, key: ItinerarySlotKey): Promise<ItinerarySlotRow | null> {
    const { rows } = await client.query<ItinerarySlotDbRow>(
      `${SLOT_SELECT} WHERE contracted_service_id = $1 AND weekday = $2 AND start_time = $3::time AND end_time = $4::time`,
      [serviceId, key.weekday, key.startTime, key.endTime],
    );
    if (rows.length === 0) return null;
    return toSlotRow(rows[0]);
  }
}
