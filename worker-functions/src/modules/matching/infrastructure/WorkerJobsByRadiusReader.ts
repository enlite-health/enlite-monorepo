/**
 * WorkerJobsByRadiusReader — spec 077 C-37 (D661): vagas a até `radiusKm` da zona do prestador, da mais perto para a mais longe.
 *
 * Origem: `worker_service_areas.location` (geography) da zona viva do prestador. Ponto da vaga: lat/lng do endereço da vaga
 * (`job_postings.patient_address_id`). Lat/lng servem SÓ para a distância; a resposta leva bairro, cidade, província e
 * `distance_km`, nunca o endereço exato. Campos da vaga pela peça `vacancyEffectiveFieldsSql` (horário e profissões do
 * serviço contratado). Recorte de teste por `testRealmSql` (D665, DT-20): prestador de teste vê só vaga de teste (rascunho
 * incluso); prestador real vê o filtro do feed público (`buildPublicJobsWhere`, DT-12).
 */
import type { PoolClient } from 'pg';
import { PublicJobsFiltersSchema } from '../domain/PublicJobsFilters';
import { buildPublicJobsWhere } from './PublicJobsQueryBuilder';
import {
  vacancyEffectiveJoinSql,
  vacancyEffectiveRequiredProfessionsSql,
  vacancyEffectiveScheduleSql,
} from '@shared/sql/vacancyEffectiveFieldsSql';
import { excludeTestVacancySql, sameRealmAsVacancySql } from '@shared/database/testRealmSql';

export interface WorkerJobByRadius {
  id: string;
  case_number: number | null;
  vacancy_number: number;
  title: string;
  service: string | null;
  neighborhood: string | null;
  city: string | null;
  state: string | null;
  /** Horário efetivo da vaga (peça `vacancyEffectiveScheduleSql`), como o banco o guarda. */
  schedule: unknown;
  worker_type: string[];
  /** Distância em km, 1 casa, calculada no servidor. */
  distance_km: number;
}

/** Zona viva do prestador com ponto (mesma régua do `FindNearbyVacanciesForWorkerUseCase`). */
export const ZONE_SQL =
  'SELECT 1 FROM worker_service_areas wsa WHERE wsa.worker_id = $1 AND wsa.deleted_at IS NULL ' +
  'AND wsa.location IS NOT NULL AND NOT (wsa.latitude = 0 AND wsa.longitude = 0) LIMIT 1';

/** SQL da lista + parâmetros. Pura: o teste e o PREPARE leem o mesmo texto que roda. */
export function buildJobsByRadiusSql(workerId: string, radiusKm: number): { sql: string; params: unknown[] } {
  const pub = buildPublicJobsWhere(PublicJobsFiltersSchema.parse({}));
  const params: unknown[] = [...pub.params, workerId, radiusKm];
  const w = `$${pub.params.length + 1}`;
  const r = `$${pub.params.length + 2}`;
  const publicConditions = pub.whereClause.replace(/^WHERE /, '');
  const sql = `WITH w AS (
         SELECT wk.id, wsa.location
         FROM workers wk
         JOIN worker_service_areas wsa ON wsa.worker_id = wk.id AND wsa.deleted_at IS NULL
         WHERE wk.id = ${w}
           AND wsa.location IS NOT NULL
           AND NOT (wsa.latitude = 0 AND wsa.longitude = 0)
         ORDER BY wsa.created_at DESC
         LIMIT 1
       )
       SELECT jp.id,
              jp.case_number,
              jp.vacancy_number,
              jp.title,
              p.service_type AS service,
              COALESCE(pa.neighborhood, p.zone_neighborhood) AS neighborhood,
              pa.city AS city,
              pa.state AS state,
              ${vacancyEffectiveScheduleSql('jp')} AS schedule,
              ${vacancyEffectiveRequiredProfessionsSql('jp')} AS worker_type,
              ROUND((d.meters / 1000)::numeric, 1) AS distance_km
       FROM job_postings jp
       ${vacancyEffectiveJoinSql('jp')}
       CROSS JOIN w
       JOIN patient_addresses pa ON pa.id = jp.patient_address_id
       LEFT JOIN patients p ON p.id = jp.patient_id
       CROSS JOIN LATERAL (
         SELECT ST_Distance(ST_SetSRID(ST_MakePoint(pa.lng::float8, pa.lat::float8), 4326)::geography, w.location) AS meters
       ) d
       WHERE pa.lat IS NOT NULL AND pa.lng IS NOT NULL
         AND ST_DWithin(ST_SetSRID(ST_MakePoint(pa.lng::float8, pa.lat::float8), 4326)::geography, w.location, ${r} * 1000)
         AND jp.deleted_at IS NULL
         AND ${sameRealmAsVacancySql('w.id', 'jp.id')}
         AND (NOT (${excludeTestVacancySql('jp')}) OR (${publicConditions}))
       ORDER BY d.meters ASC, jp.id ASC`;
  return { sql, params };
}

interface Row {
  id: string;
  case_number: number | null;
  vacancy_number: number;
  title: string;
  service: string | null;
  neighborhood: string | null;
  city: string | null;
  state: string | null;
  schedule: unknown;
  worker_type: string[] | null;
  distance_km: string | number;
}

/** `null` = o prestador não tem zona viva com ponto (o use case responde NO_SERVICE_AREA); `[]` = zona sem vaga no raio. */
export async function readJobsByRadius(
  client: PoolClient,
  args: { workerId: string; radiusKm: number },
): Promise<WorkerJobByRadius[] | null> {
  const zone = await client.query(ZONE_SQL, [args.workerId]);
  if (zone.rows.length === 0) return null;
  const { sql, params } = buildJobsByRadiusSql(args.workerId, args.radiusKm);
  const res = await client.query<Row>(sql, params);
  return res.rows.map((r) => ({
    id: r.id,
    case_number: r.case_number,
    vacancy_number: r.vacancy_number,
    title: r.title,
    service: r.service,
    neighborhood: r.neighborhood,
    city: r.city,
    state: r.state,
    schedule: r.schedule,
    worker_type: r.worker_type ?? [],
    distance_km: Number(r.distance_km),
  }));
}
