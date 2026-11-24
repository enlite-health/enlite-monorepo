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
  vacancyEffectiveRequiredSexSql,
  vacancyEffectiveScheduleSql,
} from '@shared/sql/vacancyEffectiveFieldsSql';
import { excludeTestVacancySql, sameRealmAsVacancySql } from '@shared/database/testRealmSql';
import { matchProfileSql, type MatchProfile } from './matchProfile';

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
  /** Derivado em leitura de `worker_job_applications` do próprio prestador (D516). */
  already_applied: boolean;
}

/** Zona viva do prestador com ponto (mesma régua do `FindNearbyVacanciesForWorkerUseCase`). */
export const ZONE_SQL =
  'SELECT 1 FROM worker_service_areas wsa WHERE wsa.worker_id = $1 AND wsa.deleted_at IS NULL ' +
  'AND wsa.location IS NOT NULL AND NOT (wsa.latitude = 0 AND wsa.longitude = 0) LIMIT 1';

/** SQL da lista + parâmetros. Pura: o teste e o PREPARE leem o mesmo texto que roda. */
export function buildJobsByRadiusSql(
  workerId: string,
  radiusKm: number | null,
  profile?: MatchProfile,
): { sql: string; params: unknown[] } {
  const pub = buildPublicJobsWhere(PublicJobsFiltersSchema.parse({}));
  // `radiusKm === null` (096, fallback "mais próximas"): MESMO SQL e MESMOS filtros, só sem o teto `ST_DWithin` e sem o param do raio.
  const params: unknown[] = radiusKm === null ? [...pub.params, workerId] : [...pub.params, workerId, radiusKm];
  const w = `$${pub.params.length + 1}`;
  const r = `$${pub.params.length + 2}`;
  const withinSql =
    radiusKm === null
      ? ''
      : `\n         AND ST_DWithin(ST_SetSRID(ST_MakePoint(pa.lng::float8, pa.lat::float8), 4326)::geography, w.location, ${r} * 1000)`;
  // 096 (`view=home`): sem `profile` os dois fragmentos são '' e o SQL é byte a byte o de antes (CA-1).
  let profileWhere = '';
  let profileSelect = '';
  if (profile) {
    let occupationParam = '';
    if (profile.occupation !== null) {
      params.push(profile.occupation);
      occupationParam = `$${params.length}`;
    }
    profileWhere = matchProfileSql(profile, { jp: 'jp', workerParam: w, occupationParam });
    profileSelect = `,\n              ${vacancyEffectiveRequiredSexSql('jp')} AS required_sex`;
  }
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
              ROUND((d.meters / 1000)::numeric, 1) AS distance_km,
              EXISTS (SELECT 1 FROM worker_job_applications wja WHERE wja.worker_id = ${w} AND wja.job_posting_id = jp.id) AS already_applied${profileSelect}
       FROM job_postings jp
       ${vacancyEffectiveJoinSql('jp')}
       CROSS JOIN w
       JOIN patient_addresses pa ON pa.id = jp.patient_address_id
       LEFT JOIN patients p ON p.id = jp.patient_id
       CROSS JOIN LATERAL (
         SELECT ST_Distance(ST_SetSRID(ST_MakePoint(pa.lng::float8, pa.lat::float8), 4326)::geography, w.location) AS meters
       ) d
       WHERE pa.lat IS NOT NULL AND pa.lng IS NOT NULL${withinSql}
         AND jp.deleted_at IS NULL
         AND ${sameRealmAsVacancySql('w.id', 'jp.id')}
         AND (NOT (${excludeTestVacancySql('jp')}) OR (${publicConditions}))${profileWhere}
       ORDER BY d.meters ASC, jp.id ASC`;
  return { sql, params };
}

export interface WorkerJobByRadiusWithSex extends WorkerJobByRadius {
  /** Sexo exigido efetivo da vaga: INTERNO (o use case filtra e remove; nunca sai na resposta). */
  required_sex: string | null;
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
  already_applied: boolean | null;
  required_sex?: string | null;
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
  return res.rows.map(toItem);
}

function toItem(r: Row): WorkerJobByRadius {
  return {
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
    already_applied: r.already_applied === true,
  };
}

/** Perfil do prestador para `view=home` (096): endereço da zona viva, disponibilidade declarada, profissão e sexo cifrado. */
export interface WorkerHomeProfile {
  /** Ponto da zona viva do PRÓPRIO prestador, 3 casas (~110 m); `null` = sem endereço com ponto. */
  center: { lat: number; lng: number } | null;
  /** Sexo cifrado (KMS): o use case decifra 1x, e só com cadastro completo; nunca em SQL de lista nem em log. */
  sexEncrypted: string | null;
  occupation: string | null;
  hasAvailability: boolean;
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;

/** Uma linha por prestador, COM ou SEM zona viva (a home precisa dizer o que falta, inclusive o endereço). */
export const HOME_PROFILE_SQL =
  `SELECT z.lat, z.lng, wk.sex_encrypted,
          COALESCE(wk.occupation, wk.profession) AS occupation,
          EXISTS (SELECT 1 FROM worker_availability wa WHERE wa.worker_id = wk.id) AS has_availability
   FROM workers wk
   LEFT JOIN LATERAL (
     SELECT wsa.latitude AS lat, wsa.longitude AS lng
     FROM worker_service_areas wsa
     WHERE wsa.worker_id = wk.id AND wsa.deleted_at IS NULL
       AND wsa.location IS NOT NULL AND NOT (wsa.latitude = 0 AND wsa.longitude = 0)
     ORDER BY wsa.created_at DESC
     LIMIT 1
   ) z ON true
   WHERE wk.id = $1`;

/** `null` = prestador inexistente (o use case já resolveu o id, então não acontece na prática). */
export async function readWorkerHomeProfile(client: PoolClient, workerId: string): Promise<WorkerHomeProfile | null> {
  const res = await client.query<{
    lat: string | number | null; lng: string | number | null; sex_encrypted: string | null; occupation: string | null; has_availability: boolean;
  }>(HOME_PROFILE_SQL, [workerId]);
  const r = res.rows[0];
  if (!r) return null;
  return {
    center: r.lat === null || r.lng === null ? null : { lat: round3(Number(r.lat)), lng: round3(Number(r.lng)) },
    sexEncrypted: r.sex_encrypted && r.sex_encrypted !== '' ? r.sex_encrypted : null,
    occupation: r.occupation && r.occupation.trim() !== '' ? r.occupation : null,
    hasAvailability: r.has_availability === true,
  };
}

/** Lista de `view=home`: horário e profissão em SQL; devolve o sexo exigido (interno) para o use case filtrar. */
export async function readJobsByRadiusForHome(
  client: PoolClient,
  args: { workerId: string; radiusKm: number | null; profile: MatchProfile },
): Promise<WorkerJobByRadiusWithSex[]> {
  const { sql, params } = buildJobsByRadiusSql(args.workerId, args.radiusKm, args.profile);
  const res = await client.query<Row>(sql, params);
  return res.rows.map((r) => ({ ...toItem(r), required_sex: r.required_sex ?? null }));
}
