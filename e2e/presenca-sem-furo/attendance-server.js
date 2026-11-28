// attendance (branch 077/att-806) EM PROCESSO para a F9, no mesmo molde de specs/077-.../f1a-harness/server.js:
//   - banco = o att-postgres do projeto docker presenca806 (owner migra; a app roda como `attendance_sa_test`, a role sem BYPASSRLS);
//   - itinerario = o WF REAL do stack (WORKER_FUNCTIONS_URL), nao stub;
//   - verifier fake do Firebase: aceita o token mock do WF (`mock_<base64 do JSON {uid,country}>`) e o formato `uid:<x>|country:AR`;
//   - verifier fake do OIDC de servico: o WF local roda com ATTENDANCE_AUTH=none (sem Authorization); um middleware SO DESTE HARNESS injeta
//     `Bearer svc:<SA permitida>` nas rotas /internal/v1/presence/* quando o header falta. O guard de producao nao muda.
//   - relogio da APP injetavel (provider `attendance.CLOCK`, o mesmo seam do harness do repo): `POST /clock {"at":"<ISO>"}` fixa, `POST /clock {}` volta ao real.
//     Serve para o fato "recusa ha 75 min" / "check-in numa faixa que ja passou" existir com received_at coerente. NAO e o relogio do sistema.
// Uso: ATT_REPO=<worktree 077-att-806> node attendance-server.js   (porta 8672, controle do relogio 8673; ambos so em 127.0.0.1)
const REPO = process.env.ATT_REPO || '/Users/gabrielstein-dev/projects/enlite/ebrain/repos/_worktrees/077-att-806';
process.chdir(REPO);
require(REPO + '/node_modules/ts-node').register({ project: REPO + '/tsconfig.json', transpileOnly: true, compilerOptions: { module: 'commonjs', moduleResolution: 'node', resolvePackageJsonExports: false } });
require(REPO + '/node_modules/reflect-metadata');
const http = require('http');
const { Test } = require(REPO + '/node_modules/@nestjs/testing');
const { Pool } = require(REPO + '/node_modules/pg');
const { runMigrate } = require(REPO + '/scripts/migrate');
const { AppModule, FIREBASE_AUTH, PG_POOL } = require(REPO + '/src/app.module');
const { TOKEN_VERIFIER } = require(REPO + '/src/interfaces/auth/auth.guard');
const { SERVICE_TOKEN_VERIFIER } = require(REPO + '/src/interfaces/auth/service.guard');
const { TokenInvalidError } = require(REPO + '/src/application/ports/token-verifier.port');

const HOST = '127.0.0.1';
const OWNER = process.env.ATT_OWNER_URL || `postgres://enlite_owner:pr806-owner-local@${HOST}:5672/attendance_local`;
const RUNTIME = process.env.ATT_RUNTIME_URL || `postgres://attendance_sa_test:pr806-runtime-local@${HOST}:5672/attendance_local`;
const WF = process.env.WF_URL || `http://${HOST}:8671`;
const PORT = Number(process.env.ATT_PORT || 8672), CTRL = Number(process.env.ATT_CLOCK_PORT || 8673);
const SVC = 'wf-sa@enlite-test.iam.gserviceaccount.com';
for (const u of [OWNER, RUNTIME, WF]) if (!new RegExp(`^(postgres|http)://([^@/]*@)?${HOST}[:/]`).test(u)) { console.error('FATAL: so 127.0.0.1'); process.exit(1); }

const verifier = {
  verify(jwt) {
    const mock = /^mock_(.+)$/.exec(jwt);
    if (mock) {
      try { const p = JSON.parse(Buffer.from(mock[1], 'base64').toString('utf8')); if (p.uid) return Promise.resolve({ uid: p.uid, country: p.country, claims: {} }); } catch { /* cai no invalido */ }
      return Promise.reject(new TokenInvalidError());
    }
    const m = /^uid:([^|]+)(?:\|country:(.+))?$/.exec(jwt);
    if (!m) return Promise.reject(new TokenInvalidError());
    return Promise.resolve({ uid: m[1], country: m[2], claims: {} });
  },
};
const serviceVerifier = { verify: (t) => (t.startsWith('svc:') ? Promise.resolve({ email: t.slice(4) }) : Promise.reject(new Error('invalid'))) };

(async () => {
  const env = { ...process.env, DATABASE_URL: OWNER };
  for (const argv of [['up'], ['grant-runtime', 'attendance_sa_test']]) {
    const rc = await runMigrate(argv, env, () => undefined, console.error);
    if (rc !== 0) throw new Error('migrate rc=' + rc);
  }
  let fixed = null;
  const pool = new Pool({ connectionString: RUNTIME });
  Object.assign(process.env, { DATABASE_URL: RUNTIME, WORKER_FUNCTIONS_URL: WF, FIREBASE_PROJECT_ID: 'test', SERVICE_AUDIENCE: `http://${HOST}:${PORT}`, ALLOWED_SERVICE_CALLERS: SVC, IDENTITY_CACHE_TTL_S: '60' });
  delete process.env.INSTANCE_CONNECTION_NAME;
  const mod = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(Symbol.for('attendance.CLOCK')).useValue({ now: () => fixed ?? new Date() })
    .overrideProvider(PG_POOL).useValue(pool).overrideProvider(FIREBASE_AUTH).useValue({})
    .overrideProvider(TOKEN_VERIFIER).useValue(verifier).overrideProvider(SERVICE_TOKEN_VERIFIER).useValue(serviceVerifier).compile();
  const app = mod.createNestApplication();
  app.use((req, _res, next) => { if (req.url.startsWith('/internal/v1/presence') && !req.headers.authorization) req.headers.authorization = `Bearer svc:${SVC}`; next(); });
  await app.init();
  await app.listen(PORT, HOST);
  http.createServer((req, res) => {
    let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => {
      try { const j = b ? JSON.parse(b) : {}; fixed = j.at ? new Date(j.at) : null; } catch { res.writeHead(400); return res.end('bad'); }
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ clock: fixed ? fixed.toISOString() : 'real' }));
    });
  }).listen(CTRL, HOST);
  console.log('READY attendance', HOST + ':' + PORT, 'clock-control', CTRL);
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
