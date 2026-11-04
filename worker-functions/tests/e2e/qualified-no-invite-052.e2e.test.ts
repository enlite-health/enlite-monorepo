/**
 * qualified-no-invite-052.e2e.test.ts — spec 052, Fase 4 (T-40b): qualificar NÃO convida mais por WhatsApp.
 *
 * Roda contra POSTGRES REAL, sem a API no ar: monta o `DomainEventProcessor` com o MESMO registro que o servidor usa
 * (`registerFunnelStageHandlers`, o que `src/index.ts` chama) e processa o evento `funnel_stage.qualified` de verdade.
 * Nenhuma mensagem sai: `NODE_ENV=test` desliga o Pub/Sub, a fila só anda por chamada interna que ninguém faz aqui e o
 * Twilio nem é instanciado. Dados SINTÉTICOS ("Ficticio NN", `@example.test`); nada de PII em asserção ou log.
 *
 * A vaga semeada TEM horário futuro (link fixo) e o worker está REGISTERED, sem opt-out, país AR: é exatamente o cenário em que o
 * convite antigo era enfileirado (controle positivo — sem horário futuro ele pularia sozinho e o teste passaria à toa).
 *
 * O que cada caso mata (sabotagem 7 → vermelho): religar o convite ao qualificar (registrar de novo um handler próprio para
 * `funnel_stage.qualified` que insere `qualified_worker_request` na `messaging_outbox`).
 */
import { Pool } from 'pg';
import { DomainEventProcessor } from '../../src/shared/events/DomainEventProcessor';
import { PubSubClient } from '../../src/shared/events/PubSubClient';
import { registerFunnelStageHandlers } from '../../src/shared/events/registerFunnelStageHandlers';
import { TokenService } from '../../src/modules/notification/infrastructure/TokenService';
import { emitFunnelStageEvent } from '../../src/modules/matching/application/FunnelStageEventEmitter';

const DATABASE_URL =
  process.env.TEST_DATABASE_URL ||
  process.env.DATABASE_URL ||
  'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

describe('qualificar não enfileira convite de entrevista (spec 052, Fase 4)', () => {
  let pool: Pool;
  let processor: DomainEventProcessor;
  let patientId: string;
  let vacancyId: string;
  let workerId: string;
  let wjaId: string;

  const convites = async (): Promise<number> =>
    Number(
      (await pool.query(`SELECT COUNT(*)::int AS n FROM messaging_outbox WHERE worker_id = $1 AND template_slug = 'qualified_worker_request'`, [workerId]))
        .rows[0].n,
    );
  const outboxDoWorker = async (): Promise<number> =>
    Number((await pool.query(`SELECT COUNT(*)::int AS n FROM messaging_outbox WHERE worker_id = $1`, [workerId])).rows[0].n);

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    processor = new DomainEventProcessor(pool);
    registerFunnelStageHandlers(processor, pool, new PubSubClient(), new TokenService(pool));

    const pat = await pool.query(
      `INSERT INTO patients (clickup_task_id, first_name, last_name, country, is_test) VALUES ($1, 'Ficticia', 'Seis', 'AR', true) RETURNING id`,
      [`q052-${RUN}`],
    );
    patientId = pat.rows[0].id;
    const vac = await pool.query(
      `INSERT INTO job_postings (title, patient_id, status, is_draft, country, is_test, case_number)
       VALUES ($1, $2, 'SEARCHING', false, 'AR', true, $3) RETURNING id`,
      [`Q052 ${RUN}`, patientId, 810000 + Math.floor(Math.random() * 90000)],
    );
    vacancyId = vac.rows[0].id;
    const w = await pool.query(
      `INSERT INTO workers (auth_uid, email, phone, country, timezone, status, first_name_encrypted, last_name_encrypted)
       VALUES ($1, $2, $3, 'AR', 'America/Argentina/Buenos_Aires', 'REGISTERED', 'cipher', 'cipher') RETURNING id`,
      [`q052-${RUN}`, `worker.q052.${RUN}@example.test`, `+54911${Math.floor(10000000 + Math.random() * 89999999)}`],
    );
    workerId = w.rows[0].id;
    const wja = await pool.query(
      `INSERT INTO worker_job_applications (worker_id, job_posting_id, application_funnel_stage, source)
       VALUES ($1, $2, 'COMPLETED', 'manual') RETURNING id`,
      [workerId, vacancyId],
    );
    wjaId = wja.rows[0].id;
  });

  afterAll(async () => {
    if (!pool) return;
    await pool.query('DELETE FROM funnel_stage_message_log WHERE worker_id = $1', [workerId]).catch(() => undefined);
    await pool.query(`DELETE FROM domain_events WHERE payload @> $1::jsonb`, [JSON.stringify({ workerId })]).catch(() => undefined);
    await pool.query('DELETE FROM messaging_outbox WHERE worker_id = $1', [workerId]).catch(() => undefined);
    await pool.query('DELETE FROM worker_job_applications WHERE id = $1', [wjaId]).catch(() => undefined);
    await pool.query('DELETE FROM workers WHERE id = $1', [workerId]).catch(() => undefined);
    await pool.query('DELETE FROM job_postings WHERE id = $1', [vacancyId]).catch(() => undefined);
    await pool.query('DELETE FROM patients WHERE id = $1', [patientId]).catch(() => undefined);
    await pool.end();
  });

  it('A. arrasto humano para QUALIFIED: o evento é processado (tem dono) e a fila de convites fica em 0', async () => {
    // Controle positivo: o cenário é o do convite antigo (vaga com horário futuro, worker apto) e a fila começa vazia.
    expect(await convites()).toBe(0);

    const client = await pool.connect();
    let eventId: string | null;
    try {
      await client.query('BEGIN');
      await client.query(`UPDATE worker_job_applications SET application_funnel_stage = 'QUALIFIED' WHERE id = $1`, [wjaId]);
      eventId = await emitFunnelStageEvent(client, {
        workerId,
        jobPostingId: vacancyId,
        previousStage: 'COMPLETED',
        targetStage: 'QUALIFIED',
        actorUid: 'system:test-q052',
        source: 'kanban',
      });
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
    expect(eventId).toBeTruthy();

    const result = await processor.processEvent(eventId as string);
    expect(result).toEqual({ status: 'processed', event: 'funnel_stage.qualified' });
    expect(await convites()).toBe(0);
    expect(await outboxDoWorker()).toBe(0);
  });

  it('B. webhook da Talentum (source=talentum): também sem convite, e o evento é processado', async () => {
    const ev = await pool.query(
      `INSERT INTO domain_events (event, payload) VALUES ('funnel_stage.qualified', $1::jsonb) RETURNING id`,
      [JSON.stringify({ workerId, jobPostingId: vacancyId, source: 'talentum' })],
    );
    const result = await processor.processEvent(ev.rows[0].id as string);
    expect(result).toEqual({ status: 'processed', event: 'funnel_stage.qualified' });
    expect(await convites()).toBe(0);
    expect(await outboxDoWorker()).toBe(0);
  });

  it('C. o pulo fica registrado na trilha da etapa (a linha builtin cai em DISABLED), não some em silêncio', async () => {
    const { rows } = await pool.query(
      `SELECT status, skip_reason FROM funnel_stage_message_log WHERE worker_id = $1 AND stage = 'QUALIFIED' ORDER BY created_at`,
      [workerId],
    );
    expect(rows.length).toBeGreaterThanOrEqual(2);
    for (const r of rows) expect(r).toEqual({ status: 'skipped', skip_reason: expect.stringMatching(/^(DISABLED|SOURCE_NOT_HUMAN)$/) });
  });
});
