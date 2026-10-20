/**
 * VacancyAllocationProbe — quantas alocações do itinerário ainda valem num serviço/vaga (058 P5e/P6; D522). "Vigente" = `ACTIVE` e
 * (`valid_to` nulo OU >= hoje): INCLUI entrada futura e saída agendada (D449.1) — por isso NÃO olha `valid_from`. `today` sempre por
 * `operationDateOf(pcs.country, now)`; nunca `CURRENT_DATE` (D-43). Reusado pela REGRA-05 (`PatientContractedServiceRepository`). `countVigenteForVacancy` EXIGE client de transação com identidade do ator (RLS de `patient_itinerary_*`).
 */
import type { Pool, PoolClient } from 'pg';
import { operationDateOf } from '../application/itineraryCoverage';

type Queryable = Pick<Pool | PoolClient, 'query'>;

export async function countVigenteForService(q: Queryable, serviceId: string, today: string): Promise<number> {
  const res = await q.query<{ n: number }>(
    `SELECT count(*)::int AS n
       FROM patient_itinerary_assignment a
       JOIN patient_itinerary_slot s ON s.id = a.slot_id
      WHERE s.contracted_service_id = $1
        AND a.status = 'ACTIVE'
        AND (a.valid_to IS NULL OR a.valid_to >= $2::date)`,
    [serviceId, today],
  );
  return res.rows[0]?.n ?? 0;
}

/** Vaga sem serviço contratado → 0 (apaga como hoje, D524). */
export async function countVigenteForVacancy(q: Queryable, vacancyId: string, now: Date): Promise<number> {
  const svc = await q.query<{ service_id: string; country: string }>(
    `SELECT pcs.id AS service_id, pcs.country
       FROM job_postings jp
       JOIN patient_contracted_services pcs ON pcs.id = jp.contracted_service_id
      WHERE jp.id = $1`,
    [vacancyId],
  );
  const row = svc.rows[0];
  if (!row) return 0;
  // Fecha a janela leitura→UPDATE do DELETE: MESMA chave da Trava A (migration 543). Um `allocate` em voo segura o lock e o DELETE espera;
  // depois do COMMIT do DELETE a vaga morta não aceita alocação. SÓ vale dentro de transação (o chamador é `withActorContext`).
  await q.query(`SELECT pg_advisory_xact_lock(hashtext('itinerary:service:' || $1::text))`, [row.service_id]);
  return countVigenteForService(q, row.service_id, operationDateOf(row.country, now));
}
