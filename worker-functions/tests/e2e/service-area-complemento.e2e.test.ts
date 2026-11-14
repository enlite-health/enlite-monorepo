import http from 'http';
import express from 'express';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import { Pool } from 'pg';

/**
 * D669: o app (BFF) salva a zona sem o complemento — o complemento gravado pela Web não pode sumir.
 * Web/admin omitem o campo para apagar (ServiceAddressTab/WorkerEditModal): esse caminho segue apagando.
 */
const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';
const BFF_AUD = 'https://api.enlite.health/mobile-bff';
const svc = (email: string) => 'mock_' + Buffer.from(JSON.stringify({ email, email_verified: true, aud: BFF_AUD })).toString('base64');
const SERVICO_APP = svc('mobile-bff-sa@enlite-e2e.iam.gserviceaccount.com');
const pessoa = (uid: string) => 'Bearer mock_' + Buffer.from(JSON.stringify({ uid, email: uid + '@e2e.local' })).toString('base64');

describe('PUT /api/workers/me/service-area preserva o complemento (D669)', () => {
  let pool: Pool;
  let server: Server;
  let stub: http.Server;
  let url = '';
  const stamp = String(Date.now());
  const ids: string[] = [];
  const envAntes: Record<string, string | undefined> = {};
  const setEnv = (k: string, v: string) => { if (!(k in envAntes)) envAntes[k] = process.env[k]; process.env[k] = v; };

  async function cuidadora(sufixo: string): Promise<string> {
    const uid = 'd669-' + sufixo + '-' + stamp;
    const r = await pool.query("INSERT INTO workers (auth_uid, email, status, country) VALUES ($1, $2, 'REGISTERED', 'AR') RETURNING id", [uid, uid + '@e2e.local']);
    ids.push(r.rows[0].id);
    return uid;
  }
  async function put(uid: string, corpo: Record<string, unknown>, comoApp: boolean): Promise<number> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json', Authorization: pessoa(uid) };
    if (comoApp) headers['x-enlite-service-token'] = SERVICO_APP;
    const res = await fetch(url + '/api/workers/me/service-area', { method: 'PUT', headers, body: JSON.stringify(corpo) });
    return res.status;
  }
  const zona = async (uid: string) =>
    (await pool.query(
      'SELECT sa.address_line, sa.address_complement, sa.radius_km FROM worker_service_areas sa JOIN workers w ON w.id = sa.worker_id WHERE w.auth_uid = $1',
      [uid],
    )).rows;
  const base = { address: 'Av. Corrientes 1234, Buenos Aires', serviceRadiusKm: 10, lat: -34.6, lng: -58.38 };

  beforeAll(async () => {
    setEnv('USE_MOCK_AUTH', 'true');
    setEnv('GCP_PROJECT_ID', 'enlite-e2e');
    setEnv('ANACARE_API_KEY', 'stub-key-e2e-only');
    setEnv('ANACARE_BASE_URL', 'http://127.0.0.1:29996');
    stub = http.createServer((_req, res) => { res.writeHead(500); res.end(); });
    await new Promise<void>((r) => stub.listen(29996, '127.0.0.1', () => r()));
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
    app.put('/api/workers/me/service-area', gate, appChannel(), (req, res) => controller.saveServiceArea(req, res));
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

  it('app sem complemento depois da Web com complemento: mantém o complemento e troca o resto, em 1 linha', async () => {
    const uid = await cuidadora('app-mantem');
    expect(await put(uid, { ...base, addressComplement: 'Piso 3 B' }, false)).toBe(200);
    expect(await put(uid, { ...base, address: 'Av. Santa Fe 900, Buenos Aires', serviceRadiusKm: 25 }, true)).toBe(200);
    const linhas = await zona(uid);
    expect(linhas).toHaveLength(1);
    expect(linhas[0]).toMatchObject({ address_line: 'Av. Santa Fe 900, Buenos Aires', radius_km: 25, address_complement: 'Piso 3 B' });
  });

  it('app com complemento novo troca; app com string vazia apaga', async () => {
    const uid = await cuidadora('app-troca');
    await put(uid, { ...base, addressComplement: 'Piso 3 B' }, false);
    expect(await put(uid, { ...base, addressComplement: 'Depto 7' }, true)).toBe(200);
    expect((await zona(uid))[0].address_complement).toBe('Depto 7');
    expect(await put(uid, { ...base, addressComplement: '' }, true)).toBe(200);
    expect((await zona(uid))[0].address_complement).toBeNull();
  });

  it('Web sem complemento (campo esvaziado) segue apagando', async () => {
    const uid = await cuidadora('web-apaga');
    await put(uid, { ...base, addressComplement: 'Piso 3 B' }, false);
    expect(await put(uid, base, false)).toBe(200);
    const linhas = await zona(uid);
    expect(linhas).toHaveLength(1);
    expect(linhas[0].address_complement).toBeNull();
  });

  it('pedido que falha no INSERT não deixa a cuidadora sem zona (rollback)', async () => {
    const uid = await cuidadora('rollback');
    await put(uid, { ...base, addressComplement: 'Piso 3 B' }, false);
    // lat fora do domínio da coluna: o INSERT falha depois do DELETE
    const status = await put(uid, { ...base, lat: 1e9, lng: 1e9 }, true);
    expect(status).toBe(400);
    const linhas = await zona(uid);
    expect(linhas).toHaveLength(1);
    expect(linhas[0]).toMatchObject({ address_line: base.address, address_complement: 'Piso 3 B' });
  });
});
