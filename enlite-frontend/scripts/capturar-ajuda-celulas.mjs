/* eslint-env node */
/**
 * capturar-ajuda-celulas — gera `public/ayuda-celulas/<recurso>.png`: a captura do componente a que
 * cada célula se refere, mostrada no painel de ajuda do "?" (CellHelpDrawer).
 *
 * Roda contra um stack LOCAL com dado SINTÉTICO (nunca stage nem produção) e uma conta com todas
 * as células. Uso:
 *   FRONT=http://localhost:5177 API=http://localhost:8095 UID=demo-gestora EMAIL=demo.gestora@e2e.test \
 *   PATIENT=<uuid> WORKER=<uuid> VACANCY=<uuid> GROUP=<uuid> node scripts/capturar-ajuda-celulas.mjs
 * Quando uma tela mudar, regravar. A lista de recursos com imagem vive em
 * `src/presentation/config/cellHelpImages.ts` — este script falha se capturar algo fora dela.
 */
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const FRONT = process.env.FRONT ?? 'http://localhost:5177';
const OUT = new URL('../public/ayuda-celulas/', import.meta.url).pathname;
const u = { uid: process.env.UID ?? 'demo-gestora', email: process.env.EMAIL ?? 'demo.gestora@e2e.test', role: 'admin' };
const ID = { patient: process.env.PATIENT, worker: process.env.WORKER, vacancy: process.env.VACANCY, group: process.env.GROUP };
for (const [k, v] of Object.entries(ID)) if (!v) throw new Error(`falta ${k.toUpperCase()}`);

const tokenFor = (u) => 'mock_' + Buffer.from(JSON.stringify({ uid: u.uid, email: u.email, role: u.role, country: 'AR' })).toString('base64');
const fakeIdToken = (u) => 'eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.' + Buffer.from(JSON.stringify({ sub: u.uid, uid: u.uid, email: u.email, iss: 'https://securetoken.google.com/enlite-prd', aud: 'enlite-prd', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url') + '.';

/** recurso → [rota, aba (data-testid do botão ou texto), seletor do componente] */
const MAPA = [
  // O operacional do paciente: o kanban de admissão (status/etapa), que é exatamente o que `patient:read` abre.
  ['patient',              '/admin/patients/kanban', null, 'main'],
  ['patient_identity',     `/admin/patients/${ID.patient}`, null, '[data-testid=patient-identity-card]'],
  ['patient_clinical',     `/admin/patients/${ID.patient}`, 'Datos Clínicos', '[data-testid=diagnostico-card]'],
  ['patient_care_team',    `/admin/patients/${ID.patient}`, 'Datos Clínicos', '[data-testid=equipe-tratante-card]'],
  ['patient_family',       `/admin/patients/${ID.patient}`, 'Red de Apoyo', '[data-testid=familiares-card]'],
  ['patient_chat',         `/admin/patients/${ID.patient}`, 'Red de Apoyo', '[data-testid=patient-chat-ids-card]'],
  ['patient_coverage',     `/admin/patients/${ID.patient}`, 'Servicio Contratado', '[data-testid=cobertura-medica-card]'],
  ['patient_address',      `/admin/patients/${ID.patient}`, 'Servicio Contratado', '[data-testid=localizacoes-card]'],
  ['patient_services',     `/admin/patients/${ID.patient}`, 'Servicio Contratado', '[data-testid=servicos-contratados-card]'],
  ['worker',               `/admin/workers/${ID.worker}`, null, '[data-testid=worker-professional-card]'],
  ['worker_contact',       `/admin/workers/${ID.worker}`, null, '[data-testid=worker-contact-card]'],
  ['worker_pii',           `/admin/workers/${ID.worker}`, null, '[data-testid=worker-personal-card]'],
  ['worker_address',       `/admin/workers/${ID.worker}`, null, '[data-testid=worker-address-card]'],
  ['worker_document',      `/admin/workers/${ID.worker}`, 'Documentos', '[data-testid=worker-documents-card]'],
  ['match',                `/admin/workers/${ID.worker}`, 'Encuadre', '[data-testid=worker-encuadres-card]'],
  ['vacancy',              `/admin/vacancies/${ID.vacancy}`, null, '[data-testid=vacancy-case-card]'],
  ['funnel',               `/admin/vacancies/${ID.vacancy}`, 'Encuadres', '[data-testid=vacancy-funnel-view]'],
  ['prescreening',         `/admin/vacancies/${ID.vacancy}`, 'Talentum', '[data-testid=vacancy-prescreening-config]'],
  ['talentum',             `/admin/vacancies/${ID.vacancy}`, 'Talentum', '[data-testid=talentum-card]'],
  ['messaging',            '/admin/mensajes-por-etapa', null, 'main'],
  ['dashboard',            '/admin/dashboard', null, 'main'],
  ['dashboard_numbers',    '/admin/dashboard', null, '[data-testid=mgmt-big-numbers]'],
  ['dashboard_team',       '/admin/dashboard', null, '[data-testid=mgmt-equipo-armada]'],
  ['dashboard_priorities', '/admin/dashboard', null, '[data-testid=mgmt-prioridades]'],
  ['dashboard_registrations', '/admin/dashboard', null, '[data-testid=mgmt-cadastros]'],
  ['dashboard_funnel',     '/admin/dashboard', null, '[data-testid=mgmt-funnel]'],
  ['dashboard_zones',      '/admin/dashboard', null, '[data-testid=mgmt-zone-analytics]'],
  ['user_management',      '/admin', null, 'main'],
  ['permission_management', `/admin/access/groups/${ID.group}`, null, 'main'],
  ['dedup',                '/admin/dedup', null, 'main'],
  ['recruitment',          '/admin/recruitment', null, 'main'],
];

mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 }, deviceScaleFactor: 1 });
const page = await ctx.newPage();
const idToken = fakeIdToken(u), mock = tokenFor(u);
await page.route('**/identitytoolkit.googleapis.com/**', async (route) => {
  const url = route.request().url();
  if (url.includes('signInWithPassword') || url.includes('signUp')) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ kind: 'identitytoolkit#VerifyPasswordResponse', localId: u.uid, email: u.email, idToken, refreshToken: 'r', expiresIn: '3600', registered: true }) });
  return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ users: [{ localId: u.uid, email: u.email, emailVerified: true }] }) });
});
await page.route('**/securetoken.googleapis.com/**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ access_token: idToken, id_token: idToken, expires_in: '3600', token_type: 'Bearer', refresh_token: 'r' }) }));
const swap = (route) => route.continue({ headers: { ...route.request().headers(), authorization: 'Bearer ' + mock } });
await page.route('**/api/**', swap); await page.route('**/v1/me/authz', swap); await page.route('**/analytics/**', swap);
await page.addInitScript(() => localStorage.setItem('i18nextLng', 'es'));
await page.goto(FRONT + '/admin/login'); await page.locator('input[type=email]').fill(u.email); await page.locator('input[type=password]').fill('x'); await page.getByRole('button', { name: /Iniciar sesión/i }).click();
await page.waitForURL((url) => !url.pathname.includes('login'), { timeout: 20000 });

let atual = null; const feitos = [], faltou = [];
for (const [recurso, rota, aba, seletor] of MAPA) {
  if (atual !== rota) { await page.goto(FRONT + rota, { waitUntil: 'networkidle' }); await page.waitForTimeout(1200); atual = rota; }
  if (aba) { await page.locator('button').filter({ hasText: new RegExp('^' + aba + '$') }).first().click(); await page.waitForTimeout(700); }
  const el = page.locator(seletor).first();
  if (await el.count() === 0) { faltou.push(recurso + ' (' + seletor + ')'); continue; }
  await el.scrollIntoViewIfNeeded();
  if (seletor === 'main') { await page.screenshot({ path: OUT + recurso + '.png', clip: { x: 200, y: 0, width: 1160, height: 700 } }); }
  else { await el.screenshot({ path: OUT + recurso + '.png' }); }
  feitos.push(recurso);
}
await browser.close();
console.log('capturados: ' + feitos.length + ' → ' + OUT);
if (faltou.length) { console.log('FALTOU: ' + faltou.join(', ')); process.exit(1); }
