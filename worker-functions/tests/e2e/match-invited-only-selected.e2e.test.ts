/**
 * match-invited-only-selected.e2e.test.ts
 *
 * ClickUp 86ajb48v1 AC2 — "Incluir na lista de Invitados somente os selecionados;
 * colocar todos está gerando uma métrica falsa".
 *
 * Rodar o match (MatchmakingService.saveMatchResults) persiste TODOS os top-N
 * candidatos como worker_job_applications com application_funnel_stage='INVITED'
 * e source='system'. Isso, sozinho, NÃO é um convite — inflava a coluna
 * "Invitados" do Kanban da vaga com gente que nunca foi contatada.
 *
 * Só um envio real (MessagingController.sendVacancyMatch → SET messaged_at)
 * transforma um match candidate em convite. Este teste prova, contra o banco
 * REAL via GET /api/admin/vacancies/:id/funnel, que a coluna INVITED conta
 * apenas os que têm messaged_at (os efetivamente enviados/selecionados).
 *
 * NÃO RODAR em CI compartilhado sem banco dedicado (escreve em tabelas reais).
 * Pré-condição: stack Docker de teste no ar (postgres + api) e migrations aplicadas.
 */

import { Pool } from 'pg';
import { createApiClient, createPatientFixture, getMockToken, waitForBackend } from './helpers';

const DATABASE_URL =
  process.env.DATABASE_URL ||
  'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

describe('GET /api/admin/vacancies/:id/funnel — Invitados só conta convites reais (AC2 86ajb48v1)', () => {
  const api = createApiClient();
  let adminToken: string;
  let pool: Pool;
  let patientId: string;
  let vacancyId: string;
  const workerIds: string[] = [];

  async function makeWorker(tag: string): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO workers (auth_uid, email, status, country, timezone)
       VALUES ($1, $2, 'REGISTERED', 'AR', 'America/Argentina/Buenos_Aires')
       RETURNING id`,
      [`uid-match-sel-${Date.now()}-${tag}`, `match-sel-${Date.now()}-${tag}@e2e.test`],
    );
    workerIds.push(rows[0].id);
    return rows[0].id;
  }

  beforeAll(async () => {
    await waitForBackend(api);
    adminToken = await getMockToken(api, {
      uid: 'match-sel-admin',
      email: 'match-sel-admin@e2e.local',
      role: 'admin',
    });
    pool = new Pool({ connectionString: DATABASE_URL });
    patientId = await createPatientFixture(pool, 'match-sel');

    const vacancy = await pool.query(
      `INSERT INTO job_postings (title, country, status, patient_id, case_number)
       VALUES ('Caso E2E match-sel', 'AR', 'SEARCHING', $1, 99977)
       RETURNING id`,
      [patientId],
    );
    vacancyId = vacancy.rows[0].id as string;

    // 2 match candidates NUNCA enviados (system + INVITED + messaged_at NULL)
    const notInvitedA = await makeWorker('not-a');
    const notInvitedB = await makeWorker('not-b');
    // 1 convite REAL (system + INVITED + messaged_at preenchido pelo envio)
    const invited = await makeWorker('sent');

    await pool.query(
      `INSERT INTO worker_job_applications
         (worker_id, job_posting_id, application_funnel_stage, source, acquisition_channel, messaged_at)
       VALUES
         ($1, $4, 'INVITED', 'system', 'system', NULL),
         ($2, $4, 'INVITED', 'system', 'system', NULL),
         ($3, $4, 'INVITED', 'system', 'system', NOW())`,
      [notInvitedA, notInvitedB, invited, vacancyId],
    );
  });

  afterAll(async () => {
    if (pool) {
      for (const wid of workerIds) {
        await pool.query(`DELETE FROM encuadres WHERE worker_id = $1`, [wid]);
        await pool.query(`DELETE FROM worker_job_applications WHERE worker_id = $1`, [wid]);
        await pool.query(`DELETE FROM workers WHERE id = $1`, [wid]);
      }
      await pool.query(`DELETE FROM job_postings WHERE id = $1`, [vacancyId]);
      await pool.query(`DELETE FROM patients WHERE id = $1`, [patientId]);
      await pool.end();
    }
  });

  it('coluna INVITED conta só o candidato com messaged_at (convite real), não os 2 apenas matcheados', async () => {
    const res = await api.get(
      `/api/admin/vacancies/${vacancyId}/funnel`,
      { headers: { Authorization: `Bearer ${adminToken}` } },
    );
    expect(res.status).toBe(200);

    const invited = res.data.data.stages.INVITED as Array<Record<string, unknown>>;
    const invitedWorkerIds = invited.map((c) => c.workerId as string);

    // Só o realmente enviado aparece — os 2 match candidates ficam de fora.
    expect(invited).toHaveLength(1);
    expect(invitedWorkerIds).toContain(workerIds[2]); // 'sent'
    expect(invitedWorkerIds).not.toContain(workerIds[0]); // 'not-a'
    expect(invitedWorkerIds).not.toContain(workerIds[1]); // 'not-b'

    // Métrica correta: total de cards visíveis = 1 (não 3).
    expect(res.data.data.totalEncuadres).toBe(1);
  });
});
