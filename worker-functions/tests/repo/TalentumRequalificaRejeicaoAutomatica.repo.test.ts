/**
 * Talentum re-qualifica a rejeição AUTOMÁTICA — teste de REPOSITÓRIO, banco Postgres REAL (nunca mock), migrations aplicadas.
 *
 * Regra (Gabriel, 05/11/2026; caso EN1238): o card espelha SEMPRE o veredito do Talentum; a "Mover a…" HUMANA nunca é desfeita.
 * Exercita o SQL real de `revertAutoRejectionOnPositiveVerdict` (trilha `worker_job_application_stage_history` + evento
 * `auto_not_qualified` + encuadre) via `ProcessTalentumPrescreening.execute` com o repositório e o pool de verdade; só os
 * lookups de worker/vaga e o Pub/Sub são dublês (não escrevem nada).
 *
 *  (a) NOT_QUALIFIED (auto) → QUALIFIED: card QUALIFIED, encuadre sem resultado, evento de reversão auditável
 *  (b) rejeição HUMANA (do zero, ou depois da automática) → QUALIFIED: continua REJECTED, encuadre RECHAZADO intacto
 *  (c) nenhuma mensagem ao prestador: o único evento pendente tem source 'talentum' (o StageMessageHandler pula tudo
 *      que não é 'kanban' — SOURCE_NOT_HUMAN, StageMessageHandler.ts:124) e o de reversão nasce `processed`
 *
 * Como rodar: ver `tests/repo/AxonicoLancamentoRepository.repo.test.ts` (Postgres isolado + migrations + jest.config.repo.js).
 */
import { Pool } from 'pg';
import { ProcessTalentumPrescreening } from '../../src/modules/matching/application/ProcessTalentumPrescreening';
import { TalentumPrescreeningRepository } from '../../src/modules/matching/infrastructure/TalentumPrescreeningRepository';
import { moveApplicationStage } from '../../src/modules/matching/application/moveApplicationStage';

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@127.0.0.1:5543/enlite_e2e';
const PFX = 'repo-req-rej-';
const RUN = Date.now();

type Label = 'QUALIFIED' | 'NOT_QUALIFIED' | 'IN_DOUBT';

describe('Talentum re-qualifica rejeição automática (banco real)', () => {
  let pool: Pool;
  let useCase: ProcessTalentumPrescreening;
  let pubsub: { publish: jest.Mock };
  let seq = 0;
  let workerId: string;
  let jobId: string;
  let psc: string;

  const payload = (label: Label) => ({
    action: 'PRESCREENING_RESPONSE',
    subtype: 'ANALYZED',
    data: {
      prescreening: { id: psc, name: 'CASO TESTE' },
      profile: { id: `${psc}-prof`, firstName: 'Teste', lastName: 'Repo', email: `${psc}@test.invalid`, phoneNumber: '+5491100001111', registerQuestions: [] },
      response: { id: `${psc}-resp`, state: [], score: 80, statusLabel: label },
    },
  }) as any;

  const send = (label: Label) => useCase.execute(payload(label));
  const wja = async () => (await pool.query(
    `SELECT application_funnel_stage AS stage FROM worker_job_applications WHERE worker_id = $1 AND job_posting_id = $2`, [workerId, jobId])).rows[0]?.stage;
  const encuadre = async () => (await pool.query(
    `SELECT resultado, rejection_reason_category AS cat FROM encuadres WHERE worker_id = $1 AND job_posting_id = $2`, [workerId, jobId])).rows[0];
  const eventsOf = async (event: string) => (await pool.query(
    `SELECT status, payload FROM domain_events WHERE event = $1 AND payload->>'workerId' = $2 AND payload->>'jobPostingId' = $3 ORDER BY created_at`,
    [event, workerId, jobId])).rows;

  /** "Mover a…" humano: mesmo caminho do Kanban (moveApplicationStage) com o uid carimbado como o withActorContext faz. */
  const humanMove = async (targetStage: string, reasonCategory?: string) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.current_uid', 'uid-humano-teste', true)`);
      const enc = (await client.query(`SELECT id FROM encuadres WHERE worker_id = $1 AND job_posting_id = $2`, [workerId, jobId])).rows[0];
      const r = await moveApplicationStage(client as any, {
        workerId, jobPostingId: jobId, encuadreId: enc?.id ?? null, targetStage, actorUid: 'uid-humano-teste', reasonCategory,
      }, { skipJumpReason: true });
      expect(r.moved).toBe(true);
      await client.query('COMMIT');
    } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
  };

  beforeAll(async () => {
    process.env.DATABASE_URL = DATABASE_URL;
    pool = new Pool({ connectionString: DATABASE_URL, max: 4 });
    pubsub = { publish: jest.fn().mockResolvedValue('id') };
  });

  beforeEach(async () => {
    seq += 1;
    psc = `${PFX}${RUN}-${seq}`;
    workerId = (await pool.query(
      `INSERT INTO workers (auth_uid, email, status) VALUES ($1, $2, 'REGISTERED') RETURNING id`,
      [`${PFX}uid-${seq}-${RUN}`, `${psc}@test.invalid`])).rows[0].id;
    jobId = (await pool.query(
      `INSERT INTO job_postings (title, description, status) VALUES ($1, 'x', 'SEARCHING') RETURNING id`, [`Requalifica ${seq}`])).rows[0].id;
    useCase = new ProcessTalentumPrescreening(
      new TalentumPrescreeningRepository(),
      { findByEmailNormalized: async () => ({ getValue: () => ({ id: workerId }) }), findByPhoneCandidates: async () => ({ getValue: () => null }), findByCuit: async () => ({ getValue: () => null }) } as any,
      { findByTalentumPrescreeningId: async () => ({ id: jobId }), findByTitleILike: async () => ({ id: jobId }) } as any,
      pool,
      pubsub as any,
    );
    pubsub.publish.mockClear();
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM talentum_prescreenings WHERE talentum_prescreening_id LIKE $1`, [`${PFX}%`]);
    await pool.query(`DELETE FROM encuadres WHERE worker_id IN (SELECT id FROM workers WHERE auth_uid LIKE $1)`, [`${PFX}%`]);
    await pool.query(`DELETE FROM worker_job_applications WHERE worker_id IN (SELECT id FROM workers WHERE auth_uid LIKE $1)`, [`${PFX}%`]);
    await pool.end();
  });

  it('(a) NOT_QUALIFIED automático e depois QUALIFIED: card QUALIFIED, encuadre limpo, reversão auditada', async () => {
    await send('NOT_QUALIFIED');
    expect(await wja()).toBe('REJECTED');
    expect(await encuadre()).toEqual({ resultado: 'RECHAZADO', cat: 'TALENTUM_NOT_QUALIFIED' });

    await send('QUALIFIED');

    expect(await wja()).toBe('QUALIFIED');
    expect(await encuadre()).toEqual({ resultado: null, cat: null });
    const rev = await eventsOf('funnel_stage.rejection_reverted');
    expect(rev).toHaveLength(1);
    expect(rev[0].status).toBe('processed');
    expect(rev[0].payload).toMatchObject({ toStage: 'QUALIFIED', source: 'talentum' });
  });

  it('(a2) NOT_QUALIFIED automático e depois IN_DOUBT: card IN_DOUBT (o Talentum também espelha dúvida)', async () => {
    await send('NOT_QUALIFIED');
    await send('IN_DOUBT');
    expect(await wja()).toBe('IN_DOUBT');
    expect(await encuadre()).toEqual({ resultado: null, cat: null });
  });

  it('(b) rejeição HUMANA do zero e depois QUALIFIED: continua REJECTED e o encuadre RECHAZADO fica', async () => {
    await send('IN_DOUBT');
    await humanMove('REJECTED', 'DISTANCE');
    expect(await wja()).toBe('REJECTED');

    await send('QUALIFIED');

    expect(await wja()).toBe('REJECTED');
    expect(await encuadre()).toEqual({ resultado: 'RECHAZADO', cat: 'DISTANCE' });
    expect(await eventsOf('funnel_stage.rejection_reverted')).toHaveLength(0);
  });

  it('(b2) rejeição automática, humano move para fora e rejeita DE NOVO, depois QUALIFIED: continua REJECTED', async () => {
    await send('NOT_QUALIFIED');
    await humanMove('SELECTED', 'REAVALIACAO');
    await humanMove('REJECTED', 'SCHEDULE_INCOMPATIBLE');
    expect(await wja()).toBe('REJECTED');

    await send('QUALIFIED');

    expect(await wja()).toBe('REJECTED');
    expect((await encuadre()).resultado).toBe('RECHAZADO');
    expect(await eventsOf('funnel_stage.rejection_reverted')).toHaveLength(0);
  });

  it('(c) nenhuma mensagem ao prestador: evento pendente só com source talentum (pulado como SOURCE_NOT_HUMAN) e reversão processed', async () => {
    await send('NOT_QUALIFIED');
    await send('QUALIFIED');

    const q = await eventsOf('funnel_stage.qualified');
    expect(q).toHaveLength(1);
    expect(q[0].payload.source).toBe('talentum');
    expect(q[0].payload.source).not.toBe('kanban');
    const outras = (await pool.query(
      `SELECT event, status FROM domain_events WHERE payload->>'workerId' = $1 AND payload->>'jobPostingId' = $2 AND status <> 'processed' AND event <> 'funnel_stage.qualified'`,
      [workerId, jobId])).rows;
    expect(outras).toEqual([]);
  });
});
