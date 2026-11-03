import { Pool } from 'pg';
import type { IJobPostingLookup } from '../application/ProcessTalentumPrescreening';

const TAG = '[JobPostingLookup]';

/**
 * Implementação única da porta `IJobPostingLookup` (webhook Talentum PRESCREENING_RESPONSE).
 * Só enxerga vaga VIVA (`deleted_at IS NULL`); o fallback por título prefere a oficial e nunca escolhe às cegas.
 */
export class JobPostingLookup implements IJobPostingLookup {
  constructor(private readonly pool: Pool) {}

  /**
   * `prescreeningId` = `data.prescreening.id` do webhook (NÃO é o `talentum_project_id`; medido: divergem em 98%).
   * O `_id` é único entre vagas vivas (índice 558): quem o detém é a vaga do projeto, rascunho ou não.
   */
  async findByTalentumPrescreeningId(prescreeningId: string): Promise<{ id: string } | null> {
    const result = await this.pool.query<{ id: string }>(
      `SELECT id FROM job_postings WHERE talentum_prescreening_id = $1 AND deleted_at IS NULL`,
      [prescreeningId],
    );
    return result.rows[0] ?? null;
  }

  /**
   * Fallback por título (vivas, `deleted_at IS NULL`). Prefere a OFICIAL (`is_draft = false`): com 2+ oficiais → null
   * (ambíguo, nunca LIMIT 1 cego); sem oficial, resolve só se houver EXATAMENTE 1 candidata (vaga criada pelo sync/webhook
   * nasce `is_draft = true` por DEFAULT e segue sendo a única vaga do caso). Rascunho + oficial → a oficial.
   * Log só com a contagem — sem título/PII.
   */
  async findByTitleILike(name: string): Promise<{ id: string } | null> {
    const result = await this.pool.query<{ id: string; is_draft: boolean }>(
      `SELECT id, is_draft FROM job_postings
        WHERE title ILIKE $1 AND deleted_at IS NULL
        ORDER BY is_draft ASC
        LIMIT 2`,
      [`%${name}%`],
    );
    const [first, second] = result.rows;
    // 2 candidatas: só desempata quando a 1ª é oficial e a 2ª é rascunho (ORDER BY is_draft ASC põe oficial antes).
    if (second && !(first.is_draft === false && second.is_draft === true)) {
      console.log(`${TAG} findByTitleILike → ambíguo (>1 candidata sem desempate oficial); não resolve`);
      return null;
    }
    return first ? { id: first.id } : null;
  }
}
