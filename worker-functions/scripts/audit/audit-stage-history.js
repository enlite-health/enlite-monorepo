#!/usr/bin/env node
/**
 * Audit v2 — usa worker_job_application_stage_history (fonte primária) em vez de Cloud Logging.
 *
 * Stage_history é populada pelo trigger `trg_application_stage_history` (AFTER INSERT OR UPDATE
 * OF application_funnel_stage). Cada transição é gravada. É a fonte CANÔNICA de "última ação
 * que mudou stage" do worker.
 *
 * Validações:
 *   1. wja.application_funnel_stage === ultima stage_history.new_value (integridade canônica)
 *   2. wja.updated_at >= ultima stage_history.created_at (DB consistente com história)
 *   3. Cardinalidade: 1 WJA por (worker, job_posting) — UNIQUE constraint
 *   4. Encuadre: trigger 189 garante 1 encuadre por WJA
 *
 * Output: JSON com top N workers ordenados por wja.updated_at DESC.
 *
 * Uso:
 *   1. cloud-sql-proxy --port 5438 enlite-prd:southamerica-west1:enlite-ar-db &
 *   2. node scripts/audit/audit-stage-history.js [N=100]
 */

const { Pool } = require('pg');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const N = parseInt(process.argv[2] || '100', 10);
const INCLUDE_LEGACY = process.argv.includes('--include-legacy');
const PROXY_PORT = parseInt(process.env.PROXY_PORT || '5438', 10);
const OUTPUT_PATH = path.join(__dirname, `stage-history-results-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);

async function getDbPassword() {
  return execSync('gcloud secrets versions access latest --secret="enlite-ar-db-password" --project=enlite-prd', { encoding: 'utf-8' }).trim();
}

async function fetchWorkers(pool, n) {
  const filterClause = INCLUDE_LEGACY ? '' : `
      WHERE (wja.source IS NULL OR wja.source NOT IN ('planilla_operativa', 'import'))
        AND wja.updated_at NOT IN (
          SELECT updated_at FROM worker_job_applications GROUP BY updated_at HAVING COUNT(*) > 100
        )`;
  const { rows } = await pool.query(`
    WITH top_wjas AS (
      SELECT wja.id, wja.worker_id, wja.job_posting_id, wja.application_funnel_stage,
             wja.interview_response, wja.interview_meet_link IS NOT NULL AS has_meet_link,
             wja.source, wja.acquisition_channel, wja.updated_at, wja.created_at
      FROM worker_job_applications wja
      ${filterClause}
      ORDER BY wja.updated_at DESC NULLS LAST
      LIMIT $1
    )
    SELECT
      t.id AS wja_id,
      t.worker_id,
      t.job_posting_id,
      t.application_funnel_stage,
      t.interview_response,
      t.has_meet_link,
      t.source,
      t.acquisition_channel,
      t.updated_at,
      t.created_at,
      jp.case_number,
      -- Last stage_history entry for this WJA (canonical truth of last transition)
      sh.new_value AS last_history_stage,
      sh.old_value AS prev_history_stage,
      sh.created_at AS last_history_at,
      sh.changed_by AS last_history_changed_by,
      sh.change_source AS last_history_source,
      -- Counts for context
      (SELECT COUNT(*) FROM worker_job_application_stage_history WHERE application_id = t.id) AS history_count,
      -- Encuadre presence (cardinality invariant)
      EXISTS (SELECT 1 FROM encuadres e WHERE e.worker_id = t.worker_id AND e.job_posting_id = t.job_posting_id) AS has_encuadre
    FROM top_wjas t
    JOIN job_postings jp ON jp.id = t.job_posting_id
    LEFT JOIN LATERAL (
      SELECT new_value, old_value, created_at, changed_by, change_source
      FROM worker_job_application_stage_history
      WHERE application_id = t.id AND field_name = 'application_funnel_stage'
      ORDER BY created_at DESC LIMIT 1
    ) sh ON true
    ORDER BY t.updated_at DESC NULLS LAST;
  `, [n]);
  return rows;
}

function correlate(w) {
  const issues = [];
  // 1. Stage no DB === ultimo new_value em history
  if (w.last_history_stage === null) {
    issues.push('NO_HISTORY: nenhuma entrada em stage_history (trigger não populou?)');
  } else if (w.last_history_stage !== w.application_funnel_stage) {
    issues.push(`STAGE_MISMATCH: DB=${w.application_funnel_stage} vs history.new_value=${w.last_history_stage}`);
  }
  // 2. wja.updated_at >= last_history_at
  if (w.last_history_at) {
    const dbTs = new Date(w.updated_at).getTime();
    const histTs = new Date(w.last_history_at).getTime();
    if (dbTs < histTs - 5000) { // 5s tolerância
      issues.push(`TEMPORAL_ANOMALY: wja.updated_at=${w.updated_at} is BEFORE last_history_at=${w.last_history_at}`);
    }
  }
  // 3. Encuadre present
  if (!w.has_encuadre) {
    issues.push('NO_ENCUADRE: WJA without companion encuadre (trigger 189 should have created it)');
  }
  return issues.length === 0 ? { status: 'OK', issues: [] } : { status: 'ISSUES', issues };
}

(async () => {
  const startTime = Date.now();
  console.log(`[audit-v2] Starting stage_history audit for top ${N} workers...`);
  const password = await getDbPassword();
  const pool = new Pool({
    host: 'localhost', port: PROXY_PORT, user: 'enlite_app',
    database: 'enlite_ar', password, max: 1,
  });
  try {
    const workers = await fetchWorkers(pool, N);
    console.log(`[audit-v2] Got ${workers.length} workers from DB. Correlating...`);
    const results = workers.map((w, i) => ({
      rank: i + 1,
      worker_id: w.worker_id,
      wja_id: w.wja_id,
      job_posting_id: w.job_posting_id,
      case_number: w.case_number,
      db: {
        application_funnel_stage: w.application_funnel_stage,
        interview_response: w.interview_response,
        has_meet_link: w.has_meet_link,
        source: w.source,
        acquisition_channel: w.acquisition_channel,
        updated_at: w.updated_at,
        created_at: w.created_at,
      },
      history: {
        last_stage: w.last_history_stage,
        prev_stage: w.prev_history_stage,
        last_history_at: w.last_history_at,
        changed_by: w.last_history_changed_by,
        change_source: w.last_history_source,
        total_transitions: parseInt(w.history_count, 10),
      },
      invariants: {
        has_encuadre: w.has_encuadre,
      },
      correlation: correlate(w),
    }));
    const stats = {
      total: results.length,
      ok: results.filter(r => r.correlation.status === 'OK').length,
      with_issues: results.filter(r => r.correlation.status === 'ISSUES').length,
      no_history: results.filter(r => r.correlation.issues.some(i => i.startsWith('NO_HISTORY'))).length,
      stage_mismatch: results.filter(r => r.correlation.issues.some(i => i.startsWith('STAGE_MISMATCH'))).length,
      temporal_anomaly: results.filter(r => r.correlation.issues.some(i => i.startsWith('TEMPORAL_ANOMALY'))).length,
      no_encuadre: results.filter(r => r.correlation.issues.some(i => i.startsWith('NO_ENCUADRE'))).length,
    };
    const elapsedSec = Math.round((Date.now() - startTime) / 1000);
    console.log(`[audit-v2] Done in ${elapsedSec}s. Stats:`);
    console.log(JSON.stringify(stats, null, 2));
    fs.writeFileSync(OUTPUT_PATH, JSON.stringify({ runAt: new Date().toISOString(), N, stats, results }, null, 2));
    console.log(`[audit-v2] Saved to ${OUTPUT_PATH}`);
  } finally {
    await pool.end();
  }
})().catch(err => {
  console.error('[audit-v2] Fatal:', err);
  process.exit(1);
});
