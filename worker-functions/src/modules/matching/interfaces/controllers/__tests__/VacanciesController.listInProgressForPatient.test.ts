/**
 * VacanciesAuxController.listInProgressForPatient.test.ts
 *
 * Unit tests for GET /api/admin/vacancies/in-progress?patient_id=:uuid
 * (method lives in VacanciesAuxController after the 400-line split)
 *
 * Cenários:
 *   1. patient_id ausente → 400
 *   2. patient_id inválido (não UUID) → 400
 *   3. paciente sem drafts → array vazio
 *   4. paciente com 2 drafts → retornados ordenados por updated_at DESC
 *   5. draft vindo do ClickUp (row em job_postings_clickup_sync) → filtrado (mock retorna só os app-only)
 *   6. draft com deleted_at → filtrado (mock retorna só não deletados)
 *   7. is_draft = false → filtrado (mock retorna só rascunhos com is_draft = true)
 *   8. erro de banco → 500
 */

const mockQuery = jest.fn();

jest.mock('@shared/database/DatabaseConnection', () => ({
  DatabaseConnection: {
    getInstance: jest.fn().mockReturnValue({
      getPool: jest.fn().mockReturnValue({ query: mockQuery }),
    }),
  },
}));

import { VacanciesAuxController } from '../VacanciesAuxController';
import { Request, Response } from 'express';

// ─── helpers ──────────────────────────────────────────────────────────────────

const VALID_UUID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const VALID_UUID_2 = 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff';

function mockRes(): Response {
  return {
    json: jest.fn().mockReturnThis(),
    status: jest.fn().mockReturnThis(),
  } as unknown as Response;
}

function mockReq(query: Record<string, string> = {}): Request {
  return { params: {}, query, body: {} } as unknown as Request;
}

function makeDraftRow(overrides: Record<string, unknown> = {}) {
  return {
    id: VALID_UUID,
    case_number: 766,
    vacancy_number: 1234,
    title: 'CASO 766-1234',
    created_at: '2026-05-01T10:00:00.000Z',
    updated_at: '2026-05-11T15:00:00.000Z',
    ...overrides,
  };
}

// ─── tests ────────────────────────────────────────────────────────────────────

describe('VacanciesAuxController.listInProgressForPatient', () => {
  let controller: VacanciesAuxController;

  beforeEach(() => {
    jest.clearAllMocks();
    controller = new VacanciesAuxController();
  });

  // ── cenário 1: patient_id ausente → 400 ───────────────────────────────────

  it('retorna 400 quando patient_id está ausente', async () => {
    const req = mockReq({});
    const res = mockRes();
    await controller.listInProgressForPatient(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    const body = (res.json as jest.Mock).mock.calls[0][0] as { success: boolean; error: string };
    expect(body.success).toBe(false);
    expect(typeof body.error).toBe('string');
    expect(body.error.length).toBeGreaterThan(0);
    // banco nunca deve ser chamado
    expect(mockQuery).not.toHaveBeenCalled();
  });

  // ── cenário 2: patient_id inválido → 400 ──────────────────────────────────

  it('retorna 400 quando patient_id não é UUID v4', async () => {
    const req = mockReq({ patient_id: 'not-a-uuid' });
    const res = mockRes();
    await controller.listInProgressForPatient(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    const body = (res.json as jest.Mock).mock.calls[0][0] as { success: boolean; error: string };
    expect(body.success).toBe(false);
    expect(body.error).toContain('UUID');
    expect(mockQuery).not.toHaveBeenCalled();
  });

  // ── cenário 3: paciente sem drafts → array vazio ───────────────────────────

  it('retorna array vazio quando paciente não tem drafts', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const req = mockReq({ patient_id: VALID_UUID });
    const res = mockRes();
    await controller.listInProgressForPatient(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ success: true, data: [] });
  });

  // ── cenário 4: 2 drafts → ordenados por updated_at DESC (retorno conforme SQL) ──

  it('retorna 2 drafts na ordem retornada pelo banco (updated_at DESC)', async () => {
    const newer = makeDraftRow({ id: VALID_UUID, updated_at: '2026-05-11T15:00:00.000Z' });
    const older = makeDraftRow({ id: VALID_UUID_2, updated_at: '2026-05-10T10:00:00.000Z' });
    mockQuery.mockResolvedValueOnce({ rows: [newer, older] });

    const req = mockReq({ patient_id: VALID_UUID });
    const res = mockRes();
    await controller.listInProgressForPatient(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    const body = (res.json as jest.Mock).mock.calls[0][0] as { success: boolean; data: typeof newer[] };
    expect(body.data).toHaveLength(2);
    expect(body.data[0].id).toBe(VALID_UUID);
    expect(body.data[1].id).toBe(VALID_UUID_2);
  });

  // ── cenário 5: ClickUp drafts filtrados pelo SQL (mock retorna só app-only) ──

  it('draft do ClickUp é filtrado (SQL usa LEFT JOIN + IS NULL — mock simula resultado correto)', async () => {
    // The LEFT JOIN + sync.job_posting_id IS NULL filter runs in Postgres.
    // The mock simulates the DB returning only the app-only draft (ClickUp one excluded).
    const appDraft = makeDraftRow({ id: VALID_UUID, title: 'CASO 766-1234' });
    mockQuery.mockResolvedValueOnce({ rows: [appDraft] });

    const req = mockReq({ patient_id: VALID_UUID });
    const res = mockRes();
    await controller.listInProgressForPatient(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    const body = (res.json as jest.Mock).mock.calls[0][0] as { data: typeof appDraft[] };
    expect(body.data).toHaveLength(1);
    expect(body.data[0].title).toBe('CASO 766-1234');
  });

  // ── cenário 6: deleted drafts filtrados (SQL: deleted_at IS NULL) ─────────

  it('draft com deleted_at é filtrado (mock simula resultado sem o deletado)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const req = mockReq({ patient_id: VALID_UUID });
    const res = mockRes();
    await controller.listInProgressForPatient(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect((res.json as jest.Mock).mock.calls[0][0]).toEqual({ success: true, data: [] });
  });

  // ── cenário 7: is_draft = false filtrado (SQL: is_draft = true) ─────────────

  it('vaga com is_draft = false não retorna (mock simula SQL com filtro is_draft)', async () => {
    // SQL only returns is_draft = true rows; mock confirms empty result
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const req = mockReq({ patient_id: VALID_UUID });
    const res = mockRes();
    await controller.listInProgressForPatient(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect((res.json as jest.Mock).mock.calls[0][0]).toEqual({ success: true, data: [] });
  });

  // ── cenário 8: invariante estrutural — SQL correto ─────────────────────────

  it('SQL contém os filtros obrigatórios (is_draft, deleted_at, LEFT JOIN clickup_sync)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const req = mockReq({ patient_id: VALID_UUID });
    const res = mockRes();
    await controller.listInProgressForPatient(req, res);

    expect(mockQuery).toHaveBeenCalledTimes(1);
    const [sql, bindParams] = mockQuery.mock.calls[0] as [string, unknown[]];

    expect(sql).toContain('jp.is_draft = true');
    expect(sql).toContain('jp.deleted_at IS NULL');
    expect(sql).toContain('job_postings_clickup_sync');
    expect(sql).toContain('sync.job_posting_id IS NULL');
    expect(sql).toContain('ORDER BY jp.updated_at DESC');
    // Migration 168 contract: draft is no longer coupled to status =
    // PENDING_ACTIVATION — that status check would (incorrectly) filter out
    // vacancies the operator already marked as SEARCHING/RAPID_RESPONSE/etc.
    expect(sql).not.toContain("jp.status = 'PENDING_ACTIVATION'");
    expect(sql).not.toContain('clickup_task_id'); // não existe em job_postings diretamente
    expect(bindParams).toEqual([VALID_UUID]);
  });

  // ── cenário 9: erro de banco → 500 ────────────────────────────────────────

  it('retorna 500 quando query lança exceção', async () => {
    mockQuery.mockRejectedValueOnce(new Error('connection refused'));

    const req = mockReq({ patient_id: VALID_UUID });
    const res = mockRes();
    await controller.listInProgressForPatient(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    const body = (res.json as jest.Mock).mock.calls[0][0] as { success: boolean; error: string };
    expect(body.success).toBe(false);
    expect(body.error).toContain('in-progress');
  });

  // ── cenário 10: shape de resposta ─────────────────────────────────────────

  it('shape de resposta contém id, case_number, vacancy_number, title, created_at, updated_at', async () => {
    const draft = makeDraftRow();
    mockQuery.mockResolvedValueOnce({ rows: [draft] });

    const req = mockReq({ patient_id: VALID_UUID });
    const res = mockRes();
    await controller.listInProgressForPatient(req, res);

    const body = (res.json as jest.Mock).mock.calls[0][0] as { data: Record<string, unknown>[] };
    const item = body.data[0];
    expect(item).toHaveProperty('id');
    expect(item).toHaveProperty('case_number');
    expect(item).toHaveProperty('vacancy_number');
    expect(item).toHaveProperty('title');
    expect(item).toHaveProperty('created_at');
    expect(item).toHaveProperty('updated_at');
  });
});
