/**
 * MessagingController.test.ts
 *
 * Unit tests for MessagingController.sendVacancyMatch:
 * - REGISTERED worker → ar_vacancy_match_complete, 200
 * - INCOMPLETE_REGISTER worker → ar_vacancy_match_incomplete, 200
 * - DISABLED worker → 422 WORKER_STATUS_INVALID
 * - Worker sem telefone → 422
 * - Worker inexistente → 404
 * - messaged_at atualizado em worker_job_applications (best-effort)
 * - log inserido em whatsapp_bulk_dispatch_logs com source='individual'
 *
 * Also tests sendDirect: source='individual' + triggered_by prefix 'admin:'
 */

import { Request, Response } from 'express';
import { MessagingController } from '../MessagingController';

// ── Shared mocks ──────────────────────────────────────────────────────────────

jest.mock('@shared/database/DatabaseConnection', () => ({
  DatabaseConnection: {
    getInstance: jest.fn().mockReturnValue({
      getPool: jest.fn().mockReturnValue(null), // overridden per test via mockDb
    }),
  },
}));

jest.mock('@shared/security/KMSEncryptionService', () => ({
  KMSEncryptionService: jest.fn().mockImplementation(() => ({
    decrypt: jest.fn().mockResolvedValue('+5511987654321'),
  })),
}));

jest.mock('@modules/identity', () => ({
  AuthMiddleware: {
    getAuthContext: jest.fn().mockReturnValue({
      principal: { id: 'user-abc-123', type: 'admin', roles: ['admin'] },
    }),
  },
}));

jest.mock('@shared/logging', () => ({
  logger: {
    warn: jest.fn(),
    info: jest.fn(),
    error: jest.fn(),
    child: jest.fn().mockReturnThis(),
  },
  reportError: jest.fn(),
}));

// Mock BuildVacancyMatchVariablesUseCase so we don't need a real DB in unit tests
jest.mock('../../../application/BuildVacancyMatchVariablesUseCase', () => ({
  BuildVacancyMatchVariablesUseCase: jest.fn().mockImplementation(() => ({
    execute: jest.fn().mockResolvedValue({
      worker_name: 'João',
      patient_zone: 'Palermo',
      vacancy_url: 'https://app.enlite.health/vacantes/job-1',
    }),
  })),
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

function mockRes() {
  return {
    status: jest.fn().mockReturnThis(),
    json:   jest.fn().mockReturnThis(),
  } as unknown as Response;
}

function makeReq(body: Record<string, unknown>): Request {
  return { body } as unknown as Request;
}

/**
 * Enfileira as 5 respostas do assertVacancyInviteAllowed no cenário "tudo
 * liberado" (opt-out=false, cooldown=false, idempotência=false, unanswered=0,
 * hasEngaged=false), na ordem em que o guard as consulta. Deve ser chamado
 * logo APÓS o mock do SELECT do worker e ANTES dos mocks de UPDATE/INSERT.
 */
function queueGuardClear(q: jest.Mock): void {
  q.mockResolvedValueOnce({ rows: [{ exists: false }] }) // opt-out
    .mockResolvedValueOnce({ rows: [{ exists: false }] }) // cooldown
    .mockResolvedValueOnce({ rows: [{ exists: false }] }) // idempotência
    .mockResolvedValueOnce({ rows: [{ n: 0 }] }) // unanswered count
    .mockResolvedValueOnce({ rows: [{ exists: false }] }); // hasEngaged
}

// ── sendVacancyMatch tests ────────────────────────────────────────────────────

describe('MessagingController.sendVacancyMatch', () => {
  let mockQuery: jest.Mock;
  let mockMessaging: { sendWhatsApp: jest.Mock };
  let mockTemplateRepo: { findAll: jest.Mock; upsert: jest.Mock; deactivate: jest.Mock };
  let controller: MessagingController;

  const successResult = {
    isFailure: false,
    isSuccess: true,
    getValue: () => ({ externalId: 'SM-twilio-sid', to: '+5511987654321', status: 'queued' }),
  };

  beforeEach(() => {
    jest.clearAllMocks();

    mockQuery = jest.fn();

    const { DatabaseConnection } = jest.requireMock('@shared/database/DatabaseConnection');
    DatabaseConnection.getInstance.mockReturnValue({ getPool: () => ({ query: mockQuery }) });

    mockMessaging = {
      sendWhatsApp: jest.fn().mockResolvedValue(successResult),
    };

    mockTemplateRepo = {
      findAll: jest.fn(),
      upsert:  jest.fn(),
      deactivate: jest.fn(),
    };

    controller = new MessagingController(
      mockMessaging as any,
      mockTemplateRepo as any,
    );
    (controller as any).db = { query: mockQuery };
  });

  it('REGISTERED worker → envia ar_vacancy_match_complete, retorna 200 com templateSlug', async () => {
    // SELECT status + phone
    mockQuery.mockResolvedValueOnce({ rows: [{ status: 'REGISTERED', whatsapp_phone_encrypted: null, phone: '+5511987654321' }] });
    queueGuardClear(mockQuery);
    mockQuery
      // UPDATE messaged_at
      .mockResolvedValueOnce({ rows: [] })
      // INSERT log
      .mockResolvedValueOnce({ rows: [] });

    const req = makeReq({ workerId: 'w-1', jobPostingId: 'job-1' });
    const res = mockRes();

    await controller.sendVacancyMatch(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    const jsonArg = (res.json as jest.Mock).mock.calls[0][0];
    expect(jsonArg.success).toBe(true);
    expect(jsonArg.data.templateSlug).toBe('ar_vacancy_match_complete');

    expect(mockMessaging.sendWhatsApp).toHaveBeenCalledWith(
      expect.objectContaining({ templateSlug: 'ar_vacancy_match_complete' }),
    );
  });

  it('INCOMPLETE_REGISTER worker → envia ar_vacancy_match_incomplete, retorna 200 com templateSlug', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ status: 'INCOMPLETE_REGISTER', whatsapp_phone_encrypted: null, phone: '+5511987654321' }] });
    queueGuardClear(mockQuery);
    mockQuery
      .mockResolvedValueOnce({ rows: [] }) // UPDATE messaged_at
      .mockResolvedValueOnce({ rows: [] }); // INSERT log

    const req = makeReq({ workerId: 'w-2', jobPostingId: 'job-1' });
    const res = mockRes();

    await controller.sendVacancyMatch(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    const jsonArg = (res.json as jest.Mock).mock.calls[0][0];
    expect(jsonArg.data.templateSlug).toBe('ar_vacancy_match_incomplete');
  });

  it('DISABLED worker → 422 com error=WORKER_STATUS_INVALID', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ status: 'DISABLED', whatsapp_phone_encrypted: null, phone: '+5511987654321' }],
    });

    const req = makeReq({ workerId: 'w-3', jobPostingId: 'job-1' });
    const res = mockRes();

    await controller.sendVacancyMatch(req, res);

    expect(res.status).toHaveBeenCalledWith(422);
    const jsonArg = (res.json as jest.Mock).mock.calls[0][0];
    expect(jsonArg.error).toBe('WORKER_STATUS_INVALID');
    expect(jsonArg.detail).toContain('DISABLED');
    expect(mockMessaging.sendWhatsApp).not.toHaveBeenCalled();
  });

  it('Worker inexistente → 404', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const req = makeReq({ workerId: 'w-nonexistent', jobPostingId: 'job-1' });
    const res = mockRes();

    await controller.sendVacancyMatch(req, res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect((res.json as jest.Mock).mock.calls[0][0]).toEqual({ error: 'Worker não encontrado' });
    expect(mockMessaging.sendWhatsApp).not.toHaveBeenCalled();
  });

  it('Worker sem telefone → 422', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ status: 'REGISTERED', whatsapp_phone_encrypted: null, phone: null }],
    });
    queueGuardClear(mockQuery); // guard passa; a barreira aqui é a falta de telefone

    // Decrypt returns null for encrypted phone (simulate no whatsapp_phone_encrypted either)
    const { KMSEncryptionService } = jest.requireMock('@shared/security/KMSEncryptionService');
    KMSEncryptionService.mockImplementation(() => ({ decrypt: jest.fn().mockResolvedValue(null) }));
    (controller as any).encryptionService = { decrypt: jest.fn().mockResolvedValue(null) };

    const req = makeReq({ workerId: 'w-4', jobPostingId: 'job-1' });
    const res = mockRes();

    await controller.sendVacancyMatch(req, res);

    expect(res.status).toHaveBeenCalledWith(422);
    expect((res.json as jest.Mock).mock.calls[0][0]).toEqual({
      error: 'Worker não possui número de telefone cadastrado',
    });
    expect(mockMessaging.sendWhatsApp).not.toHaveBeenCalled();
  });

  it('messaged_at atualizado em worker_job_applications após envio com sucesso', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ status: 'REGISTERED', whatsapp_phone_encrypted: null, phone: '+5511987654321' }] });
    queueGuardClear(mockQuery);
    mockQuery
      .mockResolvedValueOnce({ rows: [] }) // UPDATE messaged_at
      .mockResolvedValueOnce({ rows: [] }); // INSERT log

    const req = makeReq({ workerId: 'w-1', jobPostingId: 'job-1' });
    const res = mockRes();

    await controller.sendVacancyMatch(req, res);

    expect(res.status).toHaveBeenCalledWith(200);

    // SELECT(0) + guard(1..5) + UPDATE(6) + INSERT(7)
    const updateCall = mockQuery.mock.calls[6];
    expect(updateCall[0]).toContain('worker_job_applications');
    expect(updateCall[0]).toContain('messaged_at');
    expect(updateCall[1]).toEqual(['w-1', 'job-1']);
  });

  it('worker com messaging_channel=periskope → sendWhatsApp recebe channel=periskope', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ status: 'REGISTERED', whatsapp_phone_encrypted: null, phone: '+5511987654321', messaging_channel: 'periskope' }],
    });
    queueGuardClear(mockQuery);
    mockQuery
      .mockResolvedValueOnce({ rows: [] }) // UPDATE messaged_at
      .mockResolvedValueOnce({ rows: [] }); // INSERT log

    const req = makeReq({ workerId: 'w-periskope', jobPostingId: 'job-1' });
    const res = mockRes();

    await controller.sendVacancyMatch(req, res);

    expect(mockMessaging.sendWhatsApp).toHaveBeenCalledWith(
      expect.objectContaining({ channel: 'periskope' }),
    );
  });

  it('worker sem messaging_channel na row (default) → sendWhatsApp recebe channel=twilio', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ status: 'REGISTERED', whatsapp_phone_encrypted: null, phone: '+5511987654321' }] });
    queueGuardClear(mockQuery);
    mockQuery
      .mockResolvedValueOnce({ rows: [] }) // UPDATE messaged_at
      .mockResolvedValueOnce({ rows: [] }); // INSERT log

    const req = makeReq({ workerId: 'w-1', jobPostingId: 'job-1' });
    const res = mockRes();

    await controller.sendVacancyMatch(req, res);

    expect(mockMessaging.sendWhatsApp).toHaveBeenCalledWith(
      expect.objectContaining({ channel: 'twilio' }),
    );
  });

  it('SELECT de sendVacancyMatch inclui messaging_channel', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ status: 'REGISTERED', whatsapp_phone_encrypted: null, phone: '+5511987654321' }] });
    queueGuardClear(mockQuery);
    mockQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    const req = makeReq({ workerId: 'w-1', jobPostingId: 'job-1' });
    const res = mockRes();
    await controller.sendVacancyMatch(req, res);

    const selectSql = mockQuery.mock.calls[0][0] as string;
    expect(selectSql).toContain('messaging_channel');
  });

  it('log inserido em whatsapp_bulk_dispatch_logs com source=individual', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ status: 'REGISTERED', whatsapp_phone_encrypted: null, phone: '+5511987654321' }] });
    queueGuardClear(mockQuery);
    mockQuery
      .mockResolvedValueOnce({ rows: [] }) // UPDATE messaged_at
      .mockResolvedValueOnce({ rows: [] }); // INSERT log

    const req = makeReq({ workerId: 'w-1', jobPostingId: 'job-1' });
    const res = mockRes();

    await controller.sendVacancyMatch(req, res);

    // SELECT(0) + guard(1..5) + UPDATE(6) + INSERT(7)
    const insertCall = mockQuery.mock.calls[7];
    expect(insertCall[0]).toContain('whatsapp_bulk_dispatch_logs');
    expect(insertCall[0]).toContain("'individual'");
    expect(insertCall[1][0]).toBe('w-1');                 // worker_id
    expect(insertCall[1][1]).toBe('job-1');               // job_posting_id
    expect(insertCall[1][2]).toBe('admin:user-abc-123');  // triggered_by
    expect(insertCall[1][4]).toBe('ar_vacancy_match_complete'); // template_slug
    expect(insertCall[1][5]).toBe('SM-twilio-sid');       // twilio_sid
  });

  it('falha de Twilio → 502, sem log inserido', async () => {
    mockMessaging.sendWhatsApp.mockResolvedValueOnce({
      isFailure: true,
      isSuccess: false,
      error: 'Twilio not configured',
    });

    mockQuery.mockResolvedValueOnce({
      rows: [{ status: 'REGISTERED', whatsapp_phone_encrypted: null, phone: '+5511987654321' }],
    });
    queueGuardClear(mockQuery); // guard passa; a falha aqui é do Twilio

    const req = makeReq({ workerId: 'w-1', jobPostingId: 'job-1' });
    const res = mockRes();

    await controller.sendVacancyMatch(req, res);

    expect(res.status).toHaveBeenCalledWith(502);
    // SELECT(1) + guard(5) = 6 queries; sem UPDATE nem INSERT após falha do Twilio
    expect(mockQuery).toHaveBeenCalledTimes(6);
  });

  it('body incompleto (sem jobPostingId) → 400', async () => {
    const req = makeReq({ workerId: 'w-1' });
    const res = mockRes();

    await controller.sendVacancyMatch(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockQuery).not.toHaveBeenCalled();
  });
});

// ── sendDirect tests ──────────────────────────────────────────────────────────

describe('MessagingController.sendDirect — source=individual + admin: prefix', () => {
  let mockQuery: jest.Mock;
  let mockMessaging: { sendWhatsApp: jest.Mock };
  let controller: MessagingController;

  beforeEach(() => {
    jest.clearAllMocks();

    mockQuery = jest.fn();

    const { DatabaseConnection } = jest.requireMock('@shared/database/DatabaseConnection');
    DatabaseConnection.getInstance.mockReturnValue({ getPool: () => ({ query: mockQuery }) });

    mockMessaging = {
      sendWhatsApp: jest.fn().mockResolvedValue({
        isFailure: false,
        isSuccess: true,
        getValue: () => ({ externalId: 'SM-direct-sid', to: '+5511999888777', status: 'queued' }),
      }),
    };

    controller = new MessagingController(mockMessaging as any, {} as any);
    (controller as any).db = { query: mockQuery };
  });

  it('inserts log with source="individual" and triggered_by "admin:{uid}"', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] }); // INSERT log

    const req = makeReq({ to: '+5511999888777', templateSlug: 'talent_search_welcome' });
    const res = mockRes();

    await controller.sendDirect(req, res);

    expect(res.status).toHaveBeenCalledWith(200);

    const insertCall = mockQuery.mock.calls[0];
    expect(insertCall[0]).toContain('whatsapp_bulk_dispatch_logs');
    expect(insertCall[0]).toContain("'individual'");
    expect(insertCall[1][0]).toBe('admin:user-abc-123'); // triggered_by with prefix
  });
});
