/**
 * interview-slots.test.ts
 *
 * Testes E2E para agendamento de entrevistas (Wave 2).
 * Usa MockAuth (USE_MOCK_AUTH=true) + PostgreSQL real via Docker.
 *
 * Endpoints cobertos:
 *   POST   /api/admin/vacancies/:id/interview-slots   — criar slots em batch
 *   GET    /api/admin/vacancies/:id/interview-slots   — listar slots + summary
 *   GET    /api/admin/vacancies/:id/interview-slots?status=AVAILABLE — filtrar
 *   POST   /api/admin/interview-slots/:slotId/book    — reservar slot
 *   DELETE /api/admin/interview-slots/:slotId         — cancelar slot
 *
 * Verificações de banco:
 *   - interview_slots criados e persistidos
 *   - encuadres.interview_slot_id, interview_date, interview_time, meet_link atualizados
 *   - messaging_outbox recebe convite após booking com worker vinculado
 *   - Trigger auto-status: booked_count = max_capacity → status = FULL
 *   - cancelSlot limpa interview_slot_id dos encuadres vinculados
 *
 * Schema checks (migration 095):
 *   - Tabela interview_slots existe com todas as colunas
 *   - Colunas interview_slot_id, reminder_day_sent_at, reminder_5min_sent_at em encuadres
 *   - Templates encuadre_invitation, encuadre_reminder_day_before, encuadre_reminder_5min
 */

import { Pool } from 'pg';
import { createApiClient, createPatientFixture, getMockToken, waitForBackend } from './helpers';

const DATABASE_URL =
  process.env.DATABASE_URL ||
  'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

// Datas futuras para slots (evita a validação "data no passado")
const FUTURE_DATE_1 = '2099-06-01';
const FUTURE_DATE_2 = '2099-06-02';

describe('Interview Slots API — Wave 2', () => {
  const api = createApiClient();
  let adminToken: string;
  let workerToken: string;
  let pool: Pool;

  // IDs criados no beforeAll e reutilizados nos testes
  let vacancyId: string;
  let workerId: string;
  let workerBId: string; // segundo worker para subtestes que precisam de encuadre extra
  let workerCId: string; // terceiro worker para subteste de invite
  let workerDId: string; // quarto worker para subteste de cancelamento
  let encuadreId: string;

  beforeAll(async () => {
    await waitForBackend(api);

    adminToken = await getMockToken(api, {
      uid: 'slots-admin-e2e',
      email: 'slots-admin@e2e.local',
      role: 'admin',
    });

    workerToken = await getMockToken(api, {
      uid: 'slots-worker-e2e',
      email: 'slots-worker@e2e.local',
      role: 'worker',
    });

    pool = new Pool({ connectionString: DATABASE_URL });

    // Re-insere templates de lembrete (o setup.ts trunca message_templates)
    await pool.query(`
      INSERT INTO message_templates (slug, name, body, is_active, created_at, updated_at) VALUES
        ('encuadre_invitation',       'Invitación de Encuadre',       'Hola {{workerName}}, tu encuadre está agendado para {{interviewDate}} a las {{interviewTime}}. Link: {{meetLink}}', true, NOW(), NOW()),
        ('encuadre_reminder_day_before', 'Recordatorio Día Anterior', 'Hola {{workerName}}, mañana tenés tu encuadre a las {{interviewTime}}. Link: {{meetLink}}',                        true, NOW(), NOW()),
        ('encuadre_reminder_5min',    'Recordatorio 5 Minutos',       'Hola {{workerName}}, tu encuadre comienza en 5 minutos. Link: {{meetLink}}',                                         true, NOW(), NOW())
      ON CONFLICT (slug) DO NOTHING
    `);

    // patient_id é obrigatório no POST /api/admin/vacancies — fixture primeiro.
    const patientId = await createPatientFixture(pool, 'interview-slots');

    // Cria uma vaga via API para usar nos testes
    const vacancyRes = await api.post(
      '/api/admin/vacancies',
      { patient_id: patientId, case_number: 77701, title: 'Caso E2E Interview Slots' },
      { headers: { Authorization: `Bearer ${adminToken}` } },
    );
    expect(vacancyRes.status).toBe(201);
    vacancyId = vacancyRes.data.data.id;

    // Cria workers REGISTERED para os testes.
    // Pós-ADR-001 UNIQUE (worker_id, job_posting_id) em encuadres: cada encuadre
    // precisa de um worker distinto para a mesma vaga.
    const insertWorker = async (authUid: string, email: string, phone: string) => {
      const r = await pool.query(`
        INSERT INTO workers (auth_uid, email, phone, status, created_at, updated_at)
        VALUES ($1, $2, $3, 'REGISTERED', NOW(), NOW())
        ON CONFLICT (auth_uid) DO UPDATE SET email = EXCLUDED.email
        RETURNING id
      `, [authUid, email, phone]);
      return r.rows[0].id as string;
    };

    workerId  = await insertWorker('slots-worker-uid-e2e',  'slots-worker@e2e.local',   '+5491199990001');
    workerBId = await insertWorker('slots-workerB-uid-e2e', 'slots-workerB@e2e.local',  '+5491199990002');
    workerCId = await insertWorker('slots-workerC-uid-e2e', 'slots-workerC@e2e.local',  '+5491199990003');
    workerDId = await insertWorker('slots-workerD-uid-e2e', 'slots-workerD@e2e.local',  '+5491199990004');

    // Cria um encuadre para workerId + vacancy (worker principal)
    const encuadreInsert = await pool.query(`
      INSERT INTO encuadres (worker_id, job_posting_id, worker_raw_name, resultado, dedup_hash, created_at, updated_at)
      VALUES ($1, $2, 'Worker Slots E2E', 'PENDIENTE', md5('slots-main-' || $1::text || $2::text), NOW(), NOW())
      ON CONFLICT (worker_id, job_posting_id) DO UPDATE SET worker_raw_name = EXCLUDED.worker_raw_name
      RETURNING id
    `, [workerId, vacancyId]);
    encuadreId = encuadreInsert.rows[0].id;
  });

  afterAll(async () => {
    if (pool) await pool.end();
  });

  function auth(token: string) {
    return { headers: { Authorization: `Bearer ${token}` } };
  }

  // ── Schema checks (migration 095) ────────────────────────────────────────

  describe('Schema — migration 095', () => {
    it('tabela interview_slots existe', async () => {
      const { rows } = await pool.query(`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'interview_slots'
      `);
      expect(rows).toHaveLength(1);
    });

    it('interview_slots tem todas as colunas necessárias', async () => {
      const { rows } = await pool.query(`
        SELECT column_name FROM information_schema.columns
        WHERE table_name = 'interview_slots'
      `);
      const cols = rows.map((r: any) => r.column_name);
      expect(cols).toContain('id');
      expect(cols).toContain('job_posting_id');
      expect(cols).toContain('coordinator_id');
      expect(cols).toContain('slot_date');
      expect(cols).toContain('slot_time');
      expect(cols).toContain('slot_end_time');
      expect(cols).toContain('meet_link');
      expect(cols).toContain('max_capacity');
      expect(cols).toContain('booked_count');
      expect(cols).toContain('status');
      expect(cols).toContain('notes');
    });

    it('encuadres tem colunas de rastreamento de lembrete', async () => {
      const { rows } = await pool.query(`
        SELECT column_name FROM information_schema.columns
        WHERE table_name = 'encuadres'
          AND column_name IN ('interview_slot_id', 'reminder_day_sent_at', 'reminder_5min_sent_at')
      `);
      const cols = rows.map((r: any) => r.column_name);
      expect(cols).toContain('interview_slot_id');
      expect(cols).toContain('reminder_day_sent_at');
      expect(cols).toContain('reminder_5min_sent_at');
    });

    it('templates de lembrete foram inseridos', async () => {
      const { rows } = await pool.query(`
        SELECT slug FROM message_templates
        WHERE slug IN ('encuadre_invitation', 'encuadre_reminder_day_before', 'encuadre_reminder_5min')
        ORDER BY slug
      `);
      const slugs = rows.map((r: any) => r.slug);
      expect(slugs).toContain('encuadre_invitation');
      expect(slugs).toContain('encuadre_reminder_day_before');
      expect(slugs).toContain('encuadre_reminder_5min');
    });
  });

  // ── POST /api/admin/vacancies/:id/interview-slots ─────────────────────────

  describe('POST /api/admin/vacancies/:id/interview-slots', () => {
    it('cria slots em batch → 201 + array com slots criados', async () => {
      const res = await api.post(
        `/api/admin/vacancies/${vacancyId}/interview-slots`,
        {
          meetLink: 'https://meet.google.com/e2e-test-slot',
          notes: 'Slots E2E',
          slots: [
            { date: FUTURE_DATE_1, startTime: '09:00', endTime: '09:30', maxCapacity: 1 },
            { date: FUTURE_DATE_1, startTime: '09:30', endTime: '10:00', maxCapacity: 2 },
          ],
        },
        auth(adminToken),
      );

      expect(res.status).toBe(201);
      expect(res.data.success).toBe(true);
      expect(Array.isArray(res.data.data)).toBe(true);
      expect(res.data.data).toHaveLength(2);
      expect(res.data.data[0].slotDate).toBe(FUTURE_DATE_1);
      expect(res.data.data[0].slotTime).toBe('09:00');
      expect(res.data.data[0].status).toBe('AVAILABLE');
      expect(res.data.data[0].bookedCount).toBe(0);
      expect(res.data.data[1].maxCapacity).toBe(2);
    });

    it('slots são persistidos no banco', async () => {
      const { rows } = await pool.query(
        `SELECT * FROM interview_slots WHERE job_posting_id = $1 ORDER BY slot_time`,
        [vacancyId],
      );
      expect(rows.length).toBeGreaterThanOrEqual(2);
      expect(rows[0].meet_link).toBe('https://meet.google.com/e2e-test-slot');
      expect(rows[0].status).toBe('AVAILABLE');
    });

    it('retorna 400 quando slots array está vazio', async () => {
      const res = await api.post(
        `/api/admin/vacancies/${vacancyId}/interview-slots`,
        { slots: [] },
        auth(adminToken),
      );
      expect(res.status).toBe(400);
      expect(res.data.success).toBe(false);
    });

    it('retorna 400 para data no passado', async () => {
      const res = await api.post(
        `/api/admin/vacancies/${vacancyId}/interview-slots`,
        {
          slots: [{ date: '2020-01-01', startTime: '09:00', endTime: '09:30' }],
        },
        auth(adminToken),
      );
      expect(res.status).toBe(400);
      expect(res.data.success).toBe(false);
    });

    it('retorna 401 sem token', async () => {
      const res = await api.post(
        `/api/admin/vacancies/${vacancyId}/interview-slots`,
        { slots: [{ date: FUTURE_DATE_2, startTime: '10:00', endTime: '10:30' }] },
      );
      expect(res.status).toBe(401);
    });

    it('retorna 403 para role worker', async () => {
      const res = await api.post(
        `/api/admin/vacancies/${vacancyId}/interview-slots`,
        { slots: [{ date: FUTURE_DATE_2, startTime: '10:00', endTime: '10:30' }] },
        auth(workerToken),
      );
      expect(res.status).toBe(403);
    });
  });

  // ── GET /api/admin/vacancies/:id/interview-slots ──────────────────────────

  describe('GET /api/admin/vacancies/:id/interview-slots', () => {
    it('retorna slots com summary correto', async () => {
      const res = await api.get(
        `/api/admin/vacancies/${vacancyId}/interview-slots`,
        auth(adminToken),
      );

      expect(res.status).toBe(200);
      expect(res.data.success).toBe(true);
      expect(res.data.data.jobPostingId).toBe(vacancyId);
      expect(Array.isArray(res.data.data.slots)).toBe(true);
      expect(res.data.data.slots.length).toBeGreaterThanOrEqual(2);

      const summary = res.data.data.summary;
      expect(summary).toHaveProperty('total');
      expect(summary).toHaveProperty('available');
      expect(summary).toHaveProperty('full');
      expect(summary).toHaveProperty('cancelled');
      expect(summary.total).toBeGreaterThanOrEqual(2);
      expect(summary.available).toBeGreaterThanOrEqual(2);
    });

    it('?status=AVAILABLE filtra apenas slots disponíveis', async () => {
      const res = await api.get(
        `/api/admin/vacancies/${vacancyId}/interview-slots?status=AVAILABLE`,
        auth(adminToken),
      );

      expect(res.status).toBe(200);
      const slots = res.data.data.slots;
      slots.forEach((s: any) => expect(s.status).toBe('AVAILABLE'));
    });

    it('retorna 401 sem token', async () => {
      const res = await api.get(`/api/admin/vacancies/${vacancyId}/interview-slots`);
      expect(res.status).toBe(401);
    });
  });

  // ── POST /api/admin/interview-slots/:slotId/book ──────────────────────────

  describe('POST /api/admin/interview-slots/:slotId/book', () => {
    let slotId: string;

    beforeAll(async () => {
      // Cria um slot dedicado para os testes de booking
      const res = await api.post(
        `/api/admin/vacancies/${vacancyId}/interview-slots`,
        {
          meetLink: 'https://meet.google.com/book-test',
          slots: [{ date: FUTURE_DATE_2, startTime: '14:00', endTime: '14:30', maxCapacity: 1 }],
        },
        auth(adminToken),
      );
      slotId = res.data.data[0].id;
    });

    it('reserva slot com sucesso → 200 + dados do agendamento', async () => {
      const res = await api.post(
        `/api/admin/interview-slots/${slotId}/book`,
        { encuadreId, sendInvitation: false },
        auth(adminToken),
      );

      expect(res.status).toBe(200);
      expect(res.data.success).toBe(true);
      expect(res.data.data.slotId).toBe(slotId);
      expect(res.data.data.encuadreId).toBe(encuadreId);
      expect(res.data.data.interviewDate).toBe(FUTURE_DATE_2);
      expect(res.data.data.interviewTime).toBe('14:00');
      expect(res.data.data.meetLink).toBe('https://meet.google.com/book-test');
    });

    it('encuadre atualizado no banco com slot, data e hora', async () => {
      const { rows } = await pool.query(
        `SELECT interview_slot_id, interview_date::text, interview_time, meet_link
         FROM encuadres WHERE id = $1`,
        [encuadreId],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].interview_slot_id).toBe(slotId);
      expect(rows[0].interview_date).toContain(FUTURE_DATE_2);
      expect(rows[0].interview_time).toBe('14:00:00');
      expect(rows[0].meet_link).toBe('https://meet.google.com/book-test');
    });

    it('slot muda para FULL automaticamente quando capacidade esgotada', async () => {
      // O slot tem max_capacity=1 e acabamos de reservar → deve estar FULL
      const { rows } = await pool.query(
        `SELECT status, booked_count FROM interview_slots WHERE id = $1`,
        [slotId],
      );
      expect(rows[0].booked_count).toBe(1);
      expect(rows[0].status).toBe('FULL');
    });

    it('retorna 400 ao tentar reservar slot já lotado', async () => {
      // Cria encuadre para workerB (worker distinto — unique constraint impede 2 encuadres
      // para o mesmo par worker+vaga, então usa workerBId para o segundo candidato)
      const otherEncuadre = await pool.query(`
        INSERT INTO encuadres (worker_id, job_posting_id, worker_raw_name, resultado, dedup_hash, created_at, updated_at)
        VALUES ($1, $2, 'Worker 2 E2E', 'PENDIENTE', md5('slots-b-' || $1::text || $2::text), NOW(), NOW())
        ON CONFLICT (worker_id, job_posting_id) DO UPDATE SET worker_raw_name = EXCLUDED.worker_raw_name
        RETURNING id
      `, [workerBId, vacancyId]);
      const otherId = otherEncuadre.rows[0].id;

      const res = await api.post(
        `/api/admin/interview-slots/${slotId}/book`,
        { encuadreId: otherId, sendInvitation: false },
        auth(adminToken),
      );

      expect(res.status).toBe(400);
      expect(res.data.success).toBe(false);
    });

    it('booking com sendInvitation=true insere na messaging_outbox', async () => {
      // Cria slot fresco e encuadre com worker para testar o convite
      const slotRes = await api.post(
        `/api/admin/vacancies/${vacancyId}/interview-slots`,
        {
          meetLink: 'https://meet.google.com/invite-test',
          slots: [{ date: FUTURE_DATE_2, startTime: '15:00', endTime: '15:30', maxCapacity: 1 }],
        },
        auth(adminToken),
      );
      const inviteSlotId = slotRes.data.data[0].id;

      // workerCId: terceiro worker distinto para o teste de invite (evita unique constraint)
      const encuadreWithWorker = await pool.query(`
        INSERT INTO encuadres (worker_id, job_posting_id, worker_raw_name, resultado, dedup_hash, created_at, updated_at)
        VALUES ($1, $2, 'Worker Invite E2E', 'PENDIENTE', md5('slots-c-' || $1::text || $2::text), NOW(), NOW())
        ON CONFLICT (worker_id, job_posting_id) DO UPDATE SET worker_raw_name = EXCLUDED.worker_raw_name
        RETURNING id
      `, [workerCId, vacancyId]);
      const inviteEncuadreId = encuadreWithWorker.rows[0].id;

      // workerCId é o worker do encuadre de invite — checar a outbox dele
      const outboxBefore = await pool.query(
        `SELECT COUNT(*) FROM messaging_outbox WHERE worker_id = $1 AND template_slug = 'encuadre_invitation'`,
        [workerCId],
      );
      const countBefore = parseInt(outboxBefore.rows[0].count, 10);

      const res = await api.post(
        `/api/admin/interview-slots/${inviteSlotId}/book`,
        { encuadreId: inviteEncuadreId, sendInvitation: true },
        auth(adminToken),
      );

      expect(res.status).toBe(200);
      expect(res.data.data.invitationQueued).toBe(true);

      // Verifica que o registro na outbox foi criado para workerCId
      const outboxAfter = await pool.query(
        `SELECT COUNT(*) FROM messaging_outbox WHERE worker_id = $1 AND template_slug = 'encuadre_invitation'`,
        [workerCId],
      );
      const countAfter = parseInt(outboxAfter.rows[0].count, 10);
      expect(countAfter).toBe(countBefore + 1);
    });

    it('retorna 404 para slotId inexistente', async () => {
      const fakeId = '00000000-0000-0000-0000-000000000000';
      const res = await api.post(
        `/api/admin/interview-slots/${fakeId}/book`,
        { encuadreId, sendInvitation: false },
        auth(adminToken),
      );
      expect(res.status).toBe(404);
      expect(res.data.success).toBe(false);
    });

    it('retorna 400 sem encuadreId no body', async () => {
      const res = await api.post(
        `/api/admin/interview-slots/${slotId}/book`,
        {},
        auth(adminToken),
      );
      expect(res.status).toBe(400);
      expect(res.data.success).toBe(false);
    });

    it('retorna 401 sem token', async () => {
      const res = await api.post(
        `/api/admin/interview-slots/${slotId}/book`,
        { encuadreId },
      );
      expect(res.status).toBe(401);
    });
  });

  // ── DELETE /api/admin/interview-slots/:slotId ─────────────────────────────

  describe('DELETE /api/admin/interview-slots/:slotId', () => {
    let cancelSlotId: string;
    let cancelEncuadreId: string;

    beforeAll(async () => {
      // Cria slot + encuadre agendado para testar o cancelamento
      const slotRes = await api.post(
        `/api/admin/vacancies/${vacancyId}/interview-slots`,
        {
          meetLink: 'https://meet.google.com/cancel-test',
          slots: [{ date: FUTURE_DATE_2, startTime: '16:00', endTime: '16:30', maxCapacity: 1 }],
        },
        auth(adminToken),
      );
      cancelSlotId = slotRes.data.data[0].id;

      // workerDId: quarto worker distinto para o teste de cancelamento (evita unique constraint)
      const enc = await pool.query(`
        INSERT INTO encuadres (worker_id, job_posting_id, worker_raw_name, resultado, dedup_hash, created_at, updated_at)
        VALUES ($1, $2, 'Worker Cancel E2E', 'PENDIENTE', md5('slots-d-' || $1::text || $2::text), NOW(), NOW())
        ON CONFLICT (worker_id, job_posting_id) DO UPDATE SET worker_raw_name = EXCLUDED.worker_raw_name
        RETURNING id
      `, [workerDId, vacancyId]);
      cancelEncuadreId = enc.rows[0].id;

      await api.post(
        `/api/admin/interview-slots/${cancelSlotId}/book`,
        { encuadreId: cancelEncuadreId, sendInvitation: false },
        auth(adminToken),
      );
    });

    it('cancela slot → 200 + status CANCELLED no banco', async () => {
      const res = await api.delete(
        `/api/admin/interview-slots/${cancelSlotId}`,
        auth(adminToken),
      );

      expect(res.status).toBe(200);
      expect(res.data.success).toBe(true);
      expect(res.data.data.status).toBe('CANCELLED');

      const { rows } = await pool.query(
        `SELECT status FROM interview_slots WHERE id = $1`,
        [cancelSlotId],
      );
      expect(rows[0].status).toBe('CANCELLED');
    });

    it('cancelamento limpa interview_slot_id nos encuadres vinculados', async () => {
      const { rows } = await pool.query(
        `SELECT interview_slot_id FROM encuadres WHERE id = $1`,
        [cancelEncuadreId],
      );
      expect(rows[0].interview_slot_id).toBeNull();
    });

    it('retorna 404 para slotId inexistente', async () => {
      const fakeId = '00000000-0000-0000-0000-000000000000';
      const res = await api.delete(
        `/api/admin/interview-slots/${fakeId}`,
        auth(adminToken),
      );
      expect(res.status).toBe(404);
    });

    it('retorna 401 sem token', async () => {
      const res = await api.delete(`/api/admin/interview-slots/${cancelSlotId}`);
      expect(res.status).toBe(401);
    });
  });
});
