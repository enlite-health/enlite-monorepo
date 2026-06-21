import { Pool } from 'pg';
import { logger } from '@shared/logging';

export interface NoShowResult {
  marked: number;
  stageMovedToInDoubt: number;
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
 */
export class MarkNoShowUseCase {
  constructor(private readonly db: Pool) {}

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
      return { marked: 0, stageMovedToInDoubt: 0 };
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
