/**
 * MessagingController.test.ts
 *
 * Unit tests for MessagingController focusing on Fase 2 behaviour:
 * - sendToWorker inserts whatsapp_bulk_dispatch_logs with source='individual'
 * - sendToWorker log failure is best-effort (does not break 200 response)
 * - sendDirect inserts with source='individual' and triggeredBy prefix 'admin:'
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

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('MessagingController.sendToWorker — source=individual log', () => {
  let mockQuery: jest.Mock;
  let mockMessaging: { sendWhatsApp: jest.Mock };
  let mockTemplateRepo: { findAll: jest.Mock; upsert: jest.Mock; deactivate: jest.Mock };
  let controller: MessagingController;

  beforeEach(() => {
    jest.clearAllMocks();

    mockQuery = jest.fn();

    // Inject mock pool via DatabaseConnection singleton mock
    const { DatabaseConnection } = jest.requireMock('@shared/database/DatabaseConnection');
    DatabaseConnection.getInstance.mockReturnValue({ getPool: () => ({ query: mockQuery }) });

    mockMessaging = {
      sendWhatsApp: jest.fn().mockResolvedValue({
        isFailure: false,
        isSuccess: true,
        getValue: () => ({ externalId: 'SM-twilio-sid', to: '+5511987654321', status: 'queued' }),
      }),
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
    // Replace the pool set in constructor with mockQuery pool
    (controller as any).db = { query: mockQuery };
  });

  it('inserts log with source="individual" and triggered_by="admin:{uid}" after success', async () => {
    mockQuery
      // SELECT worker phone
      .mockResolvedValueOnce({ rows: [{ whatsapp_phone_encrypted: 'enc-phone', phone: null }] })
      // INSERT whatsapp_bulk_dispatch_logs
      .mockResolvedValueOnce({ rows: [] });

    const req = makeReq({ workerId: 'w-1', templateSlug: 'talent_search_welcome' });
    const res = mockRes();

    await controller.sendToWorker(req, res);

    expect(res.status).toHaveBeenCalledWith(200);

    // Verify INSERT call
    const insertCall = mockQuery.mock.calls[1];
    expect(insertCall[0]).toContain('whatsapp_bulk_dispatch_logs');
    expect(insertCall[0]).toContain("'individual'");
    expect(insertCall[1][0]).toBe('w-1');                    // worker_id
    expect(insertCall[1][1]).toBe('admin:user-abc-123');     // triggered_by with prefix
    expect(insertCall[1][4]).toBe('SM-twilio-sid');          // twilio_sid
  });

  it('responds 200 even when the log INSERT fails (best-effort)', async () => {
    const { logger } = jest.requireMock('@shared/logging');

    mockQuery
      // SELECT worker phone
      .mockResolvedValueOnce({ rows: [{ whatsapp_phone_encrypted: null, phone: '+5511987654321' }] })
      // INSERT log throws
      .mockRejectedValueOnce(new Error('DB connection lost'));

    const req = makeReq({ workerId: 'w-1', templateSlug: 'talent_search_welcome' });
    const res = mockRes();

    await controller.sendToWorker(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ workerId: 'w-1' }),
      expect.stringContaining('log individual'),
    );
  });

  it('returns 502 when messaging fails (no log insert attempted)', async () => {
    mockMessaging.sendWhatsApp.mockResolvedValueOnce({
      isFailure: true,
      isSuccess: false,
      error: 'Twilio not configured',
    });

    mockQuery
      // SELECT worker phone
      .mockResolvedValueOnce({ rows: [{ whatsapp_phone_encrypted: null, phone: '+5511987654321' }] });

    const req = makeReq({ workerId: 'w-1', templateSlug: 'talent_search_welcome' });
    const res = mockRes();

    await controller.sendToWorker(req, res);

    expect(res.status).toHaveBeenCalledWith(502);
    // Only 1 query (worker lookup), no INSERT
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });
});

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
