/**
 * VacancyCrudController — Unit Tests
 *
 * Validates: INSERT SQL includes all required columns, correct parameter
 * count, field defaults, allowedFields whitelist, JSONB serialization, and
 * error handling. (description column dropped in migration 214 — PII purge.)
 *
 * Phase 9 (migration 152): state, city, pathology_types, dependency_level,
 * service_device_types removed from job_postings INSERT/UPDATE.
 * pathology_types and dependency_level remain accepted in request body as
 * transit fields (forwarded to patients table via createWithPatientUpdate).
 *
 * Onda B (audit-log): mutations now wrap UPDATE/DELETE inside a transaction
 * using a PoolClient acquired via db.connect(). The mockPool must expose
 * connect() returning a mockClient with query + release.
 *
 * createVacancy (non-patient-update path):
 *   pool.query[0] → patient check
 *   pool.query[1] → nextval
 *   pool.query[2] → INSERT job_postings (RETURNING *)
 *   client.query  → BEGIN, auditVacancyCreated (SAVEPOINT + INSERT audit), COMMIT
 *
 * updateVacancy:
 *   pool.query[0]       → SELECT is_draft (authorizeVacancyUpdate)
 *   [pool.query[1]]     → SELECT patient (when patient_id changing in draft)
 *   client.query[0]     → BEGIN
 *   client.query[1]     → SELECT * FROM job_postings (before snapshot)
 *   client.query[2]     → UPDATE job_postings … RETURNING *
 *   client.query[3..N]  → logFieldChangesSafe (SAVEPOINT + INSERT audit)
 *   client.query[N+1]   → COMMIT
 *
 * deleteVacancy:
 *   client.query[0]     → BEGIN
 *   client.query[1]     → SELECT * FROM job_postings … (before snapshot)
 *   client.query[2]     → UPDATE job_postings SET status = 'CLOSED'
 *   client.query[3..N]  → logEventSafe (SAVEPOINT + INSERT audit)
 *   client.query[N+1]   → COMMIT
 */

// ── Mocks ────────────────────────────────────────────────────────────

const mockQuery = jest.fn();
const mockClientQuery = jest.fn();
const mockClientRelease = jest.fn();
const mockConnect = jest.fn().mockResolvedValue({
  query: mockClientQuery,
  release: mockClientRelease,
});
const mockPool = { query: mockQuery, connect: mockConnect };

jest.mock('@shared/database/DatabaseConnection', () => ({
  DatabaseConnection: {
    getInstance: () => ({ getPool: () => mockPool }),
  },
}));

jest.mock('../../../src/modules/matching/infrastructure/MatchmakingService', () => ({
  MatchmakingService: jest.fn().mockImplementation(() => ({
    matchWorkersForJob: jest.fn().mockResolvedValue({ candidates: [] }),
  })),
}));

import { VacancyCrudController } from '../../../src/modules/matching/interfaces/controllers/VacancyCrudController';

// Flush setImmediate callbacks from background matching
afterEach(() => new Promise(resolve => setImmediate(resolve)));

// ── Helpers ──────────────────────────────────────────────────────────

function mockReq(body: Record<string, unknown> = {}, params: Record<string, unknown> = {}): Record<string, unknown> {
  return { body, params };
}

function mockRes(): { status: jest.Mock; json: jest.Mock } {
  const res = { status: jest.fn(), json: jest.fn() };
  res.status.mockReturnValue(res);
  res.json.mockReturnValue(res);
  return res;
}

const PATIENT_ID = 'patient-uuid-abc';

const FULL_BODY = {
  case_number: 100,
  title: 'CASO 100',
  patient_id: PATIENT_ID,
  required_professions: ['AT', 'CAREGIVER'],
  required_sex: 'F',
  age_range_min: 25,
  age_range_max: 45,
  worker_profile_sought: null,
  required_experience: 'Experiencia en TEA',
  worker_attributes: 'Empatia, compromiso',
  schedule: [{ dayOfWeek: 1, startTime: '08:00', endTime: '14:00' }],
  work_schedule: 'full-time',
  // pathology_types and dependency_level remain as transit fields (not persisted in job_postings)
  pathology_types: 'TEA, TLP',
  dependency_level: 'Moderado',
  providers_needed: 2,
  salary_text: '500 USD',
  payment_day: 'Dia 20',
  daily_obs: 'Nota interna',
};

const VACANCY_ROW = { id: 'uuid-123', ...FULL_BODY, status: 'SEARCHING', country: 'AR' };

/** Mocks for a successful createVacancy: patientCheck → nextval → INSERT */
function mockCreateSuccess(overrides: { vacancyRow?: Record<string, unknown> } = {}): void {
  mockQuery
    .mockResolvedValueOnce({ rows: [{ id: PATIENT_ID }] })   // patient existence check
    .mockResolvedValueOnce({ rows: [{ vn: '42' }] })          // nextval
    .mockResolvedValueOnce({ rows: [overrides.vacancyRow ?? VACANCY_ROW] }); // INSERT
  // Audit client (BEGIN, logEventSafe internals, COMMIT) resolved via beforeEach default.
}

// ── Tests ────────────────────────────────────────────────────────────

describe('VacancyCrudController', () => {
  let controller: VacancyCrudController;

  beforeEach(() => {
    mockQuery.mockReset();
    mockClientQuery.mockReset();
    mockClientRelease.mockReset();
    mockConnect.mockReset();
    mockConnect.mockResolvedValue({ query: mockClientQuery, release: mockClientRelease });
    // Default: any unspecified client call (BEGIN/COMMIT/audit queries) resolves safely.
    mockQuery.mockResolvedValue({ rows: [] });
    mockClientQuery.mockResolvedValue({ rows: [] });
    controller = new VacancyCrudController();
  });

  // ── createVacancy ────────────────────────────────────────────────

  describe('createVacancy', () => {

    // ── patient_id presence & existence validation ────────────────

    it('returns 400 when patient_id is absent from body', async () => {
      const { patient_id: _p, ...bodyWithoutPatient } = FULL_BODY;
      const req = mockReq(bodyWithoutPatient);
      const res = mockRes();

      await controller.createVacancy(req as never, res as never);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        success: false,
        error: expect.stringContaining('patient_id é obrigatório'),
      }));
      expect(mockQuery).not.toHaveBeenCalled();
    });

    it('returns 400 when patient_id is null', async () => {
      const req = mockReq({ ...FULL_BODY, patient_id: null });
      const res = mockRes();

      await controller.createVacancy(req as never, res as never);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        success: false,
        error: expect.stringContaining('patient_id é obrigatório'),
      }));
      expect(mockQuery).not.toHaveBeenCalled();
    });

    it('returns 400 when patient_id is empty string', async () => {
      const req = mockReq({ ...FULL_BODY, patient_id: '' });
      const res = mockRes();

      await controller.createVacancy(req as never, res as never);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        success: false,
        error: expect.stringContaining('patient_id é obrigatório'),
      }));
      expect(mockQuery).not.toHaveBeenCalled();
    });

    it('returns 400 when patient_id is a number (not string)', async () => {
      const req = mockReq({ ...FULL_BODY, patient_id: 42 });
      const res = mockRes();

      await controller.createVacancy(req as never, res as never);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        success: false,
        error: expect.stringContaining('patient_id é obrigatório'),
      }));
      expect(mockQuery).not.toHaveBeenCalled();
    });

    it('returns 400 when patient_id is valid string but patient does not exist', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] }); // patient not found
      const req = mockReq({ ...FULL_BODY, patient_id: 'nonexistent-uuid' });
      const res = mockRes();

      await controller.createVacancy(req as never, res as never);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        success: false,
        error: expect.stringContaining('paciente não encontrado'),
      }));
      expect(mockQuery).toHaveBeenCalledTimes(1);
    });

    it('returns 400 when patient exists but is soft-deleted (deleted_at IS NOT NULL)', async () => {
      // The SQL filters deleted_at IS NULL, so a deleted patient returns empty rows
      mockQuery.mockResolvedValueOnce({ rows: [] }); // deleted patient returns nothing
      const req = mockReq({ ...FULL_BODY, patient_id: 'deleted-patient-uuid' });
      const res = mockRes();

      await controller.createVacancy(req as never, res as never);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        success: false,
        error: expect.stringContaining('paciente não encontrado'),
      }));
    });

    it('proceeds with INSERT when patient_id is valid and patient is active', async () => {
      mockCreateSuccess();
      const req = mockReq(FULL_BODY);
      const res = mockRes();

      await controller.createVacancy(req as never, res as never);

      expect(res.status).toHaveBeenCalledWith(201);
      expect(res.json).toHaveBeenCalledWith({ success: true, data: VACANCY_ROW });
    });

    // ── INSERT SQL and parameter assertions (pool.query[2]) ───────

    it('INSERT does NOT write description column (dropped — PII purge migration 214)', async () => {
      mockCreateSuccess();
      const req = mockReq(FULL_BODY);
      const res = mockRes();

      await controller.createVacancy(req as never, res as never);

      // INSERT is still pool.query[2] (not in a client transaction)
      const sql = mockQuery.mock.calls[2][0] as string;
      expect(sql).not.toContain('description');
      // VALUES now starts with the 4 positional params (no `''` description literal)
      expect(sql).toMatch(/VALUES\s*\(\s*\$1,\s*\$2,\s*\$3,\s*\$4,/);
    });

    it('sends 23 parameters ($1 through $23, including patient_address_id, status, published_at, closes_at, is_test, contracted_service_id)', async () => {
      mockCreateSuccess();
      const req = mockReq(FULL_BODY);
      const res = mockRes();

      await controller.createVacancy(req as never, res as never);

      const params = mockQuery.mock.calls[2][1] as unknown[];
      // +1 vs. the pre-spec-013 count (22): contracted_service_id (migration 320) — always null
      // from this path, POST /vacancies does not go through a contracted service.
      expect(params).toHaveLength(23);
      expect(params[22]).toBeNull();
    });

    it('maps all fields to correct parameter positions', async () => {
      mockCreateSuccess();
      const req = mockReq(FULL_BODY);
      const res = mockRes();

      await controller.createVacancy(req as never, res as never);

      const params = mockQuery.mock.calls[2][1] as unknown[];
      // Positions after Phase 9 (migration 152) — pathology_types, dependency_level,
      // service_device_types, city, state removed from INSERT
      expect(params[0]).toBe(42);                            // vacancy_number (from nextval)
      expect(params[1]).toBe(100);                           // case_number
      expect(params[2]).toBe('CASO 100-42');                 // title (computed)
      expect(params[3]).toBe(PATIENT_ID);                    // patient_id
      expect(params[4]).toEqual(['AT', 'CAREGIVER']);        // required_professions
      expect(params[5]).toBe('F');                           // required_sex
      expect(params[6]).toBe(25);                            // age_range_min
      expect(params[7]).toBe(45);                            // age_range_max
      expect(params[8]).toBeNull();                          // worker_profile_sought
      expect(params[9]).toBe('Experiencia en TEA');          // required_experience
      expect(params[10]).toBe('Empatia, compromiso');        // worker_attributes
      expect(params[11]).toContain('"dayOfWeek":1');         // schedule JSON
      expect(params[12]).toBe('full-time');                  // work_schedule
      expect(params[13]).toBe(2);                            // providers_needed
      expect(params[14]).toBe('500 USD');                    // salary_text
      expect(params[15]).toBe('Dia 20');                     // payment_day
      expect(params[16]).toBe('Nota interna');               // daily_obs
      expect(params[17]).toBeNull();                         // patient_address_id (not in FULL_BODY)
      expect(params[18]).toBe('PENDING_ACTIVATION');         // status default
      expect(params[21]).toBe(false);                        // is_test default (not in FULL_BODY)
    });

    it('passes status as $19 param (defaulting to PENDING_ACTIVATION) and hardcodes country=AR', async () => {
      mockCreateSuccess();
      const req = mockReq(FULL_BODY);
      const res = mockRes();

      await controller.createVacancy(req as never, res as never);

      const sql = mockQuery.mock.calls[2][0] as string;
      // status is now a param ($19), not hardcoded
      expect(sql).toContain('$19');
      expect(sql).toContain("'AR'");

      // When status not in body, defaults to PENDING_ACTIVATION
      const params = mockQuery.mock.calls[2][1] as unknown[];
      expect(params[18]).toBe('PENDING_ACTIVATION');
    });

    it('serializes schedule as JSON string', async () => {
      mockCreateSuccess();
      const req = mockReq({ ...FULL_BODY, schedule: [{ dayOfWeek: 3, startTime: '09:00', endTime: '17:00' }] });
      const res = mockRes();

      await controller.createVacancy(req as never, res as never);

      const params = mockQuery.mock.calls[2][1] as unknown[];
      expect(typeof params[11]).toBe('string');
      expect(JSON.parse(params[11] as string)).toEqual([{ dayOfWeek: 3, startTime: '09:00', endTime: '17:00' }]);
    });

    it('defaults salary_text to "A convenir" when not provided', async () => {
      mockCreateSuccess();
      const req = mockReq({ ...FULL_BODY, salary_text: undefined });
      const res = mockRes();

      await controller.createVacancy(req as never, res as never);

      const params = mockQuery.mock.calls[2][1] as unknown[];
      expect(params[14]).toBe('A convenir');
    });

    it('defaults required_professions to empty array when not provided', async () => {
      mockCreateSuccess();
      const req = mockReq({ ...FULL_BODY, required_professions: undefined });
      const res = mockRes();

      await controller.createVacancy(req as never, res as never);

      const params = mockQuery.mock.calls[2][1] as unknown[];
      expect(params[4]).toEqual([]);
    });

    it('always computes title as CASO {case_number}-{vacancyNumber}', async () => {
      mockCreateSuccess();
      const req = mockReq({ ...FULL_BODY, title: '' });
      const res = mockRes();

      await controller.createVacancy(req as never, res as never);

      const params = mockQuery.mock.calls[2][1] as unknown[];
      expect(params[2]).toBe('CASO 100-42');
    });

    it('sets null for schedule when not provided', async () => {
      mockCreateSuccess();
      const req = mockReq({ ...FULL_BODY, schedule: undefined });
      const res = mockRes();

      await controller.createVacancy(req as never, res as never);

      const params = mockQuery.mock.calls[2][1] as unknown[];
      expect(params[11]).toBeNull();
    });

    it('returns 201 with created vacancy', async () => {
      mockCreateSuccess();
      const req = mockReq(FULL_BODY);
      const res = mockRes();

      await controller.createVacancy(req as never, res as never);

      expect(res.status).toHaveBeenCalledWith(201);
      expect(res.json).toHaveBeenCalledWith({ success: true, data: VACANCY_ROW });
    });

    it('audit client is acquired and released after INSERT (best-effort audit)', async () => {
      mockCreateSuccess();
      const req = mockReq(FULL_BODY);
      const res = mockRes();

      await controller.createVacancy(req as never, res as never);

      // setImmediate audit client
      await new Promise(resolve => setImmediate(resolve));

      expect(mockConnect).toHaveBeenCalledTimes(1);
      expect(mockClientRelease).toHaveBeenCalledTimes(1);
      // Audit transaction lifecycle
      expect(mockClientQuery).toHaveBeenCalledWith('BEGIN');
      expect(mockClientQuery).toHaveBeenCalledWith('COMMIT');
    });

    it('falha no INSERT de domain_events (pós-commit) não derruba o 201 nem vira unhandled rejection', async () => {
      mockCreateSuccess();
      const req = mockReq(FULL_BODY);
      const res = mockRes();

      await controller.createVacancy(req as never, res as never);
      expect(res.status).toHaveBeenCalledWith(201);

      // O INSERT de domain_events roda no setImmediate (job:vacancy-postcreate).
      // Rejeitar a PRÓXIMA query exercita o catch do pós-commit — a resposta já
      // foi, então o único efeito aceitável é o reportError (nunca um throw).
      mockQuery.mockRejectedValueOnce(new Error('domain_events indisponível'));
      await new Promise(resolve => setImmediate(resolve));
      await new Promise(resolve => setImmediate(resolve));

      const domainEventCall = mockQuery.mock.calls.find((c) => String(c[0]).includes('domain_events'));
      expect(domainEventCall).toBeTruthy();
    });

    it('returns 500 on database error', async () => {
      mockQuery.mockRejectedValueOnce(new Error('column "description" violates not-null'));
      const req = mockReq(FULL_BODY);
      const res = mockRes();

      await controller.createVacancy(req as never, res as never);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ success: false, error: 'Failed to create vacancy' }),
      );
    });

    it('INSERT column count matches VALUES placeholder count', async () => {
      mockCreateSuccess();
      const req = mockReq(FULL_BODY);
      const res = mockRes();

      await controller.createVacancy(req as never, res as never);

      const sql = mockQuery.mock.calls[2][0] as string;
      // Extract column names from INSERT INTO ... (columns) VALUES
      const colMatch = sql.match(/INSERT INTO job_postings\s*\(([\s\S]*?)\)\s*VALUES/);
      expect(colMatch).toBeTruthy();
      const columns = colMatch![1].split(',').map(c => c.trim()).filter(Boolean);
      // 21 param columns + country (literal 'AR') + is_test (param) + contracted_service_id
      // (migration 320, spec 013 bloco C) = 24 total.
      // (description column dropped in migration 214 — no longer inserted)
      expect(columns).toHaveLength(24);
    });

    it('does NOT include state, city, pathology_types, dependency_level, service_device_types in INSERT SQL', async () => {
      mockCreateSuccess();
      const req = mockReq({ ...FULL_BODY, state: 'CABA', city: 'Palermo' });
      const res = mockRes();

      await controller.createVacancy(req as never, res as never);

      const sql = mockQuery.mock.calls[2][0] as string;
      expect(sql).not.toContain('state');
      expect(sql).not.toContain('city');
      expect(sql).not.toContain('pathology_types');
      expect(sql).not.toContain('dependency_level');
      expect(sql).not.toContain('service_device_types');
    });

    it('does NOT mention is_draft in INSERT — relies on migration 168 DEFAULT true so every new vacancy starts as a draft', async () => {
      // Migration 168 sets `is_draft BOOLEAN NOT NULL DEFAULT true`. The
      // INSERT must NOT pass this column so the default applies. If anyone
      // ever adds `is_draft` to the SQL (intentional or not), this test fails
      // loudly — protecting the invariant "newly created vacancies are
      // drafts until Talentum publish flips them" that fixed the 771-718
      // regression.
      mockCreateSuccess();
      const req = mockReq(FULL_BODY);
      const res = mockRes();

      await controller.createVacancy(req as never, res as never);

      const sql = mockQuery.mock.calls[2][0] as string;
      const colMatch = sql.match(/INSERT INTO job_postings\s*\(([\s\S]*?)\)\s*VALUES/);
      expect(colMatch).toBeTruthy();
      const columns = colMatch![1].split(',').map(c => c.trim()).filter(Boolean);
      expect(columns).not.toContain('is_draft');
    });

    // ── is_test guard field (migration 248) ────────────────────────

    describe('is_test field', () => {
      it('defaults to false when not provided in body', async () => {
        mockCreateSuccess();
        const req = mockReq(FULL_BODY);
        const res = mockRes();

        await controller.createVacancy(req as never, res as never);

        const params = mockQuery.mock.calls[2][1] as unknown[];
        expect(params[21]).toBe(false);
        expect(res.status).toHaveBeenCalledWith(201);
      });

      it('persists is_test=true when explicitly provided', async () => {
        mockCreateSuccess();
        const req = mockReq({ ...FULL_BODY, is_test: true });
        const res = mockRes();

        await controller.createVacancy(req as never, res as never);

        const params = mockQuery.mock.calls[2][1] as unknown[];
        expect(params[21]).toBe(true);
        expect(res.status).toHaveBeenCalledWith(201);
      });

      it('persists is_test=false when explicitly provided', async () => {
        mockCreateSuccess();
        const req = mockReq({ ...FULL_BODY, is_test: false });
        const res = mockRes();

        await controller.createVacancy(req as never, res as never);

        const params = mockQuery.mock.calls[2][1] as unknown[];
        expect(params[21]).toBe(false);
      });

      it('returns 400 when is_test is not a boolean (no query executed)', async () => {
        const req = mockReq({ ...FULL_BODY, is_test: 'yes' });
        const res = mockRes();

        await controller.createVacancy(req as never, res as never);

        expect(res.status).toHaveBeenCalledWith(400);
        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
          success: false,
          error: expect.stringContaining('is_test'),
        }));
        expect(mockQuery).not.toHaveBeenCalled();
      });

      it('INSERT SQL includes is_test column', async () => {
        mockCreateSuccess();
        const req = mockReq(FULL_BODY);
        const res = mockRes();

        await controller.createVacancy(req as never, res as never);

        const sql = mockQuery.mock.calls[2][0] as string;
        expect(sql).toContain('is_test');
      });
    });
  });

  // ── updateVacancy ────────────────────────────────────────────────

  describe('updateVacancy', () => {

    // Helpers — preceed each test with a SELECT that hydrates current state.
    // Migration 168 added `is_draft` as the canonical "incomplete publication"
    // flag, decoupled from status. authorizeVacancyUpdate reads both columns;
    // the helper mocks both so the controller path matches reality.
    function mockDraftSelect(): void {
      mockQuery.mockResolvedValueOnce({
        rows: [{ status: 'PENDING_ACTIVATION', is_draft: true, patient_id: 'pat-uuid-1' }],
      });
    }
    function mockOperationalSelect(status = 'SEARCHING'): void {
      mockQuery.mockResolvedValueOnce({
        rows: [{ status, is_draft: false, patient_id: 'pat-uuid-1' }],
      });
    }

    // Helper to set up client queries for a successful update:
    // BEGIN → SELECT before → UPDATE → [audit SAVEPOINT queries] → COMMIT
    function mockClientForUpdate(updatedRow: Record<string, unknown>): void {
      mockClientQuery
        .mockResolvedValueOnce({})                            // BEGIN
        .mockResolvedValueOnce({ rows: [{ id: updatedRow.id ?? 'uuid-123', status: 'PENDING_ACTIVATION', is_draft: true }] }) // SELECT before snapshot
        .mockResolvedValueOnce({ rows: [updatedRow] })        // UPDATE RETURNING *
        .mockResolvedValue({ rows: [] });                      // audit queries (SAVEPOINT, INSERT, RELEASE), COMMIT
    }

    // ── Draft mode (PENDING_ACTIVATION) — wizard de criação edita tudo ──────

    describe('draft mode (status = PENDING_ACTIVATION)', () => {
      it('allows update when body does not contain patient_id (no patient check performed)', async () => {
        mockDraftSelect();
        mockClientForUpdate({ id: 'uuid-123', title: 'CASO 999' });
        const req = mockReq({ title: 'CASO 999' }, { id: 'uuid-123' });
        const res = mockRes();

        await controller.updateVacancy(req as never, res as never);

        expect(res.status).toHaveBeenCalledWith(200);
        // pool: 1 SELECT (authorizeVacancyUpdate)
        expect(mockQuery).toHaveBeenCalledTimes(1);
        // client: BEGIN, SELECT before, UPDATE, [audit], COMMIT
        expect(mockConnect).toHaveBeenCalledTimes(1);
      });

      it('returns 400 when body contains patient_id = null', async () => {
        mockDraftSelect();
        const req = mockReq({ title: 'CASO 999', patient_id: null }, { id: 'uuid-123' });
        const res = mockRes();

        await controller.updateVacancy(req as never, res as never);

        expect(res.status).toHaveBeenCalledWith(400);
        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
          success: false,
          error: expect.stringContaining('patient_id não pode ser removido'),
        }));
        // Only the initial SELECT — no patient lookup, no UPDATE
        expect(mockQuery).toHaveBeenCalledTimes(1);
        expect(mockConnect).not.toHaveBeenCalled();
      });

      it('returns 400 when body contains patient_id = "" (empty string)', async () => {
        mockDraftSelect();
        const req = mockReq({ title: 'CASO 999', patient_id: '' }, { id: 'uuid-123' });
        const res = mockRes();

        await controller.updateVacancy(req as never, res as never);

        expect(res.status).toHaveBeenCalledWith(400);
        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
          success: false,
          error: expect.stringContaining('patient_id não pode ser removido'),
        }));
      });

      it('returns 400 when body contains valid patient_id string but patient does not exist', async () => {
        mockDraftSelect();
        mockQuery.mockResolvedValueOnce({ rows: [] }); // patient not found
        const req = mockReq({ patient_id: 'nonexistent-uuid' }, { id: 'uuid-123' });
        const res = mockRes();

        await controller.updateVacancy(req as never, res as never);

        expect(res.status).toHaveBeenCalledWith(400);
        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
          success: false,
          error: expect.stringContaining('paciente não encontrado'),
        }));
      });

      it('returns 400 when body contains patient_id for a soft-deleted patient', async () => {
        mockDraftSelect();
        mockQuery.mockResolvedValueOnce({ rows: [] });
        const req = mockReq({ patient_id: 'deleted-patient-uuid' }, { id: 'uuid-123' });
        const res = mockRes();

        await controller.updateVacancy(req as never, res as never);

        expect(res.status).toHaveBeenCalledWith(400);
        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
          success: false,
          error: expect.stringContaining('paciente não encontrado'),
        }));
      });

      it('allows update when body contains valid patient_id and patient is active', async () => {
        mockDraftSelect();
        mockQuery.mockResolvedValueOnce({ rows: [{ id: PATIENT_ID }] }); // patient found
        mockClientForUpdate({ id: 'uuid-123', patient_id: PATIENT_ID });
        const req = mockReq({ patient_id: PATIENT_ID, title: 'CASO 999' }, { id: 'uuid-123' });
        const res = mockRes();

        await controller.updateVacancy(req as never, res as never);

        expect(res.status).toHaveBeenCalledWith(200);
        // pool: 1 SELECT (authorize) + 1 SELECT (patient check)
        expect(mockQuery).toHaveBeenCalledTimes(2);
        expect(mockConnect).toHaveBeenCalledTimes(1);
      });

      it('accepts all allowed fields', async () => {
        const updates = {
          title: 'CASO 200',
          required_professions: ['NURSE'],
          required_sex: 'M',
          age_range_min: 20,
          age_range_max: 50,
          required_experience: 'x',
          worker_attributes: 'y',
          schedule: [{ dayOfWeek: 1, startTime: '08:00', endTime: '12:00' }],
          work_schedule: 'part-time',
          providers_needed: 3,
          salary_text: '1000',
          payment_day: 'Dia 5',
          daily_obs: 'obs',
          status: 'ACTIVE',
          patient_id: PATIENT_ID,
          worker_profile_sought: 'algo',
        };

        mockDraftSelect();
        mockQuery.mockResolvedValueOnce({ rows: [{ id: PATIENT_ID }] }); // patient found
        mockClientForUpdate({ id: 'uuid-123', ...updates });
        const req = mockReq(updates, { id: 'uuid-123' });
        const res = mockRes();

        await controller.updateVacancy(req as never, res as never);

        // UPDATE SQL is on client, not pool
        const updateCall = mockClientQuery.mock.calls.find(
          (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).includes('UPDATE job_postings SET'),
        );
        expect(updateCall).toBeDefined();
        const sql = updateCall![0] as string;
        expect(sql).toContain('title =');
        expect(sql).toContain('required_professions =');
        expect(sql).toContain('schedule =');
        expect(sql).toContain('status =');
        expect(res.status).toHaveBeenCalledWith(200);
      });

      it('does NOT include state, city, pathology_types, dependency_level, service_device_types in UPDATE', async () => {
        const updates = {
          title: 'CASO 200',
          status: 'ACTIVE',
          state: 'CABA',
          city: 'Palermo',
          pathology_types: 'TEA',
          dependency_level: 'Grave',
          service_device_types: ['DOMICILIARIO'],
        };

        mockDraftSelect();
        mockClientForUpdate({ id: 'uuid-123', title: 'CASO 200' });
        const req = mockReq(updates, { id: 'uuid-123' });
        const res = mockRes();

        await controller.updateVacancy(req as never, res as never);

        const updateCall = mockClientQuery.mock.calls.find(
          (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).includes('UPDATE job_postings SET'),
        );
        expect(updateCall).toBeDefined();
        const sql = updateCall![0] as string;
        expect(sql).not.toContain('state');
        expect(sql).not.toContain('city');
        expect(sql).not.toContain('pathology_types');
        expect(sql).not.toContain('dependency_level');
        expect(sql).not.toContain('service_device_types');
      });

      it('rejects unknown fields silently', async () => {
        mockDraftSelect();
        mockClientForUpdate({ id: 'uuid-123', title: 'X' });
        const req = mockReq({ title: 'X', HACKED_FIELD: 'malicious' }, { id: 'uuid-123' });
        const res = mockRes();

        await controller.updateVacancy(req as never, res as never);

        const updateCall = mockClientQuery.mock.calls.find(
          (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).includes('UPDATE job_postings SET'),
        );
        expect(updateCall).toBeDefined();
        const sql = updateCall![0] as string;
        expect(sql).not.toContain('HACKED_FIELD');
        expect(sql).toContain('title =');
      });

      it('returns 400 when no valid fields provided', async () => {
        mockDraftSelect();
        const req = mockReq({ unknown_field: 'value' }, { id: 'uuid-123' });
        const res = mockRes();

        await controller.updateVacancy(req as never, res as never);

        expect(res.status).toHaveBeenCalledWith(400);
      });

      it('serializes JSONB schedule field', async () => {
        const schedule = [{ dayOfWeek: 5, startTime: '14:00', endTime: '20:00' }];
        mockDraftSelect();
        mockClientForUpdate({ id: 'uuid-123', schedule });
        const req = mockReq({ schedule }, { id: 'uuid-123' });
        const res = mockRes();

        await controller.updateVacancy(req as never, res as never);

        // UPDATE params come from the client, not the pool
        const updateCall = mockClientQuery.mock.calls.find(
          (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).includes('UPDATE job_postings SET'),
        );
        expect(updateCall).toBeDefined();
        const params = updateCall![1] as unknown[];
        expect(typeof params[0]).toBe('string');
        expect(JSON.parse(params[0] as string)).toEqual(schedule);
      });
    });

    // ── Operational mode (non-draft) — só schedule + status ──────────────────

    describe('operational mode (status ≠ PENDING_ACTIVATION)', () => {
      it.each(['SEARCHING', 'SEARCHING_REPLACEMENT', 'RAPID_RESPONSE', 'ACTIVE', 'SUSPENDED', 'CLOSED'])(
        'allows schedule + status update when current status is %s',
        async (currentStatus) => {
          const schedule = [{ dayOfWeek: 2, startTime: '09:00', endTime: '17:00' }];
          mockOperationalSelect(currentStatus);
          mockClientForUpdate({ id: 'uuid-123', schedule, status: 'ACTIVE' });
          const req = mockReq({ schedule, status: 'ACTIVE' }, { id: 'uuid-123' });
          const res = mockRes();

          await controller.updateVacancy(req as never, res as never);

          expect(res.status).toHaveBeenCalledWith(200);
          const updateCall = mockClientQuery.mock.calls.find(
            (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).includes('UPDATE job_postings SET'),
          );
          expect(updateCall).toBeDefined();
          const sql = updateCall![0] as string;
          expect(sql).toContain('schedule =');
          expect(sql).toContain('status =');
        },
      );

      it.each([
        ['title', 'New title'],
        ['required_professions', ['NURSE']],
        ['salary_text', '2000'],
        ['providers_needed', 5],
        ['patient_id', PATIENT_ID],
        ['daily_obs', 'edited'],
      ])('rejects field "%s" with 403 when vacancy is non-draft', async (field, value) => {
        mockOperationalSelect('SEARCHING');
        const req = mockReq({ [field]: value }, { id: 'uuid-123' });
        const res = mockRes();

        await controller.updateVacancy(req as never, res as never);

        expect(res.status).toHaveBeenCalledWith(403);
        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
          success: false,
          error: expect.stringContaining(field as string),
        }));
        // Only the initial SELECT — no UPDATE attempted
        expect(mockQuery).toHaveBeenCalledTimes(1);
        expect(mockConnect).not.toHaveBeenCalled();
      });

      it('rejects mixed payload (schedule + status + title) with 403 listing only the forbidden fields', async () => {
        mockOperationalSelect('ACTIVE');
        const req = mockReq({
          schedule: [],
          status: 'SUSPENDED',
          title: 'should be ignored',
          salary_text: '999',
        }, { id: 'uuid-123' });
        const res = mockRes();

        await controller.updateVacancy(req as never, res as never);

        expect(res.status).toHaveBeenCalledWith(403);
        const errorMsg = (res.json.mock.calls[0][0] as { error: string }).error;
        const forbiddenList = errorMsg.split(':')[1].split('.')[0];
        expect(forbiddenList).toContain('title');
        expect(forbiddenList).toContain('salary_text');
        expect(forbiddenList).not.toContain('schedule');
        expect(forbiddenList).not.toContain('status');
      });

      it('allows status-only update', async () => {
        mockOperationalSelect('SEARCHING');
        mockClientForUpdate({ id: 'uuid-123', status: 'SUSPENDED' });
        const req = mockReq({ status: 'SUSPENDED' }, { id: 'uuid-123' });
        const res = mockRes();

        await controller.updateVacancy(req as never, res as never);

        expect(res.status).toHaveBeenCalledWith(200);
      });

      it('allows schedule-only update', async () => {
        const schedule = [{ dayOfWeek: 0, startTime: '10:00', endTime: '18:00' }];
        mockOperationalSelect('ACTIVE');
        mockClientForUpdate({ id: 'uuid-123', schedule });
        const req = mockReq({ schedule }, { id: 'uuid-123' });
        const res = mockRes();

        await controller.updateVacancy(req as never, res as never);

        expect(res.status).toHaveBeenCalledWith(200);
      });
    });

    it('returns 404 when vacancy not found (initial SELECT empty)', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });
      const req = mockReq({ title: 'X' }, { id: 'nonexistent' });
      const res = mockRes();

      await controller.updateVacancy(req as never, res as never);

      expect(res.status).toHaveBeenCalledWith(404);
    });

    describe('status validation', () => {
      const CANONICAL_STATUSES = [
        'SEARCHING',
        'SEARCHING_REPLACEMENT',
        'RAPID_RESPONSE',
        'PENDING_ACTIVATION',
        'ACTIVE',
        'SUSPENDED',
        'CLOSED',
      ];

      it.each(CANONICAL_STATUSES)('accepts canonical status "%s" → 200', async (status) => {
        mockOperationalSelect('SEARCHING');
        mockClientForUpdate({ id: 'uuid-123', status });
        const req = mockReq({ status }, { id: 'uuid-123' });
        const res = mockRes();

        await controller.updateVacancy(req as never, res as never);

        expect(res.status).toHaveBeenCalledWith(200);
      });

      it.each([
        ['BUSQUEDA'],
        ['REEMPLAZO'],
        ['CUBIERTO'],
        ['CANCELADO'],
        ['draft'],
      ])('rejects legacy status "%s" → 400, no query executed', async (status) => {
        const req = mockReq({ status }, { id: 'uuid-123' });
        const res = mockRes();

        await controller.updateVacancy(req as never, res as never);

        expect(res.status).toHaveBeenCalledWith(400);
        expect(res.json).toHaveBeenCalledWith(
          expect.objectContaining({
            success: false,
            error: expect.stringContaining(status),
          }),
        );
        expect(mockQuery).not.toHaveBeenCalled();
      });

      it('does not block update when status is undefined (other field updated normally in draft)', async () => {
        mockDraftSelect();
        mockClientForUpdate({ id: 'uuid-123', title: 'CASO 999' });
        const req = mockReq({ title: 'CASO 999' }, { id: 'uuid-123' });
        const res = mockRes();

        await controller.updateVacancy(req as never, res as never);

        expect(res.status).toHaveBeenCalledWith(200);
      });
    });

    it('rolls back client transaction and returns 500 on UPDATE error', async () => {
      mockDraftSelect();
      mockClientQuery
        .mockResolvedValueOnce({})   // BEGIN
        .mockResolvedValueOnce({ rows: [{ id: 'uuid-123', status: 'PENDING_ACTIVATION', is_draft: true }] }) // SELECT before
        .mockRejectedValueOnce(new Error('deadlock'))  // UPDATE fails
        .mockResolvedValueOnce({});  // ROLLBACK

      const req = mockReq({ title: 'X' }, { id: 'uuid-123' });
      const res = mockRes();

      await controller.updateVacancy(req as never, res as never);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(mockClientQuery).toHaveBeenCalledWith('ROLLBACK');
      expect(mockClientRelease).toHaveBeenCalled();
    });
  });

  // ── deleteVacancy ────────────────────────────────────────────────

  describe('deleteVacancy', () => {
    function mockClientForDelete(found = true): void {
      if (found) {
        mockClientQuery
          .mockResolvedValueOnce({})  // BEGIN
          .mockResolvedValueOnce({ rows: [{ id: 'uuid-123', status: 'SEARCHING' }] }) // SELECT before
          .mockResolvedValueOnce({ rows: [{ id: 'uuid-123' }] }) // UPDATE SET status=CLOSED
          .mockResolvedValue({ rows: [] }); // audit queries + COMMIT
      } else {
        mockClientQuery
          .mockResolvedValueOnce({})  // BEGIN
          .mockResolvedValueOnce({ rows: [] }) // SELECT before — not found
          .mockResolvedValueOnce({}); // ROLLBACK
      }
    }

    it('soft-deletes by setting status=CLOSED (UPDATE on client, not pool)', async () => {
      mockClientForDelete(true);
      const req = mockReq({}, { id: 'uuid-123' });
      const res = mockRes();

      await controller.deleteVacancy(req as never, res as never);

      // No pool queries — deleteVacancy acquires client immediately
      expect(mockQuery).not.toHaveBeenCalled();
      expect(mockConnect).toHaveBeenCalledTimes(1);

      const updateCall = mockClientQuery.mock.calls.find(
        (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).includes("status = 'CLOSED'"),
      );
      expect(updateCall).toBeDefined();
      expect(res.status).toHaveBeenCalledWith(200);
    });

    it('client transaction includes BEGIN … COMMIT lifecycle', async () => {
      mockClientForDelete(true);
      const req = mockReq({}, { id: 'uuid-123' });
      const res = mockRes();

      await controller.deleteVacancy(req as never, res as never);

      expect(mockClientQuery).toHaveBeenCalledWith('BEGIN');
      expect(mockClientQuery).toHaveBeenCalledWith('COMMIT');
      expect(mockClientRelease).toHaveBeenCalled();
    });

    it('audit INSERT is attempted inside the delete transaction', async () => {
      mockClientForDelete(true);
      const req = mockReq({}, { id: 'uuid-123' });
      const res = mockRes();

      await controller.deleteVacancy(req as never, res as never);

      const auditInsert = mockClientQuery.mock.calls.find(
        (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).includes('job_posting_audit_log'),
      );
      expect(auditInsert).toBeDefined();
    });

    it('returns 404 when vacancy not found', async () => {
      mockClientForDelete(false);
      const req = mockReq({}, { id: 'nonexistent' });
      const res = mockRes();

      await controller.deleteVacancy(req as never, res as never);

      expect(res.status).toHaveBeenCalledWith(404);
      // ROLLBACK was called
      expect(mockClientQuery).toHaveBeenCalledWith('ROLLBACK');
    });

    it('rolls back on error and returns 500', async () => {
      mockClientQuery
        .mockResolvedValueOnce({})  // BEGIN
        .mockResolvedValueOnce({ rows: [{ id: 'uuid-123', status: 'SEARCHING' }] }) // SELECT before
        .mockRejectedValueOnce(new Error('disk full')) // UPDATE fails
        .mockResolvedValueOnce({}); // ROLLBACK

      const req = mockReq({}, { id: 'uuid-123' });
      const res = mockRes();

      await controller.deleteVacancy(req as never, res as never);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(mockClientQuery).toHaveBeenCalledWith('ROLLBACK');
      expect(mockClientRelease).toHaveBeenCalled();
    });
  });
});
