/**
 * VacancyCountReader — leitor de contagem de VAGAS da Maria (change 085, spec §4.3, DD1/DD6).
 *
 * Contagem CRUA (sem supressão de célula pequena: é da rota). SÓ-LEITURA; quem chama abre o
 * `withActorContext` e passa o client. Cada campo lê o dono do conceito:
 *   status -> `job_postings.status` (atalho `viva` já chega expandido; = OPEN_JOB_STATUSES de `LIVE_JOB_POSTING_SQL`)
 *   zone -> `resolveZoneKey(pa.state, pa.city)` via `job_postings.patient_address_id` (dobra em TS; 1 vaga = 1 endereço)
 *   has_applicant -> mesmo critério de `vacancyListHelpers.ts:101` (POSTULATED_STAGES + worker não DISABLED).
 * Recorte padrão: não eliminada, não rascunho, não teste e do país (`job_postings.country`, migration 011).
 */
import type { Pool } from 'pg';
import type { CountryCode } from '@shared/domain/countryCodes';
import { workerNotDisabledSql } from '@shared/database/activeWorkerFilter';
import { countryPredicateSql } from '@shared/database/countryScopeSql';
import { resolveZoneKey } from '@shared/utils/zoneKey';
import { POSTULATED_STAGES, toSqlInList } from '@modules/matching/domain/applicationFunnelStages';

export type VacancyCountDb = Pick<Pool, 'query'>;

/** Subconjunto mínimo da forma canônica já validada (compatível com `CanonicalCountRequest`). */
export interface VacancyCountRequest {
  filters: ReadonlyArray<{ field: string; values: readonly string[] }>;
  group_by: string | null;
}

export interface VacancyCountResult {
  total: number;
  groups?: Array<{ key: string; value: number }>;
}

/** Critério de `vacancyListHelpers.ts:101` ("postulados"): estágio postulado e worker não DISABLED. */
const HAS_APPLICANT_SQL = `EXISTS (
    SELECT 1 FROM worker_job_applications wja
     WHERE wja.job_posting_id = jp.id
       AND wja.application_funnel_stage IN (${toSqlInList(POSTULATED_STAGES)})
       AND ${workerNotDisabledSql('wja.worker_id')}
  )`;

const GROUPABLE = ['status', 'zone', 'has_applicant'] as const;

export class VacancyCountReader {
  constructor(private readonly db: VacancyCountDb) {}

  async count(request: VacancyCountRequest, countries: CountryCode[]): Promise<VacancyCountResult> {
    const filter = (field: string): readonly string[] | undefined =>
      request.filters.find((f) => f.field === field)?.values;
    const groupBy = request.group_by;
    if (groupBy !== null && !(GROUPABLE as readonly string[]).includes(groupBy)) {
      throw new Error(`group_by fora do cardápio de vagas: ${groupBy}`);
    }

    const params: unknown[] = [countries];
    const where: string[] = [
      'jp.deleted_at IS NULL',
      'jp.is_draft = false',
      'jp.is_test = false',
      countryPredicateSql('jp', 1),
    ];
    const status = filter('status');
    if (status) {
      params.push([...status]);
      where.push(`jp.status = ANY($${params.length}::text[])`);
    }
    const hasApplicant = filter('has_applicant') ?? [];
    const wantTrue = hasApplicant.includes('true');
    const wantFalse = hasApplicant.includes('false');
    if (wantTrue !== wantFalse) where.push(wantTrue ? HAS_APPLICANT_SQL : `NOT ${HAS_APPLICANT_SQL}`);

    // Uma linha por (status, has_applicant, estado, cidade); a zona dobra em TS por `resolveZoneKey` (DD6).
    const r = await this.db.query<{
      status: string; has_applicant: boolean; state: string | null; city: string | null; n: number;
    }>(
      `SELECT jp.status, ${HAS_APPLICANT_SQL} AS has_applicant, pa.state, pa.city, COUNT(*)::int AS n
         FROM job_postings jp
         LEFT JOIN patient_addresses pa ON pa.id = jp.patient_address_id
        WHERE ${where.join('\n          AND ')}
        GROUP BY 1, 2, 3, 4`,
      params,
    );

    const wanted = filter('zone') ? new Set(filter('zone')) : null;
    const tally = new Map<string, number>();
    let total = 0;
    for (const row of r.rows) {
      const zone = resolveZoneKey(row.state, row.city).label;
      if (wanted && !wanted.has(zone)) continue;
      total += row.n;
      if (groupBy === null) continue;
      const key = groupBy === 'zone' ? zone : groupBy === 'status' ? row.status : String(row.has_applicant);
      tally.set(key, (tally.get(key) ?? 0) + row.n);
    }
    if (groupBy === null) return { total };
    const groups = [...tally]
      .map(([key, value]) => ({ key, value }))
      .sort((a, b) => b.value - a.value || a.key.localeCompare(b.key));
    return { total, groups };
  }
}
