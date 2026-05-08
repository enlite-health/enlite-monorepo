#!/usr/bin/env ts-node
/**
 * smoke-test-clickup-webhook.ts
 *
 * Validação end-to-end do webhook ClickUp → patients sem depender do
 * ClickUp re-disparar. Simula payloads, assina HMAC, POSTa no endpoint,
 * valida no DB.
 *
 * ── Pre-requisitos ────────────────────────────────────────────────────────────
 *   - CLICKUP_API_TOKEN no env (validar task real no Test 1)
 *   - CLICKUP_WEBHOOK_SECRET no env (assinar HMAC) OU acesso ao Secret Manager (--target prod)
 *   - DATABASE_URL apontando pro DB correto (validar updated_at no Test 1)
 *   - Server worker-functions rodando (local: `npm start`; prod: Cloud Run online)
 *
 * ── Usage ─────────────────────────────────────────────────────────────────────
 *   # Local (assume server na :8080 + DB local)
 *   set -a && source .env && set +a
 *   export DATABASE_URL=postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e
 *   npx ts-node -r tsconfig-paths/register scripts/smoke-test-clickup-webhook.ts
 *
 *   # Custom task_id
 *   npx ts-node -r tsconfig-paths/register scripts/smoke-test-clickup-webhook.ts --task-id 86ahb3j7k
 *
 *   # Production (precisa Cloud SQL Proxy + autenticação gcloud)
 *   npx ts-node -r tsconfig-paths/register scripts/smoke-test-clickup-webhook.ts --target prod
 *
 *   # Ver opções
 *   npx ts-node -r tsconfig-paths/register scripts/smoke-test-clickup-webhook.ts --help
 *
 * ── Output ────────────────────────────────────────────────────────────────────
 *   Tabela com 4 sub-tests, exit 0 se todos passam, exit 1 se algum falha.
 *
 * ── Modules ───────────────────────────────────────────────────────────────────
 *   smoke-test-clickup-webhook/types.ts          — interfaces + constants
 *   smoke-test-clickup-webhook/http-helpers.ts   — HMAC, payload, fetch helpers
 *   smoke-test-clickup-webhook/context-builder.ts — local / prod context setup
 *   smoke-test-clickup-webhook/tests.ts          — 4 test functions
 */

/* eslint-disable no-console */

import * as process from 'process';
import {
  TAG,
  DEFAULT_TASK_ID,
  DEFAULT_DB_URL,
  LOCAL_ENDPOINT_DEFAULT,
  GCLOUD_PROJECT,
  GCLOUD_REGION,
  GCLOUD_SERVICE,
  GCLOUD_SECRET,
  type ParsedArgs,
  type SmokeContext,
} from './smoke-test-clickup-webhook/types';
import { buildLocalContext, buildProdContext } from './smoke-test-clickup-webhook/context-builder';
import {
  runTest1_HappyPath,
  runTest2_InvalidHmac,
  runTest3_WrongList,
  runTest4_TaskNotFound,
} from './smoke-test-clickup-webhook/tests';

// ── Arg parsing ───────────────────────────────────────────────────────────────

function parseArgs(argv: string[]): ParsedArgs {
  if (argv.includes('--help') || argv.includes('-h')) {
    return { target: 'local', taskId: DEFAULT_TASK_ID, help: true };
  }

  const targetIdx = argv.indexOf('--target');
  const targetRaw = targetIdx >= 0 ? argv[targetIdx + 1] : undefined;
  if (targetRaw && targetRaw !== 'local' && targetRaw !== 'prod') {
    console.error(`${TAG} ERROR: --target must be "local" or "prod", got "${targetRaw}"`);
    process.exit(1);
  }
  const target: 'local' | 'prod' = (targetRaw as 'local' | 'prod') ?? 'local';

  const taskIdx = argv.indexOf('--task-id');
  const taskId  = taskIdx >= 0 ? (argv[taskIdx + 1] ?? DEFAULT_TASK_ID) : DEFAULT_TASK_ID;

  return { target, taskId, help: false };
}

function printHelp(): void {
  console.log(`
Usage:
  npx ts-node -r tsconfig-paths/register scripts/smoke-test-clickup-webhook.ts [options]

Options:
  --target local|prod   Execution target (default: local)
  --task-id <id>        ClickUp task_id for Test 1 happy path (default: ${DEFAULT_TASK_ID})
  --help, -h            Show this message

Environment variables (local):
  CLICKUP_API_TOKEN       ClickUp personal API token (required for Test 1)
  CLICKUP_WEBHOOK_SECRET  Webhook HMAC secret (auto-read via gcloud for --target prod)
  DATABASE_URL            Postgres connection string (default: ${DEFAULT_DB_URL})
  SMOKE_TARGET_URL        Override webhook endpoint URL (default: ${LOCAL_ENDPOINT_DEFAULT})

Environment variables (prod):
  DATABASE_URL must point to Cloud SQL (Cloud SQL Proxy must be running beforehand)
  gcloud CLI must be authenticated and have access to:
    - Cloud Run service: ${GCLOUD_SERVICE} in ${GCLOUD_REGION}/${GCLOUD_PROJECT}
    - Secret Manager secret: ${GCLOUD_SECRET}

Tests:
  1  taskUpdated happy path  — re-syncs real patient, validates updated_at in DB
  2  Invalid HMAC            — expects HTTP 401
  3  Wrong list_id           — expects HTTP 200 { action: 'skipped_other_list' }
  4  Task not found          — expects HTTP 200 { action: 'fetch_failed' }
`);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    printHelp();
    process.exit(0);
  }

  let ctx: SmokeContext;
  try {
    ctx = args.target === 'prod'
      ? await buildProdContext()
      : await buildLocalContext();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`${TAG} Context setup failed: ${message}`);
    process.exit(1);
  }

  console.log(`${TAG} Running 4 smoke tests (task_id=${args.taskId})...\n`);

  const results = await Promise.all([
    runTest1_HappyPath(ctx, args.taskId),
    runTest2_InvalidHmac(ctx),
    runTest3_WrongList(ctx),
    runTest4_TaskNotFound(ctx),
  ]);

  await ctx.pool.end();

  console.log('\n=== SMOKE TEST RESULTS ===');
  for (const r of results) {
    const icon = r.pass ? '[PASS]' : '[FAIL]';
    console.log(`${icon} ${r.test} (${r.durationMs}ms)`);
    console.log(`       ${r.message}`);
  }

  const failed = results.filter(r => !r.pass).length;
  if (failed > 0) {
    console.error(`\n${TAG} ${failed} test(s) failed.`);
    process.exit(1);
  }

  console.log(`\n${TAG} All smoke tests passed.`);
}

main().catch(err => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`${TAG} Uncaught error: ${message}`);
  process.exit(1);
});
