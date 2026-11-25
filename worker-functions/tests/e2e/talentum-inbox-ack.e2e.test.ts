/**
 * talentum-inbox-ack.e2e.test.ts — spec 095 §3.2 (T-095-25 + teste do T-095-31).
 *
 * Pela borda (HTTP real, banco real, sem mock de rota), só com payload sintético:
 *   T3  o webhook responde 200 `{ received: true }`, guarda a linha RECEIVED na inbox e NÃO toca o espelho
 *       (`talentum_prescreenings`); só o redrive (`/api/internal/talentum/inbox/redrive`) o atualiza.
 *   T4  o mesmo corpo 2× → 1 linha só, as duas respostas 200.
 *   T31 as rotas internas: sem `X-Internal-Secret` → 403; `redrive` sem corpo/ambíguo/fora do teto → 400 e nenhuma linha
 *       muda de estado; `process` com push válido de uma linha RECEIVED → 200 e PROCESSED; push inválido → 400.
 *
 * Rota do webhook: POST /api/webhooks-test/talentum/prescreening (USE_MOCK_AUTH=true bypassa a partner key).
 * O `PubSubClient` é mock em NODE_ENV=test: o publish do ack não dispara o processador, quem processa é o redrive/process.
 * O KMS em NODE_ENV=test é passthrough base64 (`KMSEncryptionService.testMode`): o teste prova que o corpo NÃO está em
 * texto plano em `payload_enc`, não que a cifra é a de produção.
 */
import { Pool } from 'pg';
import { createApiClient, waitForBackend } from './helpers';
import { envelope } from '../fixtures/talentumPayload';

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';
const WEBHOOK = '/api/webhooks-test/talentum/prescreening';
const PROCESS = '/api/internal/talentum/inbox/process';
const REDRIVE = '/api/internal/talentum/inbox/redrive';

const RUN = Date.now().toString(36);
const PSC = (n: string) => `ack95-${RUN}-psc-${n}`;
const PROF = (n: string) => `ack95-${RUN}-prof-${n}`;
/** Valor sentinela: nome do profile. Se aparecer em `payload_enc`, o corpo foi gravado em texto plano. */
const SENTINEL = `SentinelaAck${RUN}`;

const internalHeaders = () => ({ 'X-Internal-Secret': process.env.INTERNAL_TOKEN_SECRET || 'test-secret-for-e2e-only' });

function body(n: string, subtype: 'INITIATED' | 'COMPLETED', firstName = 'Ana') {
  return envelope({
    subtype,
    prescreening: { id: PSC(n), name: `Caso Ack ${n}` },
    profile: {
      id: PROF(n),
      firstName,
      lastName: 'Sintetica',
      email: `ack95.${RUN}.${n}@e2e.local`,
      phoneNumber: '+5491155559501',
    },
    response: { id: `ack95-${RUN}-resp-${n}`, state: [] },
  });
}

describe('Talentum — ack rápido do webhook e rotas internas da inbox (spec 095)', () => {
  const api = createApiClient();
  let pool: Pool;

  const inboxRows = async (n: string) =>
    (
      await pool.query(
        `SELECT id, state, payload_enc FROM talentum_webhook_inbox
          WHERE talentum_prescreening_id = $1 ORDER BY received_at, id`,
        [PSC(n)],
      )
    ).rows as Array<{ id: string; state: string; payload_enc: string | null }>;

  const mirror = async (n: string) =>
    (
      await pool.query(
        `SELECT status, updated_at FROM talentum_prescreenings WHERE talentum_prescreening_id = $1`,
        [PSC(n)],
      )
    ).rows as Array<{ status: string; updated_at: Date }>;

  const stateCounts = async () =>
    (await pool.query(`SELECT state, count(*)::int AS n FROM talentum_webhook_inbox GROUP BY state ORDER BY state`)).rows;

  const redriveKey = (n: string) =>
    api.post(REDRIVE, { talentumPrescreeningId: PSC(n), talentumProfileId: PROF(n) }, { headers: internalHeaders() });

  beforeAll(async () => {
    await waitForBackend(api);
    pool = new Pool({ connectionString: DATABASE_URL });
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM talentum_webhook_inbox WHERE talentum_prescreening_id LIKE $1`, [`ack95-${RUN}-%`]);
    await pool.query(`DELETE FROM talentum_prescreenings WHERE talentum_prescreening_id LIKE $1`, [`ack95-${RUN}-%`]);
    await pool.end();
  });

  describe('T3 — ack só guarda; o redrive é quem atualiza o espelho', () => {
    it('INITIATED: 200, linha RECEIVED, espelho ausente; redrive → PROCESSED e espelho INITIATED', async () => {
      const res = await api.post(WEBHOOK, body('t3', 'INITIATED', SENTINEL));
      expect(res.status).toBe(200);
      expect(res.data).toEqual({ received: true });

      const rows = await inboxRows('t3');
      expect(rows).toHaveLength(1);
      expect(rows[0].state).toBe('RECEIVED');
      expect(await mirror('t3')).toHaveLength(0);

      const drive = await redriveKey('t3');
      expect(drive.status).toBe(200);
      expect(drive.data).toEqual({ selected: 1, processed: 1, failed: 0 });
      expect((await inboxRows('t3'))[0].state).toBe('PROCESSED');
      const m = await mirror('t3');
      expect(m).toHaveLength(1);
      expect(m[0].status).toBe('INITIATED');
    });

    it('COMPLETED: 200 e espelho INALTERADO (lido do banco); só o redrive o leva a COMPLETED', async () => {
      const before = await mirror('t3');
      expect(before).toHaveLength(1);

      const res = await api.post(WEBHOOK, body('t3', 'COMPLETED'));
      expect(res.status).toBe(200);
      expect(res.data).toEqual({ received: true });

      const rows = await inboxRows('t3');
      expect(rows.map((r) => r.state)).toEqual(['PROCESSED', 'RECEIVED']);
      expect(await mirror('t3')).toEqual(before); // status e updated_at idênticos: o ack não executou o caso de uso

      const drive = await redriveKey('t3');
      expect(drive.status).toBe(200);
      expect(drive.data).toEqual({ selected: 1, processed: 1, failed: 0 });
      expect((await inboxRows('t3')).map((r) => r.state)).toEqual(['PROCESSED', 'PROCESSED']);
      expect((await mirror('t3'))[0].status).toBe('COMPLETED');
    });

    it('payload_enc não guarda o corpo em texto plano', async () => {
      const [first] = await inboxRows('t3');
      expect(first.payload_enc).toBeTruthy();
      expect(first.payload_enc).not.toContain(SENTINEL);
      expect(first.payload_enc).not.toContain('ack95.');
    });
  });

  describe('T4 — o mesmo corpo 2× guarda 1 linha', () => {
    it('duas respostas 200 e uma linha só', async () => {
      const payload = body('t4', 'INITIATED');
      const first = await api.post(WEBHOOK, payload);
      const second = await api.post(WEBHOOK, payload);
      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(second.data).toEqual({ received: true });
      expect(await inboxRows('t4')).toHaveLength(1);
    });
  });

  describe('T-095-31 — rotas internas', () => {
    it('a) sem X-Internal-Secret → 403 nas duas rotas', async () => {
      const proc = await api.post(PROCESS, { message: { data: Buffer.from('{}').toString('base64') } });
      const drive = await api.post(REDRIVE, { state: 'FAILED' });
      expect(proc.status).toBe(403);
      expect(drive.status).toBe(403);
    });

    it('b) redrive sem corpo / ambíguo / fora do teto → 400 e nenhuma linha muda de estado', async () => {
      await api.post(WEBHOOK, body('t31b', 'INITIATED'));
      expect((await inboxRows('t31b')).map((r) => r.state)).toEqual(['RECEIVED']);
      const before = await stateCounts();

      const bad: unknown[] = [
        undefined,
        {},
        { state: 'RECEIVED', talentumPrescreeningId: PSC('t31b'), talentumProfileId: PROF('t31b') },
        { talentumPrescreeningId: PSC('t31b') },
        { state: 'PROCESSED' },
        { state: 'RECEIVED', limit: 501 },
        { state: 'RECEIVED', limit: 0 },
      ];
      for (const b of bad) {
        const res = await api.post(REDRIVE, b, { headers: internalHeaders() });
        expect(res.status).toBe(400);
      }
      expect(await stateCounts()).toEqual(before);
      expect((await inboxRows('t31b')).map((r) => r.state)).toEqual(['RECEIVED']);
    });

    it('c) process com push válido de uma linha RECEIVED → 200 e PROCESSED; push inválido → 400', async () => {
      await api.post(WEBHOOK, body('t31c', 'INITIATED'));
      const [row] = await inboxRows('t31c');
      expect(row.state).toBe('RECEIVED');

      const push = (data: string) => ({ message: { data, messageId: '1' }, subscription: 'sub' });
      const encode = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64');

      const invalid = [{}, push('%%%nao-base64-json'), push(encode({ semInboxId: true })), push(encode({ inboxId: 'nao-e-uuid' }))];
      const before = await stateCounts();
      for (const b of invalid) {
        const res = await api.post(PROCESS, b, { headers: internalHeaders() });
        expect(res.status).toBe(400);
      }
      expect(await stateCounts()).toEqual(before);

      const ok = await api.post(PROCESS, push(encode({ inboxId: row.id })), { headers: internalHeaders() });
      expect(ok.status).toBe(200);
      expect(ok.data).toEqual({ inboxId: row.id, outcome: 'PROCESSED', processed: 1 });
      expect((await inboxRows('t31c'))[0].state).toBe('PROCESSED');
      expect((await mirror('t31c'))[0].status).toBe('INITIATED');
    });
  });
});
