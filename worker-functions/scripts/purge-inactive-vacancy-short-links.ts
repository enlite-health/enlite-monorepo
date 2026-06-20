/**
 * purge-inactive-vacancy-short-links.ts
 *
 * One-shot cleanup: deletes Short.io short links stored on inactive vacancies
 * (status CLOSED or SUSPENDED) to free Short.io account quota, and prunes the
 * deleted entries from job_postings.social_short_links.
 *
 * Usage:
 *   SHORT_IO_API_KEY=... SHORT_IO_DOMAIN=go.enlite.health \
 *   DATABASE_URL=... npx tsx scripts/purge-inactive-vacancy-short-links.ts [--dry-run]
 *
 * Against production, point DATABASE_URL at the Cloud SQL proxy (see CLAUDE.md).
 * Idempotent — safe to re-run; already-purged vacancies are skipped.
 */
import { Pool } from 'pg';
import { ShortLinkService } from '../src/modules/matching/infrastructure/shortlinks/ShortLinkService';
import { PurgeVacancyShortLinksUseCase } from '../src/modules/matching/application/PurgeVacancyShortLinksUseCase';

const isDryRun = process.argv.includes('--dry-run');

const DATABASE_URL =
  process.env.DATABASE_URL ||
  'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

const TARGET_STATUSES = ['CLOSED', 'SUSPENDED'];

interface VacancyRow {
  id: string;
  case_number: number | null;
  vacancy_number: number;
  status: string;
  link_count: number;
}

async function main(): Promise<void> {
  const shortLinkService = ShortLinkService.fromEnv();
  if (!shortLinkService) {
    console.error('[purge] ERROR: SHORT_IO_API_KEY and SHORT_IO_DOMAIN must be set');
    process.exit(1);
  }

  const pool = new Pool({ connectionString: DATABASE_URL });

  try {
    const { rows } = await pool.query<VacancyRow>(
      `SELECT id, case_number, vacancy_number, status,
              (SELECT COUNT(*) FROM jsonb_object_keys(social_short_links))::int AS link_count
       FROM job_postings
       WHERE status = ANY($1)
         AND social_short_links IS NOT NULL
         AND social_short_links <> '{}'::jsonb
       ORDER BY status, case_number`,
      [TARGET_STATUSES],
    );

    if (rows.length === 0) {
      console.log('[purge] No inactive vacancies with short links. Nothing to do.');
      return;
    }

    const totalLinks = rows.reduce((sum, r) => sum + r.link_count, 0);
    console.log(
      `[purge] Found ${rows.length} inactive vacancies holding ${totalLinks} links.${isDryRun ? ' (DRY RUN)' : ''}`,
    );

    const useCase = new PurgeVacancyShortLinksUseCase(pool, shortLinkService);

    let deleted = 0;
    let failed = 0;

    for (const row of rows) {
      const label = `caso${row.case_number}-${row.vacancy_number} [${row.status}] (${row.link_count} links)`;
      if (isDryRun) {
        console.log(`[purge] [DRY RUN] Would purge: ${label}`);
        continue;
      }
      try {
        const result = await useCase.execute(row.id);
        deleted += result.deleted;
        failed += result.failed;
        console.log(
          `[purge] OK: ${label} → deleted=${result.deleted} failed=${result.failed} skipped=${result.skipped}`,
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[purge] ERROR for ${label}: ${message}`);
        failed++;
      }
    }

    console.log(`[purge] Done. linksDeleted=${deleted}, linksFailed=${failed}`);
  } finally {
    await pool.end();
  }
}

main().catch(err => {
  console.error('[purge] Fatal error:', err);
  process.exit(1);
});
