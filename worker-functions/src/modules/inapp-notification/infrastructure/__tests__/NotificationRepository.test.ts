/**
 * NotificationRepository — unit (pool/client mockados na fronteira). Molde:
 * `ConversationRepository.test.ts` (pool injetado no construtor, sem `DatabaseConnection` real).
 *
 * `findRootMessageIds`/`findMessageExcerpts` (itens 2/3 da change 022-ux-mencao-e-notificacao):
 * KMS também mockado por módulo, MESMO padrão de `ConversationRepository.test.ts` (decrypt vira
 * `plain:<ciphertext>`, determinístico e sem chamar o KMS de verdade).
 */
jest.mock('@shared/database/DatabaseConnection', () => ({
  DatabaseConnection: { getInstance: () => ({ getPool: () => ({ query: jest.fn() }) }) },
}));

const mockDecrypt = jest.fn(async (v: string | null) => (v ? `plain:${v}` : ''));
jest.mock('@shared/security/KMSEncryptionService', () => ({
  KMSEncryptionService: jest.fn().mockImplementation(() => ({ decrypt: mockDecrypt })),
}));

const mockReportError = jest.fn();
jest.mock('@shared/logging', () => ({ reportError: mockReportError }));

jest.mock('@shared/async/mapWithConcurrency', () => ({
  mapWithConcurrency: jest.fn((items: unknown[], _limit: number, fn: (item: unknown) => Promise<unknown>) =>
    Promise.all(items.map(fn)),
  ),
}));

import type { Pool, PoolClient } from 'pg';
import { mapWithConcurrency } from '@shared/async/mapWithConcurrency';
import { NotificationRepository } from '../NotificationRepository';

function poolWith(query: jest.Mock): Pool {
  return { query } as unknown as Pool;
}
function clientWith(query: jest.Mock): PoolClient {
  return { query } as unknown as PoolClient;
}

describe('NotificationRepository', () => {
  describe('insertEvent — grava notification_events, payload nunca recebe texto (D-08/D-09)', () => {
    it('INSERT com os 5 campos (type_code, actor_uid, patient_id, conversation_id, message_id), RETURNING id', async () => {
      const query = jest.fn().mockResolvedValue({ rows: [{ id: 'evt-1' }] });
      const repo = new NotificationRepository(poolWith(jest.fn()));

      const id = await repo.insertEvent(
        { typeCode: 'CONVERSATION_MENTIONED', actorUid: 'a1', patientId: 'p1', conversationId: 'c1', messageId: 'm1' },
        clientWith(query),
      );

      expect(id).toBe('evt-1');
      const [sql, params] = query.mock.calls[0];
      expect(sql).toContain('INSERT INTO notification_events');
      expect(sql).not.toMatch(/payload/i); // nunca escreve em payload — usa o DEFAULT '{}'::jsonb da migration 461
      expect(params).toEqual(['CONVERSATION_MENTIONED', 'a1', 'p1', 'c1', 'm1']);
    });
  });

  describe('insertNotifications — 1 linha por destinatário, lote único', () => {
    it('lista vazia: não chama query nenhuma', async () => {
      const query = jest.fn();
      const repo = new NotificationRepository(poolWith(jest.fn()));

      await repo.insertNotifications('evt-1', [], clientWith(query));

      expect(query).not.toHaveBeenCalled();
    });

    it('3 destinatários: UM INSERT com 3 linhas, nunca 3 queries', async () => {
      const query = jest.fn().mockResolvedValue({ rows: [] });
      const repo = new NotificationRepository(poolWith(jest.fn()));

      await repo.insertNotifications('evt-1', ['u1', 'u2', 'u3'], clientWith(query));

      expect(query).toHaveBeenCalledTimes(1);
      const [sql, params] = query.mock.calls[0];
      expect(sql).toContain('INSERT INTO notifications');
      expect(params).toEqual(['evt-1', 'u1', 'u2', 'u3']);
    });
  });

  describe('listForRecipient — isolamento (D-24): sempre filtra por recipient_uid', () => {
    it('unreadOnly=false: sem cláusula extra de read_at', async () => {
      const query = jest.fn().mockResolvedValue({ rows: [] });
      const repo = new NotificationRepository();

      await repo.listForRecipient('u1', { limit: 20 }, poolWith(query));

      const [sql, params] = query.mock.calls[0];
      expect(sql).toContain('WHERE n.recipient_uid = $1');
      expect(sql).not.toContain('read_at IS NULL');
      expect(params).toEqual(['u1', 20]);
    });

    it('unreadOnly=true: acrescenta AND n.read_at IS NULL', async () => {
      const query = jest.fn().mockResolvedValue({ rows: [] });
      const repo = new NotificationRepository();

      await repo.listForRecipient('u1', { unreadOnly: true, limit: 20 }, poolWith(query));

      const [sql] = query.mock.calls[0];
      expect(sql).toContain('AND n.read_at IS NULL');
    });
  });

  describe('countUnread', () => {
    it('devolve o count como number (não string do driver)', async () => {
      const query = jest.fn().mockResolvedValue({ rows: [{ count: 3 }] });
      const repo = new NotificationRepository();

      const count = await repo.countUnread('u1', poolWith(query));

      expect(count).toBe(3);
    });

    it('sem linha nenhuma: devolve 0, nunca undefined', async () => {
      const query = jest.fn().mockResolvedValue({ rows: [] });
      const repo = new NotificationRepository();

      expect(await repo.countUnread('u1', poolWith(query))).toBe(0);
    });
  });

  describe('findRecipientUid — base do isolamento entre destinatários (D-24)', () => {
    it('notificação existe: devolve o recipient_uid', async () => {
      const query = jest.fn().mockResolvedValue({ rows: [{ recipientUid: 'u1' }] });
      const repo = new NotificationRepository();

      expect(await repo.findRecipientUid('n1', poolWith(query))).toBe('u1');
    });

    it('notificação não existe: devolve null (nunca lança) — o use case decide o 404', async () => {
      const query = jest.fn().mockResolvedValue({ rows: [] });
      const repo = new NotificationRepository();

      expect(await repo.findRecipientUid('n1', poolWith(query))).toBeNull();
    });
  });

  describe('markRead — nunca reabre notificação já lida (idempotente)', () => {
    it('UPDATE com AND read_at IS NULL', async () => {
      const query = jest.fn().mockResolvedValue({ rows: [] });
      const repo = new NotificationRepository();

      await repo.markRead('n1', clientWith(query));

      const [sql, params] = query.mock.calls[0];
      expect(sql).toContain('SET read_at = now()');
      expect(sql).toContain('AND read_at IS NULL');
      expect(params).toEqual(['n1']);
    });
  });

  describe('markAllRead — devolve a CONTAGEM de linhas afetadas (contrato: { updated })', () => {
    it('rowCount do driver vira o retorno', async () => {
      const query = jest.fn().mockResolvedValue({ rowCount: 4, rows: [] });
      const repo = new NotificationRepository();

      const updated = await repo.markAllRead('u1', clientWith(query));

      expect(updated).toBe(4);
      const [sql, params] = query.mock.calls[0];
      expect(sql).toContain('WHERE recipient_uid = $1 AND read_at IS NULL');
      expect(params).toEqual(['u1']);
    });

    it('rowCount null (driver não informou): devolve 0, nunca lança', async () => {
      const query = jest.fn().mockResolvedValue({ rowCount: null, rows: [] });
      const repo = new NotificationRepository();

      expect(await repo.markAllRead('u1', clientWith(query))).toBe(0);
    });
  });

  describe('findRootMessageIds — rootMessageId de cada mensagem de origem, EM LOTE (item 3, F11)', () => {
    it('lista vazia: não chama query, devolve Map vazio', async () => {
      const query = jest.fn();
      const repo = new NotificationRepository(poolWith(query));

      const out = await repo.findRootMessageIds([], poolWith(query));

      expect(query).not.toHaveBeenCalled();
      expect(out.size).toBe(0);
    });

    it('UMA query com ANY para VÁRIOS messageIds — nunca uma por mensagem', async () => {
      const query = jest.fn().mockResolvedValue({
        rows: [
          { id: 'm1', rootMessageId: null }, // m1 é o próprio root
          { id: 'r1', rootMessageId: 'm1' }, // r1 é reply de m1
        ],
      });
      const repo = new NotificationRepository();

      const out = await repo.findRootMessageIds(['m1', 'r1'], poolWith(query));

      expect(query).toHaveBeenCalledTimes(1);
      const [sql, params] = query.mock.calls[0];
      expect(sql).toContain('WHERE id = ANY($1::uuid[])');
      expect(params).toEqual([['m1', 'r1']]);
      expect(out.get('m1')).toBeNull();
      expect(out.get('r1')).toBe('m1');
    });

    it('messageId sem linha correspondente (mensagem removida?) não entra no Map', async () => {
      const query = jest.fn().mockResolvedValue({ rows: [] });
      const repo = new NotificationRepository();

      const out = await repo.findRootMessageIds(['inexistente'], poolWith(query));

      expect(out.has('inexistente')).toBe(false);
    });
  });

  describe('findMessageExcerpts — trecho decifrado (~140 chars) por mensagem (item 2, F8/F9)', () => {
    it('lista vazia: não chama query, devolve Map vazio', async () => {
      const query = jest.fn();
      const repo = new NotificationRepository(poolWith(query));

      const out = await repo.findMessageExcerpts([], poolWith(query));

      expect(query).not.toHaveBeenCalled();
      expect(out.size).toBe(0);
    });

    it('decifra e devolve o corpo (não corta quando cabe em 140 chars)', async () => {
      const query = jest.fn().mockResolvedValue({ rows: [{ id: 'm1', bodyEncrypted: 'enc:oi' }] });
      const repo = new NotificationRepository(poolWith(query));

      const out = await repo.findMessageExcerpts(['m1'], poolWith(query));

      expect(out.get('m1')).toBe('plain:enc:oi');
      expect(mockDecrypt).toHaveBeenCalledWith('enc:oi');
    });

    it('corta em 140 chars DEPOIS de decifrar — nunca corta o ciphertext', async () => {
      const corpoLongo = 'a'.repeat(200);
      mockDecrypt.mockResolvedValueOnce(corpoLongo);
      const query = jest.fn().mockResolvedValue({ rows: [{ id: 'm1', bodyEncrypted: 'enc:longo' }] });
      const repo = new NotificationRepository(poolWith(query));

      const out = await repo.findMessageExcerpts(['m1'], poolWith(query));

      expect(out.get('m1')).toHaveLength(140);
      expect(out.get('m1')).toBe(corpoLongo.slice(0, 140));
    });

    it('decifra via mapWithConcurrency com limite 10 — mesmo padrão de ConversationRepository (D-01)', async () => {
      const query = jest.fn().mockResolvedValue({ rows: [{ id: 'm1', bodyEncrypted: 'enc:oi' }] });
      const repo = new NotificationRepository(poolWith(query));

      await repo.findMessageExcerpts(['m1'], poolWith(query));

      expect(mapWithConcurrency).toHaveBeenCalledWith(expect.any(Array), 10, expect.any(Function));
    });

    it('falha de decifra de UMA linha isola só aquela — excerpt null, reportError SÓ com messageId (nunca corpo/ciphertext)', async () => {
      mockDecrypt.mockRejectedValueOnce(new Error('kms indisponível'));
      const query = jest.fn().mockResolvedValue({
        rows: [
          { id: 'm1', bodyEncrypted: 'enc:falha' },
          { id: 'm2', bodyEncrypted: 'enc:ok' },
        ],
      });
      const repo = new NotificationRepository(poolWith(query));

      const out = await repo.findMessageExcerpts(['m1', 'm2'], poolWith(query));

      expect(out.get('m1')).toBeNull();
      expect(out.get('m2')).toBe('plain:enc:ok');
      const [, context] = mockReportError.mock.calls[0];
      expect(context).toMatchObject({ messageId: 'm1' });
      expect(JSON.stringify(context)).not.toContain('falha'); // nunca o corpo/ciphertext no log
    });

    it('UMA query com ANY para VÁRIAS mensagens — nunca uma por mensagem', async () => {
      const query = jest.fn().mockResolvedValue({
        rows: [{ id: 'm1', bodyEncrypted: 'enc:a' }, { id: 'm2', bodyEncrypted: 'enc:b' }],
      });
      const repo = new NotificationRepository(poolWith(query));

      await repo.findMessageExcerpts(['m1', 'm2'], poolWith(query));

      expect(query).toHaveBeenCalledTimes(1);
      const [sql, params] = query.mock.calls[0];
      expect(sql).toContain('WHERE id = ANY($1::uuid[])');
      expect(params).toEqual([['m1', 'm2']]);
    });
  });

  describe('findPatientDisplayName — nome em claro (não é campo cifrado, D-13)', () => {
    it('junta first_name + last_name', async () => {
      const query = jest.fn().mockResolvedValue({ rows: [{ firstName: 'Ana', lastName: 'Silva' }] });
      const repo = new NotificationRepository();

      expect(await repo.findPatientDisplayName('p1', poolWith(query))).toBe('Ana Silva');
    });

    it('paciente sem last_name: devolve só o first_name (sem espaço sobrando)', async () => {
      const query = jest.fn().mockResolvedValue({ rows: [{ firstName: 'Ana', lastName: null }] });
      const repo = new NotificationRepository();

      expect(await repo.findPatientDisplayName('p1', poolWith(query))).toBe('Ana');
    });

    it('paciente não existe: devolve null', async () => {
      const query = jest.fn().mockResolvedValue({ rows: [] });
      const repo = new NotificationRepository();

      expect(await repo.findPatientDisplayName('inexistente', poolWith(query))).toBeNull();
    });
  });
});
