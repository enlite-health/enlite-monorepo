/**
 * candidateDistanceSql
 *
 * A fórmula de distância candidato × vaga num lugar só (DX-3.10). Antes vivia
 * inline em `VacancyMatchController.ts` (match); agora também alimenta o Kanban
 * (P8) e o modo lista (P9) da vaga, sem duplicar o SQL nem o comportamento.
 */

/** km com 1 casa entre a área do worker e o endereço da vaga — a fórmula do match (PostGIS). */
export function distanceKmSql(location: string, lat: string, lng: string): string {
  return `CASE WHEN ${location} IS NOT NULL AND ${lat} IS NOT NULL AND ${lng} IS NOT NULL
    THEN ROUND((ST_Distance(${location}, ST_MakePoint(${lng}, ${lat})::geography) / 1000.0)::numeric, 1)::float
    ELSE NULL END`;
}

/** Distância candidato × vaga pela área VIVA mais próxima. Escalar: não duplica linha (10 workers com >1 área na stage). */
export function candidateDistanceKmSql(workerId: string, jobPostingId: string): string {
  return `(SELECT MIN(${distanceKmSql('wsa_d.location', 'pa_d.lat', 'pa_d.lng')})
             FROM worker_service_areas wsa_d
             JOIN job_postings jp_d ON jp_d.id = ${jobPostingId}
             JOIN patient_addresses pa_d ON pa_d.id = jp_d.patient_address_id
            WHERE wsa_d.worker_id = ${workerId} AND wsa_d.deleted_at IS NULL)`;
}

/**
 * Spec 089 (DF-3/DF-7): UMA área viva por prestador — a MAIS PRÓXIMA do serviço — num `LEFT JOIN LATERAL ... LIMIT 1`.
 * Pressupõe `w` (workers) e `pa` (patient_addresses do serviço) no FROM; o alias da área devolvida é `wsa`, com
 * `latitude`, `longitude`, `location` e `work_zone` da MESMA linha (pino e distância não podem vir de áreas diferentes).
 * Serviço sem coordenada: `ST_MakePoint(NULL, NULL)` é NULL, a distância é NULL e o desempate `updated_at DESC` escolhe
 * a mais recente (a mesma escolha do mapa geral, `AdminWorkersMapController`). Sem `location` a área não entra
 * (o POST também a exige, F9).
 */
export function nearestServiceAreaLateralSql(): string {
  return `LEFT JOIN LATERAL (
      SELECT s.latitude, s.longitude, s.location, s.work_zone
        FROM worker_service_areas s
       WHERE s.worker_id = w.id AND s.deleted_at IS NULL AND s.location IS NOT NULL
       ORDER BY ST_Distance(s.location, ST_MakePoint(pa.lng::float8, pa.lat::float8)::geography) ASC NULLS LAST,
                s.updated_at DESC
       LIMIT 1
    ) wsa ON true`;
}

/** `interview_response` que conta como "já respondeu" (§9.2): a mesma lista decide `replied` e o `pendingInVacancyCount`. */
export const REPLIED_INTERVIEW_RESPONSES = [
  'confirmed', 'declined', 'no_response', 'awaiting_reschedule', 'awaiting_reason',
] as const;

export function repliedSql(column = 'wja.interview_response'): string {
  const list = REPLIED_INTERVIEW_RESPONSES.map((r) => `'${r}'`).join(', ');
  return `COALESCE(${column} IN (${list}), false)`;
}
