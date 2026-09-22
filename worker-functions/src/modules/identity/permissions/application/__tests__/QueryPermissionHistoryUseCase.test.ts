import { HISTORY_DEFAULT_LIMIT, HISTORY_MAX_LIMIT, QueryPermissionHistoryUseCase } from '../QueryPermissionHistoryUseCase';
import type { PermissionHistoryRepository } from '../ports';

const EVENTO = {
  eventType: 'permission' as const,
  occurredAt: new Date('2026-09-20T00:00:00Z'),
  groupId: 'g1',
  groupName: 'Recrutamento AR',
  actorUid: 'uid-0',
  actorDisplayName: 'Ana Gestora',
  actorEmail: 'ana@enlite.health',
  op: 'add' as const,
  resource: 'worker',
  action: 'read',
  subjectUserId: null,
  subjectDisplayName: null,
  subjectEmail: null,
};

function build() {
  const query = jest.fn().mockResolvedValue([EVENTO]);
  const repo: PermissionHistoryRepository = { query };
  return { useCase: new QueryPermissionHistoryUseCase(repo), query };
}

describe('QueryPermissionHistoryUseCase', () => {
  it('sem filtro, aplica o LIMITE PADRÃO — a tela não vira exportação', async () => {
    const { useCase, query } = build();

    const eventos = await useCase.execute();

    expect(eventos).toEqual([EVENTO]);
    expect(query).toHaveBeenCalledWith({ limit: HISTORY_DEFAULT_LIMIT });
  });

  it('repassa `groupId` e `type` intactos', async () => {
    const { useCase, query } = build();

    await useCase.execute({ groupId: 'g1', type: 'member', limit: 10 });

    expect(query).toHaveBeenCalledWith({ groupId: 'g1', type: 'member', limit: 10 });
  });

  it('`limit` acima do teto do banco é CLAMPADO, não repassado cru', async () => {
    const { useCase, query } = build();

    await useCase.execute({ limit: 999999 });

    expect(query).toHaveBeenCalledWith({ limit: HISTORY_MAX_LIMIT });
  });

  it('`limit` <= 0 vira 1 — nunca zero nem negativo', async () => {
    const { useCase, query } = build();

    await useCase.execute({ limit: -5 });

    expect(query).toHaveBeenCalledWith({ limit: 1 });
  });
});
