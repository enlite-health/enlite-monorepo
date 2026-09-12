/**
 * VacancyAddressReviewController — Unit Tests
 *
 * Covers:
 *   - resolve with existing patient_address_id → 200
 *   - resolve with createAddress → creates address + 200
 *   - patient_address_id does not belong to vacancy patient → 422
 *   - vacancy not found → 404
 *   - vacancy has no patient_id → safe response
 *   - invalid body → 400
 *   - DB error → 500
 *
 * Fluxo transacional (Onda B — audit-log):
 *   As mutações (UPDATE job_postings + INSERT audit) acontecem dentro de um
 *   client adquirido via db.connect(). O mockPool precisa expor connect()
 *   retornando um mockClient com query + release.
 *
 * Ordem de chamadas no caminho feliz (patient_address_id existente):
 *   pool.query[0]       → SELECT vacancy
 *   pool.query[1]       → ownership check
 *   clientQuery[0]      → BEGIN
 *   clientQuery[1]      → UPDATE job_postings SET patient_address_id
 *   clientQuery[2..N]   → logEventSafe (SAVEPOINT + INSERT audit)
 *   clientQuery[N+1]    → COMMIT
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

import { VacancyAddressReviewController } from '../../../src/modules/matching/interfaces/controllers/VacancyAddressReviewController';

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

const VACANCY_ID = 'aaaaaaaa-0000-0000-0000-000000000001';
const PATIENT_ID = 'bbbbbbbb-0000-0000-0000-000000000002';
const ADDRESS_ID = 'cccccccc-0000-0000-0000-000000000003';
const NEW_ADDRESS_ID = 'dddddddd-0000-0000-0000-000000000004';

// ── Tests ────────────────────────────────────────────────────────────

describe('VacancyAddressReviewController', () => {
  let controller: VacancyAddressReviewController;

  beforeEach(() => {
    mockQuery.mockReset();
    mockClientQuery.mockReset();
    mockClientRelease.mockReset();
    mockConnect.mockReset();
    mockConnect.mockResolvedValue({ query: mockClientQuery, release: mockClientRelease });
    // Default: client queries (BEGIN, UPDATE, logEventSafe internals, COMMIT) resolve safely.
    mockClientQuery.mockResolvedValue({ rows: [] });
    controller = new VacancyAddressReviewController();
  });

  // ── resolve with existing patient_address_id ─────────────────────

  describe('resolve with patient_address_id', () => {
    it('returns 200 and updated data when address belongs to patient', async () => {
      // pool queries: 1. vacancy lookup, 2. ownership check
      mockQuery
        .mockResolvedValueOnce({ rows: [{ id: VACANCY_ID, patient_id: PATIENT_ID }] })
        .mockResolvedValueOnce({ rows: [{ '?column?': 1 }] });
      // client queries: BEGIN, UPDATE, [audit SAVEPOINT + INSERT], COMMIT — all resolve via default

      const req = mockReq({ patient_address_id: ADDRESS_ID }, { id: VACANCY_ID });
      const res = mockRes();

      await controller.resolveAddressReview(req as never, res as never);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({
        success: true,
        data: { id: VACANCY_ID, patient_address_id: ADDRESS_ID },
      });
    });

    it('issues correct SQL for vacancy lookup', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [{ id: VACANCY_ID, patient_id: PATIENT_ID }] })
        .mockResolvedValueOnce({ rows: [{ '?column?': 1 }] });

      const req = mockReq({ patient_address_id: ADDRESS_ID }, { id: VACANCY_ID });
      const res = mockRes();

      await controller.resolveAddressReview(req as never, res as never);

      const lookupSql = mockQuery.mock.calls[0][0] as string;
      expect(lookupSql).toContain('deleted_at IS NULL');
      expect(mockQuery.mock.calls[0][1]).toEqual([VACANCY_ID]);
    });

    it('issues parameterized UPDATE with address id and vacancy id (via client, not pool)', async () => {
      // UPDATE now runs on the transactional client, not on the pool directly.
      mockQuery
        .mockResolvedValueOnce({ rows: [{ id: VACANCY_ID, patient_id: PATIENT_ID }] })
        .mockResolvedValueOnce({ rows: [{ '?column?': 1 }] });

      const req = mockReq({ patient_address_id: ADDRESS_ID }, { id: VACANCY_ID });
      const res = mockRes();

      await controller.resolveAddressReview(req as never, res as never);

      // clientQuery[0] = BEGIN, clientQuery[1] = UPDATE
      const updateCall = mockClientQuery.mock.calls.find(
        (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).includes('UPDATE job_postings'),
      );
      expect(updateCall).toBeDefined();
      const updateParams = updateCall![1] as unknown[];
      expect(updateParams[0]).toBe(ADDRESS_ID);
      expect(updateParams[1]).toBe(VACANCY_ID);
    });

    it('opens a client transaction for the UPDATE (connect called)', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [{ id: VACANCY_ID, patient_id: PATIENT_ID }] })
        .mockResolvedValueOnce({ rows: [{ '?column?': 1 }] });

      const req = mockReq({ patient_address_id: ADDRESS_ID }, { id: VACANCY_ID });
      const res = mockRes();

      await controller.resolveAddressReview(req as never, res as never);

      expect(mockConnect).toHaveBeenCalledTimes(1);
      expect(mockClientRelease).toHaveBeenCalledTimes(1);
      // Transaction lifecycle: BEGIN … COMMIT
      expect(mockClientQuery).toHaveBeenCalledWith('BEGIN');
      expect(mockClientQuery).toHaveBeenCalledWith('COMMIT');
    });

    it('audit INSERT is attempted inside the client transaction', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [{ id: VACANCY_ID, patient_id: PATIENT_ID }] })
        .mockResolvedValueOnce({ rows: [{ '?column?': 1 }] });

      const req = mockReq({ patient_address_id: ADDRESS_ID }, { id: VACANCY_ID });
      const res = mockRes();

      await controller.resolveAddressReview(req as never, res as never);

      // logEventSafe uses SAVEPOINT … INSERT INTO job_posting_audit_log … RELEASE SAVEPOINT
      const auditInsert = mockClientQuery.mock.calls.find(
        (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).includes('job_posting_audit_log'),
      );
      expect(auditInsert).toBeDefined();
    });
  });

  // ── resolve with createAddress ───────────────────────────────────

  describe('resolve with createAddress', () => {
    it('inserts new address and updates vacancy, returns 200', async () => {
      // pool queries: 1. vacancy lookup, 2. INSERT patient_address, 3. ownership check
      mockQuery
        .mockResolvedValueOnce({ rows: [{ id: VACANCY_ID, patient_id: PATIENT_ID }] })
        .mockResolvedValueOnce({ rows: [{ id: NEW_ADDRESS_ID }] })
        .mockResolvedValueOnce({ rows: [{ '?column?': 1 }] });
      // client queries handled by default (BEGIN, UPDATE, audit, COMMIT)

      const req = mockReq(
        {
          createAddress: {
            address_formatted: 'Rua A, 123',
            address_raw: 'Rua A 123',
          },
        },
        { id: VACANCY_ID },
      );
      const res = mockRes();

      await controller.resolveAddressReview(req as never, res as never);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({
        success: true,
        data: { id: VACANCY_ID, patient_address_id: NEW_ADDRESS_ID },
      });
    });

    it('INSERT uses source=admin_review', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [{ id: VACANCY_ID, patient_id: PATIENT_ID }] })
        .mockResolvedValueOnce({ rows: [{ id: NEW_ADDRESS_ID }] })
        .mockResolvedValueOnce({ rows: [{ '?column?': 1 }] });

      const req = mockReq(
        { createAddress: { address_formatted: 'Av B' } },
        { id: VACANCY_ID },
      );
      const res = mockRes();

      await controller.resolveAddressReview(req as never, res as never);

      // INSERT patient_address is still a pool query (call index 1)
      const insertSql = mockQuery.mock.calls[1][0] as string;
      expect(insertSql).toContain("'admin_review'");
      // Spec 019 (B4): address_type saiu do schema/INSERT — era o único ponto aceitando string
      // livre sem validação de lista.
      expect(insertSql).not.toMatch(/address_type/);
    });

    it('returns 422 when vacancy has no patient_id and createAddress is provided', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ id: VACANCY_ID, patient_id: null }] });

      const req = mockReq(
        { createAddress: { address_formatted: 'Rua X' } },
        { id: VACANCY_ID },
      );
      const res = mockRes();

      await controller.resolveAddressReview(req as never, res as never);

      expect(res.status).toHaveBeenCalledWith(422);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ success: false }),
      );
    });
  });

  // ── ownership failure ────────────────────────────────────────────

  describe('ownership validation', () => {
    it('returns 422 when patient_address_id does not belong to vacancy patient', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [{ id: VACANCY_ID, patient_id: PATIENT_ID }] })
        // ownership check: empty — address not found for patient
        .mockResolvedValueOnce({ rows: [] });

      const req = mockReq({ patient_address_id: 'eeeeeeee-0000-0000-0000-999999999999' }, { id: VACANCY_ID });
      const res = mockRes();

      await controller.resolveAddressReview(req as never, res as never);

      expect(res.status).toHaveBeenCalledWith(422);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          error: 'Address does not belong to the vacancy patient',
        }),
      );
      // UPDATE must NOT have been called (connect never acquired)
      expect(mockConnect).not.toHaveBeenCalled();
      expect(mockQuery).toHaveBeenCalledTimes(2);
    });
  });

  // ── vacancy not found ────────────────────────────────────────────

  describe('vacancy not found', () => {
    it('returns 404 when vacancy does not exist', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const req = mockReq({ patient_address_id: ADDRESS_ID }, { id: 'nonexistent-id' });
      const res = mockRes();

      await controller.resolveAddressReview(req as never, res as never);

      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith({ success: false, error: 'Vacancy not found' });
      expect(mockQuery).toHaveBeenCalledTimes(1);
    });
  });

  // ── vacancy without patient_id ───────────────────────────────────

  describe('vacancy with null patient_id', () => {
    it('skips ownership check and still updates when patient_address_id is provided', async () => {
      // Vacancy has no patient; ownership check is skipped (patientId is null)
      mockQuery.mockResolvedValueOnce({ rows: [{ id: VACANCY_ID, patient_id: null }] });
      // client queries handled by default

      const req = mockReq({ patient_address_id: ADDRESS_ID }, { id: VACANCY_ID });
      const res = mockRes();

      await controller.resolveAddressReview(req as never, res as never);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({
        success: true,
        data: { id: VACANCY_ID, patient_address_id: ADDRESS_ID },
      });
      // Only 1 pool query: vacancy lookup (ownership check skipped; UPDATE is on client)
      expect(mockQuery).toHaveBeenCalledTimes(1);
      // But the transaction client was still acquired
      expect(mockConnect).toHaveBeenCalledTimes(1);
    });
  });

  // ── invalid body ─────────────────────────────────────────────────

  describe('invalid body', () => {
    it('returns 400 when body is empty', async () => {
      const req = mockReq({}, { id: VACANCY_ID });
      const res = mockRes();

      await controller.resolveAddressReview(req as never, res as never);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(mockQuery).not.toHaveBeenCalled();
    });

    it('returns 400 when patient_address_id is not a UUID', async () => {
      const req = mockReq({ patient_address_id: 'not-a-uuid' }, { id: VACANCY_ID });
      const res = mockRes();

      await controller.resolveAddressReview(req as never, res as never);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(mockQuery).not.toHaveBeenCalled();
    });

    it('returns 400 when createAddress has empty address_formatted', async () => {
      const req = mockReq(
        { createAddress: { address_formatted: '' } },
        { id: VACANCY_ID },
      );
      const res = mockRes();

      await controller.resolveAddressReview(req as never, res as never);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(mockQuery).not.toHaveBeenCalled();
    });
  });

  // ── DB error ─────────────────────────────────────────────────────

  describe('database errors', () => {
    it('returns 500 when DB throws on vacancy lookup', async () => {
      mockQuery.mockRejectedValueOnce(new Error('connection reset'));

      const req = mockReq({ patient_address_id: ADDRESS_ID }, { id: VACANCY_ID });
      const res = mockRes();

      await controller.resolveAddressReview(req as never, res as never);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ success: false, details: 'connection reset' }),
      );
    });

    it('rolls back and returns 500 when UPDATE client query throws', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [{ id: VACANCY_ID, patient_id: PATIENT_ID }] })
        .mockResolvedValueOnce({ rows: [{ '?column?': 1 }] });

      // BEGIN succeeds, UPDATE fails
      mockClientQuery
        .mockResolvedValueOnce({}) // BEGIN
        .mockRejectedValueOnce(new Error('deadlock detected')) // UPDATE
        .mockResolvedValueOnce({}); // ROLLBACK

      const req = mockReq({ patient_address_id: ADDRESS_ID }, { id: VACANCY_ID });
      const res = mockRes();

      await controller.resolveAddressReview(req as never, res as never);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(mockClientQuery).toHaveBeenCalledWith('ROLLBACK');
      expect(mockClientRelease).toHaveBeenCalled();
    });
  });
});
