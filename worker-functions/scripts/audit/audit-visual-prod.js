#!/usr/bin/env node
/**
 * Audit visual em PROD — confere que workers do audit DB aparecem nas colunas corretas do Kanban
 * via endpoint admin GET /api/admin/vacancies/:id/funnel.
 *
 * Não usa browser (Playwright) — usa direto a API que o Kanban consome.
 * Mesma garantia: se API retorna worker na coluna esperada, frontend renderiza ele lá.
 *
 * Pré-condições:
 *   - File results-*.json do audit-stage-history.js (lê o último automaticamente)
 *   - Credenciais admin: FIREBASE_EMAIL + FIREBASE_PASSWORD em env
 *   - API_BASE_URL padrão = https://api.enlite.health
 *
 * Mapeamento canônico stage → coluna do Kanban (do WJAFunnelController.ts):
 *   SELECTED → SELECTED
 *   REJECTED → REJECTED
 *   CONFIRMED → CONFIRMED
 *   COMPLETED/QUALIFIED/IN_DOUBT → COMPLETED
 *   IN_PROGRESS → IN_PROGRESS
 *   INITIATED → INITIATED
 *   INVITED (ou null) → INVITED
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const FIREBASE_API_KEY = process.env.FIREBASE_API_KEY || 'AIzaSyByRp-NCY0m12iEoKyuIrV6vR49MZateXI';
const FIREBASE_EMAIL = process.env.FIREBASE_EMAIL;
const FIREBASE_PASSWORD = process.env.FIREBASE_PASSWORD;
const API_BASE = process.env.API_BASE_URL || 'https://api.enlite.health';

if (!FIREBASE_EMAIL || !FIREBASE_PASSWORD) {
  console.error('Set FIREBASE_EMAIL and FIREBASE_PASSWORD env vars before running.');
  process.exit(1);
}

const OUTPUT_PATH = path.join(__dirname, `visual-prod-results-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);

function stageToColumn(stage) {
  if (!stage) return 'INVITED';
  if (stage === 'SELECTED') return 'SELECTED';
  if (stage === 'REJECTED') return 'REJECTED';
  if (stage === 'CONFIRMED') return 'CONFIRMED';
  if (['COMPLETED', 'QUALIFIED', 'IN_DOUBT'].includes(stage)) return 'COMPLETED';
  if (stage === 'IN_PROGRESS') return 'IN_PROGRESS';
  if (stage === 'INITIATED') return 'INITIATED';
  return 'INVITED';
}

function httpsRequest(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, opts, res => {
      let body = '';
      res.on('data', c => (body += c));
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: body ? JSON.parse(body) : null });
        } catch {
          resolve({ status: res.statusCode, body });
        }
      });
    });
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

async function loginFirebase() {
  const url = `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${FIREBASE_API_KEY}`;
  const res = await httpsRequest(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: FIREBASE_EMAIL, password: FIREBASE_PASSWORD, returnSecureToken: true }),
  });
  if (res.status !== 200) throw new Error(`Firebase login failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.idToken;
}

async function getKanban(token, vacancyId) {
  const url = `${API_BASE}/api/admin/vacancies/${vacancyId}/funnel`;
  const res = await httpsRequest(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status !== 200) {
    return { error: `HTTP ${res.status}: ${JSON.stringify(res.body)}` };
  }
  return res.body?.data || res.body;
}

function loadLatestAuditResults() {
  const files = fs.readdirSync(__dirname)
    .filter(f => f.startsWith('stage-history-results-') && f.endsWith('.json'))
    .sort()
    .reverse();
  if (files.length === 0) throw new Error('No stage-history-results-*.json found. Run audit-stage-history.js first.');
  const latest = path.join(__dirname, files[0]);
  console.log(`[visual] Loading audit from ${files[0]}`);
  return JSON.parse(fs.readFileSync(latest, 'utf-8'));
}

(async () => {
  const startTime = Date.now();
  const audit = loadLatestAuditResults();
  const workers = audit.results;

  // Group by job_posting_id
  const byVacancy = new Map();
  for (const w of workers) {
    if (!byVacancy.has(w.job_posting_id)) byVacancy.set(w.job_posting_id, []);
    byVacancy.get(w.job_posting_id).push(w);
  }
  console.log(`[visual] ${workers.length} workers in ${byVacancy.size} unique vacancies.`);

  console.log('[visual] Logging in Firebase...');
  const token = await loginFirebase();
  console.log('[visual] Logged in. Fetching Kanbans...');

  const results = [];
  let vacIdx = 0;
  for (const [vacancyId, vacWorkers] of byVacancy) {
    vacIdx++;
    process.stdout.write(`\r[visual] ${vacIdx}/${byVacancy.size} vacancy ${vacancyId.slice(0, 8)} (${vacWorkers.length} workers)        `);
    const kanban = await getKanban(token, vacancyId);
    if (kanban.error) {
      for (const w of vacWorkers) {
        results.push({
          worker_id: w.worker_id,
          wja_id: w.wja_id,
          job_posting_id: vacancyId,
          case_number: w.case_number,
          db_stage: w.db.application_funnel_stage,
          expected_column: stageToColumn(w.db.application_funnel_stage),
          status: 'API_ERROR',
          reason: kanban.error,
        });
      }
      continue;
    }
    const stages = kanban?.stages || {};
    for (const w of vacWorkers) {
      const expectedColumn = stageToColumn(w.db.application_funnel_stage);
      const cardsInExpected = stages[expectedColumn] || [];
      const foundInExpected = cardsInExpected.some(c => c.id === w.wja_id);
      // Onde o card REALMENTE está?
      let foundInColumn = null;
      for (const [col, cards] of Object.entries(stages)) {
        if (cards.some(c => c.id === w.wja_id)) {
          foundInColumn = col;
          break;
        }
      }
      let status, reason;
      if (foundInExpected) {
        status = 'OK';
        reason = null;
      } else if (foundInColumn) {
        status = 'WRONG_COLUMN';
        reason = `DB stage=${w.db.application_funnel_stage} → expected column ${expectedColumn}, but card found in ${foundInColumn}`;
      } else {
        status = 'NOT_FOUND';
        reason = `Card ${w.wja_id.slice(0, 8)} not found in any Kanban column for vacancy ${w.case_number}`;
      }
      results.push({
        worker_id: w.worker_id,
        wja_id: w.wja_id,
        job_posting_id: vacancyId,
        case_number: w.case_number,
        db_stage: w.db.application_funnel_stage,
        expected_column: expectedColumn,
        actual_column: foundInColumn,
        status,
        reason,
      });
    }
  }
  process.stdout.write('\n');

  const stats = {
    total: results.length,
    ok: results.filter(r => r.status === 'OK').length,
    wrong_column: results.filter(r => r.status === 'WRONG_COLUMN').length,
    not_found: results.filter(r => r.status === 'NOT_FOUND').length,
    api_error: results.filter(r => r.status === 'API_ERROR').length,
  };

  const elapsedSec = Math.round((Date.now() - startTime) / 1000);
  console.log(`\n[visual] Done in ${elapsedSec}s. Stats:`);
  console.log(JSON.stringify(stats, null, 2));

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify({ runAt: new Date().toISOString(), API_BASE, stats, results }, null, 2));
  console.log(`\n[visual] Saved to ${OUTPUT_PATH}`);
})().catch(err => {
  console.error('[visual] Fatal:', err);
  process.exit(1);
});
