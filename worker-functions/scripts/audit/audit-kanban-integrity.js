#!/usr/bin/env node
/**
 * Audit de integridade WJA — cruza DB Postgres prod + Cloud Logging + (depois Playwright).
 *
 * Output: JSON com top N workers ordenados por wja.updated_at DESC, cada um com:
 *   - estado em banco (stage, interview_response, source, updated_at)
 *   - último log no GCP (useCase, timestamp, severity)
 *   - resultado de correlação (semantic_ok)
 *
 * Uso:
 *   1. Subir cloud-sql-proxy em port 5438:
 *      cloud-sql-proxy --port 5438 enlite-prd:southamerica-west1:enlite-ar-db &
 *   2. Rodar: node scripts/audit/audit-kanban-integrity.js [N=100]
 *
 * Pré-requisitos: gcloud autenticado em enlite-prd, secret enlite-ar-db-password acessível.
 */

const { Pool } = require('pg');
const { execSync, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const N = parseInt(process.argv[2] || '100', 10);
const PROJECT = 'enlite-prd';
const PROXY_PORT = parseInt(process.env.PROXY_PORT || '5438', 10);
const OUTPUT_PATH = path.join(__dirname, `results-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);

// useCase → expected stage map (pragmatic — only validations claras)
function inferExpectedStage(useCase, jsonPayload) {
  if (!useCase) return null;
  // ProcessTalentumPrescreening writes multiple stages; we don't know which without statusLabel
  if (useCase.includes('ProcessTalentumPrescreening')) return null;
  // BookSlot always sets CONFIRMED on success
  if (useCase.includes('BookSlotFromWhatsApp')) {
    // Apenas se for happy path (não slot inválido); inferir do msg
    const msg = jsonPayload?.message || jsonPayload?.msg || '';
    if (msg.includes('Booked slot')) return 'CONFIRMED';
    return null;
  }
  // QualifiedInterviewHandler runs after stage already QUALIFIED — sem expectativa direta
  if (useCase.includes('QualifiedInterviewHandler')) return null;
  // VacancyAutoInviteHandler cria WJA em INVITED
  if (useCase.includes('VacancyAutoInviteHandler')) return null; // pode ter mudado depois
  // HandleReminderResponse — depende do método (confirm_no/reschedule_yes/etc)
  if (useCase.includes('HandleReminderResponse')) return null;
  // BulkDispatch é só envio de mensagem — não muda stage
  if (useCase.includes('BulkDispatch')) return null;
  return null;
}

async function getDbPassword() {
  return execSync('gcloud secrets versions access latest --secret="enlite-ar-db-password" --project=enlite-prd', { encoding: 'utf-8' }).trim();
}

async function fetchTopWorkers(pool, n) {
  // Filtrar workers com ação dinâmica real no backend (não backfill histórico):
  // - source dinâmico (talentum/system/manual) — excluir 'planilla_operativa' e 'import'
  // - excluir rows com updated_at idêntico em massa (backfills tipo migration 191)
  const { rows } = await pool.query(`
    SELECT
      wja.id AS wja_id,
      wja.worker_id,
      wja.job_posting_id,
      wja.application_funnel_stage,
      wja.interview_response,
      wja.interview_meet_link IS NOT NULL AS has_meet_link,
      wja.source,
      wja.acquisition_channel,
      wja.updated_at,
      wja.created_at,
      jp.case_number,
      jp.title AS vacancy_title
    FROM worker_job_applications wja
    JOIN job_postings jp ON jp.id = wja.job_posting_id
    WHERE (wja.source IS NULL OR wja.source NOT IN ('planilla_operativa', 'import'))
      -- Excluir backfills em massa (updated_at idêntico em >100 rows)
      AND wja.updated_at NOT IN (
        SELECT updated_at FROM worker_job_applications
        GROUP BY updated_at
        HAVING COUNT(*) > 100
      )
    ORDER BY wja.updated_at DESC NULLS LAST
    LIMIT $1
  `, [n]);
  return rows;
}

function fetchLastLogForWorker(workerId) {
  // Procura último log estruturado com esse workerId nos últimos 30 dias
  const filter = `resource.type="cloud_run_revision" AND resource.labels.service_name="worker-functions" AND jsonPayload.workerId="${workerId}"`;
  try {
    const json = execFileSync('gcloud', [
      'logging', 'read', filter,
      '--limit=1',
      '--order=desc',
      '--format=json',
      `--project=${PROJECT}`,
      '--freshness=30d',
    ], { encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 });
    const entries = JSON.parse(json);
    if (entries.length === 0) return null;
    const e = entries[0];
    return {
      timestamp: e.timestamp,
      severity: e.severity,
      useCase: e.jsonPayload?.useCase || null,
      message: e.jsonPayload?.message || e.jsonPayload?.msg || null,
      traceId: e.jsonPayload?.traceId || null,
      revisionName: e.resource?.labels?.revision_name || null,
      rawPayload: e.jsonPayload || null,
    };
  } catch (err) {
    console.error(`[audit] gcloud logging failed for ${workerId}: ${err.message}`);
    return null;
  }
}

function correlate(worker, lastLog) {
  if (!lastLog) {
    return {
      status: 'NO_LOG',
      reason: 'Worker has no log in last 30 days — STALE (not necessarily wrong)',
      semantic_ok: null,
      temporal_ok: null,
    };
  }
  const logTs = new Date(lastLog.timestamp).getTime();
  const dbTs = new Date(worker.updated_at).getTime();
  // Temporal: log deveria ser >= db_updated_at (log é o que causou o update OU mais recente)
  // Tolerância de 60s pra clock skew
  const temporal_ok = logTs >= dbTs - 60_000;
  const tempDiffMs = dbTs - logTs;
  // Semantic: useCase do log explica o stage?
  const expectedStage = inferExpectedStage(lastLog.useCase, lastLog.rawPayload);
  const semantic_ok = expectedStage === null ? null : (expectedStage === worker.application_funnel_stage);
  let status = 'OK';
  let reason = '';
  if (!temporal_ok) {
    status = 'TEMPORAL_MISMATCH';
    reason = `DB updated_at is ${Math.round(tempDiffMs / 1000)}s AHEAD of last log — DB has data not explained by logs (could be: log retention, off-by-one, write without log)`;
  } else if (semantic_ok === false) {
    status = 'SEMANTIC_MISMATCH';
    reason = `Last log useCase="${lastLog.useCase}" implies stage="${expectedStage}", but DB has stage="${worker.application_funnel_stage}"`;
  } else if (semantic_ok === null) {
    status = 'OK_UNVERIFIED';
    reason = `Log useCase="${lastLog.useCase}" doesn't have a strict stage mapping (acceptable)`;
  }
  return { status, reason, semantic_ok, temporal_ok, temporalDiffSeconds: Math.round(tempDiffMs / 1000) };
}

(async () => {
  const startTime = Date.now();
  console.log(`[audit] Starting audit for top ${N} workers...`);
  const password = await getDbPassword();
  const pool = new Pool({
    host: 'localhost',
    port: PROXY_PORT,
    user: 'enlite_app',
    database: 'enlite_ar',
    password,
    max: 1,
  });

  try {
    console.log(`[audit] Fetching top ${N} workers from DB...`);
    const workers = await fetchTopWorkers(pool, N);
    console.log(`[audit] Got ${workers.length} workers. Querying Cloud Logging...`);

    const results = [];
    for (let i = 0; i < workers.length; i++) {
      const w = workers[i];
      process.stdout.write(`\r[audit] ${i + 1}/${workers.length} (${w.worker_id.slice(0, 8)}...)         `);
      const lastLog = fetchLastLogForWorker(w.worker_id);
      const correlation = correlate(w, lastLog);
      results.push({
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
        log: lastLog,
        correlation,
      });
    }
    process.stdout.write('\n');

    // Stats
    const stats = {
      total: results.length,
      ok: results.filter(r => r.correlation.status === 'OK').length,
      ok_unverified: results.filter(r => r.correlation.status === 'OK_UNVERIFIED').length,
      no_log: results.filter(r => r.correlation.status === 'NO_LOG').length,
      temporal_mismatch: results.filter(r => r.correlation.status === 'TEMPORAL_MISMATCH').length,
      semantic_mismatch: results.filter(r => r.correlation.status === 'SEMANTIC_MISMATCH').length,
    };

    const elapsedSec = Math.round((Date.now() - startTime) / 1000);
    console.log(`\n[audit] Done in ${elapsedSec}s. Stats:`);
    console.log(JSON.stringify(stats, null, 2));

    fs.writeFileSync(OUTPUT_PATH, JSON.stringify({ runAt: new Date().toISOString(), N, stats, results }, null, 2));
    console.log(`\n[audit] Saved to ${OUTPUT_PATH}`);
  } finally {
    await pool.end();
  }
})().catch(err => {
  console.error('[audit] Fatal:', err);
  process.exit(1);
});
