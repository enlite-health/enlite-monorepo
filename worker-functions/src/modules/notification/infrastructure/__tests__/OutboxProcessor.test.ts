/**
 * OutboxProcessor.test.ts
 *
 * Testa processamento event-driven de mensagens da outbox.
 *
 * Cenários:
 * 1. processById() processa uma mensagem individual com sucesso
 * 2. processById() retorna silenciosamente se mensagem não existe
 * 3. processById() retorna silenciosamente se mensagem já foi enviada (idempotente)
 * 4. processById() marca como failed após MAX_ATTEMPTS
 * 5. processBatch() processa múltiplas mensagens pending
 * 6. processBatch() não faz nada quando não há mensagens pending
 * 7. processOne() marca failed quando worker não encontrado
 * 8. processOne() marca failed quando worker sem telefone
 */

import { OutboxProcessor } from '../OutboxProcessor';

// Mock KMSEncryptionService
jest.mock('@shared/security/KMSEncryptionService', () => ({
  KMSEncryptionService: jest.fn().mockImplementation(() => ({
    decrypt: jest.fn().mockResolvedValue('+5491100001111'),
  })),
}));

// Mock TokenService
jest.mock('../TokenService', () => ({
  TokenService: jest.fn().mockImplementation(() => ({
    resolveVariables: jest.fn().mockImplementation((vars: Record<string, string>) => Promise.resolve(vars)),
  })),
}));

// Mock loggingAls, logger and reportError
jest.mock('@shared/logging', () => ({
  loggingAls: {
    run: jest.fn().mockImplementation(
      (_ctx: unknown, fn: () => Promise<void>) => fn(),
    ),
  },
  logger: {
    warn: jest.fn(),
    info: jest.fn(),
    error: jest.fn(),
    child: jest.fn().mockReturnThis(),
  },
  reportError: jest.fn(),
}));

import { loggingAls } from '@shared/logging';

describe('OutboxProcessor', () => {
  let mockMessaging: { sendWhatsApp: jest.Mock };
  let mockQuery: jest.Mock;
  let mockDb: { query: jest.Mock };
  let processor: OutboxProcessor;

  beforeEach(() => {
    mockMessaging = {
      sendWhatsApp: jest.fn().mockResolvedValue({
        isFailure: false,
        getValue: () => ({ externalId: 'twilio-sid-123' }),
      }),
    };
    mockQuery = jest.fn();
    mockDb = { query: mockQuery };
    processor = new OutboxProcessor(mockMessaging as any, mockDb as any);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // ─── processById ─────────────────────────────────────────────────

  describe('processById', () => {
    it('processa uma mensagem individual com sucesso', async () => {
      const outboxRow = {
        id: 'ob-1',
        worker_id: 'w-1',
        template_slug: 'welcome',
        variables: { name: 'Juan' },
        attempts: 0,
        trace_id: 'trace-abc-123',
      };

      mockQuery
        // SELECT outbox row
        .mockResolvedValueOnce({ rows: [outboxRow] })
        // SELECT worker phone + messaging_channel canônico
        .mockResolvedValueOnce({ rows: [{ whatsapp_phone_encrypted: 'enc-phone', phone: null, messaging_channel: 'twilio' }] })
        // UPDATE outbox status = 'sent'
        .mockResolvedValueOnce({ rows: [] })
        // INSERT whatsapp_bulk_dispatch_logs (source='outbox')
        .mockResolvedValueOnce({ rows: [] });

      await processor.processById('ob-1');

      expect(mockMessaging.sendWhatsApp).toHaveBeenCalledWith({
        to: '+5491100001111',
        templateSlug: 'welcome',
        variables: { name: 'Juan' },
        channel: 'twilio',
      });

      // Verifica UPDATE para 'sent'
      const updateCall = mockQuery.mock.calls[2];
      expect(updateCall[0]).toContain("status = 'sent'");
      expect(updateCall[1]).toContain('ob-1');
      expect(updateCall[1]).toContain('twilio');

      // Verifica INSERT de log com source='outbox'
      const logCall = mockQuery.mock.calls[3];
      expect(logCall[0]).toContain('whatsapp_bulk_dispatch_logs');
      expect(logCall[0]).toContain("'outbox'");
      expect(logCall[1][2]).toBe('system:outbox:ob-1');
    });

    it('retorna silenciosamente se mensagem não existe', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      await processor.processById('ob-nonexistent');

      expect(mockMessaging.sendWhatsApp).not.toHaveBeenCalled();
      expect(mockQuery).toHaveBeenCalledTimes(1);
    });

    it('retorna silenciosamente se mensagem já foi enviada (idempotente)', async () => {
      // Query retorna vazio porque WHERE status = 'pending' não encontra mensagem já enviada
      mockQuery.mockResolvedValueOnce({ rows: [] });

      await processor.processById('ob-already-sent');

      expect(mockMessaging.sendWhatsApp).not.toHaveBeenCalled();
    });

    it('injeta trace_id da row no contexto ALS', async () => {
      const outboxRow = {
        id: 'ob-trace',
        worker_id: 'w-trace',
        template_slug: 'tpl',
        variables: {},
        attempts: 0,
        trace_id: 'my-trace-id-xyz',
      };

      mockQuery
        .mockResolvedValueOnce({ rows: [outboxRow] })
        .mockResolvedValueOnce({ rows: [{ whatsapp_phone_encrypted: null, phone: '+54911' }] })
        .mockResolvedValueOnce({ rows: [] })
        // INSERT log (source='outbox')
        .mockResolvedValueOnce({ rows: [] });

      await processor.processById('ob-trace');

      expect(loggingAls.run).toHaveBeenCalledWith(
        expect.objectContaining({ traceId: 'my-trace-id-xyz', workerId: 'w-trace' }),
        expect.any(Function),
      );
    });

    it('gera traceId UUID quando trace_id é null', async () => {
      const outboxRow = {
        id: 'ob-notrace',
        worker_id: 'w-notrace',
        template_slug: 'tpl',
        variables: {},
        attempts: 0,
        trace_id: null,
      };

      mockQuery
        .mockResolvedValueOnce({ rows: [outboxRow] })
        .mockResolvedValueOnce({ rows: [{ whatsapp_phone_encrypted: null, phone: '+54911' }] })
        .mockResolvedValueOnce({ rows: [] })
        // INSERT log (source='outbox')
        .mockResolvedValueOnce({ rows: [] });

      await processor.processById('ob-notrace');

      expect(loggingAls.run).toHaveBeenCalledWith(
        expect.objectContaining({ workerId: 'w-notrace' }),
        expect.any(Function),
      );
      const ctx = (loggingAls.run as jest.Mock).mock.calls[0][0];
      // Should be a UUID (not null/undefined)
      expect(typeof ctx.traceId).toBe('string');
      expect(ctx.traceId.length).toBeGreaterThan(0);
    });

    it('marca como failed após MAX_ATTEMPTS falhas', async () => {
      const outboxRow = {
        id: 'ob-2',
        worker_id: 'w-2',
        template_slug: 'reminder',
        variables: {},
        attempts: 2, // Já tem 2 tentativas, esta será a 3ª (MAX)
        trace_id: null,
      };

      mockQuery
        .mockResolvedValueOnce({ rows: [outboxRow] })
        .mockResolvedValueOnce({ rows: [{ whatsapp_phone_encrypted: null, phone: '+5491100002222' }] })
        .mockResolvedValueOnce({ rows: [] }) // UPDATE outbox status='failed'
        .mockResolvedValueOnce({ rows: [] }); // INSERT whatsapp_bulk_dispatch_logs status='error'

      mockMessaging.sendWhatsApp.mockResolvedValueOnce({
        isFailure: true,
        error: 'Twilio error',
      });

      await processor.processById('ob-2');

      // Verifica UPDATE com status='failed' (attempts 2+1=3 >= MAX_ATTEMPTS)
      const updateCall = mockQuery.mock.calls[2];
      expect(updateCall[0]).toContain('status = $2');
      expect(updateCall[1][1]).toBe('failed');

      // Verifica INSERT de log com status='error' e source='outbox'
      const logCall = mockQuery.mock.calls[3];
      expect(logCall[0]).toContain('whatsapp_bulk_dispatch_logs');
      expect(logCall[0]).toContain("'error'");
      expect(logCall[0]).toContain("'outbox'");
      expect(logCall[1][2]).toBe('system:outbox:ob-2');
    });
  });

  // ─── processBatch ────────────────────────────────────────────────

  describe('processBatch', () => {
    it('processa múltiplas mensagens pending', async () => {
      const rows = [
        { id: 'ob-10', worker_id: 'w-10', template_slug: 'tpl', variables: {}, attempts: 0, trace_id: 'tid-10' },
        { id: 'ob-11', worker_id: 'w-11', template_slug: 'tpl', variables: {}, attempts: 0, trace_id: null },
      ];

      mockQuery
        // markStalePendingAsFailed (TD-023)
        .mockResolvedValueOnce({ rows: [], rowCount: 0 })
        // fetchPending
        .mockResolvedValueOnce({ rows })
        // processOne row 1: SELECT worker
        .mockResolvedValueOnce({ rows: [{ whatsapp_phone_encrypted: null, phone: '+5491100003333' }] })
        // processOne row 1: UPDATE sent
        .mockResolvedValueOnce({ rows: [] })
        // processOne row 1: INSERT log (source='outbox')
        .mockResolvedValueOnce({ rows: [] })
        // processOne row 2: SELECT worker
        .mockResolvedValueOnce({ rows: [{ whatsapp_phone_encrypted: null, phone: '+5491100004444' }] })
        // processOne row 2: UPDATE sent
        .mockResolvedValueOnce({ rows: [] })
        // processOne row 2: INSERT log (source='outbox')
        .mockResolvedValueOnce({ rows: [] });

      await processor.processBatch();

      expect(mockMessaging.sendWhatsApp).toHaveBeenCalledTimes(2);
    });

    it('não faz nada quando não há mensagens pending', async () => {
      mockQuery
        // markStalePendingAsFailed (TD-023) — 0 rows neutralizadas
        .mockResolvedValueOnce({ rows: [], rowCount: 0 })
        // fetchPending — vazio
        .mockResolvedValueOnce({ rows: [] });

      await processor.processBatch();

      expect(mockMessaging.sendWhatsApp).not.toHaveBeenCalled();
      expect(mockQuery).toHaveBeenCalledTimes(2);
    });

    it('TD-023: loga warn quando markStalePendingAsFailed neutraliza rows velhas', async () => {
      mockQuery
        // markStalePendingAsFailed neutraliza 3 rows
        .mockResolvedValueOnce({ rows: [{ id: 'old-1' }, { id: 'old-2' }, { id: 'old-3' }], rowCount: 3 })
        // fetchPending — vazio (todas as velhas foram marcadas)
        .mockResolvedValueOnce({ rows: [] });

      await processor.processBatch();

      expect(mockMessaging.sendWhatsApp).not.toHaveBeenCalled();
      // Confirma que primeira query é o UPDATE de markStale, segunda é o SELECT de pending
      const calls = mockQuery.mock.calls;
      expect(calls[0][0]).toContain("auto-failed: pending exceeded");
      expect(calls[1][0]).toContain("FROM messaging_outbox");
    });
  });

  // ─── processOne edge cases ───────────────────────────────────────

  describe('processOne edge cases', () => {
    it('marca failed quando worker não encontrado', async () => {
      const outboxRow = {
        id: 'ob-3',
        worker_id: 'w-gone',
        template_slug: 'tpl',
        variables: {},
        attempts: 0,
        trace_id: null,
      };

      mockQuery
        .mockResolvedValueOnce({ rows: [outboxRow] })
        // Worker não encontrado
        .mockResolvedValueOnce({ rows: [] })
        // markFailed
        .mockResolvedValueOnce({ rows: [] });

      await processor.processById('ob-3');

      expect(mockMessaging.sendWhatsApp).not.toHaveBeenCalled();
      const failCall = mockQuery.mock.calls[2];
      expect(failCall[0]).toContain("status = 'failed'");
      expect(failCall[1][1]).toBe('Worker não encontrado');
    });

    it('marca failed quando worker sem telefone', async () => {
      const outboxRow = {
        id: 'ob-4',
        worker_id: 'w-nophone',
        template_slug: 'tpl',
        variables: {},
        attempts: 0,
        trace_id: null,
      };

      mockQuery
        .mockResolvedValueOnce({ rows: [outboxRow] })
        // Worker sem telefone
        .mockResolvedValueOnce({ rows: [{ whatsapp_phone_encrypted: null, phone: null }] })
        // markFailed
        .mockResolvedValueOnce({ rows: [] });

      await processor.processById('ob-4');

      expect(mockMessaging.sendWhatsApp).not.toHaveBeenCalled();
      const failCall = mockQuery.mock.calls[2];
      expect(failCall[0]).toContain("status = 'failed'");
      expect(failCall[1][1]).toBe('Worker sem telefone cadastrado');
    });
  });

  // ─── Verifica que não existem mais start/stop/timer ───────────────

  describe('API surface', () => {
    it('não expõe mais start() nem stop()', () => {
      expect((processor as any).start).toBeUndefined();
      expect((processor as any).stop).toBeUndefined();
      expect((processor as any).timer).toBeUndefined();
    });
  });

  // ─── Roteamento por canal (fundação messaging_channel) ────────────

  describe('canal por worker (roteamento)', () => {
    const baseRow = {
      id: 'ob-ch-1',
      worker_id: 'w-ch-1',
      template_slug: 'tpl',
      variables: {},
      attempts: 0,
      trace_id: null,
    };

    afterEach(() => {
      delete process.env.PERISKOPE_DAILY_CAP;
    });

    it('resolve messaging_channel canônico via LEFT JOIN merged_into_id (SQL)', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [baseRow] })
        .mockResolvedValueOnce({ rows: [{ whatsapp_phone_encrypted: null, phone: '+5491100005555', messaging_channel: 'twilio' }] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] });

      await processor.processById('ob-ch-1');

      const workerSelectCall = mockQuery.mock.calls[1];
      expect(workerSelectCall[0]).toContain('LEFT JOIN workers w2');
      expect(workerSelectCall[0]).toContain('w2.id = w1.merged_into_id');
      expect(workerSelectCall[0]).toContain('COALESCE(w2.messaging_channel, w1.messaging_channel)');
    });

    it('worker canônico está em periskope (via merge) → sendWhatsApp recebe channel=periskope', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [baseRow] })
        .mockResolvedValueOnce({ rows: [{ whatsapp_phone_encrypted: null, phone: '+5491100005555', messaging_channel: 'periskope' }] })
        // COUNT do teto diário (canal periskope)
        .mockResolvedValueOnce({ rows: [{ count: '0' }] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] });

      await processor.processById('ob-ch-1');

      expect(mockMessaging.sendWhatsApp).toHaveBeenCalledWith(
        expect.objectContaining({ channel: 'periskope' }),
      );
    });

    it('grava channel resolvido na UPDATE de sucesso', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [baseRow] })
        .mockResolvedValueOnce({ rows: [{ whatsapp_phone_encrypted: null, phone: '+5491100005555', messaging_channel: 'twilio' }] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] });

      await processor.processById('ob-ch-1');

      const updateCall = mockQuery.mock.calls[2];
      expect(updateCall[0]).toContain('channel');
      expect(updateCall[1]).toContain('twilio');
    });

    it('teto diário Periskope atingido → NÃO envia, NÃO incrementa attempts (fica pending)', async () => {
      process.env.PERISKOPE_DAILY_CAP = '5';
      mockQuery
        .mockResolvedValueOnce({ rows: [baseRow] })
        .mockResolvedValueOnce({ rows: [{ whatsapp_phone_encrypted: null, phone: '+5491100005555', messaging_channel: 'periskope' }] })
        // COUNT >= cap
        .mockResolvedValueOnce({ rows: [{ count: '5' }] });

      await processor.processById('ob-ch-1');

      expect(mockMessaging.sendWhatsApp).not.toHaveBeenCalled();
      // Nenhuma UPDATE em messaging_outbox foi feita (row continua pending, reprocessável)
      expect(mockQuery).toHaveBeenCalledTimes(3);
    });

    it('teto diário ausente (env não setada) → NÃO verifica cap, envia normalmente', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [baseRow] })
        .mockResolvedValueOnce({ rows: [{ whatsapp_phone_encrypted: null, phone: '+5491100005555', messaging_channel: 'periskope' }] })
        .mockResolvedValueOnce({ rows: [] }) // UPDATE sent
        .mockResolvedValueOnce({ rows: [] }); // INSERT log

      await processor.processById('ob-ch-1');

      expect(mockMessaging.sendWhatsApp).toHaveBeenCalledTimes(1);
      // 4 queries: outbox select, worker select, UPDATE sent, INSERT log — sem COUNT de cap
      expect(mockQuery).toHaveBeenCalledTimes(4);
    });

    it('canal twilio nunca consulta o teto diário do Periskope', async () => {
      process.env.PERISKOPE_DAILY_CAP = '5';
      mockQuery
        .mockResolvedValueOnce({ rows: [baseRow] })
        .mockResolvedValueOnce({ rows: [{ whatsapp_phone_encrypted: null, phone: '+5491100005555', messaging_channel: 'twilio' }] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] });

      await processor.processById('ob-ch-1');

      expect(mockQuery).toHaveBeenCalledTimes(4);
    });

    it('canal periskope pausado (Result.fail reprocessável) → NÃO incrementa attempts nem marca failed', async () => {
      process.env.PERISKOPE_DAILY_CAP = '5';
      mockQuery
        .mockResolvedValueOnce({ rows: [baseRow] })
        .mockResolvedValueOnce({ rows: [{ whatsapp_phone_encrypted: null, phone: '+5491100005555', messaging_channel: 'periskope' }] })
        .mockResolvedValueOnce({ rows: [{ count: '0' }] });

      mockMessaging.sendWhatsApp.mockResolvedValueOnce({
        isFailure: true,
        error: 'periskope channel paused',
      });

      await processor.processById('ob-ch-1');

      // 3 queries apenas: outbox select, worker select, COUNT cap — nenhuma UPDATE/INSERT
      expect(mockQuery).toHaveBeenCalledTimes(3);
    });
  });
});
