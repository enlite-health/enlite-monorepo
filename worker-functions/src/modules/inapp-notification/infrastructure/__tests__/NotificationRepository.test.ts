/**
 * NotificationRepository — unit (pool/client mockados na fronteira). Molde:
 * `ConversationRepository.test.ts` (pool injetado no construtor, sem `DatabaseConnection` real).
 */
jest.mock('@shared/database/DatabaseConnection', () => ({
  DatabaseConnection: { getInstance: () => ({ getPool: () => ({ query: jest.fn() }) }) },
}));

import type { Pool, PoolClient } from 'pg';
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
