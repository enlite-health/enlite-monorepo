/**
 * POST /api/auth/claim/{start,confirm} — a sobrevivente sintética que ABSORVEU um login real não é reclamável (P5/A, T190).
 *
 * Cenário: ficha sintética S (auth_uid `anacareimport_*`) que, num merge, engoliu a ficha A de um login real
 * (A.merged_into_id = S.id, A.auth_uid real). Quem só prova o telefone de S não pode herdar o histórico de A.
 *
 *  (a) start com o telefone de S → 200 { noCandidate: true } (a busca não a oferece; nenhum OTP)
 *  (b) confirm direto por candidateWorkerId = S (2ª porta, findById) → recusado (NOT_IMPORTABLE) e S segue intacta
 *  (c) controle positivo: ficha sintética comum (nada absorvido) continua candidata: sid TEST_ no start
 *
 * HTTP real (express numa porta efêmera, rotas `createClaimRoutes` + controller/use cases/WorkerRepository REAIS) contra
 * o BANCO real; confere o banco. Padrão em processo dos e2e da F1 (o setup não sobe container `api`).
 * Só o portão de token é mínimo (aceita `Bearer mock_<b64>` e põe `req.user`): o que se prova é o claim, não a auth.
 * CANAL: nenhum OTP real. E2E_OTP_BYPASS=true → sid `TEST_<uuid>`, TwilioVerifyService nunca fala com o Twilio.
 */
import { Pool } from 'pg';
import express from 'express';
import type { Server } from 'http';
import type { AddressInfo } from 'net';

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';
const OTP = process.env.E2E_OTP_CODE ?? '123456';

describe('claim — sobrevivente sintética que absorveu login real (P5/A)', () => {
  let pool: Pool;
  let server: Server;
  let url = '';
  const stamp = `${Date.now()}`;
  const digits8 = stamp.slice(-8);
  const phoneSobrevivente = `54913${digits8}`;
  const phoneComum = `54914${digits8}`;
  const uidSobrevivente = `anacareimport_p5_${stamp}`;
  const uidComum = `anacareimport_p5c_${stamp}`;
  const uidRealAbsorvido = `uid-real-absorvido-${stamp}`;
  const uidQuemReclama = `uid-reclama-${stamp}`;
  const emailQuemReclama = `reclama-${stamp}@exemplo.test`;
  let sobreviventeId = '';
  let absorvidaId = '';
  let comumId = '';

  const post = async (path: string, body: Record<string, unknown>) => {
    const token = Buffer.from(JSON.stringify({ uid: uidQuemReclama, email: emailQuemReclama })).toString('base64');
    const res = await fetch(`${url}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer mock_${token}` },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, data: text ? JSON.parse(text) : {} };
  };
  const authUidDe = async (id: string) =>
    (await pool.query('SELECT auth_uid FROM workers WHERE id = $1', [id])).rows[0].auth_uid as string;
  const insert = async (authUid: string, email: string, phone: string | null) =>
    (
      await pool.query(
        `INSERT INTO workers (id, auth_uid, email, phone, status, country, created_at, updated_at)
         VALUES (gen_random_uuid(), $1, $2, $3, 'INCOMPLETE_REGISTER', 'AR', NOW(), NOW()) RETURNING id`,
        [authUid, email, phone],
      )
    ).rows[0].id as string;

  beforeAll(async () => {
    process.env.E2E_OTP_BYPASS = 'true';
    delete process.env.K_SERVICE;
    pool = new Pool({ connectionString: DATABASE_URL });
    const { createClaimController } = await import('../../src/bootstrap/createClaimController');
    const { createClaimRoutes } = await import('../../src/modules/auth/interfaces/routes/claimRoutes');
    const authMiddleware = {
      requireAuth: () => (req: any, res: any, next: any) => {
        const m = /^Bearer mock_(.+)$/.exec(req.headers.authorization ?? '');
        if (!m) return res.status(401).json({ success: false, error: 'unauthorized' });
        req.user = JSON.parse(Buffer.from(m[1], 'base64').toString());
        next();
      },
    };
    const app = express();
    app.use(express.json());
    app.use('/api', createClaimRoutes(createClaimController(), authMiddleware as any));
    server = app.listen(0);
    await new Promise<void>((r) => server.once('listening', () => r()));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    sobreviventeId = await insert(uidSobrevivente, `sobrev-${stamp}@exemplo.test`, phoneSobrevivente);
    absorvidaId = await insert(uidRealAbsorvido, `absorvida-${stamp}@exemplo.test`, null);
    await pool.query('UPDATE workers SET merged_into_id = $1 WHERE id = $2', [sobreviventeId, absorvidaId]);
    comumId = await insert(uidComum, `comum-${stamp}@exemplo.test`, phoneComum);
  });

  afterAll(async () => {
    for (const id of [absorvidaId, sobreviventeId, comumId]) {
      if (id) await pool.query('DELETE FROM workers WHERE id = $1', [id]).catch(() => {});
    }
    await new Promise<void>((r) => server.close(() => r()));
    await pool.end();
  });

  it('(a) a busca NÃO oferece a sobrevivente que absorveu login real: 200 noCandidate, sem sid', async () => {
    const res = await post(
      '/api/auth/claim/start',
      { email: emailQuemReclama, phone: `+${phoneSobrevivente}` }
    );
    expect(res.status).toBe(200);
    expect(res.data).toEqual({ success: true, data: { noCandidate: true } });
    expect(JSON.stringify(res.data)).not.toContain(sobreviventeId);
  });

  it('(b) o confirm por candidateWorkerId = sobrevivente é recusado e a ficha segue intacta', async () => {
    const res = await post(
      '/api/auth/claim/confirm',
      { verificationSid: 'TEST_p5-nao-importa', otp: OTP, email: emailQuemReclama, candidateWorkerId: sobreviventeId }
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect(await authUidDe(sobreviventeId)).toBe(uidSobrevivente);
  });

  it('(c) controle positivo: ficha sintética comum continua candidata (sid TEST_, sem canal real)', async () => {
    const res = await post(
      '/api/auth/claim/start',
      { email: emailQuemReclama, phone: `+${phoneComum}` }
    );
    expect(res.status).toBe(200);
    const data = res.data.data as { candidateWorkerId: string; verificationSid: string };
    expect(data.candidateWorkerId).toBe(comumId);
    expect(data.verificationSid).toMatch(/^TEST_/);
  });
});
