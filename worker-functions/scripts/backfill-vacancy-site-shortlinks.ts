#!/usr/bin/env ts-node
/**
 * backfill-vacancy-site-shortlinks.ts
 *
 * One-shot backfill: generates Short.io 'site' links for all public-status
 * vacancies (ACTIVE | SEARCHING | SEARCHING_REPLACEMENT | RAPID_RESPONSE)
 * that are not soft-deleted and do not yet have a social_short_links.site entry.
 *
 * Pre-conditions:
 *   1. SHORT_IO_API_KEY and SHORT_IO_DOMAIN set in environment.
 *   2. DATABASE_URL set (required in --live mode).
 *
 * Usage:
 *   set -a && source worker-functions/.env && set +a
 *   cd worker-functions
 *
 *   # Preview (default):
 *   npx ts-node -r tsconfig-paths/register scripts/backfill-vacancy-site-shortlinks.ts --dry-run
 *
 *   # Run for real:
 *   npx ts-node -r tsconfig-paths/register scripts/backfill-vacancy-site-shortlinks.ts --live
 *
 *   # Limit to N vacancies:
 *   npx ts-node -r tsconfig-paths/register scripts/backfill-vacancy-site-shortlinks.ts --live --limit 10
 *
 * Flags:
 *   --dry-run   (default) logs what would happen; no Short.io calls, no DB writes
 *   --live      persist — calls Short.io and saves links to DB
 *   --limit N   process only the first N matching vacancies (default: all)
 */

/* eslint-disable no-console */

import { Pool } from 'pg';
import { ShortLinkService } from '../src/modules/matching/infrastructure/shortlinks/ShortLinkService';
import { EnsureVacancyShortLinkUseCase } from '../src/modules/matching/application/EnsureVacancyShortLinkUseCase';

// ── Constants ──────────────────────────────────────────────────────────────────

const SCRIPT_TAG = '[backfill-vacancy-site-shortlinks]';

const PUBLIC_STATUSES = ['ACTIVE', 'SEARCHING', 'SEARCHING_REPLACEMENT', 'RAPID_RESPONSE'];

// ── Arg parsing ───────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);

function hasFlag(name: string): boolean {
  return argv.includes(name);
}

function flagValue(name: string): string | null {
  const idx = argv.indexOf(name);
  if (idx === -1) return null;
  return argv[idx + 1] ?? null;
}

// Default is dry-run; pass --live to actually write
let isDryRun = true;
if (hasFlag('--live')) isDryRun = false;
const dryRunFlag = argv.find(a => a.startsWith('--dry-run='));
if (dryRunFlag) {
  isDryRun = dryRunFlag.split('=')[1] !== 'false';
}

const limitRaw = flagValue('--limit');
const limit = limitRaw !== null ? parseInt(limitRaw, 10) : null;

// ── Env validation ─────────────────────────────────────────────────────────────

const DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

if (!isDryRun && !process.env.DATABASE_URL) {
  console.error(`${SCRIPT_TAG} ERROR: DATABASE_URL is required in --live mode.`);
  process.exit(1);
}

// ── Vacancy row type ───────────────────────────────────────────────────────────

interface VacancyRow {
  id: string;
  case_number: number;
  vacancy_number: number;
  title: string;
  status: string;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const modeStr  = isDryRun ? 'dry-run=true' : 'live (DB writes enabled)';
  const limitStr = limit !== null ? `limit=${limit}` : 'no limit';
  console.log(`${SCRIPT_TAG} Starting. Mode: ${modeStr}, ${limitStr}`);

  // Short.io service — only required in live mode
  let shortLinkService: ShortLinkService | null = null;
  if (!isDryRun) {
    shortLinkService = ShortLinkService.fromEnv();
    if (!shortLinkService) {
      console.error(
        `${SCRIPT_TAG} ERROR: SHORT_IO_API_KEY and SHORT_IO_DOMAIN must be set in --live mode.`,
      );
      process.exit(1);
    }
  }

  const pool = new Pool({ connectionString: DATABASE_URL });

  try {
    // Query vacancies missing site link
    const statusPlaceholders = PUBLIC_STATUSES.map((_, i) => `$${i + 1}`).join(',');
    const { rows: allRows } = await pool.query<VacancyRow>(
      `SELECT id, case_number, vacancy_number, title, status
       FROM job_postings
       WHERE status IN (${statusPlaceholders})
         AND deleted_at IS NULL
         AND NOT (social_short_links ? 'site')
       ORDER BY case_number DESC, vacancy_number DESC`,
      PUBLIC_STATUSES,
    );

    const rows = limit !== null ? allRows.slice(0, limit) : allRows;

    if (rows.length === 0) {
      console.log(`${SCRIPT_TAG} No vacancies need backfill. All done.`);
      return;
    }

    console.log(
      `${SCRIPT_TAG} Found ${allRows.length} vacancies missing site link.` +
      (limit !== null ? ` Processing first ${rows.length} (limit=${limit}).` : '') +
      (isDryRun ? ' DRY-RUN — no links will be created.' : ''),
    );

    let success = 0;
    let skipped = 0;
    let failed  = 0;

    const useCase = !isDryRun && shortLinkService
      ? new EnsureVacancyShortLinkUseCase(pool, shortLinkService)
      : null;

    for (const row of rows) {
      const label = `${row.title} (id=${row.id}, status=${row.status})`;

      if (isDryRun) {
        console.log(`${SCRIPT_TAG} [DRY-RUN] Would create site link for: ${label}`);
        success++;
        continue;
      }

      try {
        const result = await useCase!.execute(row.id, 'site');
        if (result.alreadyExisted) {
          console.log(`${SCRIPT_TAG} SKIP (already exists): ${label}`);
          skipped++;
        } else {
          console.log(`${SCRIPT_TAG} OK: ${label} → ${result.shortURL}`);
          success++;
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`${SCRIPT_TAG} ERROR for ${label}: ${message}`);
        failed++;
      }
    }

    console.log('\nSummary:');
    console.log(`  Total matching vacancies: ${allRows.length}`);
    if (limit !== null) {
      console.log(`  Limit applied:            ${limit}`);
    }
    if (isDryRun) {
      console.log(`  Would process:            ${success}`);
      console.log(`  Mode:                     DRY-RUN (no DB writes)`);
    } else {
      console.log(`  Created:                  ${success}`);
      console.log(`  Already existed (skip):   ${skipped}`);
      console.log(`  Errors:                   ${failed}`);
      console.log(`  Mode:                     LIVE (DB writes committed)`);
    }
  } finally {
    await pool.end();
  }
}

main().catch(err => {
  console.error(`${SCRIPT_TAG} Fatal error:`, err);
  process.exit(1);
});
