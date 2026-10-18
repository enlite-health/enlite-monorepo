/**
 * ItinerarySlotWriter — Fase 11, DX-11.5 (parte do escritor), reescrito na spec 056 (T1.7).
 *
 * `patient_itinerary_slot` é o DONO do horário: este escritor abre/fecha FAIXAS (vigência `valid`) por
 * delegação a `ServiceSlotWriter` (`openSlot`/`closeSlot`/`readVigentSlots`, mesmo client e transação) —
 * nunca reescreve `pcs.schedule` (coluna morta) nem reativa linha.
 *
 * `findServiceForWrite` serializa duas edições do mesmo serviço (`FOR UPDATE OF pcs`) e traz o
 * país do paciente (para `operationDateOf`, no caso de uso) na MESMA query. `findSlot` e
 * `slotHasActiveAllocation` recebem `hoje` por parâmetro (nunca calculam data aqui — `NOW()`/`CURRENT_DATE`
 * no SQL, ou `Date` no TS, seriam um 2º relógio; quem decide o "hoje" é o caso de uso, via `operationDateOf`).
 */
import type { PoolClient } from 'pg';
import { slotEndTimeSql } from '@shared/sql/serviceScheduleSql';
import { openSlot, closeSlot, readVigentSlots } from './ServiceSlotWriter';

export interface ServiceForWrite {
  id: string;
  addressId: string | null;
  country: string;
}

/** A faixa como a rota devolve: início + duração, com o fim DERIVADO. */
export interface ItinerarySlotRow {
  id: string;
  weekday: number;
  startTime: string;
  durationMinutes: number;
  endTime: string;
}

/** A faixa lida por id, com a marca interna de "vigente em hoje" (nunca sai na resposta HTTP). */
export interface ItinerarySlotLookup extends ItinerarySlotRow {
  vigente: boolean;
}

interface ServiceForWriteRow {
  id: string;
  address_id: string | null;
  country: string;
}

interface ItinerarySlotDbRow {
  id: string;
  weekday: number;
  start_time: string;
  duration_minutes: number;
  slot_end: string;
  vigente: boolean;
}

export class ItinerarySlotWriter {
  /** `null` = serviço inexistente, de outro paciente, ou inativo (`patients.deleted_at`/`pcs.active` decidem). */
  async findServiceForWrite(client: PoolClient, patientId: string, serviceId: string): Promise<ServiceForWrite | null> {
    const { rows } = await client.query<ServiceForWriteRow>(
      `SELECT pcs.id, pcs.address_id, p.country
         FROM patient_contracted_services pcs
         JOIN patients p ON p.id = pcs.patient_id AND p.deleted_at IS NULL
        WHERE pcs.id = $2 AND pcs.patient_id = $1 AND pcs.active
        FOR UPDATE OF pcs`,
      [patientId, serviceId],
    );
    if (rows.length === 0) return null;
    const row = rows[0];
    return { id: row.id, addressId: row.address_id, country: row.country };
  }

  /** `null` = faixa inexistente, ou de outro serviço (a cláusula `contracted_service_id = $1` decide). `vigente` é em `hoje`. */
  async findSlot(client: PoolClient, serviceId: string, slotId: string, hoje: string): Promise<ItinerarySlotLookup | null> {
    const { rows } = await client.query<ItinerarySlotDbRow>(
      `SELECT s.id, s.weekday, to_char(s.start_time, 'HH24:MI') AS start_time, s.duration_minutes,
              ${slotEndTimeSql('s')} AS slot_end, (s.valid @> $3::date) AS vigente
         FROM patient_itinerary_slot s
        WHERE s.id = $2 AND s.contracted_service_id = $1`,
      [serviceId, slotId, hoje],
    );
    if (rows.length === 0) return null;
    const r = rows[0];
    return { id: r.id, weekday: r.weekday, startTime: r.start_time, durationMinutes: r.duration_minutes, endTime: r.slot_end, vigente: r.vigente };
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

  readVigentSlots = readVigentSlots;
  openSlot = openSlot;
  closeSlot = closeSlot;
}
