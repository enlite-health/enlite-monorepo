/**
 * ItineraryAssemblyWriter — Fase 11, DX-11.8 (parte do escritor). O "montado" é log
 * (`patient_itinerary_assembly`, migration 482), nunca flag em `patients` — marcar de novo grava
 * linha nova.
 *
 * `servicesMissingSlot` é UMA query (nenhuma 2ª query por serviço — N+1): reusa
 * `liveVacancySelect` (`liveVacancySql.ts`, a MESMA condição de vaga viva do quadro C, nunca
 * copiada) numa CTE, junta com os serviços `active` do paciente e devolve, na mesma linha, se
 * falta slot `active` (`NOT EXISTS`) e a contagem total de serviços com vaga viva
 * (`COUNT(*) OVER ()` — janela sobre o mesmo resultado, sem 2ª ida ao banco).
 */
import type { PoolClient } from 'pg';
import { liveVacancySelect } from './liveVacancySql';

export interface ServiceMissingSlot {
  serviceId: string;
  serviceCode: string;
}

export interface ServicesMissingSlotResult {
  services: ServiceMissingSlot[];
  countWithLiveVacancy: number;
}

export interface InsertedAssembly {
  id: string;
  assembledAt: string;
}

interface ServiceMissingSlotRow {
  service_id: string;
  service_code: string;
  count_with_live_vacancy: string;
  missing_slot: boolean;
}

export class ItineraryAssemblyWriter {
  /** Paciente existe e não está soft-deletado (`deleted_at`) — a RLS de `patients` já filtra o resto. */
  async patientExists(client: PoolClient, patientId: string): Promise<boolean> {
    const { rows } = await client.query<{ exists: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM patients WHERE id = $1 AND deleted_at IS NULL) AS exists`,
      [patientId],
    );
    return rows[0]?.exists ?? false;
  }

  /**
   * Serviços `active` do paciente com vaga viva (a MESMA condição do quadro C) que NÃO têm slot
   * `active` — e, na mesma query, quantos serviços têm vaga viva (janela, não 2ª query).
   */
  async servicesMissingSlot(client: PoolClient, patientId: string): Promise<ServicesMissingSlotResult> {
    const { rows } = await client.query<ServiceMissingSlotRow>(
      `WITH live_vacancy AS (
         ${liveVacancySelect(`jp.contracted_service_id IN (SELECT id FROM patient_contracted_services WHERE patient_id = $1 AND active)`)}
       )
       SELECT pcs.id AS service_id, pcs.service_code,
              COUNT(*) OVER () AS count_with_live_vacancy,
              NOT EXISTS (
                SELECT 1 FROM patient_itinerary_slot s WHERE s.contracted_service_id = pcs.id AND s.active
              ) AS missing_slot
         FROM patient_contracted_services pcs
         JOIN live_vacancy lv ON lv.contracted_service_id = pcs.id
        WHERE pcs.patient_id = $1 AND pcs.active`,
      [patientId],
    );

    const countWithLiveVacancy = rows.length > 0 ? Number(rows[0].count_with_live_vacancy) : 0;
    const services = rows
      .filter((r) => r.missing_slot)
      .map((r) => ({ serviceId: r.service_id, serviceCode: r.service_code }));
    return { services, countWithLiveVacancy };
  }

  /** Log append-only (migration 482: só SELECT/INSERT para o app) — marcar de novo grava linha nova. */
  async insertAssembly(client: PoolClient, patientId: string, actorUid: string): Promise<InsertedAssembly> {
    const { rows } = await client.query<{ id: string; assembled_at: string }>(
      `INSERT INTO patient_itinerary_assembly (patient_id, assembled_by) VALUES ($1, $2) RETURNING id, assembled_at`,
      [patientId, actorUid],
    );
    return { id: rows[0].id, assembledAt: rows[0].assembled_at };
  }
}
