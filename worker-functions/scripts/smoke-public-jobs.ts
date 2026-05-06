#!/usr/bin/env ts-node
/**
 * smoke-public-jobs.ts
 *
 * Standalone smoke test for GET /api/public/v1/jobs.
 * Validates HTTP status, JSON shape, status exclusivity, schema and detail_link.
 *
 * No app imports — uses only Node 18+ native fetch.
 *
 * Usage:
 *   cd worker-functions
 *
 *   # Local:
 *   PUBLIC_JOBS_URL=http://localhost:8080/api/public/v1/jobs \
 *     npx ts-node -r tsconfig-paths/register scripts/smoke-public-jobs.ts
 *
 *   # Staging / production:
 *   PUBLIC_JOBS_URL=https://worker-functions-byh3gvl5yq-tl.a.run.app/api/public/v1/jobs \
 *     npx ts-node -r tsconfig-paths/register scripts/smoke-public-jobs.ts
 *
 * Exit codes:
 *   0 — all hard checks passed (warnings may still be printed)
 *   1 — at least one hard check failed
 */

/* eslint-disable no-console */

// ── Config ────────────────────────────────────────────────────────────────────

const TAG = '[smoke-public-jobs]';

const TARGET_URL =
  process.env.PUBLIC_JOBS_URL ??
  'http://localhost:8080/api/public/v1/jobs';

const ALLOWED_STATUSES = new Set([
  'ACTIVE',
  'SEARCHING',
  'SEARCHING_REPLACEMENT',
  'RAPID_RESPONSE',
]);

const REQUIRED_KEYS = [
  'id',
  'case_number',
  'vacancy_number',
  'title',
  'status',
  'description',
  'service',
  'pathologies',
  'state',
  'city',
  'state_city',
  'worker_type',
  'worker_sex',
  'job_zone',
  'neighborhood',
  'detail_link',
];

// ── State ─────────────────────────────────────────────────────────────────────

let failures = 0;

function pass(msg: string): void {
  console.log(`${TAG} ${msg} ✓`);
}

function fail(msg: string): void {
  console.error(`${TAG} FAIL: ${msg}`);
  failures++;
}

function warn(msg: string): void {
  console.warn(`${TAG} WARN: ${msg}`);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log(`${TAG} URL: ${TARGET_URL}`);

  // 1. HTTP request
  let response: Response;
  try {
    response = await fetch(TARGET_URL);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    fail(`Network error — could not reach ${TARGET_URL}: ${message}`);
    process.exit(1);
  }

  // 2. HTTP 200
  if (response.status === 200) {
    pass(`HTTP ${response.status}`);
  } else {
    fail(`Expected HTTP 200, got ${response.status}`);
    process.exit(1);
  }

  // 3. Content-Type
  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) {
    pass(`Content-Type: ${contentType}`);
  } else {
    fail(`Content-Type does not include application/json — got: ${contentType}`);
  }

  // 4. Parse JSON (raw text first for diagnostics)
  const rawText = await response.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
    pass(`JSON parsed ✓ (${rawText.length} bytes)`);
  } catch (parseErr) {
    // Locate the invalid character position
    const msg = parseErr instanceof Error ? parseErr.message : String(parseErr);
    const posMatch = /position (\d+)/.exec(msg);
    if (posMatch) {
      const pos = parseInt(posMatch[1], 10);
      const snippet = rawText.slice(Math.max(0, pos - 20), pos + 20);
      fail(`JSON parse error at position ${pos}. Context: ...${snippet}...`);
    } else {
      fail(`JSON parse error: ${msg}`);
    }
    process.exit(1);
  }

  // 5. Shape: { success: true, data: Array }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('success' in parsed) ||
    !('data' in parsed)
  ) {
    fail('Response shape invalid — expected { success, data }');
    process.exit(1);
  }

  const body = parsed as { success: unknown; data: unknown };

  if (body.success !== true) {
    fail(`Expected success=true, got success=${JSON.stringify(body.success)}`);
  }

  if (!Array.isArray(body.data)) {
    fail('Expected data to be an Array');
    process.exit(1);
  }

  const jobs = body.data as Array<Record<string, unknown>>;
  pass(`JSON parsed ✓ (${jobs.length} jobs)`);

  // 6. Status distribution
  const distribution: Record<string, number> = {};
  for (const job of jobs) {
    const s = String(job.status ?? 'UNKNOWN');
    distribution[s] = (distribution[s] ?? 0) + 1;
  }

  console.log(`${TAG} Status distribution:`);
  for (const [status, count] of Object.entries(distribution).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${status}: ${count}`);
  }

  // 7. Status exclusivity
  const violators = jobs.filter(j => !ALLOWED_STATUSES.has(String(j.status ?? '')));
  if (violators.length === 0) {
    pass('Exclusivity ✓ (all statuses in allowed set)');
  } else {
    const badStatuses = violators.map(v => `${v.id ?? '?'} → ${v.status}`);
    fail(`Status exclusivity violated (${violators.length} jobs):\n  ${badStatuses.join('\n  ')}`);
  }

  // 8. Schema check — warn only (prod may be behind)
  const missingReport: string[] = [];
  for (const job of jobs) {
    const missing = REQUIRED_KEYS.filter(k => !(k in job));
    if (missing.length > 0) {
      missingReport.push(`  job ${job.id ?? '?'}: missing [${missing.join(', ')}]`);
    }
  }
  if (missingReport.length === 0) {
    pass('Schema check: all required keys present in every job');
  } else {
    warn(
      `Schema check: ${missingReport.length} job(s) have missing keys ` +
      '(prod may not have the latest deploy yet):\n' +
      missingReport.slice(0, 10).join('\n') +
      (missingReport.length > 10 ? `\n  ... and ${missingReport.length - 10} more` : ''),
    );
  }

  // 9. detail_link present in all jobs
  const missingDetailLink = jobs.filter(
    j => typeof j.detail_link !== 'string' || !String(j.detail_link).startsWith('http'),
  );
  if (missingDetailLink.length === 0) {
    pass('detail_link present in all jobs');
  } else {
    fail(
      `detail_link missing or invalid in ${missingDetailLink.length} job(s): ` +
      missingDetailLink.slice(0, 5).map(j => j.id ?? '?').join(', '),
    );
  }

  // ── Final verdict ────────────────────────────────────────────────────────────
  if (failures === 0) {
    console.log(`${TAG} PASS`);
    process.exit(0);
  } else {
    console.error(`${TAG} FAIL (${failures} hard check(s) failed)`);
    process.exit(1);
  }
}

main().catch(err => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`${TAG} Uncaught error: ${message}`);
  process.exit(1);
});
