import { Pool } from 'pg';
import { logger } from '@shared/logging';

export interface NoShowResult {
  marked: number;
  stageMovedToInDoubt: number;
  /** Quantos SERIAM marcados se a automação estivesse ligada (modo observação). */
  wouldMark?: number;
}

/**
 * MarkNoShowUseCase — transição de no-show em entrevistas.
 *
 * Regra:
 *   WJA com interview_datetime < NOW() - 30min E interview_response = 'pending'
 *   → interview_response = 'no_response'
 *   → se application_funnel_stage = 'CONFIRMED' → mover para 'IN_DOUBT'
 *
 * Idempotente: já-no_response são pulados pela query (WHERE interview_response = 'pending').
 * Só mexe no stage se ainda é CONFIRMED — outros estágios são intocados.
 *
 * ⚠️ DESLIGADO POR PADRÃO (`NO_SHOW_AUTO_ENABLED`, decisão D3 de `captura-data-entrevista`).
 * Este caso de uso nunca encontrou nada em produção porque `interview_datetime` jamais foi
 * preenchido (0 de 13.046 candidaturas, verificado 30/07/2026). Quando a captura da data entrar,
 * ele passaria a achar de uma vez as **74 candidaturas** paradas em `interview_response='pending'`
 * e moveria os cards sozinho — a recrutadora veria card sair de "Agendados" sem ninguém tocar.
 * Com a flag desligada ele apenas CONTA quantos moveria (`wouldMark`), para o dono do produto
 * decidir a virada vendo o número.
 */
export class MarkNoShowUseCase {
  constructor(private readonly db: Pool) {}

  /** Automação de falta habilitada? Default: NÃO (só liga com decisão explícita). */
  private isEnabled(): boolean {
    return process.env.NO_SHOW_AUTO_ENABLED === 'true';
  }

  async execute(): Promise<NoShowResult> {
    // Busca WJAs vencidas com interview_response ainda 'pending'
    const selectResult = await this.db.query<{
      worker_id: string;
      job_posting_id: string;
      application_funnel_stage: string;
    }>(
      `SELECT worker_id, job_posting_id, application_funnel_stage
       FROM worker_job_applications
       WHERE interview_response = 'pending'
         AND interview_datetime IS NOT NULL
         AND interview_datetime < NOW() - INTERVAL '30 minutes'`,
    );

    if (selectResult.rows.length === 0) {
      // wouldMark presente também no vazio: quem monitora a virada da flag precisa
      // distinguir "0 candidatas a marcar" (wouldMark: 0) de "flag já ligada" (ausente).
      return this.isEnabled()
        ? { marked: 0, stageMovedToInDoubt: 0 }
        : { marked: 0, stageMovedToInDoubt: 0, wouldMark: 0 };
    }

    // Modo observação: não toca em nada, só reporta o tamanho do efeito.
    if (!this.isEnabled()) {
      const wouldMoveStage = selectResult.rows.filter(
        (r) => r.application_funnel_stage === 'CONFIRMED',
      ).length;
      logger.info(
        { wouldMark: selectResult.rows.length, wouldMoveStage, enabled: false },
        'MarkNoShowUseCase: DESLIGADO (NO_SHOW_AUTO_ENABLED) — nenhum card movido',
      );
      return { marked: 0, stageMovedToInDoubt: 0, wouldMark: selectResult.rows.length };
    }

    let marked = 0;
    let stageMovedToInDoubt = 0;

    for (const row of selectResult.rows) {
      const shouldMoveStage = row.application_funnel_stage === 'CONFIRMED';

      await this.db.query(
        `UPDATE worker_job_applications
         SET interview_response = 'no_response',
             updated_at = NOW()
             ${shouldMoveStage ? ", application_funnel_stage = 'IN_DOUBT'" : ''}
         WHERE worker_id = $1
           AND job_posting_id = $2
           AND interview_response = 'pending'`,
        [row.worker_id, row.job_posting_id],
      );

      marked += 1;
      if (shouldMoveStage) stageMovedToInDoubt += 1;
    }

    logger.info(
      { marked, stageMovedToInDoubt },
      'MarkNoShowUseCase: no-shows processados',
    );

    return { marked, stageMovedToInDoubt };
  }
}
