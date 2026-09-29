/**
 * ItineraryAllocationWriter — DX-11.7 (parte do escritor): a ÚNICA escrita de
 * `patient_itinerary_assignment` desta fase. `ServiceTeamReader.readWith` (Fase 10, REUSADO, não
 * duplicado) continua sendo o leitor do time derivado — este arquivo só grava e relê a própria
 * alocação. Cada método faz UMA query no `client` recebido (a transação é de quem chama,
 * `ItineraryAllocationUseCase`, P13, dentro de `inPatientTransaction`).
 *
 * `findApplicationId` NÃO filtra por etapa do funil — quem decide elegibilidade é o gate de
 * Selecionado (C) ANTES de chamar este escritor (`canAllocate`, DX-11.6); este método só confirma
 * que a candidatura EXISTE, para gravar a FK obrigatória.
 *
 * `insertAllocation` grava `valid_from` do PARÂMETRO — nunca `now()`/`CURRENT_DATE` (a data é
 * `operationDateOf(country, now)`, calculada por quem chama, DX-11.8). `endAllocation` usa
 * `GREATEST(valid_from, $2)` (o fim nunca fica antes do início) e só bate linha `ACTIVE` no `WHERE`.
 *
 * Nenhuma escrita em outra tabela (paciente, o cadastro de prestadores do legado ou o card de
 * atendimento antigo, Fase 14) — só leitura de `worker_job_applications` em `findApplicationId`
 * (invariante 6/14).
 */
import type { PoolClient } from 'pg';
import type { ItineraryAssignmentStatus } from '../domain/ServiceCoverageCalculator';

export interface AllocationSlot {
  slotId: string;
  active: boolean;
  addressId: string | null;
}

export interface InsertAllocationInput {
  slotId: string;
  workerId: string;
  applicationId: string;
  validFrom: string;
  actorUid: string;
}

export interface InsertedAllocation {
  id: string;
  validFrom: string;
}

export interface AllocationRow {
  id: string;
  status: ItineraryAssignmentStatus;
  validFrom: string;
  /** D445.5 (reemplazo permanente): o slot da alocação encerrada é o MESMO slot da nova. Opcional — só `findAllocation` preenche; molde aditivo, sem quebrar os chamadores antigos. */
  slotId?: string;
}

export class ItineraryAllocationWriter {
  /** Slot deste serviço/paciente — junção slot→serviço→paciente, nunca 2 queries. */
  async findSlotForAllocation(
    client: PoolClient,
    patientId: string,
    serviceId: string,
    slotId: string,
  ): Promise<AllocationSlot | null> {
    const res = await client.query<{ id: string; active: boolean; address_id: string | null }>(
      `SELECT s.id, s.active, pcs.address_id
         FROM patient_itinerary_slot s
         JOIN patient_contracted_services pcs ON pcs.id = s.contracted_service_id
        WHERE pcs.patient_id = $1 AND s.contracted_service_id = $2 AND s.id = $3`,
      [patientId, serviceId, slotId],
    );
    if (res.rowCount === 0) return null;
    const row = res.rows[0];
    return { slotId: row.id, active: row.active, addressId: row.address_id };
  }

  /** Candidatura do prestador na vaga — SEM filtro de etapa (o gate de Selecionado já decidiu). */
  async findApplicationId(client: PoolClient, workerId: string, vacancyId: string): Promise<string | null> {
    const res = await client.query<{ id: string }>(
      `SELECT id FROM worker_job_applications WHERE worker_id = $1 AND job_posting_id = $2`,
      [workerId, vacancyId],
    );
    return res.rows[0]?.id ?? null;
  }

  /** `valid_from` é o do PARÂMETRO — nunca `now()`/`CURRENT_DATE` (DX-11.8). */
  async insertAllocation(client: PoolClient, input: InsertAllocationInput): Promise<InsertedAllocation> {
    const res = await client.query<{ id: string; valid_from: string }>(
      `INSERT INTO patient_itinerary_assignment
         (slot_id, worker_id, application_id, valid_from, status, created_by, updated_by)
       VALUES ($1, $2, $3, $4::date, 'ACTIVE', $5, $5)
       RETURNING id, to_char(valid_from,'YYYY-MM-DD') AS valid_from`,
      [input.slotId, input.workerId, input.applicationId, input.validFrom, input.actorUid],
    );
    const row = res.rows[0];
    return { id: row.id, validFrom: row.valid_from };
  }

  /** A mesma junção slot→serviço→paciente do `findSlotForAllocation`, agora pela alocação. */
  async findAllocation(
    client: PoolClient,
    patientId: string,
    serviceId: string,
    allocationId: string,
  ): Promise<AllocationRow | null> {
    const res = await client.query<{ id: string; status: ItineraryAssignmentStatus; valid_from: string; slot_id: string }>(
      `SELECT a.id, a.status, to_char(a.valid_from,'YYYY-MM-DD') AS valid_from, a.slot_id
         FROM patient_itinerary_assignment a
         JOIN patient_itinerary_slot s ON s.id = a.slot_id
         JOIN patient_contracted_services pcs ON pcs.id = s.contracted_service_id
        WHERE pcs.patient_id = $1 AND s.contracted_service_id = $2 AND a.id = $3`,
      [patientId, serviceId, allocationId],
    );
    if (res.rowCount === 0) return null;
    const row = res.rows[0];
    return { id: row.id, status: row.status, validFrom: row.valid_from, slotId: row.slot_id };
  }

  /** `GREATEST(valid_from, hoje)`: o fim nunca fica antes do início. Só bate `status = 'ACTIVE'`. */
  async endAllocation(client: PoolClient, id: string, today: string, actorUid: string): Promise<number> {
    const res = await client.query(
      `UPDATE patient_itinerary_assignment
          SET status = 'ENDED', valid_to = GREATEST(valid_from, $2::date), updated_by = $3, updated_at = now()
        WHERE id = $1 AND status = 'ACTIVE'`,
      [id, today, actorUid],
    );
    return res.rowCount ?? 0;
  }
}
