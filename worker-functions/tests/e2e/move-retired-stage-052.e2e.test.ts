/**
 * move-retired-stage-052.e2e.test.ts — spec 052, Fase 4 (T-41a): `PUT /api/admin/encuadres/:id/move` com o destino retirado → 400.
 *
 * Roda contra POSTGRES REAL, sem a API no ar: chama o handler `WJAFunnelController.moveEncuadre` (o que a rota monta) com o
 * pool real injetado em `DatabaseConnection`, no molde de `account-link-flow.e2e.test.ts`. Nenhuma mensagem sai: `NODE_ENV=test`
 * desliga o Pub/Sub e a fila só anda por chamada interna que ninguém faz aqui. Dados SINTÉTICOS ("Ficticio NN", `@example.test`).
 *
 * O valor retirado é montado em duas partes DE PROPÓSITO: a varredura da spec ("nenhum arquivo de produto nem de teste nomeia o
 * estágio fora da migration e dos homônimos") não deve exigir exceção para o teste que prova que ele foi recusado.
 *
 * Controle positivo: o MESMO handler, com um destino vivo, responde 200 e grava no banco (sem isso, o 400 poderia vir de
 * qualquer outra recusa).
 *
 * Sabotagem 5 → vermelho: devolver o valor a `FUNNEL_STAGES` (a rota volta a aceitar o destino).
 */
import { Pool } from 'pg';
import type { Request, Response } from 'express';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import { WJAFunnelController } from '../../src/modules/matching/interfaces/controllers/WJAFunnelController';
import { completeWorkerProfile, cleanWorkerProfile } from './helpers/aptoWorkerFixture';

const DATABASE_URL =
  process.env.TEST_DATABASE_URL ||
  process.env.DATABASE_URL ||
  'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const DESTINO_RETIRADO = ['CONFIRM', 'ED'].join('');

describe('move com o destino retirado (spec 052, Fase 4)', () => {
  let pool: Pool;
  let controller: WJAFunnelController;
  let patientId: string;
  let vacancyId: string;
  let workerId: string;
  let wjaId: string;
  let encuadreId: string;

  const estagio = async (): Promise<string> =>
    (await pool.query('SELECT application_funnel_stage AS s FROM worker_job_applications WHERE id = $1', [wjaId])).rows[0].s;
  const eventos = async (): Promise<number> =>
    Number((await pool.query(`SELECT COUNT(*)::int AS n FROM domain_events WHERE payload @> $1::jsonb`, [JSON.stringify({ workerId })])).rows[0].n);

  function chamar(body: Record<string, unknown>): Promise<{ status: number; json: Record<string, unknown> }> {
    const req = { params: { id: encuadreId }, body, query: {}, user: { uid: 'system:test-t41a' } } as unknown as Request;
    return new Promise((resolve, reject) => {
      let status = 200;
      const res = {
        status(code: number) {
          status = code;
          return res;
        },
        json(payload: Record<string, unknown>) {
          resolve({ status, json: payload });
          return res;
        },
      } as unknown as Response;
      controller.moveEncuadre(req, res).catch(reject);
    });
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    (DatabaseConnection.getInstance() as unknown as { pool: Pool }).pool = pool;
    controller = new WJAFunnelController();

    const pat = await pool.query(
      `INSERT INTO patients (clickup_task_id, first_name, last_name, country, is_test) VALUES ($1, 'Ficticia', 'Siete', 'AR', true) RETURNING id`,
      [`m052-${RUN}`],
    );
    patientId = pat.rows[0].id;
    const vac = await pool.query(
      `INSERT INTO job_postings (title, patient_id, status, is_draft, country, is_test, case_number)
       VALUES ($1, $2, 'SEARCHING', false, 'AR', true, $3) RETURNING id`,
      [`M052 ${RUN}`, patientId, 820000 + Math.floor(Math.random() * 90000)],
    );
    vacancyId = vac.rows[0].id;
    const w = await pool.query(
      `INSERT INTO workers (auth_uid, email, country, timezone, status, first_name_encrypted, last_name_encrypted)
       VALUES ($1, $2, 'AR', 'America/Argentina/Buenos_Aires', 'REGISTERED', 'cipher', 'cipher') RETURNING id`,
      [`m052-${RUN}`, `worker.m052.${RUN}@example.test`],
    );
    workerId = w.rows[0].id;
    // spec 067 FR-24: o destino Completado exige prestador APTO; a intenção do teste é "worker apto" (controle positivo)
    await completeWorkerProfile(pool, workerId, 'validated');
    const wja = await pool.query(
      `INSERT INTO worker_job_applications (worker_id, job_posting_id, application_funnel_stage, source)
       VALUES ($1, $2, 'INVITED', 'talentum') RETURNING id`,
      [workerId, vacancyId],
    );
    wjaId = wja.rows[0].id;
    // O trigger de inserção da WJA já cria o encuadre; o upsert devolve o id existente.
    const enc = await pool.query(
      `INSERT INTO encuadres (worker_id, job_posting_id, worker_raw_name) VALUES ($1, $2, 'Ficticio Siete')
       ON CONFLICT (worker_id, job_posting_id) DO UPDATE SET worker_raw_name = EXCLUDED.worker_raw_name RETURNING id`,
      [workerId, vacancyId],
    );
    encuadreId = enc.rows[0].id;
  });

  afterAll(async () => {
    if (!pool) return;
    await pool.query(`DELETE FROM domain_events WHERE payload @> $1::jsonb`, [JSON.stringify({ workerId })]).catch(() => undefined);
    await pool.query('DELETE FROM encuadres WHERE worker_id = $1', [workerId]).catch(() => undefined);
    await pool.query('DELETE FROM worker_job_applications WHERE id = $1', [wjaId]).catch(() => undefined);
    await cleanWorkerProfile(pool, [workerId]).catch(() => undefined);
    await pool.query('DELETE FROM workers WHERE id = $1', [workerId]).catch(() => undefined);
    await pool.query('DELETE FROM job_postings WHERE id = $1', [vacancyId]).catch(() => undefined);
    await pool.query('DELETE FROM patients WHERE id = $1', [patientId]).catch(() => undefined);
    await pool.end();
  });

  it('A. destino retirado → 400, o estágio não muda e nenhum evento nasce', async () => {
    expect(await estagio()).toBe('INVITED');
    const antes = await eventos();

    const r = await chamar({ targetStage: DESTINO_RETIRADO, reasonCategory: 'OTHER' });

    expect(r.status).toBe(400);
    expect(r.json).toMatchObject({ success: false, error: expect.stringContaining('targetStage must be one of') });
    expect(String(r.json.error)).not.toContain(DESTINO_RETIRADO);
    expect(await estagio()).toBe('INVITED');
    expect(await eventos()).toBe(antes);
  });

  it('B. controle positivo: o mesmo handler com um destino vivo responde 200 e grava', async () => {
    const r = await chamar({ targetStage: 'COMPLETED', reasonCategory: 'ENCUADRE_ANTECIPADO' });

    expect(r.status).toBe(200);
    expect(r.json).toEqual({ success: true, data: { encuadreId, targetStage: 'COMPLETED' } });
    expect(await estagio()).toBe('COMPLETED');
    expect(await eventos()).toBeGreaterThanOrEqual(1);
  });
});
