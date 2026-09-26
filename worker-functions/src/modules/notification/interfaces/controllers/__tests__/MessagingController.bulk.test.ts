/**
 * MessagingController.bulk.test.ts
 *
 * Cobre ramos de sendVacancyMatch e sendDirect que MessagingController.test.ts
 * não cobre (arquivo principal já em ~455 linhas — regra de 400 linhas por
 * arquivo, ver CLAUDE.md). Templates/bulkDispatchIncomplete vivem em
 * MessagingController.templates.test.ts (mesmo motivo: este arquivo também
 * passaria de 400 linhas se acumulasse tudo).
 * - sendVacancyMatch: falhas best-effort do UPDATE messaged_at e do INSERT de log,
 *   normalização de erro não-Error, status ausente, guard sem `until`, decrypt de
 *   whatsapp_phone_encrypted, fallback de triggeredBy
 * - sendDirect: validação de body, falha do Twilio (502), falha best-effort do
 *   INSERT de log, normalização de erro não-Error, fallback de triggeredBy
 */

import { Request, Response } from 'express';
import { MessagingController } from '../MessagingController';

// ── Shared mocks ──────────────────────────────────────────────────────────────

jest.mock('@shared/database/DatabaseConnection', () => ({
  DatabaseConnection: {
    getInstance: jest.fn().mockReturnValue({
      getPool: jest.fn().mockReturnValue(null),
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

const mockLoggerWarn = jest.fn();
const mockReportError = jest.fn();
jest.mock('@shared/logging', () => ({
  logger: {
    warn: (...args: unknown[]) => mockLoggerWarn(...args),
    info: jest.fn(),
    error: jest.fn(),
    child: jest.fn().mockReturnThis(),
  },
  reportError: (...args: unknown[]) => mockReportError(...args),
}));

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

function makeReq(body: Record<string, unknown> = {}, extra: Record<string, unknown> = {}): Request {
  return { body, query: {}, params: {}, ...extra } as unknown as Request;
}

function queueGuardClear(q: jest.Mock): void {
  q.mockResolvedValueOnce({ rows: [{ exists: false }] }) // opt-out
    .mockResolvedValueOnce({ rows: [{ exists: false }] }) // cooldown
    .mockResolvedValueOnce({ rows: [{ exists: false }] }) // idempotência
    .mockResolvedValueOnce({ rows: [{ n: 0 }] }) // unanswered count
    .mockResolvedValueOnce({ rows: [{ exists: false }] }); // hasEngaged
}

// ── sendVacancyMatch: falhas best-effort ───────────────────────────────────────

describe('MessagingController.sendVacancyMatch — falhas best-effort (não derrubam o envio)', () => {
  let mockQuery: jest.Mock;
  let mockMessaging: { sendWhatsApp: jest.Mock };
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
    mockMessaging = { sendWhatsApp: jest.fn().mockResolvedValue(successResult) };
    controller = new MessagingController(mockMessaging as any, {} as any);
    (controller as any).db = { query: mockQuery };
  });

  it('UPDATE messaged_at falha → resposta ainda é 200, warn logado', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ status: 'REGISTERED', whatsapp_phone_encrypted: null, phone: '+5511987654321' }] });
    queueGuardClear(mockQuery);
    mockQuery
      .mockRejectedValueOnce(new Error('update boom')) // UPDATE messaged_at falha
      .mockResolvedValueOnce({ rows: [] }); // INSERT log ok

    const res = mockRes();
    await controller.sendVacancyMatch(makeReq({ workerId: 'w-1', jobPostingId: 'job-1' }), res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'update boom', workerId: 'w-1', jobPostingId: 'job-1' }),
      'Falha ao atualizar messaged_at',
    );
  });

  it('INSERT de log falha → resposta ainda é 200, warn + reportError chamados', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ status: 'REGISTERED', whatsapp_phone_encrypted: null, phone: '+5511987654321' }] });
    queueGuardClear(mockQuery);
    mockQuery
      .mockResolvedValueOnce({ rows: [] }) // UPDATE messaged_at ok
      .mockRejectedValueOnce(new Error('insert boom')); // INSERT log falha

    const res = mockRes();
    await controller.sendVacancyMatch(makeReq({ workerId: 'w-1', jobPostingId: 'job-1' }), res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'insert boom', workerId: 'w-1', templateSlug: 'ar_vacancy_match_complete' }),
      'Falha ao gravar log individual',
    );
    expect(mockReportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ source: 'MessagingController.sendVacancyMatch:log', workerId: 'w-1' }),
    );
  });

  it('UPDATE messaged_at rejeita com valor NÃO Error (string) → normalizado via new Error(String(err))', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ status: 'REGISTERED', whatsapp_phone_encrypted: null, phone: '+5511987654321' }] });
    queueGuardClear(mockQuery);
    mockQuery
      .mockRejectedValueOnce('plain-string-rejection') // UPDATE messaged_at falha com string, não Error
      .mockResolvedValueOnce({ rows: [] }); // INSERT log ok

    const res = mockRes();
    await controller.sendVacancyMatch(makeReq({ workerId: 'w-1', jobPostingId: 'job-1' }), res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'plain-string-rejection' }),
      'Falha ao atualizar messaged_at',
    );
  });

  it('INSERT de log rejeita com valor NÃO Error (string) → normalizado via new Error(String(err))', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ status: 'REGISTERED', whatsapp_phone_encrypted: null, phone: '+5511987654321' }] });
    queueGuardClear(mockQuery);
    mockQuery
      .mockResolvedValueOnce({ rows: [] }) // UPDATE messaged_at ok
      .mockRejectedValueOnce('plain-string-rejection'); // INSERT log falha com string, não Error

    const res = mockRes();
    await controller.sendVacancyMatch(makeReq({ workerId: 'w-1', jobPostingId: 'job-1' }), res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'plain-string-rejection' }),
      'Falha ao gravar log individual',
    );
  });

  it('status ausente (null) → 422 com "desconhecido" no detail (?? fallback)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ status: null, whatsapp_phone_encrypted: null, phone: '+5511987654321' }] });

    const res = mockRes();
    await controller.sendVacancyMatch(makeReq({ workerId: 'w-1', jobPostingId: 'job-1' }), res);

    expect(res.status).toHaveBeenCalledWith(422);
    expect((res.json as jest.Mock).mock.calls[0][0]).toEqual(
      expect.objectContaining({ error: 'WORKER_STATUS_INVALID', detail: expect.stringContaining('desconhecido') }),
    );
  });

  it('guard bloqueia SEM `until` (ex.: OPTED_OUT) → 422 sem a chave until no corpo', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ status: 'REGISTERED', whatsapp_phone_encrypted: null, phone: '+5511987654321' }] });
    mockQuery.mockResolvedValueOnce({ rows: [{ exists: true }] }); // opt-out bloqueia

    const res = mockRes();
    await controller.sendVacancyMatch(makeReq({ workerId: 'w-1', jobPostingId: 'job-1' }), res);

    expect(res.status).toHaveBeenCalledWith(422);
    const body = (res.json as jest.Mock).mock.calls[0][0];
    expect(body).toEqual({ error: 'OPTED_OUT', detail: 'Worker pediu para não receber mensagens (opt-out).' });
    expect(body).not.toHaveProperty('until');
  });

  it('whatsapp_phone_encrypted truthy → decripta via KMS e usa o valor decriptado como destino', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ status: 'REGISTERED', whatsapp_phone_encrypted: 'ciphertext-blob', phone: '+5511000000000' }],
    });
    queueGuardClear(mockQuery);
    mockQuery
      .mockResolvedValueOnce({ rows: [] }) // UPDATE messaged_at
      .mockResolvedValueOnce({ rows: [] }); // INSERT log

    const decryptSpy = jest.fn().mockResolvedValue('+5511987654321');
    (controller as any).encryptionService = { decrypt: decryptSpy };

    const res = mockRes();
    await controller.sendVacancyMatch(makeReq({ workerId: 'w-1', jobPostingId: 'job-1' }), res);

    expect(decryptSpy).toHaveBeenCalledWith('ciphertext-blob');
    expect(res.status).toHaveBeenCalledWith(200);
    expect(mockMessaging.sendWhatsApp).toHaveBeenCalledWith(
      expect.objectContaining({ to: '+5511987654321' }),
    );
  });

  it('AuthMiddleware sem principal.id → triggered_by cai no fallback "admin:unknown"', async () => {
    const { AuthMiddleware } = jest.requireMock('@modules/identity');
    AuthMiddleware.getAuthContext.mockReturnValueOnce(undefined);

    mockQuery.mockResolvedValueOnce({ rows: [{ status: 'REGISTERED', whatsapp_phone_encrypted: null, phone: '+5511987654321' }] });
    queueGuardClear(mockQuery);
    mockQuery
      .mockResolvedValueOnce({ rows: [] }) // UPDATE messaged_at
      .mockResolvedValueOnce({ rows: [] }); // INSERT log

    const res = mockRes();
    await controller.sendVacancyMatch(makeReq({ workerId: 'w-1', jobPostingId: 'job-1' }), res);

    // SELECT(0) + guard(1..5) + UPDATE(6) + INSERT(7)
    const insertCall = mockQuery.mock.calls[7];
    expect(insertCall[1][2]).toBe('admin:unknown');
  });
});

// ── sendDirect: ramos não cobertos ─────────────────────────────────────────────

describe('MessagingController.sendDirect — validação, falha Twilio, falha de log', () => {
  let mockQuery: jest.Mock;
  let mockMessaging: { sendWhatsApp: jest.Mock };
  let controller: MessagingController;

  beforeEach(() => {
    jest.clearAllMocks();
    mockQuery = jest.fn();
    const { DatabaseConnection } = jest.requireMock('@shared/database/DatabaseConnection');
    DatabaseConnection.getInstance.mockReturnValue({ getPool: () => ({ query: mockQuery }) });
    mockMessaging = { sendWhatsApp: jest.fn() };
    controller = new MessagingController(mockMessaging as any, {} as any);
    (controller as any).db = { query: mockQuery };
  });

  it('sem "to" → 400, não chama sendWhatsApp', async () => {
    const res = mockRes();
    await controller.sendDirect(makeReq({ templateSlug: 'x' }), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect((res.json as jest.Mock).mock.calls[0][0]).toEqual({ error: 'to e templateSlug são obrigatórios' });
    expect(mockMessaging.sendWhatsApp).not.toHaveBeenCalled();
  });

  it('sem "templateSlug" → 400, não chama sendWhatsApp', async () => {
    const res = mockRes();
    await controller.sendDirect(makeReq({ to: '+5511999888777' }), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect((res.json as jest.Mock).mock.calls[0][0]).toEqual({ error: 'to e templateSlug são obrigatórios' });
  });

  it('templateSlug só com espaços → 400 "templateSlug não pode ser vazio"', async () => {
    const res = mockRes();
    await controller.sendDirect(makeReq({ to: '+5511999888777', templateSlug: '   ' }), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect((res.json as jest.Mock).mock.calls[0][0]).toEqual({ error: 'templateSlug não pode ser vazio' });
    expect(mockMessaging.sendWhatsApp).not.toHaveBeenCalled();
  });

  it('falha do Twilio → 502 com error, sem log inserido', async () => {
    mockMessaging.sendWhatsApp.mockResolvedValueOnce({
      isFailure: true,
      isSuccess: false,
      error: 'Twilio not configured',
    });

    const res = mockRes();
    await controller.sendDirect(makeReq({ to: '+5511999888777', templateSlug: 'x' }), res);

    expect(res.status).toHaveBeenCalledWith(502);
    expect((res.json as jest.Mock).mock.calls[0][0]).toEqual({ error: 'Twilio not configured' });
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('INSERT de log falha → resposta ainda é 200, warn logado (best-effort)', async () => {
    mockMessaging.sendWhatsApp.mockResolvedValueOnce({
      isFailure: false,
      isSuccess: true,
      getValue: () => ({ externalId: 'SM-direct-sid', to: '+5511999888777', status: 'queued' }),
    });
    mockQuery
      .mockResolvedValueOnce({ rows: [] }) // SELECT resolve worker canônico por telefone (auditoria)
      .mockRejectedValueOnce(new Error('log insert boom')); // INSERT whatsapp_bulk_dispatch_logs

    const res = mockRes();
    await controller.sendDirect(makeReq({ to: '+5511999888777', templateSlug: 'x' }), res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'log insert boom' }),
      'MessagingController sendDirect log error',
    );
  });

  it('INSERT de log rejeita com valor NÃO Error (string) → normalizado via new Error(String(err))', async () => {
    mockMessaging.sendWhatsApp.mockResolvedValueOnce({
      isFailure: false,
      isSuccess: true,
      getValue: () => ({ externalId: 'SM-direct-sid', to: '+5511999888777', status: 'queued' }),
    });
    mockQuery
      .mockResolvedValueOnce({ rows: [] }) // SELECT resolve worker canônico por telefone (auditoria)
      .mockRejectedValueOnce('plain-string-rejection'); // INSERT whatsapp_bulk_dispatch_logs

    const res = mockRes();
    await controller.sendDirect(makeReq({ to: '+5511999888777', templateSlug: 'x' }), res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'plain-string-rejection' }),
      'MessagingController sendDirect log error',
    );
  });

  it('AuthMiddleware sem principal.id → triggered_by cai no fallback "admin:unknown"', async () => {
    const { AuthMiddleware } = jest.requireMock('@modules/identity');
    AuthMiddleware.getAuthContext.mockReturnValueOnce(undefined);

    mockMessaging.sendWhatsApp.mockResolvedValueOnce({
      isFailure: false,
      isSuccess: true,
      getValue: () => ({ externalId: 'SM-direct-sid', to: '+5511999888777', status: 'queued' }),
    });
    mockQuery
      .mockResolvedValueOnce({ rows: [] }) // SELECT resolve worker canônico por telefone (auditoria)
      .mockResolvedValueOnce({ rows: [] }); // INSERT whatsapp_bulk_dispatch_logs

    const res = mockRes();
    await controller.sendDirect(makeReq({ to: '+5511999888777', templateSlug: 'x' }), res);

    const insertCall = mockQuery.mock.calls[1];
    expect(insertCall[1][1]).toBe('admin:unknown');
  });
});
