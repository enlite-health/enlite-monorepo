/**
 * BulkDispatchIncompleteWorkersUseCase.test.ts
 *
 * Testa o use case de lembrete para workers com cadastro interno incompleto.
 *
 * Cenários:
 * 1. 0 workers retornados → Result.ok com total=0, sent=0
 * 2. 1 worker retornado → INSERT lock + sendWhatsApp + UPDATE state + INSERT log (status sent)
 * 3. messaging falha → error count++ + UPDATE state 'failed' + log status='error'
 * 4. slot já adquirido (INSERT lock retorna 0 rows) → skip sem chamar sendWhatsApp
 * 5. falha de DB na query inicial → Result.fail com mensagem de erro
 * 6. dry-run → não chama sendWhatsApp nem grava logs
 * 7. limit → trunca lista de workers
 * 8. falha no INSERT de log → non-fatal (não bloqueia)
 */

import { BulkDispatchIncompleteWorkersUseCase } from '../BulkDispatchIncompleteWorkersUseCase';
import { IMessagingService } from '../../domain/IMessagingService';
import { Result } from '@shared/utils/Result';
import { Pool } from 'pg';

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

function makeMessaging(
  success = true,
  externalId = 'SM999',
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

const WORKER_A = { id: 'w-incomplete-1', phone: '+5511999990011' };
const WORKER_B = { id: 'w-incomplete-2', phone: '+5511999990012' };

describe('BulkDispatchIncompleteWorkersUseCase', () => {
  beforeEach(() => {
    process.env.BULK_DISPATCH_DELAY_MS = '0';
  });

  afterEach(() => {
    delete process.env.BULK_DISPATCH_DELAY_MS;
    jest.clearAllMocks();
  });

  describe('0 workers elegíveis', () => {
    it('retorna Result.ok com total=0, sent=0, errors=0', async () => {
      const db = makeDbSequence([{ rows: [] }]);
      const messaging = makeMessaging();

      const uc = new BulkDispatchIncompleteWorkersUseCase(db, messaging);
      const result = await uc.execute('scheduler');

      expect(result.isSuccess).toBe(true);
      const val = result.getValue()!;
      expect(val.total).toBe(0);
      expect(val.sent).toBe(0);
      expect(val.errors).toBe(0);
      expect(val.dryRun).toBe(false);
      expect(val.batchId).toMatch(/^[0-9a-f-]{36}$/i);
      expect(messaging.sendWhatsApp).not.toHaveBeenCalled();
    });
  });

  describe('1 worker elegível, envio bem-sucedido', () => {
    it('adquire lock, envia, atualiza state e grava log', async () => {
      const db = makeDbSequence([
        { rows: [WORKER_A] },
        { rows: [{ worker_id: WORKER_A.id }] }, // lock adquirido
        { rows: [] },                            // UPDATE state
        { rows: [] },                            // INSERT log
      ]);
      const messaging = makeMessaging(true, 'SM_inc_ok');

      const uc = new BulkDispatchIncompleteWorkersUseCase(db, messaging);
      const result = await uc.execute('scheduler');

      expect(result.isSuccess).toBe(true);
      const val = result.getValue()!;
      expect(val.total).toBe(1);
      expect(val.sent).toBe(1);
      expect(val.errors).toBe(0);

      expect(messaging.sendWhatsApp).toHaveBeenCalledWith({
        to: WORKER_A.phone,
        templateSlug: 'complete_register_ofc',
        channel: 'twilio',
      });

      const calls = (db.query as jest.Mock).mock.calls as Array<[string, ...unknown[]]>;

      const lockCall = calls.find(([sql]) => sql.includes('INSERT INTO worker_reminder_state'));
      expect(lockCall).toBeDefined();
      expect(lockCall![1]).toContain(WORKER_A.id);
      expect(lockCall![1]).toContain('complete_register_ofc');

      const updateCall = calls.find(([sql]) => sql.includes('UPDATE worker_reminder_state'));
      expect(updateCall).toBeDefined();
      expect(updateCall![1]).toContain('sent');

      const logCall = calls.find(([sql]) => sql.includes('INSERT INTO whatsapp_bulk_dispatch_logs'));
      expect(logCall).toBeDefined();
      // phone = NULL sempre (migration 475, mensageria-pii-e-retencao): o SQL grava NULL
      // literal na coluna phone — não é mais um parâmetro bindado.
      expect(logCall![0]).toMatch(/\(worker_id, triggered_by, phone, template_slug, status, twilio_sid, error_message, batch_id, source\)\s*\n\s*VALUES \(\$1, \$2, NULL, \$3, \$4, \$5, \$6, \$7, 'bulk'\)/);
      const logParams = logCall![1] as unknown[];
      expect(logParams[2]).toBe('complete_register_ofc');
      expect(logParams[3]).toBe('sent');
      expect(logParams[4]).toBe('SM_inc_ok');
      expect(logParams).not.toContain(WORKER_A.phone);
    });
  });

  describe('messaging falha', () => {
    it('errors++ e UPDATE state como failed', async () => {
      const db = makeDbSequence([
        { rows: [WORKER_A] },
        { rows: [{ worker_id: WORKER_A.id }] }, // lock adquirido
        { rows: [] },                            // UPDATE state
        { rows: [] },                            // INSERT log
      ]);
      const messaging = makeMessaging(false);

      const uc = new BulkDispatchIncompleteWorkersUseCase(db, messaging);
      const result = await uc.execute('scheduler');

      expect(result.isSuccess).toBe(true);
      const val = result.getValue()!;
      expect(val.sent).toBe(0);
      expect(val.errors).toBe(1);

      const calls = (db.query as jest.Mock).mock.calls as Array<[string, ...unknown[]]>;
      const updateCall = calls.find(([sql]) => sql.includes('UPDATE worker_reminder_state'));
      expect(updateCall![1]).toContain('failed');

      const logCall = calls.find(([sql]) => sql.includes('INSERT INTO whatsapp_bulk_dispatch_logs'));
      const logParams = logCall![1] as unknown[];
      expect(logParams[3]).toBe('error');
      expect(logParams[4]).toBeNull();
      expect(logParams[5]).toBe('Twilio error');
      expect(logParams).not.toContain(WORKER_A.phone);
    });
  });

  describe('slot já adquirido por outro processo', () => {
    it('skip sem chamar sendWhatsApp quando INSERT retorna 0 rows', async () => {
      const db = makeDbSequence([
        { rows: [WORKER_A] },
        { rows: [] }, // lock NÃO adquirido
      ]);
      const messaging = makeMessaging(true);

      const uc = new BulkDispatchIncompleteWorkersUseCase(db, messaging);
      const result = await uc.execute('scheduler');

      expect(result.isSuccess).toBe(true);
      const val = result.getValue()!;
      expect(val.total).toBe(1);
      expect(val.sent).toBe(0);
      expect(val.errors).toBe(0);
      expect(val.details).toHaveLength(0);

      expect(messaging.sendWhatsApp).not.toHaveBeenCalled();

      const calls = (db.query as jest.Mock).mock.calls as Array<[string, ...unknown[]]>;
      const updateCall = calls.find(([sql]) => sql.includes('UPDATE worker_reminder_state'));
      expect(updateCall).toBeUndefined();
    });
  });

  describe('falha na query inicial de workers', () => {
    it('retorna Result.fail com mensagem de erro', async () => {
      const db = makeDbSequence([new Error('DB offline')]);
      const messaging = makeMessaging();

      const uc = new BulkDispatchIncompleteWorkersUseCase(db, messaging);
      const result = await uc.execute('scheduler');

      expect(result.isFailure).toBe(true);
      expect(result.error).toContain('DB offline');
      expect(messaging.sendWhatsApp).not.toHaveBeenCalled();
    });
  });

  describe('dry-run', () => {
    it('retorna lista de workers sem chamar sendWhatsApp nem gravar logs', async () => {
      const db = makeDbSequence([{ rows: [WORKER_A, WORKER_B] }]);
      const messaging = makeMessaging();

      const uc = new BulkDispatchIncompleteWorkersUseCase(db, messaging);
      const result = await uc.execute('scheduler', { dryRun: true });

      expect(result.isSuccess).toBe(true);
      const val = result.getValue()!;
      expect(val.dryRun).toBe(true);
      expect(val.total).toBe(2);
      expect(val.sent).toBe(0);
      expect(val.details).toHaveLength(2);

      expect(messaging.sendWhatsApp).not.toHaveBeenCalled();
      // Apenas 1 query (SELECT) deve ter sido feita
      expect((db.query as jest.Mock).mock.calls).toHaveLength(1);
    });
  });

  describe('limit', () => {
    it('trunca lista de workers ao limite informado', async () => {
      const db = makeDbSequence([
        { rows: [WORKER_A, WORKER_B] },
        { rows: [{ worker_id: WORKER_A.id }] },
        { rows: [] },
        { rows: [] },
      ]);
      const messaging = makeMessaging();

      const uc = new BulkDispatchIncompleteWorkersUseCase(db, messaging);
      const result = await uc.execute('scheduler', { limit: 1 });

      expect(result.isSuccess).toBe(true);
      const val = result.getValue()!;
      expect(val.total).toBe(1);
      expect(messaging.sendWhatsApp).toHaveBeenCalledTimes(1);
    });
  });

  describe('query de elegibilidade — cadência e freeze', () => {
    it('inclui a cadência 3d/7d e o cap 3, sem dias consecutivos', async () => {
      const db = makeDbSequence([{ rows: [] }]);
      const uc = new BulkDispatchIncompleteWorkersUseCase(db, makeMessaging());
      await uc.execute('scheduler');

      const selectSql = (db.query as jest.Mock).mock.calls[0][0] as string;
      expect(selectSql).toContain("INTERVAL '3 days'");
      expect(selectSql).toContain("INTERVAL '7 days'");
      expect(selectSql).toContain('COALESCE(ss.total_sent, 0) < 3');
      expect(selectSql).not.toContain("INTERVAL '1 days'");
    });

    it('inclui o freeze da coorte do incidente (não recontatar quem já recebeu)', async () => {
      const db = makeDbSequence([{ rows: [] }]);
      const uc = new BulkDispatchIncompleteWorkersUseCase(db, makeMessaging());
      await uc.execute('scheduler');

      const selectSql = (db.query as jest.Mock).mock.calls[0][0] as string;
      expect(selectSql).toContain('2026-06-02T00:00:00Z');
      expect(selectSql).toMatch(/NOT EXISTS[\s\S]*whatsapp_bulk_dispatch_logs frz/);
    });
  });

  describe('roteamento por canal (messaging_channel)', () => {
    it('SELECT inclui w.messaging_channel', async () => {
      const db = makeDbSequence([{ rows: [] }]);
      const uc = new BulkDispatchIncompleteWorkersUseCase(db, makeMessaging());
      await uc.execute('scheduler');

      const selectSql = (db.query as jest.Mock).mock.calls[0][0] as string;
      expect(selectSql).toContain('w.messaging_channel');
    });

    it('worker com messaging_channel=periskope → sendWhatsApp recebe channel=periskope', async () => {
      const workerPeriskope = { id: 'w-periskope-1', phone: '+5511999990099', messaging_channel: 'periskope' };
      const db = makeDbSequence([
        { rows: [workerPeriskope] },
        { rows: [{ worker_id: workerPeriskope.id }] },
        { rows: [] },
        { rows: [] },
      ]);
      const messaging = makeMessaging(true, 'SM_periskope');

      const uc = new BulkDispatchIncompleteWorkersUseCase(db, messaging);
      await uc.execute('scheduler');

      expect(messaging.sendWhatsApp).toHaveBeenCalledWith({
        to: workerPeriskope.phone,
        templateSlug: 'complete_register_ofc',
        channel: 'periskope',
      });
    });

    it('worker sem messaging_channel na row (default) → sendWhatsApp recebe channel=twilio', async () => {
      const db = makeDbSequence([
        { rows: [WORKER_A] },
        { rows: [{ worker_id: WORKER_A.id }] },
        { rows: [] },
        { rows: [] },
      ]);
      const messaging = makeMessaging(true, 'SM_default');

      const uc = new BulkDispatchIncompleteWorkersUseCase(db, messaging);
      await uc.execute('scheduler');

      expect(messaging.sendWhatsApp).toHaveBeenCalledWith({
        to: WORKER_A.phone,
        templateSlug: 'complete_register_ofc',
        channel: 'twilio',
      });
    });
  });

  describe('falha no INSERT de log', () => {
    it('não bloqueia o fluxo — sent ainda é contabilizado', async () => {
      const db = makeDbSequence([
        { rows: [WORKER_A] },
        { rows: [{ worker_id: WORKER_A.id }] },
        { rows: [] },                          // UPDATE state ok
        new Error('log DB connection lost'),   // INSERT log falha
      ]);
      const messaging = makeMessaging(true, 'SM_log_fail2');

      const uc = new BulkDispatchIncompleteWorkersUseCase(db, messaging);
      const result = await uc.execute('scheduler');

      expect(result.isSuccess).toBe(true);
      const val = result.getValue()!;
      expect(val.sent).toBe(1);
      expect(val.errors).toBe(0);
    });
  });
});
