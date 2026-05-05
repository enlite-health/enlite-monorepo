/**
 * vacancies-api.test.ts
 *
 * Testa o CRUD de vagas (job_postings) via VacanciesController.
 * Usa MockAuth (USE_MOCK_AUTH=true) — sem Firebase real.
 *
 * Endpoints cobertos:
 *   POST   /api/admin/vacancies
 *   GET    /api/admin/vacancies
 *   GET    /api/admin/vacancies/stats
 *   GET    /api/admin/vacancies/:id
 *   PUT    /api/admin/vacancies/:id
 *   DELETE /api/admin/vacancies/:id
 */

import { Pool } from 'pg';
import { createApiClient, getMockToken, waitForBackend } from './helpers';

const DATABASE_URL =
  process.env.DATABASE_URL ||
  'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

describe('Vacancies API', () => {
  const api = createApiClient();
  let adminToken: string;
  let workerToken: string;
  let pool: Pool;

  beforeAll(async () => {
    await waitForBackend(api);

    adminToken = await getMockToken(api, {
      uid: 'vacancies-admin-e2e',
      email: 'vacancies-admin@e2e.local',
      role: 'admin',
    });

    workerToken = await getMockToken(api, {
      uid: 'vacancies-worker-e2e',
      email: 'vacancies-worker@e2e.local',
      role: 'worker',
    });

    pool = new Pool({ connectionString: DATABASE_URL });
  });

  afterAll(async () => {
    if (pool) await pool.end();
  });

  function authHeaders(token: string) {
    return { headers: { Authorization: `Bearer ${token}` } };
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // POST /api/admin/vacancies — criar vaga
  // ─────────────────────────────────────────────────────────────────────────────
  describe('POST /api/admin/vacancies', () => {
    it('cria vaga com campos mínimos → 201 + id retornado', async () => {
      const body = {
        case_number: 99901,
        title: 'Caso E2E Teste',
        worker_profile_sought: 'AT com experiência em adultos mayores',
        schedule_days_hours: 'Lunes a Viernes 08-16hs',
        providers_needed: 1,
      };

      const res = await api.post('/api/admin/vacancies', body, authHeaders(adminToken));

      expect(res.status).toBe(201);
      expect(res.data.success).toBe(true);
      expect(res.data.data.id).toBeTruthy();
      expect(res.data.data.case_number).toBe(99901);
      // Default status when not provided is PENDING_ACTIVATION (task 1.4b)
      expect(res.data.data.status).toBe('PENDING_ACTIVATION');
    });

    it('nova vaga aparece no banco com status PENDING_ACTIVATION (default quando status não enviado)', async () => {
      const body = {
        case_number: 99902,
        title: 'Caso E2E Banco',
      };

      const res = await api.post('/api/admin/vacancies', body, authHeaders(adminToken));
      expect(res.status).toBe(201);

      const { rows } = await pool.query(
        `SELECT id, status, case_number FROM job_postings WHERE id = $1`,
        [res.data.data.id],
      );
      expect(rows).toHaveLength(1);
      // Default status is PENDING_ACTIVATION (task 1.4b)
      expect(rows[0].status).toBe('PENDING_ACTIVATION');
      expect(rows[0].case_number).toBe(99902);
    });

    it('retorna 401 sem token', async () => {
      const res = await api.post('/api/admin/vacancies', { case_number: 99999 });
      expect(res.status).toBe(401);
    });

    it('retorna 403 para role worker', async () => {
      const res = await api.post(
        '/api/admin/vacancies',
        { case_number: 99999 },
        authHeaders(workerToken),
      );
      expect(res.status).toBe(403);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // GET /api/admin/vacancies — listar vagas
  // ─────────────────────────────────────────────────────────────────────────────
  describe('GET /api/admin/vacancies', () => {
    it('retorna lista com estrutura correta', async () => {
      const res = await api.get('/api/admin/vacancies', authHeaders(adminToken));

      expect(res.status).toBe(200);
      expect(res.data.success).toBe(true);
      expect(Array.isArray(res.data.data)).toBe(true);
      expect(res.data).toHaveProperty('total');
      expect(res.data).toHaveProperty('limit');
      expect(res.data).toHaveProperty('offset');
    });

    it('aceita paginação via limit e offset', async () => {
      const res = await api.get(
        '/api/admin/vacancies?limit=5&offset=0',
        authHeaders(adminToken),
      );
      expect(res.status).toBe(200);
      expect(res.data.limit).toBe(5);
      expect(res.data.data.length).toBeLessThanOrEqual(5);
    });

    it('aceita filtro de status', async () => {
      const res = await api.get(
        '/api/admin/vacancies?status=ativo',
        authHeaders(adminToken),
      );
      expect(res.status).toBe(200);
      expect(Array.isArray(res.data.data)).toBe(true);
    });

    it('aceita filtro de busca textual', async () => {
      const res = await api.get(
        '/api/admin/vacancies?search=Caso',
        authHeaders(adminToken),
      );
      expect(res.status).toBe(200);
    });

    it('retorna 401 sem token', async () => {
      const res = await api.get('/api/admin/vacancies');
      expect(res.status).toBe(401);
    });

    it('retorna 403 para role worker', async () => {
      const res = await api.get('/api/admin/vacancies', authHeaders(workerToken));
      expect(res.status).toBe(403);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // GET /api/admin/vacancies/stats
  // ─────────────────────────────────────────────────────────────────────────────
  describe('GET /api/admin/vacancies/stats', () => {
    it('retorna array de estatísticas', async () => {
      const res = await api.get('/api/admin/vacancies/stats', authHeaders(adminToken));

      expect(res.status).toBe(200);
      expect(res.data.success).toBe(true);
      expect(Array.isArray(res.data.data)).toBe(true);
      // Espera ao menos os 4 indicadores definidos no controller
      expect(res.data.data.length).toBeGreaterThanOrEqual(4);
      res.data.data.forEach((stat: any) => {
        expect(stat).toHaveProperty('label');
        expect(stat).toHaveProperty('value');
        expect(stat).toHaveProperty('icon');
      });
    });

    it('retorna 401 sem token', async () => {
      const res = await api.get('/api/admin/vacancies/stats');
      expect(res.status).toBe(401);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // GET /api/admin/vacancies/:id — detalhe
  // ─────────────────────────────────────────────────────────────────────────────
  describe('GET /api/admin/vacancies/:id', () => {
    let createdId: string;

    beforeAll(async () => {
      const res = await api.post(
        '/api/admin/vacancies',
        { case_number: 99903, title: 'Caso E2E Detalhe' },
        authHeaders(adminToken),
      );
      createdId = res.data.data?.id;
    });

    it('retorna detalhes da vaga com encuadres e publications', async () => {
      if (!createdId) return;
      const res = await api.get(
        `/api/admin/vacancies/${createdId}`,
        authHeaders(adminToken),
      );
      expect(res.status).toBe(200);
      expect(res.data.success).toBe(true);
      expect(res.data.data.id).toBe(createdId);
    });

    it('retorna 404 para UUID inexistente', async () => {
      const fakeId = '00000000-0000-0000-0000-000000000000';
      const res = await api.get(
        `/api/admin/vacancies/${fakeId}`,
        authHeaders(adminToken),
      );
      expect(res.status).toBe(404);
    });

    it('retorna 401 sem token', async () => {
      const res = await api.get(`/api/admin/vacancies/${createdId ?? '00000000-0000-0000-0000-000000000000'}`);
      expect(res.status).toBe(401);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // PUT /api/admin/vacancies/:id — atualizar
  // ─────────────────────────────────────────────────────────────────────────────
  describe('PUT /api/admin/vacancies/:id', () => {
    let vacancyId: string;

    beforeAll(async () => {
      const res = await api.post(
        '/api/admin/vacancies',
        { case_number: 99904, title: 'Caso E2E Update' },
        authHeaders(adminToken),
      );
      vacancyId = res.data.data?.id;
    });

    it('atualiza campo title → 200 + dado persistido', async () => {
      if (!vacancyId) return;
      const res = await api.put(
        `/api/admin/vacancies/${vacancyId}`,
        { title: 'Título Atualizado E2E' },
        authHeaders(adminToken),
      );
      expect(res.status).toBe(200);
      expect(res.data.success).toBe(true);
      expect(res.data.data.title).toBe('Título Atualizado E2E');

      // Verifica persistência no banco
      const { rows } = await pool.query(
        `SELECT title FROM job_postings WHERE id = $1`,
        [vacancyId],
      );
      expect(rows[0].title).toBe('Título Atualizado E2E');
    });

    it('retorna 400 quando nenhum campo válido é enviado', async () => {
      if (!vacancyId) return;
      const res = await api.put(
        `/api/admin/vacancies/${vacancyId}`,
        { campo_inexistente: 'valor' },
        authHeaders(adminToken),
      );
      expect(res.status).toBe(400);
      expect(res.data.success).toBe(false);
    });

    it('retorna 404 para UUID inexistente', async () => {
      const fakeId = '00000000-0000-0000-0000-000000000000';
      const res = await api.put(
        `/api/admin/vacancies/${fakeId}`,
        { title: 'Qualquer' },
        authHeaders(adminToken),
      );
      expect(res.status).toBe(404);
    });

    it('retorna 401 sem token', async () => {
      const res = await api.put(
        `/api/admin/vacancies/${vacancyId ?? '00000000-0000-0000-0000-000000000000'}`,
        { title: 'X' },
      );
      expect(res.status).toBe(401);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // DELETE /api/admin/vacancies/:id — soft delete
  // ─────────────────────────────────────────────────────────────────────────────
  describe('DELETE /api/admin/vacancies/:id', () => {
    let vacancyId: string;

    beforeAll(async () => {
      const res = await api.post(
        '/api/admin/vacancies',
        { case_number: 99905, title: 'Caso E2E Delete' },
        authHeaders(adminToken),
      );
      vacancyId = res.data.data?.id;
    });

    it('soft-deleta vaga (status → closed) → 200', async () => {
      if (!vacancyId) return;
      const res = await api.delete(
        `/api/admin/vacancies/${vacancyId}`,
        authHeaders(adminToken),
      );
      expect(res.status).toBe(200);
      expect(res.data.success).toBe(true);

      // Verifica que status virou 'CLOSED' no banco (soft delete)
      const { rows } = await pool.query(
        `SELECT status FROM job_postings WHERE id = $1`,
        [vacancyId],
      );
      expect(rows[0].status).toBe('CLOSED');
    });

    it('retorna 404 para UUID inexistente', async () => {
      const fakeId = '00000000-0000-0000-0000-000000000000';
      const res = await api.delete(
        `/api/admin/vacancies/${fakeId}`,
        authHeaders(adminToken),
      );
      expect(res.status).toBe(404);
    });

    it('retorna 401 sem token', async () => {
      const res = await api.delete(
        `/api/admin/vacancies/${vacancyId ?? '00000000-0000-0000-0000-000000000000'}`,
      );
      expect(res.status).toBe(401);
    });

    it('retorna 403 para role worker', async () => {
      const res = await api.delete(
        `/api/admin/vacancies/${vacancyId ?? '00000000-0000-0000-0000-000000000000'}`,
        authHeaders(workerToken),
      );
      expect(res.status).toBe(403);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Regressão — bugs encontrados em 2026-03-26
  //
  // Cada teste aqui documenta um bug real que foi ao ar. O nome do teste
  // descreve o sintoma original para que a causa seja imediatamente óbvia
  // quando o teste falhar no futuro.
  // ─────────────────────────────────────────────────────────────────────────────
  describe('Regressão', () => {
    // ── Bug 1 ─────────────────────────────────────────────────────────────────
    // Sintoma: POST /api/admin/vacancies → 500 "column diagnosis does not exist"
    // Causa:   createVacancy() incluía diagnosis no INSERT de job_postings, mas
    //          a coluna foi movida para patients em migration 039.
    // Fix:     Removido diagnosis do INSERT do controller.
    it('POST sem diagnosis no body não retorna 500 (coluna removida de job_postings em migration 039)', async () => {
      const res = await api.post(
        '/api/admin/vacancies',
        { case_number: 88801, title: 'Regressão Bug 1' },
        authHeaders(adminToken),
      );
      // Antes do fix: 500 com "column diagnosis does not exist"
      expect(res.status).toBe(201);
      expect(res.data.success).toBe(true);
    });

    it('job_postings não tem coluna diagnosis (pertence a patients desde migration 039)', async () => {
      const { rows } = await pool.query(`
        SELECT column_name
        FROM information_schema.columns
        WHERE table_name = 'job_postings'
          AND column_name = 'diagnosis'
      `);
      // Se essa assertion falhar, alguém adicionou diagnosis de volta —
      // o controller precisará ser atualizado junto.
      expect(rows).toHaveLength(0);
    });

    // ── Bug 2 ─────────────────────────────────────────────────────────────────
    // Sintoma: Após criar uma vaga, o servidor caía — todas as requisições
    //          seguintes retornavam ECONNRESET.
    // Causa:   Erros síncronos lançados dentro do callback do setImmediate
    //          (ex: GEMINI_API_KEY ausente ao instanciar serviço) se tornavam
    //          exceções não-capturadas que derrubavam o processo Node.js.
    // Fix:     try-catch envolvendo todo o callback do setImmediate.
    it('servidor permanece saudável após criar vaga sem GEMINI_API_KEY configurado', async () => {
      // Cria a vaga — dispara o setImmediate com match em background
      const createRes = await api.post(
        '/api/admin/vacancies',
        { case_number: 88802, title: 'Regressão Bug 2' },
        authHeaders(adminToken),
      );
      expect(createRes.status).toBe(201);

      // Aguarda o setImmediate executar (próximo tick do event loop)
      await new Promise(r => setTimeout(r, 200));

      // Antes do fix: /health retornava ECONNRESET porque o processo tinha caído
      const healthRes = await api.get('/health');
      expect(healthRes.status).toBe(200);

      // Garante que a API continua aceitando requests normais
      const listRes = await api.get('/api/admin/vacancies', authHeaders(adminToken));
      expect(listRes.status).toBe(200);
    });

    // ── Bug 3 ─────────────────────────────────────────────────────────────────
    // Sintoma: GET /api/admin/vacancies/:id retornava data.id = null para vagas
    //          sem paciente associado.
    // Causa:   SELECT jp.*, p.* — quando p.patient_id é NULL, p.id (NULL)
    //          sobrescrevia jp.id no objeto retornado pelo driver do Postgres.
    // Fix:     Substituído p.* por campos nomeados com aliases explícitos;
    //          adicionado jp.id as id para garantir precedência.
    it('GET /:id retorna o id da vaga, não do paciente (jp.id não sobrescrito por p.id)', async () => {
      // Cria vaga SEM patient_id — o cenário que expunha o bug
      const createRes = await api.post(
        '/api/admin/vacancies',
        { case_number: 88803, title: 'Regressão Bug 3 — sem paciente' },
        authHeaders(adminToken),
      );
      expect(createRes.status).toBe(201);
      const vacancyId = createRes.data.data.id as string;
      expect(vacancyId).toBeTruthy();

      const getRes = await api.get(
        `/api/admin/vacancies/${vacancyId}`,
        authHeaders(adminToken),
      );
      expect(getRes.status).toBe(200);
      // Antes do fix: getRes.data.data.id era null (p.id sobrescrevia jp.id)
      expect(getRes.data.data.id).toBe(vacancyId);
    });

    // ── Bug 4 ─────────────────────────────────────────────────────────────────
    // Sintoma: POST /api/admin/vacancies → 500 "null value in column description
    //          violates not-null constraint"
    // Causa:   description TEXT NOT NULL desde migration 011. Vagas criadas via
    //          UI não têm descrição livre no momento da criação.
    // Fix:     Migration 058 tornou description nullable.
    it('POST sem description não retorna 500 (description é nullable desde migration 058)', async () => {
      const res = await api.post(
        '/api/admin/vacancies',
        // Intencionalmente omite description
        { case_number: 88804, title: 'Regressão Bug 4 — sem description' },
        authHeaders(adminToken),
      );
      // Antes do fix: 500 com "null value in column description..."
      expect(res.status).toBe(201);
    });

    it('description é nullable em job_postings (migration 058)', async () => {
      const { rows } = await pool.query(`
        SELECT is_nullable
        FROM information_schema.columns
        WHERE table_name = 'job_postings'
          AND column_name = 'description'
      `);
      expect(rows).toHaveLength(1);
      // Se essa assertion falhar, alguém reverteu a migration 058 ou recriou
      // a coluna como NOT NULL — o controller precisa fornecer um default.
      expect(rows[0].is_nullable).toBe('YES');
    });

    // ── Bug 5 ─────────────────────────────────────────────────────────────────
    // Sintoma: PUT /api/admin/vacancies/:id com status: 'BUSQUEDA' →
    //          antes retornava 500 com check constraint violation do banco.
    // Causa:   Frontend enviava STATUS_OPTIONS legados ('BUSQUEDA','REEMPLAZO','CUBIERTO','CANCELADO')
    //          após migration 148 que limitou status a 7 valores canônicos via CHECK constraint.
    // Fix:     VacancyCrudController.updateVacancy valida status antes do banco; retorna 400 explícito.
    describe('Bug 5 — status legado na atualização', () => {
      let vacancyId: string;

      beforeAll(async () => {
        const res = await api.post(
          '/api/admin/vacancies',
          { case_number: 88805, title: 'Regressão Bug 5 — status legado' },
          authHeaders(adminToken),
        );
        vacancyId = res.data.data?.id;
      });

      it("PUT /:id com status 'BUSQUEDA' → 400 (antes era 500 com check constraint do banco)", async () => {
        if (!vacancyId) return;
        const res = await api.put(
          `/api/admin/vacancies/${vacancyId}`,
          { status: 'BUSQUEDA' },
          authHeaders(adminToken),
        );
        // Antes do fix: 500 com check constraint violation do banco
        expect(res.status).toBe(400);
        expect(res.data.success).toBe(false);
        expect(res.data.error).toMatch(/BUSQUEDA/);
      });

      it("PUT /:id com status 'REEMPLAZO' → 400", async () => {
        if (!vacancyId) return;
        const res = await api.put(
          `/api/admin/vacancies/${vacancyId}`,
          { status: 'REEMPLAZO' },
          authHeaders(adminToken),
        );
        expect(res.status).toBe(400);
        expect(res.data.success).toBe(false);
      });

      it("PUT /:id com status 'CUBIERTO' → 400", async () => {
        if (!vacancyId) return;
        const res = await api.put(
          `/api/admin/vacancies/${vacancyId}`,
          { status: 'CUBIERTO' },
          authHeaders(adminToken),
        );
        expect(res.status).toBe(400);
        expect(res.data.success).toBe(false);
      });

      it("PUT /:id com status 'CANCELADO' → 400", async () => {
        if (!vacancyId) return;
        const res = await api.put(
          `/api/admin/vacancies/${vacancyId}`,
          { status: 'CANCELADO' },
          authHeaders(adminToken),
        );
        expect(res.status).toBe(400);
        expect(res.data.success).toBe(false);
      });

      it("PUT /:id com status 'draft' → 400", async () => {
        if (!vacancyId) return;
        const res = await api.put(
          `/api/admin/vacancies/${vacancyId}`,
          { status: 'draft' },
          authHeaders(adminToken),
        );
        expect(res.status).toBe(400);
        expect(res.data.success).toBe(false);
      });
    });

    // ── Bug 6 ─────────────────────────────────────────────────────────────────
    // Sintoma: qualquer INSERT/UPDATE direto no banco com status inválido derruba a transação.
    // Causa:   migration 148 aplicou CHECK constraint job_postings_status_check.
    // Fix:     constraint existe no schema; este teste garante que nunca será removida acidentalmente.
    describe('Bug 6 — constraint de status no banco (invariante de schema)', () => {
      afterAll(async () => {
        await pool.query(
          `DELETE FROM job_postings WHERE case_number BETWEEN 77701 AND 77707`,
        );
      });

      it('job_postings_status_check existe no banco e rejeita valores não-canônicos', async () => {
        let caughtError: Error | null = null;
        try {
          await pool.query(
            `INSERT INTO job_postings (case_number, vacancy_number, title, status)
             VALUES ($1, nextval('job_postings_vacancy_number_seq'), $2, $3)`,
            [77700, 'Bug 6 — status inválido', 'BUSQUEDA'],
          );
        } catch (err: any) {
          caughtError = err;
        }
        // Se essa assertion falhar, a CHECK constraint foi removida do schema —
        // a validação no controller é a única barreira e pode ter sido bypassada.
        expect(caughtError).not.toBeNull();
        expect(caughtError!.message).toMatch(/job_postings_status_check|check constraint/i);
      });

      it('job_postings_status_check aceita todos os 7 valores canônicos', async () => {
        const canonicalStatuses = [
          'SEARCHING',
          'SEARCHING_REPLACEMENT',
          'RAPID_RESPONSE',
          'PENDING_ACTIVATION',
          'ACTIVE',
          'SUSPENDED',
          'CLOSED',
        ];

        for (let i = 0; i < canonicalStatuses.length; i++) {
          const status = canonicalStatuses[i];
          const caseNumber = 77701 + i;
          await expect(
            pool.query(
              `INSERT INTO job_postings (case_number, vacancy_number, title, status)
               VALUES ($1, nextval('job_postings_vacancy_number_seq'), $2, $3)`,
              [caseNumber, `Bug 6 — status ${status}`, status],
            ),
          ).resolves.not.toThrow();
        }
      });
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Short-link auto-publish hook — Phase 3
  //
  // When a vacancy is created or updated to a public status (ACTIVE, SEARCHING,
  // SEARCHING_REPLACEMENT, RAPID_RESPONSE), tryEnsureShortLink runs in a
  // setImmediate background callback.
  //
  // In the E2E environment SHORT_IO_API_KEY is not set, so the hook logs a warn
  // and exits without generating a real link. The tests below verify:
  //   - Non-blocking: 201/200 is returned regardless of SHORT_IO state
  //   - Server stays healthy after the hook runs (no unhandled exception)
  //   - CLOSED vacancy does NOT trigger the hook (social_short_links stays null)
  //   - ACTIVE vacancy with pre-existing site link: use case is idempotent
  // ─────────────────────────────────────────────────────────────────────────────
  describe('Short-link auto-publish hook (Phase 3)', () => {
    it('criar vaga com status ACTIVE retorna 201 (hook roda sem bloquear)', async () => {
      const res = await api.post(
        '/api/admin/vacancies',
        { case_number: 66601, title: 'Short-link hook ACTIVE', status: 'ACTIVE' },
        authHeaders(adminToken),
      );
      expect(res.status).toBe(201);
      expect(res.data.success).toBe(true);
    });

    it('servidor permanece saudável após criar vaga ACTIVE sem SHORT_IO configurado', async () => {
      const createRes = await api.post(
        '/api/admin/vacancies',
        { case_number: 66602, title: 'Short-link hook resilience', status: 'ACTIVE' },
        authHeaders(adminToken),
      );
      expect(createRes.status).toBe(201);

      // Give setImmediate time to complete
      await new Promise(r => setTimeout(r, 300));

      const healthRes = await api.get('/health');
      expect(healthRes.status).toBe(200);
    });

    it('criar vaga com status CLOSED não popula social_short_links', async () => {
      const createRes = await api.post(
        '/api/admin/vacancies',
        { case_number: 66603, title: 'Short-link hook CLOSED', status: 'CLOSED' },
        authHeaders(adminToken),
      );
      expect(createRes.status).toBe(201);
      const id = createRes.data.data.id as string;

      // Allow any background work to settle
      await new Promise(r => setTimeout(r, 200));

      const { rows } = await pool.query<{ social_short_links: Record<string, unknown> | null }>(
        `SELECT social_short_links FROM job_postings WHERE id = $1`,
        [id],
      );
      // CLOSED → hook is skipped → no site link written.
      // Column DEFAULT is '{}' (migration 115), so it's never NULL —
      // the meaningful assertion is that no 'site' key was populated.
      expect(rows[0].social_short_links?.['site']).toBeUndefined();
    });

    it('atualizar vaga PENDING_ACTIVATION → ACTIVE retorna 200 (hook roda sem bloquear)', async () => {
      const createRes = await api.post(
        '/api/admin/vacancies',
        { case_number: 66604, title: 'Short-link update hook' },
        authHeaders(adminToken),
      );
      expect(createRes.status).toBe(201);
      const id = createRes.data.data.id as string;

      const updateRes = await api.put(
        `/api/admin/vacancies/${id}`,
        { status: 'ACTIVE' },
        authHeaders(adminToken),
      );
      expect(updateRes.status).toBe(200);
      expect(updateRes.data.success).toBe(true);
    });

    it('vaga ACTIVE com site link pré-existente: use case idempotente (não falha)', async () => {
      // Insert a vacancy with a pre-existing site link directly in DB
      const { rows: vnRows } = await pool.query<{ vn: string }>(
        "SELECT nextval('job_postings_vacancy_number_seq') AS vn",
      );
      const vn = vnRows[0].vn;
      const { rows } = await pool.query<{ id: string }>(
        `INSERT INTO job_postings (vacancy_number, case_number, title, status, social_short_links)
         VALUES ($1, 66605, 'Short-link idempotent', 'ACTIVE', '{"site": {"url":"https://srt.io/existing","id":"abc"}}')
         RETURNING id`,
        [parseInt(vn)],
      );
      const id = rows[0].id;

      // Trigger update — hook should detect existing link and return early
      const updateRes = await api.put(
        `/api/admin/vacancies/${id}`,
        { title: 'Short-link idempotent updated' },
        authHeaders(adminToken),
      );
      expect(updateRes.status).toBe(200);

      // Allow hook to settle
      await new Promise(r => setTimeout(r, 200));

      // site link must remain unchanged (not overwritten)
      const { rows: check } = await pool.query<{ social_short_links: Record<string, unknown> }>(
        `SELECT social_short_links FROM job_postings WHERE id = $1`,
        [id],
      );
      const siteLink = check[0].social_short_links?.site as { url: string } | undefined;
      expect(siteLink?.url).toBe('https://srt.io/existing');
    });
  });
});
