/**
 * admin-kanban-interview-source.test.ts
 *
 * Valida que o GET /api/admin/vacancies/:id/funnel devolve data e link da
 * entrevista a partir de worker_job_applications.interview_datetime /
 * interview_meet_link quando o agendamento aconteceu via WhatsApp
 * (BookSlotFromWhatsAppUseCase escreve só em worker_job_applications,
 * deixando encuadres.interview_date / meet_link nulos).
 *
 * Esse cenário cobre regressão do bug em que o card aparecia em CONFIRMED
 * com data vazia.
 */

import { Pool } from 'pg';
import { createApiClient, createPatientFixture, getMockToken, waitForBackend } from './helpers';

const DATABASE_URL =
  process.env.DATABASE_URL ||
  'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

describe('GET /api/admin/vacancies/:id/funnel — fonte da data de entrevista', () => {
  const api = createApiClient();
  let adminToken: string;
  let pool: Pool;
  let patientId: string;
  let vacancyId: string;
  let workerId: string;
  let encuadreId: string;

  beforeAll(async () => {
    await waitForBackend(api);
    adminToken = await getMockToken(api, {
      uid: 'kanban-interview-admin',
      email: 'kanban-interview-admin@e2e.local',
      role: 'admin',
    });
    pool = new Pool({ connectionString: DATABASE_URL });
    patientId = await createPatientFixture(pool, 'kanban-interview');

    const vacancy = await pool.query(
      `INSERT INTO job_postings (title, country, status, patient_id, case_number)
       VALUES ('Caso E2E kanban', 'AR', 'SEARCHING', $1, 99981)
       RETURNING id`,
      [patientId],
    );
    vacancyId = vacancy.rows[0].id as string;

    const worker = await pool.query(
      `INSERT INTO workers (auth_uid, email, country, timezone)
       VALUES ($1, $2, 'AR', 'America/Argentina/Buenos_Aires')
       RETURNING id`,
      [`uid-kanban-${Date.now()}`, `kanban-${Date.now()}@interview.test`],
    );
    workerId = worker.rows[0].id as string;

    // Cenário moderno: WhatsApp gravou em worker_job_applications,
    // encuadres ficou sem data/meet_link (fonte legada vazia).
    // source='talentum' bypasses the INCOMPLETE_REGISTER trigger guard.
    await pool.query(
      `INSERT INTO worker_job_applications
         (worker_id, job_posting_id, application_funnel_stage,
          interview_datetime, interview_meet_link, interview_response, source)
       VALUES ($1, $2, 'CONFIRMED', '2026-06-01 14:30:00+00', 'https://meet.google.com/abc-defg-hij', 'confirmed', 'talentum')`,
      [workerId, vacancyId],
    );

    // O trigger trg_ensure_encuadre_on_wja_insert já criou um encuadre ao inserir a WJA.
    // Fazemos upsert para obter o id do encuadre existente (ou criar se ainda não existe).
    const enc = await pool.query(
      `INSERT INTO encuadres (worker_id, job_posting_id, worker_raw_name)
       VALUES ($1, $2, 'Worker Kanban E2E')
       ON CONFLICT (worker_id, job_posting_id) DO UPDATE SET worker_raw_name = EXCLUDED.worker_raw_name
       RETURNING id`,
      [workerId, vacancyId],
    );
    encuadreId = enc.rows[0].id as string;
  });

  afterAll(async () => {
    if (pool) {
      await pool.query(`DELETE FROM encuadres WHERE id = $1`, [encuadreId]);
      await pool.query(`DELETE FROM worker_job_applications WHERE worker_id = $1`, [workerId]);
      await pool.query(`DELETE FROM workers WHERE id = $1`, [workerId]);
      await pool.query(`DELETE FROM job_postings WHERE id = $1`, [vacancyId]);
      await pool.query(`DELETE FROM patients WHERE id = $1`, [patientId]);
      await pool.end();
    }
  });

  it('card no kanban lê interviewDate/Time/meetLink de worker_job_applications quando encuadres.interview_date está nulo', async () => {
    const res = await api.get(
      `/api/admin/vacancies/${vacancyId}/funnel`,
      { headers: { Authorization: `Bearer ${adminToken}` } },
    );
    expect(res.status).toBe(200);
    const confirmed = res.data.data.stages.CONFIRMED as Array<Record<string, unknown>>;

    // Phase 1 fix: card.id is now wja.id; card.encuadreId holds the encuadre id.
    // Match by encuadreId (the encuadre created in beforeAll).
    const card = confirmed.find((c) => c.encuadreId === encuadreId);
    expect(card).toBeDefined();

    const interviewDate = card!.interviewDate as string;
    expect(interviewDate.startsWith('2026-06-01')).toBe(true);

    // 14:30Z exibido no fuso da OPERAÇÃO (America/Argentina/Buenos_Aires, UTC-3) = 11:30.
    // Desde 30/07 o Kanban resolve data/hora via INTERVIEW_*_RESOLVED_SQL (fuso BsAs) —
    // exibir em UTC era o comportamento antigo: entrevista de 21h local caía no dia seguinte.
    expect(card!.interviewTime).toBe('11:30:00');
    expect(card!.meetLink).toBe('https://meet.google.com/abc-defg-hij');
  });
});
