import { Pool } from 'pg';
import type { IJobPostingLookup } from '../application/ProcessTalentumPrescreening';

const TAG = '[JobPostingLookup]';

/**
 * Implementação única da porta `IJobPostingLookup` (webhook Talentum PRESCREENING_RESPONSE).
 * Só enxerga vaga OFICIAL viva: `deleted_at IS NULL` sempre; o fallback por título ainda
 * exige `is_draft = false`.
 */
export class JobPostingLookup implements IJobPostingLookup {
  constructor(private readonly pool: Pool) {}

  /** `prescreeningId` = `data.prescreening.id` do webhook (NÃO é o `talentum_project_id`; medido: divergem em 98%). */
  async findByTalentumPrescreeningId(prescreeningId: string): Promise<{ id: string } | null> {
    const result = await this.pool.query<{ id: string }>(
      `SELECT id FROM job_postings
        WHERE talentum_prescreening_id = $1 AND is_draft = false AND deleted_at IS NULL`,
      [prescreeningId],
    );
    return result.rows[0] ?? null;
  }

  /**
   * Fallback por título: resolve só com EXATAMENTE 1 candidata oficial (não-rascunho, viva).
   * 0 ou >1 → null (nunca LIMIT 1 cego). Log só com a contagem — sem título/PII.
   */
  async findByTitleILike(name: string): Promise<{ id: string } | null> {
    const result = await this.pool.query<{ id: string }>(
      `SELECT id FROM job_postings
        WHERE title ILIKE $1 AND is_draft = false AND deleted_at IS NULL
        LIMIT 2`,
      [`%${name}%`],
    );
    if (result.rows.length > 1) {
      console.log(`${TAG} findByTitleILike → ambíguo (>1 vaga oficial); não resolve`);
      return null;
    }
    return result.rows[0] ?? null;
  }
}
