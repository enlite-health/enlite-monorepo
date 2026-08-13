import type { Pool } from 'pg';
import {
  classifyArmedCase,
  REQUIRED_SUBSTITUTES,
  type ArmedCaseBucket,
} from '../domain/armedCases';
import {
  computeScheduleWeeklyHours,
  hasStructuredSchedule,
} from '../domain/scheduleHours';
import { LIVE_JOB_POSTING_SQL } from '../domain/openJobStatuses';

/** Linha por job_posting (não-draft, não deletado) com contagens de seleção. */
interface JobPostingArmedRow {
  id: string;
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
  /**
   * % de grupo de resposta rápida armado (call 22/07, linha 1 dos números clave).
   * num = casos MEDÍVEIS com substitutos ≥ REQUIRED_SUBSTITUTES; den = ARMADA+POR_ARMAR;
   * excluidos = SEM_CONFIG + PENDENTE_CLASSIFICACAO (não dá para julgar → fora do
   * denominador, mas visíveis — percentual sem partes é chute).
   */
  respostaRapida: { num: number; den: number; excluidos: number };
  /**
   * job_postings.id dos casos ARMADA — consumido pelo card "Em Busca" do dashboard
   * (paciente com vaga viva NÃO-armada). Vazio hoje (ARMADA=0 por falta de papel).
   */
  armadaCaseIds: string[];
}

/**
 * Agrega a métrica "Equipe Armada" + horas do dashboard de gestão.
 *
 * READ-ONLY: uma única query (COUNT/FILTER sobre encuadres + job_postings).
 * Toda a classificação (buckets, cast defensivo, horas) é delegada às funções
 * puras de domínio (`armedCases.ts` / `scheduleHours.ts`), testadas isoladamente.
 * Nunca toca colunas *_encrypted (zero PII).
 *
 * ESCOPO = VAGA VIVA (30/07/2026). Antes o filtro era só `is_draft`/`deleted_at`, sem
 * olhar o status — então vaga FECHADA e SUSPENSA entrava na conta. Efeito medido em
 * produção: "Equipos por armar" mostrava **134** com **50 vagas mortas** dentro (fila real
 * 84), e "casos sem classificação" mostrava **135** com **78 mortas** (real 57). Estes
 * números são FILA DE TRABALHO — caso fechado não é trabalho a fazer, e as horas dele não
 * são demanda a cobrir. Mesmo recorte do funil por prestador (decisão do Diego, 30/07).
 */
export class GetArmedCasesUseCase {
  constructor(private readonly db: Pool) {}

  async execute(): Promise<ArmedCasesResult> {
    const { rows } = await this.db.query<JobPostingArmedRow>(
      `SELECT
         jp.id,
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
       WHERE ${LIVE_JOB_POSTING_SQL}`,
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
    let respostaRapidaArmada = 0;
    const armadaCaseIds: string[] = [];

    for (const row of rows) {
      const bucket = classifyArmedCase({
        providersNeeded: row.providers_needed,
        selectedTotal: row.sel_total,
        selectedWithRole: row.sel_with_role,
        selecTitular: row.sel_titular,
        selecSubstituto: row.sel_substituto,
      });
      buckets[bucket] += 1;
      if (bucket === 'ARMADA') armadaCaseIds.push(row.id);

      // RR armado é julgamento sobre casos MEDÍVEIS (mesmo denominador do bucket).
      if (
        (bucket === 'ARMADA' || bucket === 'POR_ARMAR') &&
        row.sel_substituto >= REQUIRED_SUBSTITUTES
      ) {
        respostaRapidaArmada += 1;
      }

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
      respostaRapida: {
        num: respostaRapidaArmada,
        den: buckets.ARMADA + buckets.POR_ARMAR,
        excluidos: buckets.SEM_CONFIG + buckets.PENDENTE_CLASSIFICACAO,
      },
      armadaCaseIds,
    };
  }
}

/** Arredonda a 1 casa para evitar ruído de ponto flutuante (ex.: 7.4999). */
function round1(value: number): number {
  return Math.round(value * 10) / 10;
}
