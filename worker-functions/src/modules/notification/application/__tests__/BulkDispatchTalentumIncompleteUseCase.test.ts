/**
 * BulkDispatchTalentumIncompleteUseCase.test.ts
 *
 * Testa o use case de lembrete para workers com prescreening Talentum
 * em INITIATED/IN_PROGRESS há >5 dias.
 *
 * Cenários:
 * 1. 0 workers retornados → resultado com total=0, sent=0, errors=0
 * 2. 1 worker retornado → INSERT lock + sendWhatsApp + UPDATE state + INSERT log (status sent)
 * 3. messaging falha → error count++ + UPDATE state 'failed' + INSERT log com status='error'
 * 4. lock já adquirido (INSERT retorna 0 rows) → skip sem chamar sendWhatsApp
 * 5. log INSERT falha → não bloqueia o fluxo (non-fatal)
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

// Mock do TokenService para não precisar de KMS/banco real.
// resolveVariables simula a tradução tk_xxx → valor plaintext.
jest.mock('../../infrastructure/TokenService', () => ({
  TokenService: jest.fn().mockImplementation(() => ({
    generate: jest.fn().mockResolvedValue('tk_abc123def456'),
    resolveVariables: jest.fn().mockImplementation(async (vars: Record<string, string>) => {
      const resolved: Record<string, string> = {};
      for (const [k, v] of Object.entries(vars)) {
        resolved[k] = v?.startsWith('tk_') ? 'João Silva' : v;
      }
      return resolved;
    }),
  })),
}));

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

/**
 * Cria um Pool mock com sequência de respostas configurável.
 * Posições padrão por worker (quando lock é adquirido com sucesso):
 *   0: SELECT workers (eligibility query)
 *   1: INSERT worker_reminder_state (lock) → rows: [{worker_id}]
 *   2: UPDATE worker_reminder_state (status)
 *   3: INSERT whatsapp_bulk_dispatch_logs
 */
function makeDbSequence(responses: Array<{ rows: unknown[] } | Error>): jest.Mocked<Pool> {
  const mockQuery = jest.fn();
  responses.forEach(resp => {
    if (resp instanceof Error) {
      mockQuery.mockRejectedValueOnce(resp);
    } else {
      mockQuery.mockResolvedValueOnce(resp);
    }
  });
  return { query: mockQuery } as unknown as jest.Mocked<Pool>;
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
      const db = makeDbSequence([{ rows: [] }]);
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
    it('adquire lock, chama sendWhatsApp, atualiza state e grava log', async () => {
      const worker = { worker_id: 'w-uuid-1', phone: '+5511999990001' };
      const db = makeDbSequence([
        { rows: [worker] },                     // SELECT eligibility
        { rows: [{ worker_id: worker.worker_id }] }, // INSERT lock → adquirido
        { rows: [] },                            // UPDATE state
        { rows: [] },                            // INSERT log
      ]);

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
        variables: { worker_name: 'João Silva' },
      });

      const calls = (db.query as jest.Mock).mock.calls as Array<[string, ...unknown[]]>;

      // Verifica INSERT lock
      const lockCall = calls.find(([sql]) => sql.includes('INSERT INTO worker_reminder_state'));
      expect(lockCall).toBeDefined();
      expect(lockCall![1]).toContain(worker.worker_id);
      expect(lockCall![1]).toContain('talentum_incomplete_reminder');

      // Verifica UPDATE state com 'sent'
      const updateCall = calls.find(([sql]) => sql.includes('UPDATE worker_reminder_state'));
      expect(updateCall).toBeDefined();
      expect(updateCall![1]).toContain('sent');

      // Verifica INSERT log com status='sent'
      const insertLogCall = calls.find(([sql]) => sql.includes('INSERT INTO whatsapp_bulk_dispatch_logs'));
      expect(insertLogCall).toBeDefined();
      const logParams = insertLogCall![1] as unknown[];
      expect(logParams[3]).toBe('talentum_incomplete_reminder'); // template_slug
      expect(logParams[4]).toBe('sent');                         // status
      expect(logParams[5]).toBe('SM_success_1');                 // twilio_sid
    });
  });

  describe('execute — messaging falha', () => {
    it('incrementa errors, atualiza state como failed e grava log com status error', async () => {
      const worker = { worker_id: 'w-uuid-2', phone: '+5511999990002' };
      const db = makeDbSequence([
        { rows: [worker] },
        { rows: [{ worker_id: worker.worker_id }] }, // lock adquirido
        { rows: [] },                                 // UPDATE state
        { rows: [] },                                 // INSERT log
      ]);

      const messaging = makeMessaging(false);

      const useCase = new BulkDispatchTalentumIncompleteUseCase(db, messaging);
      const result = await useCase.execute('scheduler');

      expect(result.total).toBe(1);
      expect(result.sent).toBe(0);
      expect(result.errors).toBe(1);

      const calls = (db.query as jest.Mock).mock.calls as Array<[string, ...unknown[]]>;

      // UPDATE state deve ser 'failed'
      const updateCall = calls.find(([sql]) => sql.includes('UPDATE worker_reminder_state'));
      expect(updateCall).toBeDefined();
      expect(updateCall![1]).toContain('failed');

      // INSERT log com status='error'
      const insertLogCall = calls.find(([sql]) => sql.includes('INSERT INTO whatsapp_bulk_dispatch_logs'));
      expect(insertLogCall).toBeDefined();
      const logParams = insertLogCall![1] as unknown[];
      expect(logParams[4]).toBe('error'); // status
      expect(logParams[5]).toBeNull();    // twilio_sid null on error
      expect(logParams[6]).toBe('Twilio error'); // error_message
    });
  });

  describe('execute — slot já adquirido por outro processo', () => {
    it('skip sem chamar sendWhatsApp quando INSERT lock retorna 0 rows', async () => {
      const worker = { worker_id: 'w-uuid-3', phone: '+5511999990003' };
      const db = makeDbSequence([
        { rows: [worker] },  // SELECT eligibility
        { rows: [] },        // INSERT lock → 0 rows = já adquirido por outro processo
      ]);

      const messaging = makeMessaging(true);

      const useCase = new BulkDispatchTalentumIncompleteUseCase(db, messaging);
      const result = await useCase.execute('scheduler');

      expect(result.total).toBe(1);
      expect(result.sent).toBe(0);
      expect(result.errors).toBe(0);

      // Não deve ter chamado sendWhatsApp
      expect(messaging.sendWhatsApp).not.toHaveBeenCalled();

      // Não deve ter chamado UPDATE nem INSERT log (pulou o worker)
      const calls = (db.query as jest.Mock).mock.calls as Array<[string, ...unknown[]]>;
      const updateCall = calls.find(([sql]) => sql.includes('UPDATE worker_reminder_state'));
      expect(updateCall).toBeUndefined();
      const insertLogCall = calls.find(([sql]) => sql.includes('INSERT INTO whatsapp_bulk_dispatch_logs'));
      expect(insertLogCall).toBeUndefined();
    });
  });

  describe('execute — falha no INSERT de log', () => {
    it('não bloqueia o fluxo e continua contabilizando sent', async () => {
      const worker = { worker_id: 'w-uuid-4', phone: '+5511999990004' };
      const db = makeDbSequence([
        { rows: [worker] },
        { rows: [{ worker_id: worker.worker_id }] }, // lock adquirido
        { rows: [] },                                 // UPDATE state
        new Error('DB connection lost'),              // INSERT log falha
      ]);

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
      const db1 = makeDbSequence([{ rows: [] }]);
      const db2 = makeDbSequence([{ rows: [] }]);
      const messaging = makeMessaging();

      const useCase1 = new BulkDispatchTalentumIncompleteUseCase(db1, messaging);
      const useCase2 = new BulkDispatchTalentumIncompleteUseCase(db2, messaging);

      const r1 = await useCase1.execute('scheduler');
      const r2 = await useCase2.execute('scheduler');

      expect(r1.batchId).not.toBe(r2.batchId);
    });
  });
});
