import type { Pool } from 'pg';
import {
  classifyArmedCase,
  type ArmedCaseBucket,
} from '../domain/armedCases';
import {
  computeScheduleWeeklyHours,
  hasStructuredSchedule,
} from '../domain/scheduleHours';

/** Linha por job_posting (não-draft, não deletado) com contagens de seleção. */
interface JobPostingArmedRow {
  providers_needed: string | null;
  schedule: unknown;
  sel_total: number;
  sel_with_role: number;
  sel_titular: number;
  sel_substituto: number;
}

export interface ArmedCasesResult {
  /** Casos com equipe completa (titulares + substitutos suficientes). */
  armados: number;
  /** Casos classificáveis ainda sem equipe completa. */
  porArmar: number;
  /** providers_needed não-numérico/NULL — não dá pra julgar. */
  semConfig: number;
  /** Selecionados sem papel setado (rollout) — não dá pra julgar armada. */
  pendenteClasificacao: number;
  /** Soma das horas/semana dos casos ativos com schedule estruturado. */
  horasTotais: number;
  /** Horas/semana ainda descobertas (soma dos casos POR_ARMAR). */
  horasAPreencher: number;
  /** Quantos casos ativos têm schedule estruturado. */
  coberturaConSchedule: number;
  /** Quantos casos ativos NÃO têm schedule estruturado. */
  coberturaSinSchedule: number;
}

/**
 * Agrega a métrica "Equipe Armada" + horas do dashboard de gestão.
 *
 * READ-ONLY: uma única query (COUNT/FILTER sobre encuadres + job_postings).
 * Toda a classificação (buckets, cast defensivo, horas) é delegada às funções
 * puras de domínio (`armedCases.ts` / `scheduleHours.ts`), testadas isoladamente.
 * Nunca toca colunas *_encrypted (zero PII).
 */
export class GetArmedCasesUseCase {
  constructor(private readonly db: Pool) {}

  async execute(): Promise<ArmedCasesResult> {
    const { rows } = await this.db.query<JobPostingArmedRow>(
      `SELECT
         jp.providers_needed,
         jp.schedule,
         COALESCE(s.sel_total, 0)::int      AS sel_total,
         COALESCE(s.sel_with_role, 0)::int  AS sel_with_role,
         COALESCE(s.sel_titular, 0)::int    AS sel_titular,
         COALESCE(s.sel_substituto, 0)::int AS sel_substituto
       FROM job_postings jp
       LEFT JOIN (
         SELECT
           job_posting_id,
           COUNT(*) FILTER (WHERE resultado = 'SELECCIONADO')                          AS sel_total,
           COUNT(*) FILTER (WHERE resultado = 'SELECCIONADO' AND role IS NOT NULL)      AS sel_with_role,
           COUNT(DISTINCT worker_id) FILTER (WHERE resultado = 'SELECCIONADO' AND role = 'TITULAR')        AS sel_titular,
           COUNT(DISTINCT worker_id) FILTER (WHERE resultado = 'SELECCIONADO' AND role = 'RAPID_RESPONSE') AS sel_substituto
         FROM encuadres
         WHERE job_posting_id IS NOT NULL
         GROUP BY job_posting_id
       ) s ON s.job_posting_id = jp.id
       WHERE jp.is_draft = false AND jp.deleted_at IS NULL`,
    );

    const buckets: Record<ArmedCaseBucket, number> = {
      ARMADA: 0,
      POR_ARMAR: 0,
      SEM_CONFIG: 0,
      PENDENTE_CLASSIFICACAO: 0,
    };
    let horasTotais = 0;
    let horasAPreencher = 0;
    let coberturaConSchedule = 0;
    let coberturaSinSchedule = 0;

    for (const row of rows) {
      const bucket = classifyArmedCase({
        providersNeeded: row.providers_needed,
        selectedTotal: row.sel_total,
        selectedWithRole: row.sel_with_role,
        selecTitular: row.sel_titular,
        selecSubstituto: row.sel_substituto,
      });
      buckets[bucket] += 1;

      const hours = computeScheduleWeeklyHours(row.schedule);
      horasTotais += hours;
      if (bucket === 'POR_ARMAR') horasAPreencher += hours;

      if (hasStructuredSchedule(row.schedule)) coberturaConSchedule += 1;
      else coberturaSinSchedule += 1;
    }

    return {
      armados: buckets.ARMADA,
      porArmar: buckets.POR_ARMAR,
      semConfig: buckets.SEM_CONFIG,
      pendenteClasificacao: buckets.PENDENTE_CLASSIFICACAO,
      horasTotais: round1(horasTotais),
      horasAPreencher: round1(horasAPreencher),
      coberturaConSchedule,
      coberturaSinSchedule,
    };
  }
}

/** Arredonda a 1 casa para evitar ruído de ponto flutuante (ex.: 7.4999). */
function round1(value: number): number {
  return Math.round(value * 10) / 10;
}
