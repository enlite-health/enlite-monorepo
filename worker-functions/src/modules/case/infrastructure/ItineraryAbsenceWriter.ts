/**
 * ItineraryAbsenceWriter — DX-13.7 (parte do escritor): as 3 escritas de `patient_itinerary_absence`
 * (Fase 13). Molde `ItineraryAllocationWriter.ts` (Fase 11) — cada método faz UMA query no `client`
 * recebido; a transação é de quem chama (`ItineraryAbsenceUseCase`, P17, dentro de
 * `inPatientTransaction`).
 *
 * `insertAbsence` grava `on_date` do PARÂMETRO — nunca `now()`/`CURRENT_DATE` (a data é validada
 * pelo caso de uso contra `operationDateOf(country, now)`, DX-13.7). Os dois campos do substituto
 * (`substitute_worker_id`/`substitute_application_id`) são gravados JUNTOS — os dois `null` ou os
 * dois preenchidos, nunca um sem o outro (invariante 5, `piab_substitute_pair` no banco); quem
 * decide isso é o caso de uso, este escritor só grava o par que recebeu.
 *
 * `updateSubstitute`/`cancelAbsence` têm `cancelled_at IS NULL` no `WHERE` — cancelada não aceita
 * nova escrita (o `rowCount 0` sinaliza a corrida para o caso de uso decidir `AbsenceCancelledError`).
 * `cancelAbsence` nunca remove a linha (cancelar é escrever `cancelled_at`; o banco recusa a remoção
 * direta da tabela).
 *
 * Nenhuma escrita na tabela do paciente, no cadastro de prestadores do legado, em
 * `worker_job_applications`, nem no card de atendimento antigo (Fase 14) — só leitura de
 * `worker_job_applications` seria pelo caso de uso (`findApplicationId`, REUSADO de
 * `ItineraryAllocationWriter`, não copiado aqui). Nenhuma coluna de texto livre (motivo).
 */
import type { PoolClient } from 'pg';

export interface InsertAbsenceInput {
  allocationId: string;
  date: string;
  substituteWorkerId: string | null;
  substituteApplicationId: string | null;
  actorUid: string;
}

export interface InsertedAbsence {
  id: string;
  date: string;
}

export interface AbsenceRow {
  id: string;
  allocationId: string;
  date: string;
  substituteWorkerId: string | null;
  cancelled: boolean;
}

export class ItineraryAbsenceWriter {
  /** `on_date` é o do PARÂMETRO — nunca `now()`/`CURRENT_DATE`. Os 2 campos do substituto, JUNTOS. */
  async insertAbsence(client: PoolClient, input: InsertAbsenceInput): Promise<InsertedAbsence> {
    const res = await client.query<{ id: string; on_date: string }>(
      `INSERT INTO patient_itinerary_absence
         (assignment_id, on_date, substitute_worker_id, substitute_application_id, created_by, updated_by)
       VALUES ($1, $2::date, $3, $4, $5, $5)
       RETURNING id, to_char(on_date,'YYYY-MM-DD') AS on_date`,
      [input.allocationId, input.date, input.substituteWorkerId, input.substituteApplicationId, input.actorUid],
    );
    const row = res.rows[0];
    return { id: row.id, date: row.on_date };
  }

  /** Junção ausência → alocação → slot → serviço — a MESMA borda de paciente/serviço das irmãs. */
  async findAbsence(client: PoolClient, patientId: string, serviceId: string, absenceId: string): Promise<AbsenceRow | null> {
    const res = await client.query<{
      id: string;
      assignment_id: string;
      on_date: string;
      substitute_worker_id: string | null;
      cancelled_at: string | null;
    }>(
      `SELECT ab.id, ab.assignment_id, to_char(ab.on_date,'YYYY-MM-DD') AS on_date, ab.substitute_worker_id, ab.cancelled_at
         FROM patient_itinerary_absence ab
         JOIN patient_itinerary_assignment a ON a.id = ab.assignment_id
         JOIN patient_itinerary_slot s ON s.id = a.slot_id
         JOIN patient_contracted_services pcs ON pcs.id = s.contracted_service_id
        WHERE pcs.patient_id = $1 AND s.contracted_service_id = $2 AND ab.id = $3`,
      [patientId, serviceId, absenceId],
    );
    if (res.rowCount === 0) return null;
    const row = res.rows[0];
    return {
      id: row.id,
      allocationId: row.assignment_id,
      date: row.on_date,
      substituteWorkerId: row.substitute_worker_id,
      cancelled: row.cancelled_at !== null,
    };
  }

  /** Põe/tira o substituto — os 2 campos JUNTOS (`null`/`null` tira); `cancelled_at IS NULL` no WHERE. */
  async updateSubstitute(
    client: PoolClient,
    id: string,
    substituteWorkerId: string | null,
    substituteApplicationId: string | null,
    actorUid: string,
  ): Promise<number> {
    const res = await client.query(
      `UPDATE patient_itinerary_absence
          SET substitute_worker_id = $2, substitute_application_id = $3, updated_by = $4, updated_at = now()
        WHERE id = $1 AND cancelled_at IS NULL`,
      [id, substituteWorkerId, substituteApplicationId, actorUid],
    );
    return res.rowCount ?? 0;
  }

  /** Cancela escrevendo `cancelled_at` — nunca remove a linha (o banco recusa a remoção direta, 483). `cancelled_at IS NULL` no WHERE. */
  async cancelAbsence(client: PoolClient, id: string, actorUid: string): Promise<number> {
    const res = await client.query(
      `UPDATE patient_itinerary_absence
          SET cancelled_at = now(), cancelled_by = $2, updated_by = $2, updated_at = now()
        WHERE id = $1 AND cancelled_at IS NULL`,
      [id, actorUid],
    );
    return res.rowCount ?? 0;
  }
}
