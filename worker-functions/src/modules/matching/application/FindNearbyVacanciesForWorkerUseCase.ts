import { Pool } from 'pg';

/** Um slot do schedule da vaga (mesmo formato de worker_availability). */
export interface VacancyScheduleSlot {
  dayOfWeek: number;
  startTime: string;
  endTime: string;
}

export interface NearbyVacancy {
  /** Referência humana da vaga ("el caso NNN") — NUNCA o UUID. */
  caseNumber: number | null;
  zone: string | null;
  timezone: string | null;
  /** Schedule completo da vaga (de-identificado, sem monto). */
  schedule: VacancyScheduleSlot[];
  /** Dias (0=Dom…6=Sáb) do schedule que o worker NÃO cobre hoje. */
  missingDays: number[];
}

export interface FindNearbyVacanciesResult {
  vacancies: NearbyVacancy[];
}

const ACTIVE_STATUSES = [
  'SEARCHING',
  'ACTIVE',
  'SEARCHING_REPLACEMENT',
  'RAPID_RESPONSE',
  'PENDING_ACTIVATION',
];
const DEFAULT_RADIUS_KM = 30;

/**
 * Quase-match (F1, nível 2): vagas ativas que o worker QUASE cobre — batem em
 * profissão e zona, ele NÃO está aplicado, e faltam 0 < N ≤ maxMissingDays dias da
 * disponibilidade dele. A Luz mostra isso como "oportunidades cerca de tus días" e
 * pode oferecer adaptar a disponibilidade. De-identificado (sem paciente, sem monto).
 *
 * Só considera worker COM disponibilidade declarada (senão não há "gap" a medir).
 */
export class FindNearbyVacanciesForWorkerUseCase {
  constructor(private readonly db: Pool) {}

  async execute(
    workerId: string,
    maxMissingDays = Number(process.env.MATCHING_NEARBY_MAX_MISSING_DAYS ?? 1),
    radiusKm = DEFAULT_RADIUS_KM,
    limit = 5,
  ): Promise<FindNearbyVacanciesResult> {
    const { rows } = await this.db.query(
      `WITH w AS (
         SELECT wk.id, wk.occupation, wsa.latitude, wsa.longitude
         FROM workers wk
         JOIN worker_service_areas wsa
           ON wsa.worker_id = wk.id AND wsa.deleted_at IS NULL
         WHERE wk.id = $1
           AND wsa.location IS NOT NULL
           AND NOT (wsa.latitude = 0 AND wsa.longitude = 0)
         LIMIT 1
       ),
       missing AS (
         SELECT jp.id,
                jp.case_number,
                jp.patient_zone,
                jp.timezone,
                jp.schedule,
                (
                  SELECT COALESCE(array_agg(DISTINCT vd."dayOfWeek" ORDER BY vd."dayOfWeek"), '{}')
                  FROM jsonb_to_recordset(COALESCE(jp.schedule, '[]'::jsonb)) AS vd("dayOfWeek" int)
                  WHERE NOT EXISTS (
                    SELECT 1 FROM worker_availability wa
                    WHERE wa.worker_id = $1 AND wa.day_of_week = vd."dayOfWeek"
                  )
                ) AS missing_days
         FROM job_postings jp, w
         WHERE jp.deleted_at IS NULL
           AND jp.is_covered = false
           AND jp.status = ANY($2::text[])
           AND w.occupation = ANY(jp.required_professions)
           AND NOT EXISTS (
             SELECT 1 FROM worker_job_applications wja
             WHERE wja.worker_id = $1 AND wja.job_posting_id = jp.id
           )
           AND EXISTS (SELECT 1 FROM worker_availability wa WHERE wa.worker_id = $1)
           AND (
             jp.service_lat IS NULL OR jp.service_lng IS NULL
             OR 6371 * acos(LEAST(1, GREATEST(-1,
                  cos(radians(w.latitude)) * cos(radians(jp.service_lat))
                    * cos(radians(jp.service_lng) - radians(w.longitude))
                  + sin(radians(w.latitude)) * sin(radians(jp.service_lat))
                ))) <= $3
           )
       )
       SELECT id, case_number, patient_zone, timezone, schedule, missing_days
       FROM missing
       WHERE cardinality(missing_days) BETWEEN 1 AND $4
       ORDER BY cardinality(missing_days) ASC, case_number DESC
       LIMIT $5`,
      [workerId, ACTIVE_STATUSES, radiusKm, maxMissingDays, limit],
    );

    const vacancies: NearbyVacancy[] = rows.map((r) => ({
      caseNumber: r.case_number ?? null,
      zone: r.patient_zone ?? null,
      timezone: r.timezone ?? null,
      schedule: Array.isArray(r.schedule)
        ? (r.schedule as Record<string, unknown>[]).map((s) => ({
            dayOfWeek: Number(s.dayOfWeek),
            startTime: String(s.startTime ?? ''),
            endTime: String(s.endTime ?? ''),
          }))
        : [],
      missingDays: (r.missing_days as number[]) ?? [],
    }));

    return { vacancies };
  }
}
