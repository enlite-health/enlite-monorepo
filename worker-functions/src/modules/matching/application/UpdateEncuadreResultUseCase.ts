import { Pool } from 'pg';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import { EncuadreResultado, EncuadreRole, RejectionReasonCategory } from '../domain/Encuadre';

interface UpdateEncuadreResultInput {
  encuadreId: string;
  resultado: EncuadreResultado;
  rejectionReasonCategory?: RejectionReasonCategory | null;
  rejectionReason?: string | null;
  /** Papel do selecionado (TITULAR/RAPID_RESPONSE). COALESCE preserva o existente. */
  role?: EncuadreRole | null;
}

interface UpdateEncuadreResultOutput {
  success: boolean;
  encuadreId: string;
  resultado: EncuadreResultado;
}

export class UpdateEncuadreResultUseCase {
  private db: Pool;

  constructor() {
    this.db = DatabaseConnection.getInstance().getPool();
  }

  async execute(input: UpdateEncuadreResultInput): Promise<UpdateEncuadreResultOutput> {
    const { encuadreId, resultado, rejectionReasonCategory, rejectionReason, role } = input;

    const updateResult = await this.db.query(
      `UPDATE encuadres
       SET resultado = $2,
           rejection_reason_category = $3,
           rejection_reason = COALESCE($4, rejection_reason),
           role = COALESCE($5, role),
           updated_at = NOW()
       WHERE id = $1
       RETURNING worker_id, job_posting_id`,
      [encuadreId, resultado, rejectionReasonCategory ?? null, rejectionReason ?? null, role ?? null]
    );

    if (updateResult.rowCount === 0) {
      throw new Error(`Encuadre ${encuadreId} not found`);
    }

    const { worker_id: workerId } = updateResult.rows[0];

    // Recalculate avg_quality_rating from worker_placement_audits
    if (workerId) {
      await this.db.query(
        `UPDATE workers
         SET avg_quality_rating = (
           SELECT ROUND(AVG(rating)::numeric, 2)
           FROM worker_placement_audits
           WHERE worker_id = $1 AND rating IS NOT NULL
         ),
         updated_at = NOW()
         WHERE id = $1`,
        [workerId]
      );
    }

    return { success: true, encuadreId, resultado };
  }
}
