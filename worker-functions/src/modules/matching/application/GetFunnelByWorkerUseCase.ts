import type { Pool } from 'pg';
import {
  deriveKanbanColumn,
  isMatchedNotInvited,
  mostAdvancedColumn,
  FUNNEL_COLUMNS,
  type KanbanColumn,
} from '../domain/kanbanColumn';
import { LIVE_JOB_POSTING_SQL } from '../domain/openJobStatuses';
import { excludeDisabledWorkersSql } from '@shared/database/activeWorkerFilter';
import { countryPredicateSql } from '@shared/database/countryScopeSql';
import { COUNTRY_CODES, type CountryCode } from '@shared/domain/countryCodes';

/** Contagem por coluna do Kanban — as MESMAS colunas que o operador vê no board. */
export type FunnelColumnCounts = Record<Exclude<KanbanColumn, 'BLOQUEADO'>, number>;

export interface FunnelByWorkerResult {
  /** Prestadores DISTINTOS no recorte (nunca a soma de cards). */
  total: number;
  /**
   * Prestadores distintos em CADA coluna. Um prestador em duas colunas (rejeitado
   * na vaga A, em progresso na vaga B) conta nas duas → NÃO soma com `total`.
   */
  porEtapa: FunnelColumnCounts;
  /**
   * Cada prestador UMA vez, na coluna mais avançada em que está. Soma == `total`.
   */
  consolidado: FunnelColumnCounts;
}

/** Linha em grão de candidatura — nunca pré-agregada em SQL (ver docstring da classe). */
interface FunnelRow {
  worker_id: string;
  stage: string | null;
  source: string | null;
  messaged_at: Date | null;
}

/**
 * Funil do "Dashboard para Gestão à Vista" contado por PRESTADOR, não por card.
 *
 * Pedido do Diego (30/07/2026): "os números precisam ser por unidade de Profissionais
 * e não soma de cards — o profissional que está em 10 vagas aparece acumulado".
 * Em prod a distorção chega a 2,9× (IN_PROGRESS: 5.194 cards → 2.964 pessoas).
 *
 * Duas vistas, porque respondem perguntas diferentes e o mercado publica as duas
 * (Greenhouse: "Current pipeline per job" × "Pipeline history", esta última
 * documentando explicitamente que os totais não somam):
 *   - porEtapa    → "quantas pessoas tenho para entrevistar" (não soma)
 *   - consolidado → "de N pessoas, quantas faltam contatar"  (soma == total)
 *
 * READ-ONLY. Uma query em grão de candidatura; a classificação em coluna e a
 * deduplicação acontecem em JS reusando `deriveKanbanColumn` — o MESMO SSOT que o
 * Kanban usa. Replicar esse CASE em SQL foi exatamente o defeito que este caso de
 * uso conserta: o painel lia a etapa crua e divergia do board (coluna "Completos"
 * = 2.541 cards no Kanban × "4" no painel). Convenção de agregar em JS já
 * estabelecida por GetZoneAnalyticsUseCase. Nunca toca colunas *_encrypted.
 *
 * Recorte: só vaga viva (não apagada, não rascunho, em busca), prestador não
 * mergeado, e fora o candidato de matching que nunca recebeu mensagem — o mesmo
 * `isMatchedNotInvited` que o Kanban já aplica. ~4,6k linhas hoje.
 */
export class GetFunnelByWorkerUseCase {
  constructor(private readonly db: Pool) {}

  /**
   * @param periodDays filtro opcional por ENTRADA no funil (`wja.created_at` nos
   *   últimos N dias) — acordo da call 22/07 (02:13, "o filtro por período vai
   *   resolver boa parte da discussão"). É data de CRIAÇÃO da candidatura, não de
   *   movimentação (não existe timestamp de transição por etapa — limitação
   *   documentada em docs/gestao-a-vista/13). Ausente = tudo, comportamento de sempre.
   * @param countries países que a agregação deve enxergar (PR-9, FR-732).
   *   Default = os dois países — o predicado continua na query mesmo assim.
   */
  async execute(
    periodDays?: number,
    countries: CountryCode[] = [...COUNTRY_CODES],
  ): Promise<FunnelByWorkerResult> {
    const countryParamIndex = periodDays != null ? 2 : 1;
    const periodSql =
      periodDays != null ? 'AND wja.created_at >= NOW() - make_interval(days => $1)' : '';
    const params = periodDays != null ? [periodDays, countries] : [countries];
    const { rows } = await this.db.query<FunnelRow>(
      `SELECT wja.worker_id,
              wja.application_funnel_stage AS stage,
              wja.source,
              wja.messaged_at
         FROM worker_job_applications wja
         JOIN job_postings jp ON jp.id = wja.job_posting_id
         JOIN workers      w  ON w.id  = wja.worker_id
        WHERE ${LIVE_JOB_POSTING_SQL}
          AND w.merged_into_id IS NULL
          AND ${excludeDisabledWorkersSql('w')}
          AND ${countryPredicateSql('w', countryParamIndex)}
          ${periodSql}`,
      params,
    );

    // Sets de worker_id (não contadores): o mesmo prestador em N vagas da MESMA
    // coluna precisa contar 1 — é o bug que estamos consertando.
    const workersPorColuna = new Map<KanbanColumn, Set<string>>();
    // Coluna mais avançada de cada prestador, para a vista consolidada.
    const colunaDoWorker = new Map<string, KanbanColumn>();

    for (const row of rows) {
      // Candidato de match salvo pelo algoritmo e nunca mensageado não é convite.
      if (isMatchedNotInvited(row.stage, row.source, row.messaged_at)) continue;

      const column = deriveKanbanColumn(row.stage, row.source);

      let bucket = workersPorColuna.get(column);
      if (!bucket) {
        bucket = new Set<string>();
        workersPorColuna.set(column, bucket);
      }
      bucket.add(row.worker_id);

      const atual = colunaDoWorker.get(row.worker_id);
      colunaDoWorker.set(
        row.worker_id,
        atual ? mostAdvancedColumn(atual, column) : column,
      );
    }

    const porEtapa = emptyCounts();
    for (const [column, workers] of workersPorColuna) {
      porEtapa[column as keyof FunnelColumnCounts] = workers.size;
    }

    const consolidado = emptyCounts();
    for (const column of colunaDoWorker.values()) {
      consolidado[column as keyof FunnelColumnCounts] += 1;
    }

    return { total: colunaDoWorker.size, porEtapa, consolidado };
  }
}

/** Zero em TODAS as colunas — coluna sem ninguém aparece como 0, nunca ausente. */
function emptyCounts(): FunnelColumnCounts {
  const counts = {} as FunnelColumnCounts;
  for (const column of FUNNEL_COLUMNS) {
    counts[column as keyof FunnelColumnCounts] = 0;
  }
  return counts;
}
