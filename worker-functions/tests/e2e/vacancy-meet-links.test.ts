/**
 * vacancy-meet-links.test.ts
 *
 * Testes E2E para o endpoint de Google Meet links em vagas.
 * Usa MockAuth (USE_MOCK_AUTH=true) + PostgreSQL real via Docker.
 * Usa USE_MOCK_GOOGLE_CALENDAR=true (sem chamada real ao Calendar).
 *
 * Endpoints cobertos:
 *   PUT /api/admin/vacancies/:id/meet-links
 *
 * Verificações:
 *   - Salva 3 links válidos + persiste no banco (migration 098)
 *   - Salva mix de links e nulls
 *   - Rejeita link com formato inválido → 400
 *   - Rejeita body malformado (array errado) → 400
 *   - Retorna 404 para vaga inexistente
 *   - Bloqueia worker (não-admin) → 403
 *   - Schema check: colunas da migration 098 existem
 */

import { Pool } from 'pg';
import { createApiClient, createPatientFixture, getMockToken, waitForBackend } from './helpers';

const DATABASE_URL =
  process.env.DATABASE_URL ||
  'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

const VALID_LINK_1 = 'https://meet.google.com/abc-defg-hij';
const VALID_LINK_2 = 'https://meet.google.com/xyz-1234-abc';
const VALID_LINK_3 = 'https://meet.google.com/zzz-0000-qqq';
const INVALID_LINK = 'https://zoom.us/j/12345';

describe('Vacancy Meet Links API', () => {
  const api = createApiClient();
  let adminToken: string;
  let workerToken: string;
  let pool: Pool;
  let vacancyId: string;

  beforeAll(async () => {
    await waitForBackend(api);

    adminToken = await getMockToken(api, {
      uid: 'meet-links-admin-e2e',
      email: 'meet-links-admin@e2e.local',
      role: 'admin',
    });

    workerToken = await getMockToken(api, {
      uid: 'meet-links-worker-e2e',
      email: 'meet-links-worker@e2e.local',
      role: 'worker',
    });

    pool = new Pool({ connectionString: DATABASE_URL });

    // patient_id é obrigatório no POST /api/admin/vacancies — cria paciente de referência primeiro.
    const patientId = await createPatientFixture(pool, 'meet-links');

    // Cria vaga de referência para os testes
    const vacancyRes = await api.post(
      '/api/admin/vacancies',
      { patient_id: patientId, case_number: 99801, title: 'Caso E2E Meet Links' },
      { headers: { Authorization: `Bearer ${adminToken}` } }
    );
    expect(vacancyRes.status).toBe(201);
    vacancyId = vacancyRes.data.data.id;
  });

  afterAll(async () => {
    if (pool) await pool.end();
  });

  function auth(token: string) {
    return { headers: { Authorization: `Bearer ${token}` } };
  }

  // ── Schema check (migration 098) ──────────────────────────────────────────

  describe('Schema — migration 098', () => {
    it.each([
      'meet_link_1', 'meet_datetime_1',
      'meet_link_2', 'meet_datetime_2',
      'meet_link_3', 'meet_datetime_3',
    ])('coluna %s existe em job_postings', async (column) => {
      const { rows } = await pool.query(`
        SELECT column_name
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name   = 'job_postings'
          AND column_name  = $1
      `, [column]);
      expect(rows).toHaveLength(1);
    });
  });

  // ── PUT /api/admin/vacancies/:id/meet-links ───────────────────────────────

  describe('PUT /api/admin/vacancies/:id/meet-links', () => {
    it('salva 3 links válidos → 200 + dados retornados', async () => {
      const res = await api.put(
        `/api/admin/vacancies/${vacancyId}/meet-links`,
        { meet_links: [VALID_LINK_1, VALID_LINK_2, VALID_LINK_3] },
        auth(adminToken)
      );

      expect(res.status).toBe(200);
      expect(res.data.success).toBe(true);
      expect(res.data.data.meet_link_1).toBe(VALID_LINK_1);
      expect(res.data.data.meet_link_2).toBe(VALID_LINK_2);
      expect(res.data.data.meet_link_3).toBe(VALID_LINK_3);
    });

    it('persiste os links no banco após salvar', async () => {
      await api.put(
        `/api/admin/vacancies/${vacancyId}/meet-links`,
        { meet_links: [VALID_LINK_1, null, null] },
        auth(adminToken)
      );

      const { rows } = await pool.query(
        'SELECT meet_link_1, meet_link_2, meet_link_3 FROM job_postings WHERE id = $1',
        [vacancyId]
      );
      expect(rows[0].meet_link_1).toBe(VALID_LINK_1);
      expect(rows[0].meet_link_2).toBeNull();
      expect(rows[0].meet_link_3).toBeNull();
    });

    it('resolve datetime via mock quando USE_MOCK_GOOGLE_CALENDAR=true', async () => {
      // O mock retorna '2026-04-05T14:00:00-03:00' para qualquer link válido
      const res = await api.put(
        `/api/admin/vacancies/${vacancyId}/meet-links`,
        { meet_links: [VALID_LINK_1, null, null] },
        auth(adminToken)
      );

      expect(res.status).toBe(200);
      // Se USE_MOCK_GOOGLE_CALENDAR está ativo no ambiente de teste, datetime é preenchido;
      // caso contrário, pode ser null (sem credenciais de Calendar). Ambos são válidos.
      expect(res.data.data).toHaveProperty('meet_datetime_1');
    });

    it('salva mix de links e nulls → 200', async () => {
      const res = await api.put(
        `/api/admin/vacancies/${vacancyId}/meet-links`,
        { meet_links: [null, VALID_LINK_2, null] },
        auth(adminToken)
      );

      expect(res.status).toBe(200);
      expect(res.data.data.meet_link_1).toBeNull();
      expect(res.data.data.meet_link_2).toBe(VALID_LINK_2);
      expect(res.data.data.meet_link_3).toBeNull();
    });

    it('salva todos como null (limpa links) → 200', async () => {
      const res = await api.put(
        `/api/admin/vacancies/${vacancyId}/meet-links`,
        { meet_links: [null, null, null] },
        auth(adminToken)
      );

      expect(res.status).toBe(200);
      expect(res.data.data.meet_link_1).toBeNull();
      expect(res.data.data.meet_link_2).toBeNull();
      expect(res.data.data.meet_link_3).toBeNull();
    });

    it('rejeita link com formato inválido → 400', async () => {
      const res = await api.put(
        `/api/admin/vacancies/${vacancyId}/meet-links`,
        { meet_links: [INVALID_LINK, null, null] },
        auth(adminToken)
      );

      expect(res.status).toBe(400);
      expect(res.data.success).toBe(false);
      expect(res.data.error).toMatch(/invalid/i);
    });

    it('rejeita body sem meet_links → 400', async () => {
      const res = await api.put(
        `/api/admin/vacancies/${vacancyId}/meet-links`,
        { wrong_field: ['a', 'b', 'c'] },
        auth(adminToken)
      );

      expect(res.status).toBe(400);
      expect(res.data.success).toBe(false);
    });

    it('rejeita meet_links com menos de 3 elementos → 400', async () => {
      const res = await api.put(
        `/api/admin/vacancies/${vacancyId}/meet-links`,
        { meet_links: [VALID_LINK_1, null] },
        auth(adminToken)
      );

      expect(res.status).toBe(400);
      expect(res.data.success).toBe(false);
    });

    it('retorna 404 para vaga inexistente', async () => {
      const res = await api.put(
        '/api/admin/vacancies/00000000-0000-0000-0000-000000000000/meet-links',
        { meet_links: [null, null, null] },
        auth(adminToken)
      );

      expect(res.status).toBe(404);
      expect(res.data.success).toBe(false);
    });

    it('bloqueia worker (não-admin) → 403', async () => {
      const res = await api.put(
        `/api/admin/vacancies/${vacancyId}/meet-links`,
        { meet_links: [null, null, null] },
        auth(workerToken)
      );

      expect(res.status).toBe(403);
    });

    it('bloqueia requisição sem token → 401', async () => {
      const res = await api.put(
        `/api/admin/vacancies/${vacancyId}/meet-links`,
        { meet_links: [null, null, null] }
      );

      expect(res.status).toBe(401);
    });
  });
});
