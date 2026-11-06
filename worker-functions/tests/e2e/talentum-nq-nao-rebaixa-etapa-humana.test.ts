/**
 * talentum-nq-nao-rebaixa-etapa-humana.test.ts
 *
 * F3 (regra do Gabriel, 05/11/2026): NOT_QUALIFIED do Talentum NÃO rebaixa etapa humana ACIMA de QUALIFIED (CONFIRMED, SELECTED,
 * QUICK_RESPONSE_TEAM). O card mostra o veredito (talentum_prescreenings.status = NOT_QUALIFIED), mas a etapa da WJA e o encuadre
 * ficam com a operação. Etapas <= QUALIFIED seguem para REJECTED. Entra pela BORDA: POST real no webhook, Postgres real.
 *
 *  (a) CONFIRMED / (b) QUICK_RESPONSE_TEAM / (c) SELECTED + NOT_QUALIFIED → etapa e encuadre intactos, sem evento auto_not_qualified
 *  (d) controle QUALIFIED + NOT_QUALIFIED → REJECTED + encuadre RECHAZADO + evento (como hoje)
 * Nenhuma mensagem: os eventos desta transição nascem `processed` (audit-only); o e2e confere que não sobra evento pendente.
 */
import { Pool } from 'pg';
import { createApiClient, waitForBackend } from './helpers';
import { envelope, type ResponseBlock } from '../fixtures/talentumPayload';

type Analyzed = ResponseBlock & { score: number; statusLabel: 'NOT_QUALIFIED' | 'IN_DOUBT' };

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';
const ENDPOINT = '/api/webhooks/talentum/prescreening';
const KEYS = ['CONF', 'QRT', 'SEL', 'CTL'] as const;
type Key = (typeof KEYS)[number];
const START: Record<Key, string> = { CONF: 'CONFIRMED', QRT: 'QUICK_RESPONSE_TEAM', SEL: 'SELECTED', CTL: 'QUALIFIED' };
const PSC = (k: Key) => `nqhum-psc-${k}`;
const PROF = (k: Key) => `nqhum-prof-${k}`;
const EMAIL = (k: Key) => `nqhum.${k.toLowerCase()}@test.local`;
const TITLE: Record<Key, string> = { CONF: 'CASO 821 NQHUM CONF', QRT: 'CASO 822 NQHUM QRT', SEL: 'CASO 823 NQHUM SEL', CTL: 'CASO 824 NQHUM CTL' };
const PHONE: Record<Key, string> = { CONF: '+5491182100001', QRT: '+5491182200001', SEL: '+5491182300001', CTL: '+5491182400001' };

describe('Talentum — NOT_QUALIFIED não rebaixa etapa humana acima de QUALIFIED (webhook real)', () => {
  let api: ReturnType<typeof createApiClient>;
  let pool: Pool;
  const wid = {} as Record<Key, string>;
  const jid = {} as Record<Key, string>;

  const send = (k: Key, label: Analyzed['statusLabel']) =>
    api.post(ENDPOINT, envelope({
      subtype: 'ANALYZED',
      prescreening: { id: PSC(k), name: TITLE[k] },
      profile: { id: PROF(k), email: EMAIL(k), phoneNumber: PHONE[k], cuil: `20-8${PHONE[k].slice(-7)}-2` },
      response: { id: `nqhum-resp-${k}-${label}`, state: [], score: 30, statusLabel: label } as Analyzed,
    }));
  const sendNq = (k: Key) => send(k, 'NOT_QUALIFIED');
  const stage = async (k: Key) => (await pool.query(
    `SELECT application_funnel_stage AS s FROM worker_job_applications WHERE worker_id=$1 AND job_posting_id=$2`, [wid[k], jid[k]])).rows[0]?.s;
  const encuadre = async (k: Key) => (await pool.query(
    `SELECT resultado, rejection_reason_category AS cat FROM encuadres WHERE worker_id=$1 AND job_posting_id=$2`, [wid[k], jid[k]])).rows[0];
  const events = async (k: Key, event: string) => (await pool.query(
    `SELECT status, payload FROM domain_events WHERE event=$1 AND payload->>'workerId'=$2 AND payload->>'jobPostingId'=$3`, [event, wid[k], jid[k]])).rows;
  const verdict = async (k: Key) => (await pool.query(
    `SELECT status FROM talentum_prescreenings WHERE talentum_prescreening_id=$1 AND worker_id=$2`, [PSC(k), wid[k]])).rows.map((r) => r.status);

  async function clean() {
    const w = Object.values(wid).filter(Boolean);
    if (!w.length) return;
    await pool.query(`DELETE FROM worker_job_applications WHERE worker_id = ANY($1::uuid[])`, [w]);
    await pool.query(`DELETE FROM encuadres WHERE worker_id = ANY($1::uuid[])`, [w]);
    await pool.query(`DELETE FROM talentum_prescreening_responses WHERE prescreening_id IN (SELECT id FROM talentum_prescreenings WHERE talentum_prescreening_id LIKE 'nqhum-psc-%')`);
    await pool.query(`DELETE FROM talentum_prescreenings WHERE talentum_prescreening_id LIKE 'nqhum-psc-%'`);
    await pool.query(`DELETE FROM domain_events WHERE payload->>'workerId' = ANY($1::text[])`, [w]);
  }

  /** Estado da operação ANTES do veredito: WJA na etapa humana + encuadre com resultado de quem já conduziu o caso. */
  async function seed(k: Key) {
    // O webhook cria WJA + encuadre (o worker INCOMPLETE_REGISTER não entra por INSERT direto); depois a operação move.
    expect((await send(k, 'IN_DOUBT')).status).toBe(200);
    await pool.query(
      `UPDATE worker_job_applications SET application_funnel_stage=$3, updated_at=NOW() WHERE worker_id=$1 AND job_posting_id=$2`, [wid[k], jid[k], START[k]]);
    await pool.query(
      `UPDATE encuadres SET resultado=$3, updated_at=NOW() WHERE worker_id=$1 AND job_posting_id=$2`, [wid[k], jid[k], k === 'CTL' ? null : 'SELECCIONADO']);
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

  it.each([['CONF', 'CONFIRMED'], ['QRT', 'QUICK_RESPONSE_TEAM'], ['SEL', 'SELECTED']] as Array<[Key, string]>)(
    'WJA em %s (%s) + NOT_QUALIFIED: etapa e encuadre intactos, veredito gravado, sem evento auto_not_qualified',
    async (k, expected) => {
      await seed(k);

      expect((await sendNq(k)).status).toBe(200);

      expect(await stage(k)).toBe(expected);
      expect(await encuadre(k)).toEqual({ resultado: 'SELECCIONADO', cat: null });
      expect(await verdict(k)).toEqual(['NOT_QUALIFIED']);
      expect(await events(k, 'funnel_stage.rejected')).toHaveLength(0);
      expect(await events(k, 'funnel_stage.not_qualified')).toHaveLength(0);
      const pendentes = (await pool.query(
        `SELECT event FROM domain_events WHERE payload->>'workerId'=$1 AND payload->>'jobPostingId'=$2 AND status <> 'processed'`, [wid[k], jid[k]])).rows;
      expect(pendentes).toEqual([]);
    },
  );

  it('controle: WJA em QUALIFIED + NOT_QUALIFIED continua rebaixando para REJECTED, encuadre RECHAZADO e evento auto_not_qualified', async () => {
    await seed('CTL');

    expect((await sendNq('CTL')).status).toBe(200);

    expect(await stage('CTL')).toBe('REJECTED');
    expect(await encuadre('CTL')).toEqual({ resultado: 'RECHAZADO', cat: 'TALENTUM_NOT_QUALIFIED' });
    expect(await verdict('CTL')).toEqual(['NOT_QUALIFIED']);
    const ev = await events('CTL', 'funnel_stage.rejected');
    expect(ev).toHaveLength(1);
    expect(ev[0].payload.source).toBe('auto_not_qualified');
  });
});
