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
