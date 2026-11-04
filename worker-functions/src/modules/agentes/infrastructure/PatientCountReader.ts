/**
 * PatientCountReader — leitor de contagem de PACIENTES da Maria (change 085, spec §4.2, DD1/DD3).
 *
 * Devolve contagem CRUA (sem supressão de célula pequena: isso é da rota; grupos só com >0). SÓ-LEITURA; quem
 * chama abre o `withActorContext` e passa o client (RLS exige identidade na transação). Cada campo lê o dono:
 *   stage -> `patients.status` ('' = `(sin etapa)`) · incomplete_registration -> `patientIncompleteAdmissionSql`
 *   has_provider -> alocação ACTIVE vigente no itinerário (mesma definição de `VacancyAllocationProbe`, "hoje"
 *   por `fn_operation_date(p.country)`). Recorte padrão: não eliminado + país + sem baja (DISCHARGED), salvo se o
 *   filtro `stage` NOMEIA ALTA/DISCHARGED literalmente (atalho não abre). Sem filtro de `is_test` (DD1).
 */
import type { Pool } from 'pg';
import type { CountryCode } from '@shared/domain/countryCodes';
import { countryPredicateSql } from '@shared/database/countryScopeSql';
import { patientIncompleteAdmissionSql, ACTIVATABLE_STATUSES } from '@modules/case/domain/PatientCompleteness';
import { excludeDischargedSql } from '@modules/case/infrastructure/patientListScopeSql';

export type PatientCountDb = Pick<Pool, 'query'>;

export interface PatientCountRequest {
  filters: ReadonlyArray<{ field: string; values: readonly string[]; literalValues?: readonly string[] }>;
  group_by: string | null;
}

export interface PatientCountResult {
  total: number;
  groups?: Array<{ key: string; value: number }>;
  /** `incomplete_registration` só existe em admissão: o recorte foi restrito a ADMISSION/PENDING_ADMISSION. */
  restricted_to_admission?: true;
}

const NO_STAGE = '(sin etapa)';
const GROUPABLE = ['stage', 'incomplete_registration', 'has_provider'] as const;

const STAGE_SQL = `COALESCE(p.status, '')`;
const INCOMPLETE_SQL = patientIncompleteAdmissionSql('p');
// DD3: vigente = ACTIVE e (sem fim OU fim >= hoje do país do paciente). Nunca a data do servidor.
const HAS_PROVIDER_SQL = `EXISTS (
  SELECT 1
    FROM patient_contracted_services pcs
    JOIN patient_itinerary_slot s ON s.contracted_service_id = pcs.id
    JOIN patient_itinerary_assignment a ON a.slot_id = s.id
   WHERE pcs.patient_id = p.id
     AND a.status = 'ACTIVE'
     AND (a.valid_to IS NULL OR a.valid_to >= fn_operation_date(p.country))
)`;

/** Booleano do cardápio: ['true'], ['false'] ou ambos (= sem restrição). */
function boolPredicate(expr: string, values: readonly string[]): string | null {
  const wantTrue = values.includes('true');
  const wantFalse = values.includes('false');
  if (wantTrue === wantFalse) return null;
  return wantTrue ? expr : `NOT ${expr}`;
}

export class PatientCountReader {
  constructor(private readonly db: PatientCountDb) {}

  async count(request: PatientCountRequest, countries: CountryCode[]): Promise<PatientCountResult> {
    const find = (field: string) => request.filters.find((f) => f.field === field);
    const groupBy = request.group_by;
    if (groupBy !== null && !(GROUPABLE as readonly string[]).includes(groupBy)) {
      throw new Error(`group_by fora do cardápio de pacientes: ${groupBy}`);
    }

    const stage = find('stage');
    const incompleteFilter = find('incomplete_registration');
    const restricted = incompleteFilter !== undefined || groupBy === 'incomplete_registration';

    // Atalho NÃO abre a baja (F-db-16): só nomeação literal de ALTA/DISCHARGED.
    const opensDischarged = (stage?.literalValues ?? []).some((v) => v === 'ALTA' || v === 'DISCHARGED');
    const params: unknown[] = [countries, !opensDischarged];
    const where: string[] = ['p.deleted_at IS NULL', countryPredicateSql('p', 1), excludeDischargedSql(2)];

    // Estágios efetivos: filtro ∩ funil de admissão quando restrito.
    let stages: string[] | null = stage ? stage.values.map((v) => (v === NO_STAGE ? '' : v)) : null;
    if (restricted) {
      const funnel: readonly string[] = ACTIVATABLE_STATUSES;
      stages = stages ? stages.filter((v) => funnel.includes(v)) : [...funnel];
    }
    if (stages) {
      params.push(stages);
      where.push(`${STAGE_SQL} = ANY($${params.length}::text[])`);
    }

    const incomplete = boolPredicate(INCOMPLETE_SQL, incompleteFilter?.values ?? []);
    if (incomplete) where.push(incomplete);
    const provider = boolPredicate(HAS_PROVIDER_SQL, find('has_provider')?.values ?? []);
    if (provider) where.push(provider);
    const whereSql = where.join('\n      AND ');
    const flag = restricted ? { restricted_to_admission: true as const } : {};

    if (groupBy === null) {
      const r = await this.db.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM patients p WHERE ${whereSql}`, params);
      return { total: r.rows[0].n, ...flag };
    }
    const keyExpr = { stage: STAGE_SQL, incomplete_registration: INCOMPLETE_SQL, has_provider: HAS_PROVIDER_SQL }[groupBy]!;
    const r = await this.db.query<{ key: string | boolean; value: number }>(
      `SELECT ${keyExpr} AS key, COUNT(*)::int AS value
         FROM patients p WHERE ${whereSql}
        GROUP BY 1`,
      params,
    );
    const groups = r.rows
      .map((row) => ({ key: row.key === '' ? NO_STAGE : String(row.key), value: row.value }))
      .sort((a, b) => b.value - a.value || a.key.localeCompare(b.key));
    // grupo de campo escalar é partição: soma = total
    return { total: groups.reduce((s, g) => s + g.value, 0), groups, ...flag };
  }
}
