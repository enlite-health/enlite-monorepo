/**
 * talentum-reconciliar-nq-nao-rebaixa-etapa-humana.test.ts
 *
 * F3 pelo caminho do SCRIPT `reconciliar-talentum-sem-worker`: a lib tem upsert próprio da WJA (CASE de precedência), e REJECTED
 * empata 7 x 7 com SELECTED. Sem o guard do CASE, o upsert do script rebaixa a WJA SEM encuadre RECHAZADO e SEM evento
 * auto_not_qualified (sem volta). Executa o SQL REAL (`reconcile` da lib, Postgres real, withActorContext como o script).
 *
 *  (a) WJA SELECTED / (b) QUICK_RESPONSE_TEAM + NOT_QUALIFIED guardado no card → etapa e encuadre intactos, sem evento
 *  (c) controle: WJA QUALIFIED + NOT_QUALIFIED → REJECTED, encuadre RECHAZADO, evento auto_not_qualified
 * Leitura do Talentum: leitor FALSO em memória (nenhum GET real). Nenhuma mensagem sai (eventos audit-only).
 */
import { Pool } from 'pg';
import { createApiClient, waitForBackend } from './helpers';
import { envelope, type ResponseBlock } from '../fixtures/talentumPayload';
import { reconcile, type PendingRow, type TalentumReader } from '../../scripts/reconciliar-talentum-sem-worker-lib';
import { withActorContext } from '../../src/shared/database/actorContext';
import { systemActor } from '../../src/shared/audit/actorSource';

type Analyzed = ResponseBlock & { score: number; statusLabel: 'IN_DOUBT' };

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';
const ENDPOINT = '/api/webhooks/talentum/prescreening';
const KEYS = ['SEL', 'QRT', 'CTL'] as const;
type Key = (typeof KEYS)[number];
const START: Record<Key, string> = { SEL: 'SELECTED', QRT: 'QUICK_RESPONSE_TEAM', CTL: 'QUALIFIED' };
const PSC = (k: Key) => `rcnq-psc-${k}`;
const PROF = (k: Key) => `rcnq-prof-${k}`;
const EMAIL = (k: Key) => `rcnq.${k.toLowerCase()}@test.local`;
const TITLE: Record<Key, string> = { SEL: 'CASO 831 RCNQ SEL', QRT: 'CASO 832 RCNQ QRT', CTL: 'CASO 833 RCNQ CTL' };
const PHONE: Record<Key, string> = { SEL: '+5491183100001', QRT: '+5491183200001', CTL: '+5491183300001' };

describe('Talentum — script de reconciliação: NOT_QUALIFIED não rebaixa etapa humana acima de QUALIFIED (SQL real)', () => {
  let api: ReturnType<typeof createApiClient>;
  let pool: Pool;
  const wid = {} as Record<Key, string>;
  const jid = {} as Record<Key, string>;
  const tpId = {} as Record<Key, string>;

  const stage = async (k: Key) => (await pool.query(
    `SELECT application_funnel_stage AS s FROM worker_job_applications WHERE worker_id=$1 AND job_posting_id=$2`, [wid[k], jid[k]])).rows[0]?.s;
  const encuadre = async (k: Key) => (await pool.query(
    `SELECT resultado, rejection_reason_category AS cat FROM encuadres WHERE worker_id=$1 AND job_posting_id=$2`, [wid[k], jid[k]])).rows[0];
  const events = async (k: Key, event: string) => (await pool.query(
    `SELECT payload FROM domain_events WHERE event=$1 AND payload->>'workerId'=$2 AND payload->>'jobPostingId'=$3`, [event, wid[k], jid[k]])).rows;

  /** Estado da operação: o webhook cria worker/WJA/encuadre (IN_DOUBT); a operação move a WJA; o card fica sem worker (o que o script lista). */
  async function seed(k: Key) {
    const res = await api.post(ENDPOINT, envelope({
      subtype: 'ANALYZED',
      prescreening: { id: PSC(k), name: TITLE[k] },
      profile: { id: PROF(k), email: EMAIL(k), phoneNumber: PHONE[k], cuil: `20-8${PHONE[k].slice(-7)}-3` },
      response: { id: `rcnq-resp-${k}`, state: [], score: 50, statusLabel: 'IN_DOUBT' } as Analyzed,
    }));
    expect(res.status).toBe(200);
    await pool.query(
      `UPDATE worker_job_applications SET application_funnel_stage=$3, updated_at=NOW() WHERE worker_id=$1 AND job_posting_id=$2`, [wid[k], jid[k], START[k]]);
    await pool.query(
      `UPDATE encuadres SET resultado=$3, updated_at=NOW() WHERE worker_id=$1 AND job_posting_id=$2`, [wid[k], jid[k], k === 'CTL' ? null : 'SELECCIONADO']);
    tpId[k] = (await pool.query(
      `UPDATE talentum_prescreenings SET worker_id=NULL, status='NOT_QUALIFIED' WHERE talentum_prescreening_id=$1 RETURNING id`, [PSC(k)])).rows[0].id;
  }

  const runScript = (k: Key) => {
    const row: PendingRow = { id: tpId[k], talentumPrescreeningId: PSC(k), talentumProfileId: PROF(k), status: 'NOT_QUALIFIED', jobPostingId: jid[k], talentumProjectId: 'rcnq-proj' };
    const talentum: TalentumReader = {
      candidates: async () => [{ profileId: PROF(k), firstName: 'Sintetico', lastName: 'Teste', phoneNumber: PHONE[k], email: EMAIL(k) }],
      readyForInterview: async () => [],
    };
    return reconcile({
      talentum, listPending: async () => [row],
      runInTransaction: <T,>(fn: Parameters<typeof withActorContext>[1]) => withActorContext(pool, fn as never, systemActor('rcnq-teste')) as Promise<T>,
    }, 'apply');
  };

  async function clean() {
    const w = Object.values(wid).filter(Boolean);
    if (!w.length) return;
    await pool.query(`DELETE FROM worker_job_applications WHERE worker_id = ANY($1::uuid[])`, [w]);
    await pool.query(`DELETE FROM encuadres WHERE worker_id = ANY($1::uuid[])`, [w]);
    await pool.query(`DELETE FROM talentum_prescreening_responses WHERE prescreening_id IN (SELECT id FROM talentum_prescreenings WHERE talentum_prescreening_id LIKE 'rcnq-psc-%')`);
    await pool.query(`DELETE FROM talentum_prescreenings WHERE talentum_prescreening_id LIKE 'rcnq-psc-%'`);
    await pool.query(`DELETE FROM domain_events WHERE payload->>'workerId' = ANY($1::text[])`, [w]);
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

  it.each([['SEL', 'SELECTED'], ['QRT', 'QUICK_RESPONSE_TEAM']] as Array<[Key, string]>)(
    'script com WJA em %s (%s) + NOT_QUALIFIED: etapa e encuadre intactos, sem evento auto_not_qualified',
    async (k, expected) => {
      await seed(k);

      const out = await runScript(k);

      expect(out).toEqual([expect.objectContaining({ kind: 'RESOLVED', workerId: wid[k] })]);
      expect(await stage(k)).toBe(expected);
      expect(await encuadre(k)).toEqual({ resultado: 'SELECCIONADO', cat: null });
      expect(await events(k, 'funnel_stage.rejected')).toHaveLength(0);
    },
  );

  it('controle: script com WJA em QUALIFIED + NOT_QUALIFIED rebaixa para REJECTED, encuadre RECHAZADO e evento auto_not_qualified', async () => {
    await seed('CTL');

    const out = await runScript('CTL');

    expect(out).toEqual([expect.objectContaining({ kind: 'RESOLVED', workerId: wid.CTL })]);
    expect(await stage('CTL')).toBe('REJECTED');
    expect(await encuadre('CTL')).toEqual({ resultado: 'RECHAZADO', cat: 'TALENTUM_NOT_QUALIFIED' });
    const ev = await events('CTL', 'funnel_stage.rejected');
    expect(ev).toHaveLength(1);
    expect(ev[0].payload.source).toBe('auto_not_qualified');
  });
});
