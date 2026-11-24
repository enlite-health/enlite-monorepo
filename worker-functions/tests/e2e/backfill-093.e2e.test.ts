/**
 * backfill-093.e2e.test.ts @integration — spec 093 CA-8: a carga única `backfill-promote-eligible-093`.
 *
 * Postgres real, dados sintéticos (sem PII), nenhum side-effect outbound: promover só cria WJA + encuadre
 * e carimba a tentativa (RF-7) — o teste prova isso conferindo `messaging_outbox` vazio para os workers.
 *
 * Cenário: 3 workers com 1 tentativa bloqueada pendente cada, numa vaga válida:
 *   A  REGISTERED, sem opt-out   → única que o --execute promove
 *   B  REGISTERED, opt-out vigente → pulada (SUP-2, reason worker_opted_out)
 *   C  INCOMPLETE_REGISTER        → fora do universo (não é elegível)
 *
 *   (a) dry-run não escreve (promoted_at NULL, nenhuma WJA nova); `candidates` é teto (universo menos opt-out)
 *   (b) --execute promove só a A (WJA criada + promoted_at preenchido); B e C seguem intactas
 *   (c) a saída só tem as chaves do contrato (RF-6) e nenhum id/telefone/e-mail
 */
import { Pool } from 'pg';
import { runBackfill } from '../../scripts/backfill-promote-eligible-093';

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? '';
const PREFIX = 'bf093-';

describe('Spec 093 CA-8 — carga única de promoção das tentativas bloqueadas @integration', () => {
  let pool: Pool;
  const ids: Record<'A' | 'B' | 'C', { worker: string; blocked: string }> = {
    A: { worker: '', blocked: '' }, B: { worker: '', blocked: '' }, C: { worker: '', blocked: '' },
  };
  let jobPostingId = '';
  let patientId = '';

  const limpar = async (): Promise<void> => {
    const w = `SELECT id FROM workers WHERE auth_uid LIKE '${PREFIX}%'`;
    await pool.query(`DELETE FROM encuadres WHERE worker_id IN (${w})`);
    await pool.query(`DELETE FROM worker_job_application_stage_history WHERE application_id IN (SELECT id FROM worker_job_applications WHERE worker_id IN (${w}))`);
    await pool.query(`DELETE FROM worker_job_applications WHERE worker_id IN (${w})`);
    await pool.query(`DELETE FROM worker_blocked_applications WHERE worker_id IN (${w})`);
    await pool.query(`DELETE FROM messaging_opt_out WHERE worker_id IN (${w})`);
    await pool.query(`DELETE FROM workers WHERE auth_uid LIKE '${PREFIX}%'`);
    await pool.query(`DELETE FROM job_postings WHERE patient_id IN (SELECT id FROM patients WHERE clickup_task_id LIKE '${PREFIX}%')`);
    await pool.query(`DELETE FROM patients WHERE clickup_task_id LIKE '${PREFIX}%'`);
  };

  /** Worker com status declarado: a migration 591 exige `app.status_flow` na mesma transação. */
  const criarWorker = async (tag: string, status: string): Promise<string> => {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.status_flow', 'TEST_FIXTURE', true)`);
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO workers (auth_uid, email, country, status, occupation) VALUES ($1, $2, 'AR', $3, 'AT') RETURNING id`,
        [`${PREFIX}${tag}`, `${PREFIX}${tag}@e2e.local`, status],
      );
      await c.query('COMMIT');
      return rows[0].id;
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    } finally {
      c.release();
    }
  };

  const bloquear = async (workerId: string): Promise<string> =>
    (await pool.query<{ id: string }>(
      `INSERT INTO worker_blocked_applications (worker_id, job_posting_id, blocked_reason, acquisition_channel)
       VALUES ($1, $2, 'registration_incomplete', 'facebook') RETURNING id`,
      [workerId, jobPostingId],
    )).rows[0].id;

  const estado = async () => ({
    promovidas: Number((await pool.query(
      `SELECT count(*) n FROM worker_blocked_applications WHERE worker_id = ANY($1) AND promoted_at IS NOT NULL`,
      [Object.values(ids).map((v) => v.worker)])).rows[0].n),
    wjas: Number((await pool.query(
      `SELECT count(*) n FROM worker_job_applications WHERE worker_id = ANY($1)`,
      [Object.values(ids).map((v) => v.worker)])).rows[0].n),
    outbox: Number((await pool.query(
      `SELECT count(*) n FROM messaging_outbox WHERE worker_id = ANY($1)`,
      [Object.values(ids).map((v) => v.worker)])).rows[0].n),
  });

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    await limpar();
    patientId = (await pool.query<{ id: string }>(
      `INSERT INTO patients (clickup_task_id, first_name, last_name, country, status, case_number)
       VALUES ($1, 'Bf093', 'E2E', 'AR', 'ACTIVE', 930001) RETURNING id`, [`${PREFIX}pac`])).rows[0].id;
    jobPostingId = (await pool.query<{ id: string }>(
      `INSERT INTO job_postings (case_number, vacancy_number, title, status, patient_id, country, is_draft, is_test, social_short_links)
       VALUES (930001, 930001, 'CASO BF093-E2E', 'SEARCHING', $1, 'AR', false, false, '{}'::jsonb) RETURNING id`, [patientId])).rows[0].id;

    ids.A.worker = await criarWorker('A', 'REGISTERED');
    ids.B.worker = await criarWorker('B', 'REGISTERED');
    ids.C.worker = await criarWorker('C', 'INCOMPLETE_REGISTER');
    await pool.query(`INSERT INTO messaging_opt_out (worker_id, phone) VALUES ($1, '+5490000000')`, [ids.B.worker]);
    for (const k of ['A', 'B', 'C'] as const) ids[k].blocked = await bloquear(ids[k].worker);
  });

  afterAll(async () => {
    await limpar();
    await pool.end();
  });

  it('(a) dry-run não escreve e devolve o teto de candidatas (sem opt-out)', async () => {
    const antes = await estado();
    const r = await runBackfill(pool, { execute: false });

    expect(await estado()).toEqual(antes);
    expect(antes.promovidas).toBe(0);
    expect(r.skipped_opt_out).toBeGreaterThanOrEqual(1);
    expect(r.candidates).toBeGreaterThanOrEqual(1);
    expect(r.scanned).toBe(r.candidates + r.skipped_opt_out);
  });

  it('(b) --execute promove só a elegível sem opt-out; pula opt-out e não-elegível; não enfileira mensagem', async () => {
    const r = await runBackfill(pool, { execute: true });
    expect(r.promoted).toBeGreaterThanOrEqual(1);
    expect(r.reasons.worker_opted_out).toBeGreaterThanOrEqual(1);

    const linhas = await pool.query<{ id: string; promoted: boolean; wja: string | null }>(
      `SELECT id, promoted_at IS NOT NULL AS promoted, promoted_wja_id AS wja FROM worker_blocked_applications WHERE worker_id = ANY($1)`,
      [Object.values(ids).map((v) => v.worker)]);
    const por = Object.fromEntries(linhas.rows.map((l) => [l.id, l]));
    expect(por[ids.A.blocked].promoted).toBe(true);
    expect(por[ids.A.blocked].wja).not.toBeNull();
    expect(por[ids.B.blocked].promoted).toBe(false);
    expect(por[ids.C.blocked].promoted).toBe(false);

    const wjas = await pool.query(`SELECT worker_id FROM worker_job_applications WHERE worker_id = ANY($1)`, [Object.values(ids).map((v) => v.worker)]);
    expect(wjas.rows.map((x) => x.worker_id)).toEqual([ids.A.worker]);
    expect((await estado()).outbox).toBe(0);
  });

  it('(c) a saída só tem as chaves do contrato e nenhum identificador', async () => {
    const dry = await runBackfill(pool, { execute: false });
    const exe = await runBackfill(pool, { execute: true });

    expect(Object.keys(dry).sort()).toEqual(['candidates', 'scanned', 'skipped_opt_out']);
    expect(Object.keys(exe).sort()).toEqual(['promoted', 'reasons', 'scanned', 'skipped']);
    const texto = JSON.stringify([dry, exe]);
    for (const v of Object.values(ids)) {
      expect(texto).not.toContain(v.worker);
      expect(texto).not.toContain(v.blocked);
    }
    expect(texto).not.toContain('@');
    expect(texto).not.toContain(PREFIX);
    expect(exe.promoted).toBe(0); // idempotente: a 2ª passada não promove de novo
  });
});
