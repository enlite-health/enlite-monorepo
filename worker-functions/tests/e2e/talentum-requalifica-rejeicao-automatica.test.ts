/**
 * talentum-requalifica-rejeicao-automatica.test.ts
 *
 * Regra (Gabriel, 05/11/2026; caso EN1238): o card do Kanban espelha SEMPRE o veredito do Talentum; a "Mover a…" HUMANA nunca é
 * desfeita. Entra pela BORDA: POST real no webhook do Talentum, Postgres real, trilha e gatilho reais. A "Mover a…" humana é o
 * mesmo efeito no banco do `moveApplicationStage` (UPDATE do WJA + encuadre) com `app.current_uid` carimbado como o
 * `withActorContext` faz.
 *
 *  (a)  NOT_QUALIFIED (auto) → QUALIFIED: card QUALIFIED, encuadre limpo, reversão auditada
 *  (a2) NOT_QUALIFIED (auto) → IN_DOUBT: card IN_DOUBT
 *  (b)  rejeição HUMANA do zero → QUALIFIED: continua REJECTED
 *  (b2) auto, humano move para fora e rejeita de novo → QUALIFIED: continua REJECTED
 *  (c)  nenhuma mensagem ao prestador (só evento qualified source 'talentum'; StageMessageHandler pula o que não é 'kanban')
 */
import { Pool } from 'pg';
import { createApiClient, waitForBackend } from './helpers';
import { envelope, type ResponseBlock } from '../fixtures/talentumPayload';

type Analyzed = ResponseBlock & { score: number; statusLabel: 'QUALIFIED' | 'NOT_QUALIFIED' | 'IN_DOUBT' };

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';
const ENDPOINT = '/api/webhooks/talentum/prescreening';
const KEYS = ['A', 'A2', 'B', 'B2', 'C'] as const;
type Key = (typeof KEYS)[number];
const PSC = (k: Key) => `rrej-psc-${k}`;
const PROF = (k: Key) => `rrej-prof-${k}`;
const EMAIL = (k: Key) => `rrej.${k.toLowerCase()}@test.local`;
const TITLE: Record<Key, string> = { A: 'CASO 811 RREJ A', A2: 'CASO 812 RREJ A2', B: 'CASO 813 RREJ B', B2: 'CASO 814 RREJ B2', C: 'CASO 815 RREJ C' };
const PHONE: Record<Key, string> = { A: '+5491181100001', A2: '+5491181200001', B: '+5491181300001', B2: '+5491181400001', C: '+5491181500001' };

describe('Talentum — veredito positivo desfaz a rejeição AUTOMÁTICA (webhook real)', () => {
  let api: ReturnType<typeof createApiClient>;
  let pool: Pool;
  const wid = {} as Record<Key, string>;
  const jid = {} as Record<Key, string>;

  const send = (k: Key, label: Analyzed['statusLabel']) =>
    api.post(ENDPOINT, envelope({
      subtype: 'ANALYZED',
      prescreening: { id: PSC(k), name: TITLE[k] },
      profile: { id: PROF(k), email: EMAIL(k), phoneNumber: PHONE[k], cuil: `20-8${PHONE[k].slice(-7)}-1` },
      response: { id: `rrej-resp-${k}-${label}`, state: [], score: 80, statusLabel: label } as Analyzed,
    }));
  const stage = async (k: Key) => (await pool.query(
    `SELECT application_funnel_stage AS s FROM worker_job_applications WHERE worker_id=$1 AND job_posting_id=$2`, [wid[k], jid[k]])).rows[0]?.s;
  const encuadre = async (k: Key) => (await pool.query(
    `SELECT resultado, rejection_reason_category AS cat FROM encuadres WHERE worker_id=$1 AND job_posting_id=$2`, [wid[k], jid[k]])).rows[0];
  const events = async (k: Key, event: string) => (await pool.query(
    `SELECT status, payload FROM domain_events WHERE event=$1 AND payload->>'workerId'=$2 AND payload->>'jobPostingId'=$3`, [event, wid[k], jid[k]])).rows;

  /** "Mover a…" humano: UPDATE do WJA (+ encuadre) na transação com o uid carimbado, como o withActorContext. */
  const humanMove = async (k: Key, target: 'REJECTED' | 'SELECTED') => {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.current_uid', 'uid-humano-rrej', true)`);
      await c.query(`UPDATE worker_job_applications SET application_funnel_stage=$3, updated_at=NOW() WHERE worker_id=$1 AND job_posting_id=$2`, [wid[k], jid[k], target]);
      await c.query(
        target === 'REJECTED'
          ? `UPDATE encuadres SET resultado='RECHAZADO', rejection_reason_category='DISTANCE', updated_at=NOW() WHERE worker_id=$1 AND job_posting_id=$2`
          : `UPDATE encuadres SET resultado=NULL, rejection_reason_category=NULL, updated_at=NOW() WHERE worker_id=$1 AND job_posting_id=$2`,
        [wid[k], jid[k]]);
      await c.query('COMMIT');
    } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
  };

  async function clean() {
    const w = Object.values(wid).filter(Boolean);
    const j = Object.values(jid).filter(Boolean);
    if (!w.length) return;
    await pool.query(`DELETE FROM worker_job_applications WHERE worker_id = ANY($1::uuid[])`, [w]);
    await pool.query(`DELETE FROM encuadres WHERE worker_id = ANY($1::uuid[])`, [w]);
    await pool.query(`DELETE FROM talentum_prescreening_responses WHERE prescreening_id IN (SELECT id FROM talentum_prescreenings WHERE talentum_prescreening_id LIKE 'rrej-psc-%')`);
    await pool.query(`DELETE FROM talentum_prescreenings WHERE talentum_prescreening_id LIKE 'rrej-psc-%'`);
    await pool.query(`DELETE FROM domain_events WHERE payload->>'workerId' = ANY($1::text[])`, [w]);
    void j;
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    api = createApiClient();
    await waitForBackend(api);
    await pool.query(`DELETE FROM workers WHERE email = ANY($1::text[])`, [KEYS.map(EMAIL)]);
    await pool.query(`DELETE FROM job_postings WHERE title = ANY($1::text[])`, [Object.values(TITLE)]);
    for (const k of KEYS) {
      wid[k] = (await pool.query(`INSERT INTO workers (auth_uid, email, status) VALUES ($1, $2, 'INCOMPLETE_REGISTER') RETURNING id`, [`talentum_${PROF(k)}`, EMAIL(k)])).rows[0].id;
      jid[k] = (await pool.query(`INSERT INTO job_postings (title, description, status) VALUES ($1, 'test', 'SEARCHING') RETURNING id`, [TITLE[k]])).rows[0].id;
    }
  });

  afterEach(clean);

  afterAll(async () => {
    await clean();
    await pool.query(`DELETE FROM job_postings WHERE id = ANY($1::uuid[])`, [Object.values(jid)]);
    await pool.query(`DELETE FROM workers WHERE id = ANY($1::uuid[])`, [Object.values(wid)]);
    await pool.end();
  });

  it('(a) NOT_QUALIFIED automático e depois QUALIFIED: card QUALIFIED, encuadre limpo, reversão auditada', async () => {
    expect((await send('A', 'NOT_QUALIFIED')).status).toBe(200);
    expect(await stage('A')).toBe('REJECTED');
    expect(await encuadre('A')).toEqual({ resultado: 'RECHAZADO', cat: 'TALENTUM_NOT_QUALIFIED' });

    expect((await send('A', 'QUALIFIED')).status).toBe(200);

    expect(await stage('A')).toBe('QUALIFIED');
    expect(await encuadre('A')).toEqual({ resultado: null, cat: null });
    const rev = await events('A', 'funnel_stage.rejection_reverted');
    expect(rev).toHaveLength(1);
    expect(rev[0].status).toBe('processed');
  });

  it('(a2) NOT_QUALIFIED automático e depois IN_DOUBT: card IN_DOUBT e encuadre limpo', async () => {
    await send('A2', 'NOT_QUALIFIED');
    await send('A2', 'IN_DOUBT');
    expect(await stage('A2')).toBe('IN_DOUBT');
    expect(await encuadre('A2')).toEqual({ resultado: null, cat: null });
  });

  it('(b) rejeição HUMANA do zero e depois QUALIFIED: continua REJECTED e o encuadre RECHAZADO fica', async () => {
    await send('B', 'IN_DOUBT');
    await humanMove('B', 'REJECTED');
    expect(await stage('B')).toBe('REJECTED');

    await send('B', 'QUALIFIED');

    expect(await stage('B')).toBe('REJECTED');
    expect(await encuadre('B')).toEqual({ resultado: 'RECHAZADO', cat: 'DISTANCE' });
    expect(await events('B', 'funnel_stage.rejection_reverted')).toHaveLength(0);
  });

  it('(b2) automática, humano move para fora e rejeita DE NOVO, depois QUALIFIED: continua REJECTED', async () => {
    await send('B2', 'NOT_QUALIFIED');
    await humanMove('B2', 'SELECTED');
    await humanMove('B2', 'REJECTED');

    await send('B2', 'QUALIFIED');

    expect(await stage('B2')).toBe('REJECTED');
    expect((await encuadre('B2')).resultado).toBe('RECHAZADO');
    expect(await events('B2', 'funnel_stage.rejection_reverted')).toHaveLength(0);
  });

  it('(c) nenhuma mensagem ao prestador: só o evento qualified com source talentum (não kanban), reversão processed', async () => {
    await send('C', 'NOT_QUALIFIED');
    await send('C', 'QUALIFIED');

    const q = await events('C', 'funnel_stage.qualified');
    expect(q).toHaveLength(1);
    expect(q[0].payload.source).toBe('talentum');
    const pendentes = (await pool.query(
      `SELECT event FROM domain_events WHERE payload->>'workerId'=$1 AND payload->>'jobPostingId'=$2 AND status <> 'processed' AND event <> 'funnel_stage.qualified'`,
      [wid.C, jid.C])).rows;
    expect(pendentes).toEqual([]);
  });
});
