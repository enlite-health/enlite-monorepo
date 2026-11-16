/**
 * POST /api/workers/init — claim `country` (D731), país da conta nova (D733) e canal app sem ficha (D734).
 * HTTP real numa porta efêmera, banco real, `appChannel()` real (token de serviço `mock_` da mobile-bff-sa, o mesmo
 * de `profileAppChannelNoMirror.e2e.test.ts`). A ÚNICA substituição é o Firebase Admin (dublê em memória de
 * `getUser`/`setCustomUserClaims`, molde de `me-areas-route.e2e.test.ts`): não há Identity Platform no e2e, e o claim
 * gravado é lido de volta DESTE dublê. Fixtures sintéticas `@e2e.local`, sem PII; sem telefone (nenhum OTP).
 */
import express from 'express';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import * as firebaseAdmin from 'firebase-admin';
import { Pool } from 'pg';

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';
const BFF_AUD = 'https://api.enlite.health/mobile-bff';
const SVC = 'mock_' + Buffer.from(JSON.stringify({ email: 'mobile-bff-sa@enlite-e2e.iam.gserviceaccount.com', email_verified: true, aud: BFF_AUD })).toString('base64');
const pessoa = (uid: string) => 'Bearer mock_' + Buffer.from(JSON.stringify({ uid, email: uid + '@e2e.local' })).toString('base64');
const ABAC = { role: 'worker', account_type: 'worker', pid: 'p-e2e', areas: { atendimento: ['worker'] } };

describe('init grava o claim country da ficha (D731/D733/D734)', () => {
  let pool: Pool;
  let server: Server;
  let url = '';
  const stamp = String(Date.now());
  const uid = (n: string) => `e2e-d731-${n}-${stamp}`;
  const claims = new Map<string, Record<string, unknown>>();
  const envAntes: Record<string, string | undefined> = {};
  const setEnv = (k: string, v: string) => { if (!(k in envAntes)) envAntes[k] = process.env[k]; process.env[k] = v; };
  const fichas = async (u: string) => (await pool.query('SELECT country FROM workers WHERE auth_uid = $1', [u])).rows.map((r) => String(r.country).trim());

  async function init(u: string, body: Record<string, unknown>, servico?: string): Promise<number> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json', Authorization: pessoa(u) };
    if (servico) headers['x-enlite-service-token'] = servico;
    return (await fetch(url + '/api/workers/init', { method: 'POST', headers, body: JSON.stringify(body) })).status;
  }

  beforeAll(async () => {
    setEnv('USE_MOCK_AUTH', 'true');
    setEnv('GCP_PROJECT_ID', 'enlite-e2e');
    setEnv('DATABASE_URL', DATABASE_URL);
    pool = new Pool({ connectionString: DATABASE_URL });
    jest.spyOn(firebaseAdmin, 'auth').mockImplementation((() => ({
      getUser: async (u: string) => ({ uid: u, customClaims: claims.get(u) }),
      setCustomUserClaims: async (u: string, c: Record<string, unknown>) => void claims.set(u, c),
    })) as never);
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
    app.post('/api/workers/init', gate, appChannel(), (req, res) => controller.initWorker(req, res));
    server = app.listen(0);
    await new Promise<void>((r) => server.once('listening', () => r()));
    url = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    jest.restoreAllMocks();
    await pool.query('DELETE FROM workers WHERE auth_uid LIKE $1', [`e2e-d731-%-${stamp}`]);
    await new Promise<void>((r) => server.close(() => r()));
    const { DatabaseConnection } = await import('@shared/database/DatabaseConnection');
    await DatabaseConnection.getInstance().close();
    await pool.end();
    for (const [k, v] of Object.entries(envAntes)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  });

  it('T-F0b-42 canal app, conta sem ficha: 404 e NENHUM INSERT em workers, nenhum claim (D734)', async () => {
    const u = uid('app-sem');
    expect(await init(u, { country: 'BR' }, SVC)).toBe(404);
    expect(await fichas(u)).toEqual([]);
    expect(claims.has(u)).toBe(false);
  });

  it('T-F0b-42 controle web (sem token de serviço): conta nova com região BR nasce BR e o claim sai BR (D733)', async () => {
    const u = uid('web-br');
    expect(await init(u, { country: 'BR' })).toBe(201);
    expect(await fichas(u)).toEqual(['BR']);
    expect(claims.get(u)).toEqual({ country: 'BR' });
  });

  it('T-F0b-42 web, região XX: a ficha nasce AR e o claim sai AR (D733)', async () => {
    const u = uid('web-xx');
    expect(await init(u, { country: 'XX' })).toBe(201);
    expect(await fichas(u)).toEqual(['AR']);
    expect(claims.get(u)).toEqual({ country: 'AR' });
  });

  it('T-F0b-42 canal app, ficha AR existente e corpo BR: claim AR da FICHA, claims de ABAC preservados, ficha intacta', async () => {
    const u = uid('app-ficha');
    await pool.query("INSERT INTO workers (auth_uid, email, status, country) VALUES ($1, $2, 'REGISTERED', 'AR')", [u, u + '@e2e.local']);
    claims.set(u, { ...ABAC });
    expect(await init(u, { country: 'BR' }, SVC)).toBe(200);
    expect(claims.get(u)).toEqual({ ...ABAC, country: 'AR' });
    expect(await fichas(u)).toEqual(['AR']);
  });
});
