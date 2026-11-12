/**
 * WorkerCountReader — leitor de contagem de PRESTADORES da Maria (change 085, spec §4.1, DD1/DD4/DD6).
 *
 * Devolve contagem CRUA (sem supressão de célula pequena: isso é da rota). SÓ-LEITURA; quem chama abre o
 * `withActorContext` e passa o client (RLS exige `app.user_uid`). Cada campo lê o dono do conceito:
 *   registration -> `workers.status` · has_phone -> critério de `546_067_dono_dois_limiares.sql:53`
 *   apto -> `fn_worker_is_apto` (via `workerAptoSql`) · zone -> `resolveZoneKey` (dobra em TS, DISTINCT worker).
 * Os ids de worker ficam na memória do processo (zona): nunca saem do leitor nem vão a log.
 */
import type { Pool } from 'pg';
import type { CountryCode } from '@shared/domain/countryCodes';
import { DISABLED_WORKER_STATUS, excludeDisabledWorkersSql } from '@shared/database/activeWorkerFilter';
import { countryPredicateSql } from '@shared/database/countryScopeSql';
import { workerAptoSql } from '@shared/database/workerAptoSql';
import { resolveZoneKey } from '@shared/utils/zoneKey';

export type WorkerCountDb = Pick<Pool, 'query'>;

/** Subconjunto mínimo da forma canônica já validada (compatível com `CanonicalCountRequest`). */
export interface WorkerCountRequest {
  filters: ReadonlyArray<{ field: string; values: readonly string[] }>;
  group_by: string | null;
}

export interface WorkerCountResult {
  total: number;
  groups?: Array<{ key: string; value: number }>;
}

/** Critério do dono (`546_067_dono_dois_limiares.sql:53`): telefone presente e não vazio. */
const HAS_PHONE_SQL = `(w.phone IS NOT NULL AND w.phone <> '')`;
const APTO_SQL = `COALESCE(${workerAptoSql('w.id')}, false)`;

const GROUPABLE = ['registration', 'has_phone', 'apto', 'zone'] as const;

/** Booleano do cardápio: ['true'], ['false'] ou ambos (= sem restrição). */
function boolPredicate(expr: string, values: readonly string[]): string | null {
  const wantTrue = values.includes('true');
  const wantFalse = values.includes('false');
  if (wantTrue === wantFalse) return null;
  return wantTrue ? expr : `NOT ${expr}`;
}

export class WorkerCountReader {
  constructor(private readonly db: WorkerCountDb) {}

  async count(request: WorkerCountRequest, countries: CountryCode[]): Promise<WorkerCountResult> {
    const filter = (field: string): readonly string[] | undefined =>
      request.filters.find((f) => f.field === field)?.values;
    const groupBy = request.group_by;
    if (groupBy !== null && !(GROUPABLE as readonly string[]).includes(groupBy)) {
      throw new Error(`group_by fora do cardápio de prestadores: ${groupBy}`);
    }

    const registration = filter('registration');
    const params: unknown[] = [countries];
    // DD1: recorte padrão. `DISABLED` só entra se o filtro `registration` o nomeia.
    const where: string[] = [
      'w.merged_into_id IS NULL',
      'w.is_test = false',
      countryPredicateSql('w', 1),
    ];
    if (!registration?.includes(DISABLED_WORKER_STATUS)) where.push(excludeDisabledWorkersSql('w'));
    if (registration) {
      params.push([...registration]);
      where.push(`w.status = ANY($${params.length}::text[])`);
    }
    const phone = boolPredicate(HAS_PHONE_SQL, filter('has_phone') ?? []);
    if (phone) where.push(phone);
    const apto = boolPredicate(APTO_SQL, filter('apto') ?? []);
    if (apto) where.push(apto);
    const whereSql = where.join('\n      AND ');

    const zoneFilter = filter('zone');
    if (zoneFilter || groupBy === 'zone') return this.countByZone(whereSql, params, request, zoneFilter);

    if (groupBy === null) {
      const r = await this.db.query<{ n: number }>(
        `SELECT COUNT(*)::int AS n FROM workers w WHERE ${whereSql}`,
        params,
      );
      return { total: r.rows[0].n };
    }
    const keyExpr = { registration: 'w.status', has_phone: HAS_PHONE_SQL, apto: APTO_SQL }[groupBy]!;
    const r = await this.db.query<{ key: string | boolean | null; value: number }>(
      `SELECT ${keyExpr} AS key, COUNT(*)::int AS value
         FROM workers w WHERE ${whereSql}
        GROUP BY 1`,
      params,
    );
    const groups = r.rows
      .map((row) => ({ key: String(row.key), value: row.value }))
      .sort((a, b) => b.value - a.value || a.key.localeCompare(b.key));
    // grupo de campo escalar é partição: soma = total
    return { total: groups.reduce((s, g) => s + g.value, 0), groups };
  }

  /**
   * DD6: a SQL devolve (id, state, city, atributos) do recorte já filtrado; a dobra por `resolveZoneKey` em
   * `Set<id>` conta DISTINCT worker (N áreas na mesma zona = 1). Worker sem área cai em "No informado".
   * Com filtro de zona, entram só workers cujo conjunto de zonas o intersecta; o group_by=zone mostra só as
   * zonas do filtro (e `total` = workers distintos, que pode ser menor que a soma dos grupos).
   */
  private async countByZone(
    whereSql: string,
    params: unknown[],
    request: WorkerCountRequest,
    zoneFilter: readonly string[] | undefined,
  ): Promise<WorkerCountResult> {
    const groupBy = request.group_by;
    const needsApto = groupBy === 'apto';
    const r = await this.db.query<{
      id: string; registration: string; has_phone: boolean; apto: boolean | null;
      state: string | null; city: string | null;
    }>(
      `WITH base AS MATERIALIZED (
         SELECT w.id, w.status AS registration, ${HAS_PHONE_SQL} AS has_phone,
                ${needsApto ? APTO_SQL : 'NULL::boolean'} AS apto
           FROM workers w WHERE ${whereSql}
       )
       SELECT b.id, b.registration, b.has_phone, b.apto, wsa.state, wsa.city
         FROM base b LEFT JOIN worker_service_areas wsa ON wsa.worker_id = b.id`,
      params,
    );

    const wanted = zoneFilter ? new Set(zoneFilter) : null;
    const zonesOf = new Map<string, Set<string>>();
    const attrs = new Map<string, string>();
    for (const row of r.rows) {
      const zone = resolveZoneKey(row.state, row.city).label;
      let set = zonesOf.get(row.id);
      if (!set) { set = new Set(); zonesOf.set(row.id, set); }
      set.add(zone);
      if (groupBy === 'registration') attrs.set(row.id, row.registration);
      else if (groupBy === 'has_phone') attrs.set(row.id, String(row.has_phone));
      else if (groupBy === 'apto') attrs.set(row.id, String(row.apto === true));
    }

    const inScope = [...zonesOf].filter(([, zs]) => !wanted || [...zs].some((z) => wanted.has(z)));
    const total = inScope.length;
    if (groupBy === null) return { total };

    const tally = new Map<string, Set<string>>();
    for (const [id, zs] of inScope) {
      const keys = groupBy === 'zone' ? [...zs].filter((z) => !wanted || wanted.has(z)) : [attrs.get(id)!];
      for (const k of keys) {
        let ids = tally.get(k);
        if (!ids) { ids = new Set(); tally.set(k, ids); }
        ids.add(id);
      }
    }
    const groups = [...tally]
      .map(([key, ids]) => ({ key, value: ids.size }))
      .sort((a, b) => b.value - a.value || a.key.localeCompare(b.key));
    return { total, groups };
  }
}
