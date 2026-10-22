/**
 * mover-apto-067.e2e.test.ts — spec 067 F4 (FR-24), banco REAL, controller em processo.
 *
 * `WJAFunnelController.moveEncuadre` (o arrasto do card pela API): para um destino de Completado (COMPLETED/QUALIFIED/IN_DOUBT)
 * exige prestador APTO (documentos obrigatórios VALIDADOS); os demais destinos seguem no limiar de hoje (REGISTERED).
 *
 * Outbound mapeado (plan §6): `moveEncuadre` grava o evento de etapa (`domain_events` pending) e publica no Pub/Sub depois do
 * COMMIT. O Pub/Sub é substituído por um dublê que só conta (nenhuma rede); a recusa do FR-24 sai ANTES de qualquer escrita.
 * Dados SINTÉTICOS (@example.test), sem PII em asserção.
 */
import { Pool } from 'pg';
import type { Request, Response } from 'express';

process.env.DATABASE_URL =
  process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

import { WJAFunnelController } from '../../src/modules/matching/interfaces/controllers/WJAFunnelController';
import { DatabaseConnection } from '../../src/shared/database/DatabaseConnection';
import { completeWorkerProfile, cleanWorkerProfile } from './helpers/aptoWorkerFixture';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const ID = {
  patient: 'a0670000-0000-4000-b001-000000000001',
  job: 'a0670000-0000-4000-b002-000000000001',
  apto: 'a0670000-0000-4000-b003-000000000001',
  naoApto: 'a0670000-0000-4000-b003-000000000002',
};
const WORKERS = [ID.apto, ID.naoApto];
const ENC: Record<string, string> = {};
const published: string[] = [];

async function limpar(): Promise<void> {
  await pool.query(`DELETE FROM worker_job_applications WHERE job_posting_id = $1`, [ID.job]);
  await pool.query(`DELETE FROM encuadres WHERE job_posting_id = $1`, [ID.job]);
  await cleanWorkerProfile(pool, WORKERS);
  await pool.query(`DELETE FROM workers WHERE id = ANY($1::uuid[])`, [WORKERS]);
  await pool.query(`DELETE FROM job_postings WHERE id = $1`, [ID.job]);
  await pool.query(`DELETE FROM patients WHERE id = $1`, [ID.patient]);
}

async function move(encuadreId: string, body: Record<string, unknown>): Promise<{ status: number; body: Record<string, any> }> {
  const controller = new WJAFunnelController();
  // fronteira externa: nenhuma publicação real (o PubSubClient de produção fala com GCP)
  (controller as unknown as { pubsub: unknown }).pubsub = { publish: async (topic: string) => { published.push(topic); return 'msg'; } };
  let status = 200;
  let payload: Record<string, any> = {};
  const res = {
    status: (s: number) => { status = s; return res; },
    json: (b: Record<string, any>) => { payload = b; return res; },
  } as unknown as Response;
  await controller.moveEncuadre({ params: { id: encuadreId }, body, user: { uid: 'mover-apto-067' } } as unknown as Request, res);
  return { status, body: payload };
}

const stageOf = async (w: string): Promise<string | null> =>
  (await pool.query(`SELECT application_funnel_stage AS s FROM worker_job_applications WHERE worker_id = $1 AND job_posting_id = $2`, [w, ID.job])).rows[0]?.s ?? null;

beforeAll(async () => {
  await limpar();
  await pool.query(`INSERT INTO patients (id, clickup_task_id, country, first_name, last_name) VALUES ($1, 'mover-apto-067', 'AR', 'Ficticia', 'Teste')`, [ID.patient]);
  const { rows } = await pool.query<{ vn: string }>("SELECT nextval('job_postings_vacancy_number_seq') AS vn");
  await pool.query(
    `INSERT INTO job_postings (id, vacancy_number, case_number, patient_id, title, description, country, status, is_draft)
     VALUES ($1, $2, 99068, $3, 'mover-apto-067', '', 'AR', 'SEARCHING', false)`,
    [ID.job, parseInt(rows[0].vn, 10), ID.patient],
  );
  for (const [tag, id] of [['apto', ID.apto], ['naoApto', ID.naoApto]] as const) {
    await pool.query(
      `INSERT INTO workers (id, auth_uid, email, status, country, timezone) VALUES ($1, $2, $3, 'REGISTERED', 'AR', 'America/Argentina/Buenos_Aires')`,
      [id, `uid-mover-067-${tag}`, `mover-067-${tag}@example.test`],
    );
    await completeWorkerProfile(pool, id, tag === 'apto' ? 'validated' : 'unvalidated');
    const enc = await pool.query<{ id: string }>(`INSERT INTO encuadres (worker_id, job_posting_id, worker_raw_name) VALUES ($1, $2, 'Ficticio') RETURNING id`, [id, ID.job]);
    ENC[tag] = enc.rows[0].id;
  }
});

afterAll(async () => {
  await limpar();
  await pool.end();
  await DatabaseConnection.getInstance().getPool().end().catch(() => undefined);
});

describe('arrasto para Completado exige APTO (spec 067 FR-24) — moveEncuadre, SQL real', () => {
  it('pré-condição (dono, no SQL): só o prestador validado é apto; os dois são REGISTERED', async () => {
    const { rows } = await pool.query(`SELECT id, status, fn_worker_is_apto(id) AS apto FROM workers WHERE id = ANY($1::uuid[])`, [WORKERS]);
    const por = Object.fromEntries(rows.map((r) => [r.id, [r.status, r.apto]]));
    expect(por).toEqual({ [ID.apto]: ['REGISTERED', true], [ID.naoApto]: ['REGISTERED', false] });
  });

  it.each(['COMPLETED', 'QUALIFIED', 'IN_DOUBT'])('REGISTERED não apto → %s: 403 WORKER_NOT_ELIGIBLE/documents_not_validated e NADA gravado', async (targetStage) => {
    const antesEventos = (await pool.query(`SELECT count(*)::int AS n FROM domain_events`)).rows[0].n;
    const r = await move(ENC.naoApto, { targetStage, reasonCategory: 'ENCUADRE_ANTECIPADO' });
    expect(r.status).toBe(403);
    expect(r.body).toMatchObject({ success: false, code: 'WORKER_NOT_ELIGIBLE', reason: 'documents_not_validated', workerStatus: 'REGISTERED' });
    expect(await stageOf(ID.naoApto)).toBeNull();
    expect((await pool.query(`SELECT count(*)::int AS n FROM domain_events`)).rows[0].n).toBe(antesEventos);
    expect(published).toEqual([]);
  });

  it('controle positivo: o apto vai a COMPLETED (200) — o teste sabe dizer "passou"', async () => {
    const r = await move(ENC.apto, { targetStage: 'COMPLETED', reasonCategory: 'ENCUADRE_ANTECIPADO' });
    expect(r.status).toBe(200);
    expect(await stageOf(ID.apto)).toBe('COMPLETED');
  });

  it('destino que NÃO é de Completado segue no limiar de hoje: o REGISTERED não apto vai a REJECTED', async () => {
    const r = await move(ENC.naoApto, { targetStage: 'REJECTED', reasonCategory: 'DISTANCE', rejectionReason: 'distance' });
    expect(r.status).toBe(200);
    expect(await stageOf(ID.naoApto)).toBe('REJECTED');
  });
});
