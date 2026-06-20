import { Pool } from 'pg';
import { ShortLinkService } from '../infrastructure/shortlinks/ShortLinkService';

interface StoredLink {
  url: string;
  id: string;
}

export interface PurgeVacancyShortLinksResult {
  /** Links successfully deleted from Short.io and removed from the DB. */
  deleted: number;
  /** Links whose Short.io deletion failed — kept in the DB for retry. */
  failed: number;
  /** Legacy string-format links with no Short.io id — kept (cannot be deleted via API). */
  skipped: number;
}

/**
 * PurgeVacancyShortLinksUseCase
 *
 * Deletes every Short.io short link stored for a vacancy to free account quota,
 * then prunes the deleted entries from job_postings.social_short_links.
 *
 * Used when a vacancy becomes inactive (CLOSED / SUSPENDED / soft-deleted) and by
 * the one-shot cleanup script. Does NOT filter by deleted_at, so it works after a
 * soft-delete. Idempotent: re-running on an already-purged vacancy is a no-op.
 */
export class PurgeVacancyShortLinksUseCase {
  constructor(
    private readonly pool: Pool,
    private readonly shortLinkService: ShortLinkService,
  ) {}

  async execute(vacancyId: string): Promise<PurgeVacancyShortLinksResult> {
    const result = await this.pool.query<{
      social_short_links: Record<string, string | StoredLink>;
    }>(
      `SELECT COALESCE(social_short_links, '{}'::jsonb) AS social_short_links
       FROM job_postings
       WHERE id = $1`,
      [vacancyId],
    );

    if (result.rows.length === 0) throw new Error(`Vacancy ${vacancyId} not found`);

    const links = result.rows[0].social_short_links;
    const entries = Object.entries(links);
    if (entries.length === 0) return { deleted: 0, failed: 0, skipped: 0 };

    let deleted = 0;
    let failed = 0;
    let skipped = 0;
    const remaining: Record<string, string | StoredLink> = {};

    for (const [channel, val] of entries) {
      const id = typeof val === 'string' ? '' : val.id;
      if (!id) {
        // Legacy string link or missing id — cannot delete via API; keep it.
        remaining[channel] = val;
        skipped++;
        continue;
      }
      try {
        await this.shortLinkService.delete(id);
        deleted++;
      } catch {
        // Keep the entry so a later run can retry the Short.io deletion.
        remaining[channel] = val;
        failed++;
      }
    }

    await this.pool.query(
      `UPDATE job_postings SET social_short_links = $1::jsonb, updated_at = NOW() WHERE id = $2`,
      [JSON.stringify(remaining), vacancyId],
    );

    return { deleted, failed, skipped };
  }
}
