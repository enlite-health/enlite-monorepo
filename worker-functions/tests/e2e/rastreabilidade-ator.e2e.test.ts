/**
 * rastreabilidade-ator.e2e.test.ts
 *
 * "Quem fez o quê" no recrutamento — contra Postgres + API reais.
 *
 * O carimbo depende de `set_config('app.current_uid', …, true)` acontecer DENTRO
 * da mesma transação do UPDATE, e disso o trigger `fn_log_application_stage_change`
 * ler a sessão. Nenhum unit test com pool mockado prova isso: o mock aceita
 * qualquer sequência de queries e não tem trigger. Por isso este teste afirma a
 * LINHA GRAVADA, não o 200 do endpoint.
 *
 * openspec: rastreabilidade-ator-recrutamento, Bloco 4.
 */

import { Pool } from 'pg';
import { createApiClient, createPatientFixture, getMockToken, waitForBackend } from './helpers';

const DATABASE_URL =
  process.env.DATABASE_URL ||
  'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

describe('Movimento de funil registra QUEM moveu', () => {
  const api = createApiClient();
  let pool: Pool;
  let patientId: string;
  let vacancyId: string;
  let workerA: string;
  let workerB: string;
  let encuadreA: string;
  let encuadreB: string;
  const uniqueCaseNumber = 99962;
  const suffix = `ator-${Date.now()}`;

  /** Duas recrutadoras diferentes — é a comparação que a medição precisa fazer. */
  const STAFF_A = { uid: `uid-staff-a-${suffix}`, email: `flor-${suffix}@e2e.local` };
  const STAFF_B = { uid: `uid-staff-b-${suffix}`, email: `gris-${suffix}@e2e.local` };

  async function tokenFor(staff: { uid: string; email: string }): Promise<string> {
    return getMockToken(api, { uid: staff.uid, email: staff.email, role: 'admin' });
  }

  async function createWorkerWithEncuadre(tag: string): Promise<{ workerId: string; encuadreId: string }> {
    const w = await pool.query(
      `INSERT INTO workers (auth_uid, email, country, timezone, status)
       VALUES ($1, $2, 'AR', 'America/Argentina/Buenos_Aires', 'REGISTERED')
       RETURNING id`,
      [`uid-${tag}-${suffix}`, `worker-${tag}-${suffix}@ator.test`],
    );
    const workerId = w.rows[0].id as string;
    await pool.query(
      `INSERT INTO worker_job_applications (worker_id, job_posting_id, application_funnel_stage)
       VALUES ($1, $2, 'INVITED')`,
      [workerId, vacancyId],
    );
    // O encuadre nasce junto com a candidatura, pelo trigger
    // `trg_ensure_encuadre_on_wja_insert` — criar aqui violaria
    // `encuadres_worker_job_unique`.
    const e = await pool.query(
      `SELECT id FROM encuadres WHERE worker_id = $1 AND job_posting_id = $2`,
      [workerId, vacancyId],
    );
    expect(e.rowCount).toBe(1);
    return { workerId, encuadreId: e.rows[0].id as string };
  }

  /** Linhas de histórico de etapa do worker, mais recentes primeiro. */
  async function stageHistory(workerId: string) {
    const { rows } = await pool.query(
      `SELECT h.changed_by, h.change_source, h.old_value, h.new_value
         FROM worker_job_application_stage_history h
         JOIN worker_job_applications wja ON wja.id = h.application_id
        WHERE wja.worker_id = $1
        ORDER BY h.created_at DESC`,
      [workerId],
    );
    return rows as Array<{
      changed_by: string | null;
      change_source: string | null;
      old_value: string | null;
      new_value: string | null;
    }>;
  }

  beforeAll(async () => {
    await waitForBackend(api);
    pool = new Pool({ connectionString: DATABASE_URL });
    patientId = await createPatientFixture(pool, 'ator-trace');

    const vacancy = await pool.query(
      `INSERT INTO job_postings (title, description, country, status, patient_id, case_number, providers_needed)
       VALUES ('Caso E2E rastreabilidade', 'desc', 'AR', 'SEARCHING', $1, $2, '2')
       RETURNING id`,
      [patientId, uniqueCaseNumber],
    );
    vacancyId = vacancy.rows[0].id as string;

    ({ workerId: workerA, encuadreId: encuadreA } = await createWorkerWithEncuadre('a'));
    ({ workerId: workerB, encuadreId: encuadreB } = await createWorkerWithEncuadre('b'));
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM encuadres WHERE job_posting_id = $1`, [vacancyId]);
    await pool.query(`DELETE FROM worker_job_applications WHERE job_posting_id = $1`, [vacancyId]);
    await pool.query(`DELETE FROM job_postings WHERE id = $1`, [vacancyId]);
    await pool.query(`DELETE FROM workers WHERE id = ANY($1::uuid[])`, [[workerA, workerB]]);
    await pool.query(`DELETE FROM patients WHERE id = $1`, [patientId]);
    await pool.end();
  });

  it('card movido pelo painel grava staff:<uid> na linha de histórico', async () => {
    const token = await tokenFor(STAFF_A);

    const res = await api.put(
      `/api/admin/encuadres/${encuadreA}/move`,
      { targetStage: 'QUALIFIED' },
      { headers: { Authorization: `Bearer ${token}` } },
    );
    expect(res.status).toBe(200);

    const history = await stageHistory(workerA);
    const move = history.find((h) => h.new_value === 'QUALIFIED');
    expect(move).toBeDefined();
    expect(move!.changed_by).toBe(`staff:${STAFF_A.uid}`);
    expect(move!.old_value).toBe('INVITED');
  });

  it('duas pessoas diferentes ficam distinguíveis — é o que a comparação exige', async () => {
    const token = await tokenFor(STAFF_B);

    const res = await api.put(
      `/api/admin/encuadres/${encuadreB}/move`,
      { targetStage: 'IN_DOUBT' },
      { headers: { Authorization: `Bearer ${token}` } },
    );
    expect(res.status).toBe(200);

    const [moveB] = await stageHistory(workerB);
    expect(moveB.changed_by).toBe(`staff:${STAFF_B.uid}`);

    const [moveA] = await stageHistory(workerA);
    expect(moveA.changed_by).toBe(`staff:${STAFF_A.uid}`);
    expect(moveA.changed_by).not.toBe(moveB.changed_by);
  });

  it('a fonte é derivável do prefixo, sem depender da coluna change_source', async () => {
    const { rows } = await pool.query(
      `SELECT CASE
                WHEN h.changed_by LIKE 'staff:%' THEN 'admin_panel'
                WHEN h.changed_by LIKE 'luz:%'   THEN 'luz_conversation'
                WHEN h.changed_by IS NULL        THEN 'nao_instrumentado'
                ELSE 'outro'
              END AS source,
              COUNT(*)::int AS n
         FROM worker_job_application_stage_history h
         JOIN worker_job_applications wja ON wja.id = h.application_id
        WHERE wja.job_posting_id = $1
        GROUP BY 1`,
      [vacancyId],
    );
    const bySource = Object.fromEntries(rows.map((r) => [r.source, r.n]));
    expect(bySource.admin_panel).toBeGreaterThanOrEqual(2);
  });

  it('movimento inválido não deixa linha de histórico órfã (rollback)', async () => {
    const token = await tokenFor(STAFF_A);
    const before = (await stageHistory(workerA)).length;

    const res = await api.put(
      `/api/admin/encuadres/${encuadreA}/move`,
      { targetStage: 'ETAPA_QUE_NAO_EXISTE' },
      { headers: { Authorization: `Bearer ${token}` } },
    );
    expect(res.status).toBe(400);

    expect((await stageHistory(workerA)).length).toBe(before);
  });

  it('a leitura agregada separa os atores e não mostra PII de candidato', async () => {
    const { rows } = await pool.query(
      `SELECT h.changed_by AS actor, COUNT(*)::int AS acoes
         FROM worker_job_application_stage_history h
         JOIN worker_job_applications wja ON wja.id = h.application_id
        WHERE wja.job_posting_id = $1 AND h.changed_by IS NOT NULL
        GROUP BY 1 ORDER BY 2 DESC`,
      [vacancyId],
    );
    const actors = rows.map((r) => r.actor as string);
    expect(actors).toEqual(expect.arrayContaining([`staff:${STAFF_A.uid}`, `staff:${STAFF_B.uid}`]));
    // identidade é uid/prefixo — nada de nome, telefone ou documento do candidato
    expect(actors.every((a) => a.startsWith('staff:'))).toBe(true);
  });
});
