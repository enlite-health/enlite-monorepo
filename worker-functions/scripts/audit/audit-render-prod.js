#!/usr/bin/env node
/**
 * Audit FINAL — Playwright contra app.enlite.health prod, browser real.
 *
 * Pega 6 vagas representativas do último visual-prod-results.json e abre
 * cada uma no Kanban (browser real, login real, render React real),
 * valida cada card no DOM + captura screenshot.
 *
 * Uso:
 *   cd worker-functions
 *   FIREBASE_EMAIL='...' FIREBASE_PASSWORD='...' node scripts/audit/audit-render-prod.js
 *
 * Dependências:
 *   playwright (usa o do enlite-frontend, segue node_modules resolver)
 */

const path = require('path');
const fs = require('fs');

// Resolver Playwright do enlite-frontend (pnpm tem .pnpm path)
const PLAYWRIGHT_PATH = path.resolve(__dirname, '../../../enlite-frontend/node_modules/.pnpm/playwright@1.58.2/node_modules/playwright');
const { chromium } = require(PLAYWRIGHT_PATH);

const FIREBASE_API_KEY = process.env.FIREBASE_API_KEY || 'AIzaSyByRp-NCY0m12iEoKyuIrV6vR49MZateXI';
const FIREBASE_EMAIL = process.env.FIREBASE_EMAIL;
const FIREBASE_PASSWORD = process.env.FIREBASE_PASSWORD;
const APP_URL = process.env.APP_URL || 'https://app.enlite.health';

if (!FIREBASE_EMAIL || !FIREBASE_PASSWORD) {
  console.error('Set FIREBASE_EMAIL and FIREBASE_PASSWORD env vars');
  process.exit(1);
}

const OUTPUT_DIR = path.join(__dirname, `render-prod-${new Date().toISOString().replace(/[:.]/g, '-')}`);

// 6 vagas representativas com diversidade de stages (escolhidas do audit 500)
const REPRESENTATIVE_VACANCIES = [
  { case: 672, id: 'd8201c1e-2be4-4b56-9a81-511b59434a6c', desc: '23 workers, 3 cols (COMPLETED 17 + IN_PROGRESS 5 + INITIATED 1)' },
  { case: 770, id: '444e4467-2481-4dc9-841d-dcb5dc74b411', desc: '22 workers, 3 cols (INVITED 20 + IN_PROGRESS 1 + COMPLETED 1)' },
  { case: 774, id: '88e95def-883a-4c67-99a6-f03e0dd41a05', desc: '22 INVITED massa' },
  { case: 402, id: '762a59fd-17d7-4833-9249-749f58015061', desc: '12 workers, 4 cols diversidade' },
  { case: 429, id: '0274ad7e-2dc6-434c-86c4-eb1b41e04359', desc: '13 workers, 3 cols' },
  { case: 505, id: 'a22b7f76-76f0-4ad5-99c7-7e15f7f6a0fa', desc: '12 workers, 3 cols' },
];

function loadAuditWorkers() {
  const files = fs.readdirSync(__dirname).filter(f => f.startsWith('visual-prod-results-') && f.endsWith('.json')).sort().reverse();
  if (files.length === 0) throw new Error('No visual-prod-results found');
  const data = JSON.parse(fs.readFileSync(path.join(__dirname, files[0]), 'utf-8'));
  return data.results;
}

async function loginFirebase() {
  const res = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${FIREBASE_API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: FIREBASE_EMAIL, password: FIREBASE_PASSWORD, returnSecureToken: true }),
  });
  const data = await res.json();
  if (!data.localId) throw new Error(`Firebase login failed: ${JSON.stringify(data)}`);
  return data;
}

(async () => {
  const startTime = Date.now();
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  console.log(`[render] Output dir: ${OUTPUT_DIR}`);

  const allWorkers = loadAuditWorkers();
  const workersByVacancy = new Map();
  for (const w of allWorkers) {
    if (!workersByVacancy.has(w.job_posting_id)) workersByVacancy.set(w.job_posting_id, []);
    workersByVacancy.get(w.job_posting_id).push(w);
  }

  console.log('[render] Logging in Firebase...');
  const { localId: uid, idToken, refreshToken } = await loginFirebase();
  console.log(`[render] Logged in as ${FIREBASE_EMAIL} (uid=${uid.slice(0, 8)})`);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });

  // Inject Firebase auth + force Kanban view for all vacancies BEFORE navigating
  const vacancyIds = REPRESENTATIVE_VACANCIES.map(v => v.id);
  await context.addInitScript(({ uid, email, idToken, refreshToken, apiKey, vacancyIds }) => {
    const key = `firebase:authUser:${apiKey}:[DEFAULT]`;
    const value = JSON.stringify({
      uid, email, emailVerified: true, isAnonymous: false,
      providerData: [{ providerId: 'password', uid: email, displayName: null, email, phoneNumber: null, photoURL: null }],
      stsTokenManager: { refreshToken, accessToken: idToken, expirationTime: Date.now() + 3_600_000 },
      createdAt: String(Date.now()), lastLoginAt: String(Date.now()),
      apiKey, appName: '[DEFAULT]',
    });
    localStorage.setItem(key, value);
    // Force Kanban view (default é 'list')
    for (const vid of vacancyIds) {
      localStorage.setItem(`vacancy-funnel-view-${vid}`, 'kanban');
    }
  }, { uid, email: FIREBASE_EMAIL, idToken, refreshToken, apiKey: FIREBASE_API_KEY, vacancyIds });

  const results = [];

  for (const vac of REPRESENTATIVE_VACANCIES) {
    console.log(`\n[render] Vacancy case=${vac.case} (${vac.desc})`);
    const vacWorkers = workersByVacancy.get(vac.id) || [];
    if (vacWorkers.length === 0) {
      console.warn(`  no workers in audit data — skipping`);
      continue;
    }

    const page = await context.newPage();
    try {
      const url = `${APP_URL}/admin/vacancies/${vac.id}`;
      await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 });

      // Wait Kanban to render
      await page.waitForSelector('[data-testid="kanban-board"]', { timeout: 30000 });
      await page.waitForTimeout(2000); // wait cards to settle

      // Screenshot da página inteira
      const screenshotPath = path.join(OUTPUT_DIR, `vacancy-${vac.case}-${vac.id.slice(0, 8)}.png`);
      await page.screenshot({ path: screenshotPath, fullPage: true });

      // Pra cada worker, verificar:
      // 1. card existe no DOM
      // 2. card está dentro da coluna esperada
      const vacancyResults = [];
      for (const w of vacWorkers) {
        const cardSelector = `[data-testid="kanban-card-${w.wja_id}"]`;
        const card = await page.$(cardSelector);
        if (!card) {
          vacancyResults.push({
            worker_id: w.worker_id,
            wja_id: w.wja_id,
            expected_column: w.expected_column,
            status: 'CARD_NOT_IN_DOM',
            reason: `Selector ${cardSelector} not found in rendered Kanban`,
          });
          continue;
        }
        // Find parent column via DOM traversal
        const parentColumn = await card.evaluate(el => {
          let p = el.parentElement;
          while (p && !p.dataset.testid?.startsWith('kanban-column-')) {
            p = p.parentElement;
          }
          return p?.dataset.testid?.replace('kanban-column-', '') || null;
        });
        const ok = parentColumn === w.expected_column;
        vacancyResults.push({
          worker_id: w.worker_id,
          wja_id: w.wja_id,
          expected_column: w.expected_column,
          actual_column_dom: parentColumn,
          status: ok ? 'OK' : 'WRONG_COLUMN_DOM',
        });
      }

      const okCount = vacancyResults.filter(r => r.status === 'OK').length;
      console.log(`  ✓ ${okCount}/${vacWorkers.length} cards na coluna correta no DOM`);
      console.log(`  📸 Screenshot: ${path.basename(screenshotPath)}`);

      results.push({
        case_number: vac.case,
        job_posting_id: vac.id,
        screenshot: path.basename(screenshotPath),
        total_workers: vacWorkers.length,
        ok_count: okCount,
        worker_results: vacancyResults,
      });
    } catch (err) {
      console.error(`  ❌ Error: ${err.message}`);
      results.push({ case_number: vac.case, job_posting_id: vac.id, error: err.message });
    } finally {
      await page.close();
    }
  }

  await browser.close();

  const totalWorkers = results.reduce((s, r) => s + (r.total_workers || 0), 0);
  const totalOk = results.reduce((s, r) => s + (r.ok_count || 0), 0);
  const stats = {
    total_vacancies: REPRESENTATIVE_VACANCIES.length,
    successful_vacancies: results.filter(r => !r.error).length,
    total_workers_validated: totalWorkers,
    total_ok: totalOk,
    wrong_column_dom: results.flatMap(r => r.worker_results || []).filter(r => r.status === 'WRONG_COLUMN_DOM').length,
    card_not_in_dom: results.flatMap(r => r.worker_results || []).filter(r => r.status === 'CARD_NOT_IN_DOM').length,
  };

  const elapsedSec = Math.round((Date.now() - startTime) / 1000);
  console.log(`\n[render] Done in ${elapsedSec}s.`);
  console.log(JSON.stringify(stats, null, 2));

  fs.writeFileSync(path.join(OUTPUT_DIR, 'results.json'), JSON.stringify({ runAt: new Date().toISOString(), stats, results }, null, 2));
  console.log(`[render] Saved to ${OUTPUT_DIR}/results.json`);
})().catch(err => {
  console.error('[render] Fatal:', err);
  process.exit(1);
});
