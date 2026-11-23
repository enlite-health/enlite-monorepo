/**
 * POST /api/workers/init — telefone de worker existente (FR-88/C-43, DT-51), pela BORDA: HTTP real numa porta efêmera,
 * WorkerControllerV2 + InitWorkerUseCase + WorkerRepository REAIS, Postgres real, sem mock de dado. Só o claim `country`
 * usa o adapter em memória do USE_MOCK_AUTH (não há Identity Platform no e2e). Fixtures `@e2e.local`; telefones
 * derivados do carimbo (sem PII). Nenhum caso dispara OTP (canal real): CLAIM_PENDING fica fora até a decisão do item
 * "ficha importada para conta que já tem auth_uid".
 */
import express from 'express';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import { Pool } from 'pg';

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';
const pessoa = (uid: string) => 'Bearer mock_' + Buffer.from(JSON.stringify({ uid, email: uid + '@e2e.local', email_verified: true })).toString('base64');

describe('init: telefone do worker existente pela borda (PR-INF-34)', () => {
  let pool: Pool;
  let server: Server;
  let url = '';
  const stamp = String(Date.now());
  const uid = (n: string) => `e2e-pi34h-${n}-${stamp}`;
  const phone = (n: number) => `549${String(Number(stamp.slice(-7)) * 10 + n).padStart(10, '0').slice(-10)}`;
  const envAntes: Record<string, string | undefined> = {};
  const setEnv = (k: string, v: string) => { if (!(k in envAntes)) envAntes[k] = process.env[k]; process.env[k] = v; };

  const ficha = async (n: string, tel: string | null) =>
    (await pool.query(
      "INSERT INTO workers (auth_uid, email, phone, status, country) VALUES ($1, $2, $3, 'REGISTERED', 'AR') RETURNING id",
      [uid(n), uid(n) + '@e2e.local', tel],
    )).rows[0].id as string;
  const phoneOf = async (n: string) => (await pool.query('SELECT phone FROM workers WHERE auth_uid = $1', [uid(n)])).rows[0].phone as string | null;
  async function init(n: string, body: Record<string, unknown>) {
    const res = await fetch(url + '/api/workers/init', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: pessoa(uid(n)) }, body: JSON.stringify(body),
    });
    return { status: res.status, text: await res.text() };
  }
  const json = (t: string) => JSON.parse(t);

  beforeAll(async () => {
    setEnv('USE_MOCK_AUTH', 'true');
    setEnv('GCP_PROJECT_ID', 'enlite-e2e');
    setEnv('DATABASE_URL', DATABASE_URL);
    pool = new Pool({ connectionString: DATABASE_URL });
    const { WorkerControllerV2 } = await import('../../src/modules/worker/interfaces/controllers/WorkerControllerV2');
    const controller = new WorkerControllerV2();
    const gate = (req: any, res: any, next: any) => {
      const m = /^Bearer mock_(.+)$/.exec(req.headers.authorization ?? '');
      if (!m) return res.status(401).json({ success: false });
      req.user = JSON.parse(Buffer.from(m[1], 'base64').toString());
      req.user.emailVerified = req.user.email_verified === true;
      next();
    };
    const app = express();
    app.use(express.json());
    app.post('/api/workers/init', gate, (req, res) => controller.initWorker(req, res));
    server = app.listen(0);
    await new Promise<void>((r) => server.once('listening', () => r()));
    url = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await pool.query('DELETE FROM workers WHERE auth_uid LIKE $1', [`e2e-pi34h-%-${stamp}`]);
    await new Promise<void>((r) => server.close(() => r()));
    const { DatabaseConnection } = await import('@shared/database/DatabaseConnection');
    await DatabaseConnection.getInstance().close();
    await pool.end();
    for (const [k, v] of Object.entries(envAntes)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  });

  it('T-F3c-55 OK: ficha sem telefone + celular livre → 200 code OK e o celular gravado no banco', async () => {
    await ficha('ok', null);
    const r = await init('ok', { phone: `+${phone(1)}` });
    expect(r.status).toBe(200);
    expect(json(r.text).data).toMatchObject({ status: 'ok', code: 'OK' });
    expect(await phoneOf('ok')).toBe(phone(1));
  });

  it('T-F3c-55 PHONE_LOCKED (outro número): ficha com telefone → 200 code PHONE_LOCKED e o telefone não muda', async () => {
    await ficha('lock', phone(2));
    const r = await init('lock', { phone: `+${phone(3)}` });
    expect(r.status).toBe(200);
    expect(json(r.text).data).toMatchObject({ status: 'ok', code: 'PHONE_LOCKED' });
    expect(await phoneOf('lock')).toBe(phone(2));
  });

  it('T-F3c-55 PHONE_LOCKED (mesmo número): idempotente → 200 code OK e nada é regravado', async () => {
    await ficha('igual', phone(4));
    const antes = (await pool.query('SELECT updated_at FROM workers WHERE auth_uid = $1', [uid('igual')])).rows[0].updated_at;
    const r = await init('igual', { phone: `+${phone(4)}` });
    expect(r.status).toBe(200);
    expect(json(r.text).data).toMatchObject({ status: 'ok', code: 'OK' });
    expect(await phoneOf('igual')).toBe(phone(4));
    expect((await pool.query('SELECT updated_at FROM workers WHERE auth_uid = $1', [uid('igual')])).rows[0].updated_at).toEqual(antes);
  });

  it('T-F3c-55 PHONE_IN_USE: celular de outra conta real → 409 code, sem texto do banco nem o número, nada gravado', async () => {
    await ficha('dona', phone(5));
    await ficha('quer', null);
    const r = await init('quer', { phone: `+${phone(5)}` });
    expect(r.status).toBe(409);
    expect(json(r.text)).toMatchObject({ success: false, code: 'PHONE_IN_USE' });
    expect(r.text).not.toMatch(/duplicate key|already exists/);
    expect(r.text).not.toContain(phone(5));
    expect(await phoneOf('quer')).toBeNull();
  });

  it('T-F3c-55 INVALID_PHONE: telefone curto → 422 code e nada gravado', async () => {
    await ficha('inv', null);
    const r = await init('inv', { phone: '12345' });
    expect(r.status).toBe(422);
    expect(json(r.text)).toMatchObject({ success: false, code: 'INVALID_PHONE' });
    expect(await phoneOf('inv')).toBeNull();
  });
});
