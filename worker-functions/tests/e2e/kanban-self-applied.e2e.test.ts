/**
 * kanban-self-applied.e2e.test.ts
 *
 * "Levantou a mão": quando o PRÓPRIO prestador entra numa vaga pelo link
 * público (track-channel → ApplyToVacancyUseCase), o trigger de histórico
 * grava o ator `worker_self:<uid>` (D95). O card do Kanban precisa mostrar
 * isso — sem o selo ele é idêntico a um convite frio que ninguém pediu, e a
 * pessoa fica esperando em silêncio (caso Carina: 14 vagas em 3 semanas,
 * zero contato).
 *
 * Este teste afirma a LINHA do histórico → o campo da API, contra Postgres
 * real. Mock não pega: a derivação é SQL (LIKE no prefixo do ator).
 */

import { Pool } from 'pg';
import { createApiClient, createPatientFixture, getMockToken, waitForBackend } from './helpers';

const DATABASE_URL =
  process.env.DATABASE_URL ||
  'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

describe('GET /api/admin/vacancies/:id/funnel — selo de auto-postulação', () => {
  const api = createApiClient();
  let adminToken: string;
  let pool: Pool;
  let patientId: string;
  let vacancyId: string;
  let selfWorkerId: string;
  let coldWorkerId: string;
  let selfWjaId: string;
  let coldWjaId: string;

  const stamp = Date.now();

  beforeAll(async () => {
    await waitForBackend(api);
    adminToken = await getMockToken(api, {
      uid: 'kanban-selfapply-admin',
      email: 'kanban-selfapply-admin@e2e.local',
      role: 'admin',
    });
    pool = new Pool({ connectionString: DATABASE_URL });
    patientId = await createPatientFixture(pool, 'kanban-selfapply');

    const vacancy = await pool.query(
      `INSERT INTO job_postings (title, country, status, patient_id, case_number)
       VALUES ('Caso E2E self-apply', 'AR', 'SEARCHING', $1, 99973)
       RETURNING id`,
      [patientId],
    );
    vacancyId = vacancy.rows[0].id as string;

    const mkWorker = async (tag: string): Promise<string> => {
      const r = await pool.query(
        `INSERT INTO workers (auth_uid, email, country, timezone)
         VALUES ($1, $2, 'AR', 'America/Argentina/Buenos_Aires')
         RETURNING id`,
        [`uid-${tag}-${stamp}`, `${tag}-${stamp}@selfapply.test`],
      );
      return r.rows[0].id as string;
    };
    selfWorkerId = await mkWorker('selfapply');
    coldWorkerId = await mkWorker('coldinvite');

    const mkWja = async (workerId: string): Promise<string> => {
      const r = await pool.query(
        `INSERT INTO worker_job_applications
           (worker_id, job_posting_id, application_funnel_stage, source, acquisition_channel)
         VALUES ($1, $2, 'INVITED', 'talentum', 'site')
         RETURNING id`,
        [workerId, vacancyId],
      );
      return r.rows[0].id as string;
    };
    selfWjaId = await mkWja(selfWorkerId);
    coldWjaId = await mkWja(coldWorkerId);

    // Só a primeira candidatura tem carimbo do próprio prestador. A segunda
    // fica com o autor que o time usa ao arrastar o card.
    await pool.query(
      `INSERT INTO worker_job_application_stage_history
         (application_id, field_name, old_value, new_value, changed_by)
       VALUES ($1, 'application_funnel_stage', NULL, 'INVITED', $2)`,
      [selfWjaId, `worker_self:uid-selfapply-${stamp}`],
    );
    await pool.query(
      `INSERT INTO worker_job_application_stage_history
         (application_id, field_name, old_value, new_value, changed_by)
       VALUES ($1, 'application_funnel_stage', NULL, 'INVITED', 'staff:some-recruiter-uid')`,
      [coldWjaId],
    );
  });

  afterAll(async () => {
    if (pool) {
      await pool.query(
        `DELETE FROM worker_job_application_stage_history WHERE application_id = ANY($1::uuid[])`,
        [[selfWjaId, coldWjaId]],
      );
      await pool.query(`DELETE FROM encuadres WHERE job_posting_id = $1`, [vacancyId]);
      await pool.query(`DELETE FROM worker_job_applications WHERE job_posting_id = $1`, [vacancyId]);
      await pool.query(`DELETE FROM workers WHERE id = ANY($1::uuid[])`, [[selfWorkerId, coldWorkerId]]);
      await pool.query(`DELETE FROM job_postings WHERE id = $1`, [vacancyId]);
      await pool.query(`DELETE FROM patients WHERE id = $1`, [patientId]);
      await pool.end();
    }
  });

  it('quem entrou sozinho vem com selfAppliedAt; quem foi convidado pelo time vem null', async () => {
    const res = await api.get(`/api/admin/vacancies/${vacancyId}/funnel`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(res.status).toBe(200);

    const cards = Object.values(
      res.data.data.stages as Record<string, Array<Record<string, unknown>>>,
    ).flat();

    const selfCard = cards.find((c) => c.id === selfWjaId);
    const coldCard = cards.find((c) => c.id === coldWjaId);
    expect(selfCard).toBeDefined();
    expect(coldCard).toBeDefined();

    expect(selfCard!.selfAppliedAt).toEqual(expect.any(String));
    // Ausência de carimbo NUNCA vira "levantou a mão" — o Kanban não infere.
    expect(coldCard!.selfAppliedAt).toBeNull();
  });

  it('vale a PRIMEIRA manifestação, mesmo com movimentos posteriores do time', async () => {
    await pool.query(
      `INSERT INTO worker_job_application_stage_history
         (application_id, field_name, old_value, new_value, changed_by)
       VALUES ($1, 'application_funnel_stage', 'INVITED', 'QUALIFIED', 'staff:some-recruiter-uid')`,
      [selfWjaId],
    );

    const res = await api.get(`/api/admin/vacancies/${vacancyId}/funnel`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    const cards = Object.values(
      res.data.data.stages as Record<string, Array<Record<string, unknown>>>,
    ).flat();
    const selfCard = cards.find((c) => c.id === selfWjaId);

    expect(selfCard!.selfAppliedAt).toEqual(expect.any(String));
  });
});
