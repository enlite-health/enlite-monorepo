/**
 * BulkDispatchTalentumIncompleteUseCase.test.ts
 *
 * Testa o use case de lembrete para workers com prescreening Talentum
 * em INITIATED/IN_PROGRESS há >5 dias.
 *
 * Cenários:
 * 1. 0 workers retornados → resultado com total=0, sent=0, errors=0
 * 2. 1 worker retornado → 1 sendWhatsApp + 1 INSERT em log (status sent)
 * 3. messaging falha → error count++ + INSERT com status='error'
 * 4. log INSERT falha → não bloqueia o fluxo (non-fatal)
 */

import { BulkDispatchTalentumIncompleteUseCase } from '../BulkDispatchTalentumIncompleteUseCase';
import { IMessagingService } from '../../domain/IMessagingService';
import { Result } from '@shared/utils/Result';
import { Pool } from 'pg';

// Silencia logs durante os testes
jest.mock('@shared/logging', () => ({
  logger: {
    child: jest.fn().mockReturnValue({
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    }),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
  reportError: jest.fn(),
}));

// Mock do TokenService para não precisar de KMS/banco real
jest.mock('../../infrastructure/TokenService', () => ({
  TokenService: jest.fn().mockImplementation(() => ({
    generate: jest.fn().mockResolvedValue('tk_abc123def456'),
  })),
}));

function makeDb(rows: Array<{ worker_id: string; phone: string }> = []): jest.Mocked<Pool> {
  return {
    query: jest.fn().mockResolvedValue({ rows }),
  } as unknown as jest.Mocked<Pool>;
}

function makeMessaging(
  success = true,
  externalId = 'SM123',
): jest.Mocked<IMessagingService> {
  return {
    sendWhatsApp: jest.fn().mockResolvedValue(
      success
        ? Result.ok({ externalId, status: 'queued', to: '+5511999990000' })
        : Result.fail('Twilio error'),
    ),
    sendWithContentSid: jest.fn(),
  } as unknown as jest.Mocked<IMessagingService>;
}

describe('BulkDispatchTalentumIncompleteUseCase', () => {
  beforeEach(() => {
    process.env.BULK_DISPATCH_DELAY_MS = '0';
  });

  afterEach(() => {
    delete process.env.BULK_DISPATCH_DELAY_MS;
    jest.clearAllMocks();
  });

  describe('execute — 0 workers elegíveis', () => {
    it('retorna total=0, sent=0, errors=0 sem chamar sendWhatsApp', async () => {
      const db = makeDb([]);
      const messaging = makeMessaging();

      const useCase = new BulkDispatchTalentumIncompleteUseCase(db, messaging);
      const result = await useCase.execute('scheduler');

      expect(result.total).toBe(0);
      expect(result.sent).toBe(0);
      expect(result.errors).toBe(0);
      expect(result.batchId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      );
      expect(messaging.sendWhatsApp).not.toHaveBeenCalled();
    });
  });

  describe('execute — 1 worker elegível, envio bem-sucedido', () => {
    it('chama sendWhatsApp 1x e grava log com status sent', async () => {
      const worker = { worker_id: 'w-uuid-1', phone: '+5511999990001' };
      // Primeiro query retorna o worker; segundo (INSERT log) retorna vazio
      const db = makeDb([worker]);
      (db.query as jest.Mock)
        .mockResolvedValueOnce({ rows: [worker] }) // SELECT workers
        .mockResolvedValueOnce({ rows: [] }); // INSERT log

      const messaging = makeMessaging(true, 'SM_success_1');

      const useCase = new BulkDispatchTalentumIncompleteUseCase(db, messaging);
      const result = await useCase.execute('scheduler');

      expect(result.total).toBe(1);
      expect(result.sent).toBe(1);
      expect(result.errors).toBe(0);

      expect(messaging.sendWhatsApp).toHaveBeenCalledTimes(1);
      expect(messaging.sendWhatsApp).toHaveBeenCalledWith({
        to: worker.phone,
        templateSlug: 'talentum_incomplete_reminder',
        variables: { worker_name: 'tk_abc123def456' },
      });

      // Verifica que INSERT de log foi chamado com status='sent'
      const insertCall = (db.query as jest.Mock).mock.calls.find(
        (call: unknown[]) => typeof call[0] === 'string' && (call[0] as string).includes('INSERT INTO whatsapp_bulk_dispatch_logs'),
      );
      expect(insertCall).toBeDefined();
      const params = insertCall![1] as unknown[];
      expect(params[3]).toBe('talentum_incomplete_reminder'); // template_slug
      expect(params[4]).toBe('sent'); // status
      expect(params[5]).toBe('SM_success_1'); // twilio_sid
    });
  });

  describe('execute — messaging falha', () => {
    it('incrementa errors e grava log com status error', async () => {
      const worker = { worker_id: 'w-uuid-2', phone: '+5511999990002' };
      const db = makeDb([worker]);
      (db.query as jest.Mock)
        .mockResolvedValueOnce({ rows: [worker] })
        .mockResolvedValueOnce({ rows: [] });

      const messaging = makeMessaging(false);

      const useCase = new BulkDispatchTalentumIncompleteUseCase(db, messaging);
      const result = await useCase.execute('scheduler');

      expect(result.total).toBe(1);
      expect(result.sent).toBe(0);
      expect(result.errors).toBe(1);

      const insertCall = (db.query as jest.Mock).mock.calls.find(
        (call: unknown[]) => typeof call[0] === 'string' && (call[0] as string).includes('INSERT INTO whatsapp_bulk_dispatch_logs'),
      );
      expect(insertCall).toBeDefined();
      const params = insertCall![1] as unknown[];
      expect(params[4]).toBe('error'); // status
      expect(params[5]).toBeNull(); // twilio_sid null on error
      expect(params[6]).toBe('Twilio error'); // error_message
    });
  });

  describe('execute — falha no INSERT de log', () => {
    it('não bloqueia o fluxo e continua contabilizando sent', async () => {
      const worker = { worker_id: 'w-uuid-3', phone: '+5511999990003' };
      const db = makeDb([worker]);
      (db.query as jest.Mock)
        .mockResolvedValueOnce({ rows: [worker] })
        .mockRejectedValueOnce(new Error('DB connection lost')); // INSERT log falha

      const messaging = makeMessaging(true, 'SM_log_fail');

      const useCase = new BulkDispatchTalentumIncompleteUseCase(db, messaging);
      const result = await useCase.execute('scheduler');

      // Apesar da falha no log, o envio foi contabilizado
      expect(result.total).toBe(1);
      expect(result.sent).toBe(1);
      expect(result.errors).toBe(0);
    });
  });

  describe('execute — batchId é UUID v4 único', () => {
    it('cada execução gera batchId diferente', async () => {
      const db1 = makeDb([]);
      const db2 = makeDb([]);
      const messaging = makeMessaging();

      const useCase1 = new BulkDispatchTalentumIncompleteUseCase(db1, messaging);
      const useCase2 = new BulkDispatchTalentumIncompleteUseCase(db2, messaging);

      const r1 = await useCase1.execute('scheduler');
      const r2 = await useCase2.execute('scheduler');

      expect(r1.batchId).not.toBe(r2.batchId);
    });
  });
});
