/**
 * Repositório com pool mockado — mesmo molde de `PgPermissionAuditRepository`
 * (repositories.test.ts): prova que a leitura sai por `iam.query_permission_history`
 * (nunca SELECT direto em `iam.permission_group_changes`/`iam.user_groups`), que
 * os filtros opcionais viram `null` quando ausentes, e o mapeamento de linha →
 * evento nos dois `eventType` (`permission`/`member`).
 */

import { poolMockWithConnect } from '@shared/database/poolMockSupport';
import { PgPermissionHistoryRepository } from '../PgPermissionHistoryRepository';

jest.mock('@shared/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  loggingAls: { getStore: () => undefined },
}));

function repoComQuery(query: jest.Mock): PgPermissionHistoryRepository {
  return new PgPermissionHistoryRepository(poolMockWithConnect(query) as never);
}

describe('PgPermissionHistoryRepository.query', () => {
  it('passa pela função gated `iam.query_permission_history` (nunca SELECT direto na tabela) e mapeia os DOIS tipos de evento', async () => {
    const query = jest.fn().mockResolvedValue({
      rows: [
        {
          event_type: 'permission',
          occurred_at: new Date('2026-09-10T12:00:00Z'),
          group_id: 'g1',
          group_name: 'Recrutador',
          actor_uid: 'ana',
          actor_display_name: 'Ana',
          actor_email: 'ana@e.com',
          op: 'add',
          resource: 'worker',
          action: 'read',
          subject_user_id: null,
          subject_display_name: null,
          subject_email: null,
        },
        {
          event_type: 'member',
          occurred_at: new Date('2026-09-11T08:30:00Z'),
          group_id: 'g1',
          group_name: 'Recrutador',
          actor_uid: 'ana',
          actor_display_name: 'Ana',
          actor_email: 'ana@e.com',
          op: 'remove',
          resource: null,
          action: null,
          subject_user_id: 'bob',
          subject_display_name: 'Bob',
          subject_email: 'bob@e.com',
        },
      ],
    });
    const repo = repoComQuery(query);

    const events = await repo.query({ groupId: 'g1', type: null, limit: 50 });

    expect(events).toEqual([
      {
        eventType: 'permission',
        occurredAt: new Date('2026-09-10T12:00:00Z'),
        groupId: 'g1',
        groupName: 'Recrutador',
        actorUid: 'ana',
        actorDisplayName: 'Ana',
        actorEmail: 'ana@e.com',
        op: 'add',
        resource: 'worker',
        action: 'read',
        subjectUserId: null,
        subjectDisplayName: null,
        subjectEmail: null,
      },
      {
        eventType: 'member',
        occurredAt: new Date('2026-09-11T08:30:00Z'),
        groupId: 'g1',
        groupName: 'Recrutador',
        actorUid: 'ana',
        actorDisplayName: 'Ana',
        actorEmail: 'ana@e.com',
        op: 'remove',
        resource: null,
        action: null,
        subjectUserId: 'bob',
        subjectDisplayName: 'Bob',
        subjectEmail: 'bob@e.com',
      },
    ]);
    const [sql, params] = query.mock.calls[0];
    expect(String(sql)).toContain('FROM iam.query_permission_history($1, $2, $3)');
    expect(String(sql)).not.toMatch(/SELECT[\s\S]*FROM iam\.(permission_group_changes|user_groups)/i);
    expect(params).toEqual(['g1', null, 50]);
  });

  it('filtros ausentes viram null (groupId/type/limit) — a função aplica os próprios defaults', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [] });
    const repo = repoComQuery(query);

    const events = await repo.query({});

    expect(events).toEqual([]);
    expect(query.mock.calls[0][1]).toEqual([null, null, null]);
  });

  it('actor anônimo (uid/nome/e-mail null) e evento sem contraparte de célula/membro mapeiam sem lançar', async () => {
    const query = jest.fn().mockResolvedValue({
      rows: [
        {
          event_type: 'permission',
          occurred_at: new Date('2026-09-12T00:00:00Z'),
          group_id: 'g2',
          group_name: 'Financeiro',
          actor_uid: null,
          actor_display_name: null,
          actor_email: null,
          op: 'remove',
          resource: 'invoice',
          action: 'write',
          subject_user_id: null,
          subject_display_name: null,
          subject_email: null,
        },
      ],
    });
    const repo = repoComQuery(query);

    const [event] = await repo.query({ type: 'permission' });

    expect(event).toMatchObject({ actorUid: null, actorDisplayName: null, actorEmail: null });
    expect(query.mock.calls[0][1]).toEqual([null, 'permission', null]);
  });

  it('erro gated (42501, ator sem `permission_management:read`) RELANÇA — leitura não engole falha', async () => {
    const query = jest.fn().mockRejectedValue(Object.assign(new Error('sem permissão'), { code: '42501' }));
    const repo = repoComQuery(query);

    await expect(repo.query({})).rejects.toThrow();
  });
});
