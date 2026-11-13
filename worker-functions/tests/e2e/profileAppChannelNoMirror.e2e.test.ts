import http from 'http';
import express from 'express';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import { Pool } from 'pg';

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';
const BFF_AUD = 'https://api.enlite.health/mobile-bff';
const svc = (email: string) => 'mock_' + Buffer.from(JSON.stringify({ email, email_verified: true, aud: BFF_AUD })).toString('base64');
const pessoa = (uid: string) => 'Bearer mock_' + Buffer.from(JSON.stringify({ uid, email: uid + '@e2e.local' })).toString('base64');

describe('canal app não espelha no Ana Care (spec 077 FR-54)', () => {
  let pool: Pool;
  let server: Server;
  let stub: http.Server;
  let url = '';
  let stubHits = 0;
  const stamp = String(Date.now());
  const ids: string[] = [];
  const envAntes: Record<string, string | undefined> = {};
  const setEnv = (k: string, v: string) => { if (!(k in envAntes)) envAntes[k] = process.env[k]; process.env[k] = v; };
  async function cuidadora(sufixo: string): Promise<{ uid: string; id: string }> {
    const uid = 'f2b08-' + sufixo + '-' + stamp;
    const r = await pool.query("INSERT INTO workers (auth_uid, email, status, country) VALUES ($1, $2, 'REGISTERED', 'AR') RETURNING id, is_test", [uid, uid + '@e2e.local']);
    expect(r.rows[0].is_test).toBe(false);
    ids.push(r.rows[0].id);
    return { uid, id: r.rows[0].id };
  }
  const espelhos = async (id: string) => Number((await pool.query("SELECT count(*) AS n FROM domain_events WHERE event = 'worker.mirror_requested' AND payload->>'workerId' = $1", [id])).rows[0].n);
  const trilha = async (id: string) => (await pool.query('SELECT DISTINCT source FROM worker_profile_changes_audit WHERE worker_id = $1', [id])).rows.map((r) => r.source);
  async function put(uid: string, servico?: string): Promise<number> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json', Authorization: pessoa(uid) };
    if (servico) headers['x-enlite-service-token'] = servico;
    const res = await fetch(url + '/api/workers/me/general-info', { method: 'PUT', headers, body: JSON.stringify({ firstName: 'Canal', lastName: 'App', profession: 'CAREGIVER', languages: ['es'] }) });
    return res.status;
  }

  beforeAll(async () => {
    setEnv('USE_MOCK_AUTH', 'true');
    setEnv('GCP_PROJECT_ID', 'enlite-e2e');
    setEnv('ANACARE_API_KEY', 'stub-key-e2e-only');
    setEnv('ANACARE_BASE_URL', 'http://127.0.0.1:29997');
    stub = http.createServer((_req, res) => { stubHits += 1; res.writeHead(500); res.end(); });
    await new Promise<void>((r) => stub.listen(29997, '127.0.0.1', () => r()));
    pool = new Pool({ connectionString: DATABASE_URL });
    const { WorkerControllerV2 } = await import('../../src/modules/worker/interfaces/controllers/WorkerControllerV2');
    const { appChannel } = await import('../../src/modules/worker/interfaces/middleware/appChannel');
    const controller = new WorkerControllerV2();
    const gate = (req: any, res: any, next: any) => {
      const m = /^Bearer mock_(.+)$/.exec(req.headers.authorization ?? '');
      if (!m) return res.status(401).json({ success: false });
      req.user = JSON.parse(Buffer.from(m[1], 'base64').toString());
      next();
    };
    const app = express();
    app.use(express.json());
    app.put('/api/workers/me/general-info', gate, appChannel(), (req, res) => controller.saveGeneralInfo(req, res));
    server = app.listen(0);
    await new Promise<void>((r) => server.once('listening', () => r()));
    url = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    for (const id of ids) await pool.query("DELETE FROM domain_events WHERE payload->>'workerId' = $1", [id]).catch(() => undefined);
    for (const id of ids) await pool.query('DELETE FROM workers WHERE id = $1', [id]).catch(() => undefined);
    await new Promise<void>((r) => server.close(() => r()));
    await new Promise<void>((r) => stub.close(() => r()));
    const { DatabaseConnection } = await import('@shared/database/DatabaseConnection');
    await DatabaseConnection.getInstance().close();
    await pool.end();
    for (const [k, v] of Object.entries(envAntes)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  });

  it('T-F2b-08 canal app: 200, zero worker.mirror_requested, trilha app e zero pedido ao stub', async () => {
    const c = await cuidadora('app');
    expect(await put(c.uid, svc('mobile-bff-sa@enlite-e2e.iam.gserviceaccount.com'))).toBe(200);
    expect(await espelhos(c.id)).toBe(0);
    expect(await trilha(c.id)).toEqual(['app']);
    expect(stubHits).toBe(0);
  });

  it('T-F2b-08 controle: sem token de serviço enfileira 1 worker.mirror_requested e a trilha sai platform', async () => {
    const c = await cuidadora('sem');
    expect(await put(c.uid)).toBe(200);
    expect(await espelhos(c.id)).toBe(1);
    expect(await trilha(c.id)).toEqual(['platform']);
  });

  it('T-F2b-08 token de outra SA (header forjado) não marca app e enfileira 1', async () => {
    const c = await cuidadora('outra');
    expect(await put(c.uid, svc('assistants-service-sa@enlite-e2e.iam.gserviceaccount.com'))).toBe(200);
    expect(await espelhos(c.id)).toBe(1);
    expect(await trilha(c.id)).toEqual(['platform']);
  });
});
