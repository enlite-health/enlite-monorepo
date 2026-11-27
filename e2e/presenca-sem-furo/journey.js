// Jornada da F9 (emenda 077 "presenca sem furo"), dirigida por e2e/presenca-sem-furo.sh. Dado 100% sintetico, tudo em 127.0.0.1.
// NODE_PATH = worker-functions/node_modules (pg, uuid). Saida: SO contagens e codigos.
const { execFileSync } = require('child_process');
const path = require('path');
const { Pool } = require('pg');
const { v4: uuid } = require('uuid');

const H = '127.0.0.1';
const WF = process.env.WF_URL || `http://${H}:8671`;
const ATT = process.env.ATT_URL || `http://${H}:8672`;
const CLOCK = process.env.ATT_CLOCK_URL || `http://${H}:8673`;
const WF_DB = process.env.WF_DB_URL || `postgresql://enlite_admin:enlite_password@${H}:5671/enlite_e2e`;
const ATT_DB = process.env.ATT_OWNER_URL || `postgres://enlite_owner:pr806-owner-local@${H}:5672/attendance_local`;
const SECRET = process.env.INTERNAL_TOKEN_SECRET || 'test-secret-for-e2e-only';
const WFDIR = path.resolve(__dirname, '../../worker-functions');
for (const u of [WF, ATT, CLOCK, WF_DB, ATT_DB]) if (!new RegExp(`(//|@)${H}[:/]`).test(u)) { console.error('RECUSADO: alvo fora de 127.0.0.1'); process.exit(2); }

const wfDb = new Pool({ connectionString: WF_DB, max: 2 });
const attDb = new Pool({ connectionString: ATT_DB, max: 2 });
const MIN = 60_000, iso = (ms) => new Date(ms).toISOString();
const mock = (o) => 'mock_' + Buffer.from(JSON.stringify(o)).toString('base64');
const P = { lat: -34.6037, lng: -58.3816 };

async function http(method, url, { token, body, headers = {} } = {}) {
  const r = await fetch(url, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t.slice(0, 120); }
  return { status: r.status, body: j };
}
const setClock = (at) => http('POST', `${CLOCK}/clock`, { body: at ? { at: iso(at) } : {} });
const asWorker = (s) => mock({ uid: s.uid, email: s.email, role: 'worker', country: 'AR' });

function opOf(type, s, at, o = {}) {
  const pos = { lat: P.lat + (o.dLat || 0), lng: P.lng, accuracy_m: 10, is_mock: !!o.mock, at: iso(at) };
  return { op_id: uuid(), kind: 'EVENT', type, device_at: iso(at), payload: { occurrence_id: s.occurrenceId, slot_id: s.slotId, on_date: s.onDate, device_at: iso(at), was_offline: false, position: pos, gate: null, local_verdict: o.verdict || 'INSIDE', ...(o.reason ? { exception_reason: o.reason } : {}) } };
}
async function ops(s, list) {
  const r = await http('POST', `${ATT}/internal/v1/ops`, { token: asWorker(s), body: { ops: list }, headers: { 'x-app-version': 'qa-806' } });
  return r.status === 200 ? r.body.results.map((x) => `${x.status}${x.reason ? ':' + x.reason : ''}`).join(',') : `HTTP ${r.status}`;
}
/** Roda `fn` com o relogio DA APP do attendance em `at` e SEMPRE volta ao real. */
async function atClock(at, fn) { await setClock(at); try { return await fn(); } finally { await setClock(null); } }

async function attCount(workerIds, sql) {
  let n = 0;
  for (const w of workerIds) {
    const c = await attDb.connect();
    try { await c.query('BEGIN'); await c.query(`SELECT set_config('app.worker_id',$1,true)`, [w]); n += Number((await c.query(sql)).rows[0].n); await c.query('ROLLBACK'); } finally { c.release(); }
  }
  return n;
}
async function counts(sc) {
  const w = sc.shifts.map((s) => s.workerId), occ = sc.shifts.map((s) => s.occurrenceId);
  const wf = async (sql, p) => Number((await wfDb.query(sql, p)).rows[0].n);
  return {
    'check_attempt server_reason=MOCK_LOCATION': await attCount(w, `SELECT count(*) n FROM attendance.check_attempt WHERE server_reason='MOCK_LOCATION'`),
    'presence_exception PENDING': await attCount(w, `SELECT count(*) n FROM attendance.presence_exception_state WHERE state='PENDING'`),
    'shift_attendance CLOSED_DECLARED': await attCount(w, `SELECT count(*) n FROM attendance.shift_attendance WHERE status='CLOSED_DECLARED'`),
    'daily_reports': await wf(`SELECT count(*) n FROM daily_reports WHERE worker_id = ANY($1::uuid[])`, [w]),
    'coordination_alert PRESENCE_OPEN_4H': await wf(`SELECT count(*) n FROM coordination_alert WHERE kind='PRESENCE_OPEN_4H' AND occurrence_id = ANY($1::uuid[])`, [occ]),
    'coordination_alert CHECK_IN_REFUSED_NO_ENTRY': await wf(`SELECT count(*) n FROM coordination_alert WHERE kind='CHECK_IN_REFUSED_NO_ENTRY' AND occurrence_id = ANY($1::uuid[])`, [occ]),
    'coordination_alert_delivery EMAIL SKIPPED_TEST': await wf(`SELECT count(*) n FROM coordination_alert_delivery d JOIN coordination_alert a USING (alert_id) WHERE d.channel='EMAIL' AND d.status='SKIPPED_TEST' AND a.occurrence_id = ANY($1::uuid[])`, [occ]),
    'presence_exception_decision APPROVED': await attCount(w, `SELECT count(*) n FROM attendance.presence_exception_decision WHERE decision='APPROVED'`),
  };
}
const print = (label, c) => { console.log(`-- ${label}`); for (const [k, v] of Object.entries(c)) console.log(`${k}: ${v}`); };
const ZERO = (c) => Object.values(c).every((v) => v === 0);

(async () => {
  const run = process.env.RUN || Date.now().toString(36);
  const out = execFileSync('npx', ['ts-node', '--transpile-only', 'scripts/seed-e2e-itinerario-local.ts', '--dsn', WF_DB, '--run', run], { cwd: WFDIR, encoding: 'utf8' });
  const sc = JSON.parse(out.trim().split('\n').pop());
  const by = Object.fromEntries(sc.shifts.map((s) => [s.case, s]));
  const A = by.REPORT, B = by.REFUSED, C = by.OPEN_4H;
  const fails = [];
  const expect = (cond, msg) => { if (!cond) { fails.push(msg); console.log(`FALHA: ${msg}`); } };
  console.log(`run=${run} shifts=${sc.shifts.length} (REPORT, REFUSED, OPEN_4H) master=1`);

  const before = await counts(sc);
  print('controle (antes da jornada)', before);
  expect(ZERO(before), 'controle: as 8 contagens deveriam ser 0 antes da jornada');

  // ---- A: entrada fora do raio COM motivo -> excecao PENDING; report bloqueado ate haver saida
  const tA = Date.parse(A.startsAt) + 10 * MIN;
  console.log('A check-in fora do raio (GPS_INDOOR):', await atClock(tA, () => ops(A, [opOf('CHECK_IN', A, tA, { dLat: 0.045, verdict: 'OUTSIDE', reason: 'GPS_INDOOR' })])));
  const answers = [
    { objectiveId: sc.catalog.objAut, scaleCode: 'AUT', optionCode: 'no_lo_hizo', reasonCode: 'rechazo' },
    { objectiveId: sc.catalog.objSn, scaleCode: 'SN', optionCode: 'si' },
    { objectiveId: sc.catalog.objCnt, scaleCode: 'CNT', countValue: 3 },
    { activityId: sc.catalog.actSn, scaleCode: 'SN', optionCode: 'no' },
  ];
  const report = () => http('PUT', `${WF}/api/workers/me/daily-reports/${reportId}`, { token: asWorker(A), body: { occurrenceId: A.occurrenceId, ptiVersionId: A.ptiVersionId, narrative: 'relato sintetico F9', narrativeSource: 'TYPED', deviceSubmittedAt: iso(Date.now()), appVersion: '1.0.0', answers } });
  const reportId = uuid();
  const r1 = await report();
  console.log(`A report com a presenca ABERTA -> HTTP ${r1.status} ${r1.body && r1.body.code}`);
  expect(r1.status === 409 && r1.body.code === 'daily_report_presence_open', 'report antes da saida deveria ser 409 daily_report_presence_open');
  const mid = await counts(sc);
  console.log(`presence_exception PENDING (instantaneo, antes da decisao): ${mid['presence_exception PENDING']}`);
  const pendingSnapshot = mid['presence_exception PENDING'];

  // ---- A: saida declarada -> CLOSED_DECLARED -> report aceito
  const exitAt = Date.parse(A.endsAt) - 5 * MIN, now = Date.now();
  const decl = { op_id: uuid(), kind: 'EVENT', type: 'CHECK_OUT_DECLARED', device_at: iso(now), payload: { occurrence_id: A.occurrenceId, slot_id: A.slotId, on_date: A.onDate, declared_exit_at: iso(exitAt), device_at: iso(now), app_version: '0.1.0' } };
  console.log('A saida declarada:', await ops(A, [decl]));
  const r2 = await report();
  console.log(`A report depois da declaracao -> HTTP ${r2.status}`);
  expect(r2.status === 201, 'report depois da saida declarada deveria ser 201');

  // ---- B: entrada recusada (posicao simulada) ha 75 min; sem entrada aceita depois
  const tB = Date.now() - 75 * MIN;
  console.log('B check-in com posicao simulada, aparelho diz INSIDE (ha 75 min):', await atClock(tB, () => ops(B, [opOf('CHECK_IN', B, tB, { mock: true, verdict: 'INSIDE' })])));

  // ---- C: entrada aceita, sem saida, turno terminou ha 4 h 30
  const tC = Date.parse(C.startsAt) + 5 * MIN;
  console.log('C check-in dentro do raio:', await atClock(tC, () => ops(C, [opOf('CHECK_IN', C, tC)])));

  // ---- job de alerta (rota interna do WF, a mesma do Scheduler)
  const j1 = await http('POST', `${WF}/api/internal/presence/alerts`, { headers: { 'x-internal-secret': SECRET } });
  console.log('job presence-alerts 1a execucao:', j1.status, JSON.stringify(j1.body));
  const j2 = await http('POST', `${WF}/api/internal/presence/alerts`, { headers: { 'x-internal-secret': SECRET } });
  console.log('job presence-alerts 2a execucao (idempotencia):', j2.status, JSON.stringify(j2.body));

  // ---- decisao da excecao pela rota admin da fila, como Master
  const master = mock({ uid: sc.masterUid, email: sc.masterEmail, role: 'recruiter', country: 'AR' });
  const q = await http('GET', `${WF}/api/admin/presence/review-queue?kind=EXCEPTION_PENDING`, { token: master });
  const items = (q.body && (q.body.data?.items || q.body.items || q.body.data)) || [];
  // a fila nao expoe occurrence_id (so o id do evento): o id da excecao da jornada vem do banco do attendance (RLS por worker)
  const cx = await attDb.connect(); let evId = null;
  try { await cx.query('BEGIN'); await cx.query(`SELECT set_config('app.worker_id',$1,true)`, [A.workerId]); evId = (await cx.query(`SELECT x.event_id FROM attendance.presence_exception_state x JOIN attendance.event e ON e.event_id=x.event_id WHERE e.occurrence_id=$1 AND x.state='PENDING'`, [A.occurrenceId])).rows[0]?.event_id ?? null; await cx.query('ROLLBACK'); } finally { cx.release(); }
  const mine = Array.isArray(items) && evId ? items.find((i) => i.id === evId) : null;
  console.log(`fila (Master) -> HTTP ${q.status}, itens=${Array.isArray(items) ? items.length : '?'}, a da jornada na fila=${!!mine}`);
  expect(q.status === 200 && mine, 'a excecao da jornada deveria estar na fila do Master');
  const eventId = mine && mine.id;
  const d = eventId ? await http('POST', `${WF}/api/admin/presence/exceptions/${eventId}/decision`, { token: master, body: { decision: 'APPROVED', resolution_code: 'INDOOR_CONFIRMED' } }) : { status: 0, body: null };
  console.log(`decisao APPROVED -> HTTP ${d.status}`);
  expect(d.status === 200, 'a decisao deveria devolver 200');

  const after = await counts(sc);
  print('depois da jornada', after);
  const want = { 'check_attempt server_reason=MOCK_LOCATION': 1, 'shift_attendance CLOSED_DECLARED': 1, 'daily_reports': 1, 'coordination_alert PRESENCE_OPEN_4H': 1, 'coordination_alert CHECK_IN_REFUSED_NO_ENTRY': 1, 'presence_exception_decision APPROVED': 1 };
  for (const [k, v] of Object.entries(want)) expect(after[k] === v, `${k}: esperado ${v}, veio ${after[k]}`);
  expect(pendingSnapshot === 1, `presence_exception PENDING (antes da decisao): esperado 1, veio ${pendingSnapshot}`);
  expect(after['presence_exception PENDING'] === 0, 'depois da decisao nao deveria restar PENDING');
  expect(after['coordination_alert_delivery EMAIL SKIPPED_TEST'] >= 2, `coordination_alert_delivery EMAIL SKIPPED_TEST: esperado >=2, veio ${after['coordination_alert_delivery EMAIL SKIPPED_TEST']}`);
  const stat = await wfDb.query(`SELECT d.channel, d.status, count(*)::int n FROM coordination_alert_delivery d JOIN coordination_alert a USING (alert_id) WHERE a.occurrence_id = ANY($1::uuid[]) GROUP BY 1,2 ORDER BY 1,2`, [sc.shifts.map((s) => s.occurrenceId)]);
  console.log('entregas por canal/status:', JSON.stringify(stat.rows));
  const ev = await wfDb.query(`SELECT event, count(*)::int n FROM domain_events GROUP BY 1 ORDER BY 1`);
  const ob = await wfDb.query(`SELECT count(*)::int n FROM messaging_outbox`);
  console.log('domain_events por tipo (banco inteiro):', JSON.stringify(ev.rows), '| messaging_outbox:', ob.rows[0].n);
  await wfDb.end(); await attDb.end();
  console.log(fails.length ? `RESULTADO: ${fails.length} divergencia(s)` : 'RESULTADO: as 8 contagens conferem');
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error('ERRO', e.message); process.exit(3); });
