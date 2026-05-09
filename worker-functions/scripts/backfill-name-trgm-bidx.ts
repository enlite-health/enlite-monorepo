/**
 * backfill-name-trgm-bidx.ts
 *
 * Backfill da coluna name_trgm_bidx em workers existentes.
 * Decripta first/last name via KMS, gera bidx via BlindIndexService, atualiza row.
 *
 * Uso:
 *   ts-node scripts/backfill-name-trgm-bidx.ts                 # produção
 *   ts-node scripts/backfill-name-trgm-bidx.ts --dry-run       # só conta, não atualiza
 *   ts-node scripts/backfill-name-trgm-bidx.ts --batch-size 25 # custom batch size
 *
 * Idempotente: workers já com name_trgm_bidx IS NOT NULL são pulados.
 * Workers com merged_into_id IS NOT NULL são pulados (índice GIN parcial os exclui).
 * Workers sem nome (ambos encrypted nulos) ficam com name_trgm_bidx = NULL.
 */

import { Pool } from 'pg';
import { KMSEncryptionService } from '../src/shared/security/KMSEncryptionService';
import { BlindIndexService } from '../src/shared/security/BlindIndexService';

// ── CLI parsing ────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);

if (args.includes('--help')) {
  console.log(`
Usage: ts-node scripts/backfill-name-trgm-bidx.ts [options]

Options:
  --dry-run          Count eligible workers and estimate cost without writing.
  --batch-size N     Workers per DB round-trip (default 50, max 200).
  --help             Print this message and exit.
  `);
  process.exit(0);
}

const dryRun = args.includes('--dry-run');

const batchSizeIdx = args.indexOf('--batch-size');
const rawBatchSize =
  batchSizeIdx !== -1 && args[batchSizeIdx + 1]
    ? parseInt(args[batchSizeIdx + 1], 10)
    : 50;

if (isNaN(rawBatchSize) || rawBatchSize < 1 || rawBatchSize > 200) {
  console.error('[backfill-name-trgm-bidx] --batch-size must be between 1 and 200');
  process.exit(1);
}

const BATCH_SIZE = rawBatchSize;

// ── DB setup ───────────────────────────────────────────────────────────────────

const DATABASE_URL =
  process.env.DATABASE_URL ||
  'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

// ── Types ──────────────────────────────────────────────────────────────────────

interface WorkerRow {
  id: string;
  first_name_encrypted: string | null;
  last_name_encrypted: string | null;
}

interface Summary {
  processed: number;
  updated: number;
  skipped: number;
  errors: number;
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const pool = new Pool({ connectionString: DATABASE_URL });
  const kms = new KMSEncryptionService();
  const bidxService = new BlindIndexService();

  const startMs = Date.now();

  console.log(
    `[backfill-name-trgm-bidx] mode=${dryRun ? 'DRY RUN' : 'EXECUTE'} batch-size=${BATCH_SIZE}`,
  );

  // ── Dry-run: count only ────────────────────────────────────────────────────

  if (dryRun) {
    const { rows } = await pool.query<{ total: string }>(
      `SELECT COUNT(*) AS total
         FROM workers
        WHERE name_trgm_bidx IS NULL
          AND merged_into_id IS NULL
          AND (first_name_encrypted IS NOT NULL OR last_name_encrypted IS NOT NULL)`,
    );
    const total = parseInt(rows[0].total, 10);
    const batches = Math.ceil(total / BATCH_SIZE);
    const kmsCallsEst = total * 2; // decrypt first + last per worker
    const estSeconds = batches * 1; // 1s sleep between batches

    console.log(`[backfill-name-trgm-bidx] eligible workers : ${total}`);
    console.log(`[backfill-name-trgm-bidx] batches          : ${batches}`);
    console.log(`[backfill-name-trgm-bidx] KMS calls (est.) : ${kmsCallsEst}`);
    console.log(`[backfill-name-trgm-bidx] time (est.)      : ~${estSeconds}s`);
    console.log('[backfill-name-trgm-bidx] [DRY RUN — nenhuma escrita realizada]');

    await pool.end();
    return;
  }

  // ── Execute ────────────────────────────────────────────────────────────────

  const summary: Summary = { processed: 0, updated: 0, skipped: 0, errors: 0 };
  let batchNum = 0;

  while (true) {
    const { rows } = await pool.query<WorkerRow>(
      `SELECT id, first_name_encrypted, last_name_encrypted
         FROM workers
        WHERE name_trgm_bidx IS NULL
          AND merged_into_id IS NULL
          AND (first_name_encrypted IS NOT NULL OR last_name_encrypted IS NOT NULL)
        ORDER BY created_at ASC
        LIMIT $1`,
      [BATCH_SIZE],
    );

    if (rows.length === 0) break;

    batchNum++;

    for (const row of rows) {
      summary.processed++;

      try {
        // Decrypt first + last in parallel (2 KMS calls per worker)
        const [firstName, lastName] = await Promise.all([
          kms.decrypt(row.first_name_encrypted),
          kms.decrypt(row.last_name_encrypted),
        ]);

        const bidxBuffers = await bidxService.generateNameTrigramBidx(firstName, lastName);
        const bidxLiteral = bidxService.serializeForPg(bidxBuffers);

        if (bidxLiteral === null) {
          // Both names decrypted to empty strings — skip to avoid NULL-loop.
          console.warn(
            `[backfill-name-trgm-bidx] WARN worker ${row.id}: empty after decrypt — skipping`,
          );
          summary.skipped++;
          continue;
        }

        await pool.query(
          `UPDATE workers SET name_trgm_bidx = $1::bytea[] WHERE id = $2`,
          [bidxLiteral, row.id],
        );

        const hexShort = bidxBuffers[0]?.toString('hex').slice(0, 8) ?? '(none)';
        console.log(
          `[backfill-name-trgm-bidx] [${summary.processed}] worker ${row.id}: ${hexShort}...`,
        );

        summary.updated++;
      } catch (err) {
        console.error(
          `[backfill-name-trgm-bidx] ERROR worker ${row.id}:`,
          err instanceof Error ? err.message : err,
        );
        summary.errors++;
      }
    }

    console.log(
      `[backfill-name-trgm-bidx] batch ${batchNum} done — ` +
        `updated=${summary.updated} skipped=${summary.skipped} errors=${summary.errors}`,
    );

    // KMS rate limit guard: 600 req/min default quota.
    // At batch=50 × 2 KMS calls = 100 calls + 1s sleep → well within quota.
    if (rows.length === BATCH_SIZE) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }

  const elapsedMs = Date.now() - startMs;
  const kmsCallsActual = summary.updated * 2; // only successful decrypts

  console.log('\n[backfill-name-trgm-bidx] ── SUMMARY ──────────────────────────────');
  console.log(`  processed : ${summary.processed}`);
  console.log(`  updated   : ${summary.updated}`);
  console.log(`  skipped   : ${summary.skipped}`);
  console.log(`  errors    : ${summary.errors}`);
  console.log(`  KMS calls : ~${kmsCallsActual}`);
  console.log(`  elapsed   : ${(elapsedMs / 1000).toFixed(1)}s`);

  await pool.end();

  if (summary.errors > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('[backfill-name-trgm-bidx] FATAL:', err);
  process.exit(1);
});
