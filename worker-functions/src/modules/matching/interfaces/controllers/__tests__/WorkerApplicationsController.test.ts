/**
 * WorkerApplicationsController.test.ts
 *
 * Tests for POST /api/worker-applications/track-channel
 *
 * Scenarios:
 * 1. Missing auth → 401
 * 2. Invalid channel → 400 with whitelist error
 * 3. Missing jobPostingId → 400
 * 4. Worker not found (getProgress fails) → 404
 * 5. Happy path: upserts WJA with channel + funnel_stage='INVITED' (pré-Talentum — migration 230)
 * 6. Happy path: creates encuadre with decrypted name and channel as import_source_audit
 * 7. Encuadre dedup_hash is deterministic md5
 * 8. Accepts all valid channels (WJA + encuadre per channel)
 * 9. DB error → 500
 */

const mockQuery = jest.fn();

jest.mock('@shared/database/DatabaseConnection', () => ({
  DatabaseConnection: {
    getInstance: jest.fn().mockReturnValue({
      getPool: jest.fn().mockReturnValue({ query: mockQuery }),
    }),
  },
}));

let decryptCallIndex = 0;
const MOCK_DECRYPTED = ['María', 'García', '', '', '', '', '', '', ''];

jest.mock('@shared/security/KMSEncryptionService', () => ({
  KMSEncryptionService: jest.fn().mockImplementation(() => ({
    encrypt: jest.fn().mockResolvedValue('encrypted'),
    decrypt: jest.fn().mockImplementation(() => {
      const val = MOCK_DECRYPTED[decryptCallIndex] ?? '';
      decryptCallIndex++;
      return Promise.resolve(val);
    }),
    encryptBatch: jest.fn().mockResolvedValue({}),
  })),
}));

import crypto from 'crypto';
import { WorkerApplicationsController } from '../WorkerApplicationsController';
import { Request, Response } from 'express';

function mockReqRes(
  body: Record<string, unknown> = {},
  authUid?: string,
): [Request, Response] {
  const req = {
    body,
    params: {},
    query: {},
    user: authUid ? { uid: authUid } : undefined,
    headers: {},
  } as unknown as Request;
  const res = {
    json: jest.fn().mockReturnThis(),
    status: jest.fn().mockReturnThis(),
  } as unknown as Response;
  return [req, res];
}

// Worker row returned by WorkerRepository (via GetWorkerProgressUseCase)
function mockWorkerFound(workerId = 'worker-uuid-1') {
  mockQuery.mockResolvedValueOnce({
    rows: [{
      id: workerId,
      auth_uid: 'uid-1',
      email: 'w@test.com',
      registration_step: 5,
      phone: '+5491155001122',
      whatsapp_phone: null,
      country: 'AR',
      first_name_encrypted: 'enc-maria',
      last_name_encrypted: 'enc-garcia',
      created_at: new Date(),
      updated_at: new Date(),
    }],
  });
}

/** Mock worker eligibility check (assertWorkerCanApply → SELECT status FROM workers) */
function mockWorkerEligible(status: string = 'REGISTERED') {
  mockQuery.mockResolvedValueOnce({ rows: [{ status }] });
}

/** Mock all DB calls after worker lookup: eligibility check + WJA upsert + encuadre insert */
function mockDbSuccess(status: string = 'REGISTERED') {
  mockWorkerEligible(status);
  mockQuery.mockResolvedValueOnce({ rowCount: 1, rows: [] }); // WJA upsert
  mockQuery.mockResolvedValueOnce({ rowCount: 1, rows: [] }); // encuadre insert
}

describe('WorkerApplicationsController — trackChannel', () => {
  let controller: WorkerApplicationsController;

  beforeEach(() => {
    jest.clearAllMocks();
    decryptCallIndex = 0;
    controller = new WorkerApplicationsController();
  });

  // ── Validation & Auth ──────────────────────────────────────────────────

  it('returns 401 when no auth uid', async () => {
    const [req, res] = mockReqRes({ jobPostingId: 'jp-1', channel: 'facebook' });
    await controller.trackChannel(req, res);
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('accepts auth via x-auth-uid header fallback', async () => {
    const req = {
      body: { jobPostingId: 'jp-1', channel: 'facebook' },
      params: {}, query: {},
      user: undefined,
      headers: { 'x-auth-uid': 'uid-header' },
    } as unknown as Request;
    const res = {
      json: jest.fn().mockReturnThis(),
      status: jest.fn().mockReturnThis(),
    } as unknown as Response;

    mockWorkerFound('w-1');
    mockDbSuccess();

    await controller.trackChannel(req, res);
    expect(res.json).toHaveBeenCalledWith({ success: true });
  });

  it('returns 400 when channel is invalid', async () => {
    const [req, res] = mockReqRes({ jobPostingId: 'jp-1', channel: 'tiktok' }, 'uid-1');
    await controller.trackChannel(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
    const body = (res.json as jest.Mock).mock.calls[0][0];
    expect(body.error).toMatch(/facebook|instagram|whatsapp|linkedin|site/);
  });

  it('returns 400 when jobPostingId is missing', async () => {
    const [req, res] = mockReqRes({ channel: 'instagram' }, 'uid-1');
    await controller.trackChannel(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('returns 400 with fallback message when body is completely empty', async () => {
    const [req, res] = mockReqRes({}, 'uid-1');
    await controller.trackChannel(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect((res.json as jest.Mock).mock.calls[0][0].error).toBeTruthy();
  });

  it('returns 404 when worker is not found', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const [req, res] = mockReqRes({ jobPostingId: 'jp-1', channel: 'linkedin' }, 'uid-1');
    await controller.trackChannel(req, res);
    expect(res.status).toHaveBeenCalledWith(404);
  });

  // ── WJA upsert ─────────────────────────────────────────────────────────

  it('upserts WJA with funnel_stage=INVITED and first-touch channel (migration 230: pré-Talentum = INVITED)', async () => {
    mockWorkerFound('w-1');
    mockDbSuccess();

    const [req, res] = mockReqRes({ jobPostingId: 'jp-1', channel: 'facebook' }, 'uid-1');
    await controller.trackChannel(req, res);

    expect(res.json).toHaveBeenCalledWith({ success: true });

    // Call 0 = worker lookup, 1 = eligibility check, 2 = WJA upsert
    const upsertCall = mockQuery.mock.calls[2];
    expect(upsertCall[0]).toContain('worker_job_applications');
    expect(upsertCall[0]).toContain("'INVITED'");
    expect(upsertCall[0]).toContain('acquisition_channel IS NULL');
    expect(upsertCall[1]).toEqual(['w-1', 'jp-1', 'facebook']);
  });

  // GUARD do gatilho: postulação sem UTM (channel ausente ou null) NÃO pode dar 400.
  // É o caminho principal — o frontend chama track-channel a cada clique mesmo sem UTM,
  // mandando channel=null. Se o schema voltar a exigir channel, o gatilho quebra silencioso.
  it('accepts request WITHOUT channel (no UTM) — proceeds, persists acquisition_channel=null', async () => {
    mockWorkerFound('w-1');
    mockDbSuccess();

    const [req, res] = mockReqRes({ jobPostingId: 'jp-1' }, 'uid-1');
    await controller.trackChannel(req, res);

    expect(res.json).toHaveBeenCalledWith({ success: true });
    expect(res.status).not.toHaveBeenCalledWith(400);
    expect(mockQuery.mock.calls[2][1]).toEqual(['w-1', 'jp-1', null]);
  });

  it('accepts explicit channel=null (no UTM) — proceeds, persists acquisition_channel=null', async () => {
    mockWorkerFound('w-1');
    mockDbSuccess();

    const [req, res] = mockReqRes({ jobPostingId: 'jp-1', channel: null }, 'uid-1');
    await controller.trackChannel(req, res);

    expect(res.json).toHaveBeenCalledWith({ success: true });
    expect(res.status).not.toHaveBeenCalledWith(400);
    expect(mockQuery.mock.calls[2][1]).toEqual(['w-1', 'jp-1', null]);
  });

  // ── Encuadre creation ──────────────────────────────────────────────────

  it('creates encuadre with decrypted name and channel as import_source_audit', async () => {
    mockWorkerFound('w-1');
    mockDbSuccess();

    const [req, res] = mockReqRes({ jobPostingId: 'jp-1', channel: 'instagram' }, 'uid-1');
    await controller.trackChannel(req, res);

    expect(res.json).toHaveBeenCalledWith({ success: true });

    // Call 3 = encuadre insert (0=worker, 1=eligibility, 2=WJA, 3=encuadre)
    const encuadreCall = mockQuery.mock.calls[3];
    expect(encuadreCall[0]).toContain('INSERT INTO encuadres');
    expect(encuadreCall[0]).toContain('NOT EXISTS');
    expect(encuadreCall[0]).toContain('ON CONFLICT (worker_id, job_posting_id) DO NOTHING');

    // $1=workerId, $2=jobPostingId, $3=dedupHash, $4=name, $5=phone, $6=channel
    expect(encuadreCall[1][0]).toBe('w-1');
    expect(encuadreCall[1][1]).toBe('jp-1');
    expect(encuadreCall[1][3]).toBe('María García');  // decrypted name
    expect(encuadreCall[1][5]).toBe('instagram');      // import_source_audit = channel
  });

  it('generates deterministic md5 dedup_hash from worker+job', async () => {
    mockWorkerFound('w-1');
    mockDbSuccess();

    const [req, res] = mockReqRes({ jobPostingId: 'jp-1', channel: 'whatsapp' }, 'uid-1');
    await controller.trackChannel(req, res);

    const expectedHash = crypto.createHash('md5')
      .update('social-link|w-1|jp-1')
      .digest('hex');

    const encuadreCall = mockQuery.mock.calls[3];
    expect(encuadreCall[1][2]).toBe(expectedHash);
  });

  it('encuadre uses decrypted name, not email or full_name', async () => {
    mockWorkerFound('w-1');
    mockDbSuccess();

    const [req, res] = mockReqRes({ jobPostingId: 'jp-1', channel: 'site' }, 'uid-1');
    await controller.trackChannel(req, res);

    const encuadreQuery = mockQuery.mock.calls[3][0] as string;
    // Must NOT reference w.email or w.full_name — name comes from decrypted fields
    expect(encuadreQuery).not.toContain('w.email');
    expect(encuadreQuery).not.toContain('full_name');
  });

  // ── All channels ───────────────────────────────────────────────────────

  it('accepts all valid channels and passes each as import_source_audit', async () => {
    const channels = ['facebook', 'instagram', 'whatsapp', 'linkedin', 'site'] as const;
    for (const channel of channels) {
      jest.clearAllMocks();
      decryptCallIndex = 0;
      mockWorkerFound('w-1');
      mockDbSuccess();

      const [req, res] = mockReqRes({ jobPostingId: 'jp-1', channel }, 'uid-1');
      await controller.trackChannel(req, res);

      expect(res.json).toHaveBeenCalledWith({ success: true });

      // Verify encuadre import_source_audit matches channel (call 3: 0=worker, 1=eligibility, 2=WJA, 3=encuadre)
      const encuadreCall = mockQuery.mock.calls[3];
      expect(encuadreCall[1][5]).toBe(channel);
    }
  });

  // ── Edge cases ──────────────────────────────────────────────────────────

  it('uses empty string when worker has no name', async () => {
    // Override decrypt to return empty strings (no name set)
    decryptCallIndex = 0;
    MOCK_DECRYPTED[0] = '';
    MOCK_DECRYPTED[1] = '';

    mockWorkerFound('w-1');
    mockDbSuccess();

    const [req, res] = mockReqRes({ jobPostingId: 'jp-1', channel: 'facebook' }, 'uid-1');
    await controller.trackChannel(req, res);

    expect(res.json).toHaveBeenCalledWith({ success: true });

    const encuadreCall = mockQuery.mock.calls[3];
    expect(encuadreCall[1][3]).toBe(''); // empty name fallback

    // Restore
    MOCK_DECRYPTED[0] = 'María';
    MOCK_DECRYPTED[1] = 'García';
  });

  it('uses empty string when worker has no phone', async () => {
    // Mock worker with null phone
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: 'w-no-phone',
        auth_uid: 'uid-1',
        email: 'w@test.com',
        registration_step: 5,
        phone: null,
        country: 'AR',
        created_at: new Date(),
        updated_at: new Date(),
      }],
    });
    mockDbSuccess();

    const [req, res] = mockReqRes({ jobPostingId: 'jp-1', channel: 'site' }, 'uid-1');
    await controller.trackChannel(req, res);

    const encuadreCall = mockQuery.mock.calls[3];
    expect(encuadreCall[1][4]).toBe(''); // empty phone fallback
  });

  // ── Eligibility gating (cadastro + documentos completos) ──────────────

  it('returns 403 when worker.status = INCOMPLETE_REGISTER — inclui missingFields no body', async () => {
    mockWorkerFound('w-1');
    mockWorkerEligible('INCOMPLETE_REGISTER');
    // RecordBlockedAttemptUseCase chama fn_worker_missing_fields (query extra)
    // missingFields sem worker_documents → sem expand query (2 queries para o use case)
    mockQuery.mockResolvedValueOnce({ rows: [{ missing: '["phone"]' }] }); // fn_worker_missing_fields
    mockQuery.mockResolvedValueOnce({ rowCount: 1 });                      // INSERT worker_blocked_applications

    const [req, res] = mockReqRes({ jobPostingId: 'jp-1', channel: 'facebook' }, 'uid-1');
    await controller.trackChannel(req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    const body = (res.json as jest.Mock).mock.calls[0][0];
    expect(body.code).toBe('WORKER_NOT_ELIGIBLE');
    expect(body.reason).toBe('registration_incomplete');
    expect(body.workerStatus).toBe('INCOMPLETE_REGISTER');
    expect(body.missingFields).toEqual(['phone']);
    // NÃO deve ter chamado WJA upsert nem encuadre insert — só worker lookup + eligibility +
    // fn_worker_missing_fields + INSERT worker_blocked_applications
    expect(mockQuery).toHaveBeenCalledTimes(4);
    // Confirma que WJA upsert nunca foi chamado
    const queryCalls = mockQuery.mock.calls.map((c: unknown[]) => c[0] as string);
    expect(queryCalls.some(q => q.includes('worker_job_applications'))).toBe(false);
  });

  it('returns 403 when worker.status = DISABLED — missingFields vazio', async () => {
    mockWorkerFound('w-1');
    mockWorkerEligible('DISABLED');
    // RecordBlockedAttemptUseCase para worker_disabled NÃO chama fn_worker_missing_fields
    // mas chama o INSERT (query extra)
    mockQuery.mockResolvedValueOnce({ rowCount: 1 }); // INSERT worker_blocked_applications

    const [req, res] = mockReqRes({ jobPostingId: 'jp-1', channel: 'instagram' }, 'uid-1');
    await controller.trackChannel(req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    const body = (res.json as jest.Mock).mock.calls[0][0];
    expect(body.reason).toBe('worker_disabled');
    expect(body.missingFields).toEqual([]);
    // 2 (lookup + eligibility) + 1 (INSERT blocked — sem fn_worker_missing_fields para DISABLED)
    expect(mockQuery).toHaveBeenCalledTimes(3);
    // Confirma que WJA upsert nunca foi chamado
    const queryCalls = mockQuery.mock.calls.map((c: unknown[]) => c[0] as string);
    expect(queryCalls.some(q => q.includes('worker_job_applications'))).toBe(false);
  });

  it('returns 403 when worker row disappears between progress and eligibility (race)', async () => {
    mockWorkerFound('w-1');
    mockQuery.mockResolvedValueOnce({ rows: [] }); // SELECT status returns nothing
    // worker_not_found: fn_worker_missing_fields retorna ["worker_not_found"] → sem expand query
    mockQuery.mockResolvedValueOnce({ rows: [{ missing: '["worker_not_found"]' }] });
    mockQuery.mockResolvedValueOnce({ rowCount: 1 }); // INSERT

    const [req, res] = mockReqRes({ jobPostingId: 'jp-1', channel: 'whatsapp' }, 'uid-1');
    await controller.trackChannel(req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    const body = (res.json as jest.Mock).mock.calls[0][0];
    expect(body.reason).toBe('worker_not_found');
    expect(body.missingFields).toEqual(['worker_not_found']);
  });

  it('403 com worker_documents expandido: AT faltando at_certificate → doc_at_certificate no body', async () => {
    mockWorkerFound('w-1');
    mockWorkerEligible('INCOMPLETE_REGISTER');
    // fn_worker_missing_fields retorna worker_documents → expand query será feita
    mockQuery.mockResolvedValueOnce({ rows: [{ missing: '["worker_documents"]' }] }); // fn
    mockQuery.mockResolvedValueOnce({ rowCount: 1 });                                  // INSERT
    // expand query: AT com at_certificate faltando
    mockQuery.mockResolvedValueOnce({ rows: [{
      profession: 'AT',
      resume_cv_url: 'url',
      identity_document_url: 'url',
      criminal_record_url: 'url',
      at_certificate_url: null,
    }] });

    const [req, res] = mockReqRes({ jobPostingId: 'jp-1', channel: 'facebook' }, 'uid-1');
    await controller.trackChannel(req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    const body = (res.json as jest.Mock).mock.calls[0][0];
    expect(body.missingFields).toEqual(['doc_at_certificate']);
    expect(body.missingFields).not.toContain('worker_documents');
  });

  it('403 com CUIDADOR sem DNI → doc_identity_document e sem doc_at_certificate', async () => {
    mockWorkerFound('w-1');
    mockWorkerEligible('INCOMPLETE_REGISTER');
    mockQuery.mockResolvedValueOnce({ rows: [{ missing: '["worker_documents"]' }] });
    mockQuery.mockResolvedValueOnce({ rowCount: 1 });
    mockQuery.mockResolvedValueOnce({ rows: [{
      profession: 'CAREGIVER',
      resume_cv_url: null,
      identity_document_url: null,
      criminal_record_url: 'url',
      at_certificate_url: null,
    }] });

    const [req, res] = mockReqRes({ jobPostingId: 'jp-1', channel: 'facebook' }, 'uid-1');
    await controller.trackChannel(req, res);

    const body = (res.json as jest.Mock).mock.calls[0][0];
    expect(body.missingFields).toEqual(['doc_identity_document']);
    expect(body.missingFields).not.toContain('doc_at_certificate');
    expect(body.missingFields).not.toContain('doc_resume_cv');
  });

  it('403 com profession NULL → trata como AT (resume_cv + at_certificate obrigatórios)', async () => {
    mockWorkerFound('w-1');
    mockWorkerEligible('INCOMPLETE_REGISTER');
    mockQuery.mockResolvedValueOnce({ rows: [{ missing: '["worker_documents"]' }] });
    mockQuery.mockResolvedValueOnce({ rowCount: 1 });
    mockQuery.mockResolvedValueOnce({ rows: [{
      profession: null,
      resume_cv_url: null,
      identity_document_url: 'url',
      criminal_record_url: 'url',
      at_certificate_url: null,
    }] });

    const [req, res] = mockReqRes({ jobPostingId: 'jp-1', channel: 'facebook' }, 'uid-1');
    await controller.trackChannel(req, res);

    const body = (res.json as jest.Mock).mock.calls[0][0];
    expect(body.missingFields).toContain('doc_resume_cv');
    expect(body.missingFields).toContain('doc_at_certificate');
    expect(body.missingFields).not.toContain('doc_identity_document');
  });

  it('403 com title_certificate + worker_documents: ambos aparecem corretamente expandidos', async () => {
    mockWorkerFound('w-1');
    mockWorkerEligible('INCOMPLETE_REGISTER');
    mockQuery.mockResolvedValueOnce({ rows: [{ missing: '["title_certificate","worker_documents"]' }] });
    mockQuery.mockResolvedValueOnce({ rowCount: 1 });
    mockQuery.mockResolvedValueOnce({ rows: [{
      profession: 'AT',
      resume_cv_url: null,
      identity_document_url: 'url',
      criminal_record_url: 'url',
      at_certificate_url: 'url',
    }] });

    const [req, res] = mockReqRes({ jobPostingId: 'jp-1', channel: 'facebook' }, 'uid-1');
    await controller.trackChannel(req, res);

    const body = (res.json as jest.Mock).mock.calls[0][0];
    expect(body.missingFields).toContain('title_certificate');
    expect(body.missingFields).toContain('doc_resume_cv');
    expect(body.missingFields).not.toContain('worker_documents');
  });

  // ── Error handling ─────────────────────────────────────────────────────

  it('returns 500 on DB error with Error instance', async () => {
    mockWorkerFound('w-1');
    mockQuery.mockRejectedValueOnce(new Error('DB down'));

    const [req, res] = mockReqRes({ jobPostingId: 'jp-1', channel: 'whatsapp' }, 'uid-1');
    await controller.trackChannel(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect((res.json as jest.Mock).mock.calls[0][0].error).toBe('DB down');
  });

  it('returns 500 with "Unknown error" for non-Error throws', async () => {
    mockWorkerFound('w-1');
    mockQuery.mockRejectedValueOnce('string-error');

    const [req, res] = mockReqRes({ jobPostingId: 'jp-1', channel: 'linkedin' }, 'uid-1');
    await controller.trackChannel(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect((res.json as jest.Mock).mock.calls[0][0].error).toBe('Unknown error');
  });
});
