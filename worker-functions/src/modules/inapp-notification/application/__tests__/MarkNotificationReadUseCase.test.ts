/**
 * MarkNotificationReadUseCase — TDD (Spec 022, Bloco 4, T406/T417). Molde: `withActorContext`
 * mockado (mesmo de `PostMessageUseCase.test.ts`) — inspeciona que o `client` da transação é o
 * MESMO em `findRecipientUid`/`markRead`, nunca 2 conexões.
 */
const mockWithActorContext = jest.fn();
jest.mock('@shared/database/actorContext', () => ({
  withActorContext: (...args: unknown[]) => mockWithActorContext(...args),
}));

import type { Pool, PoolClient } from 'pg';
import { MarkNotificationReadUseCase, NotificationNotOwnedError } from '../MarkNotificationReadUseCase';
import type { NotificationRepository } from '../../infrastructure/NotificationRepository';

const POOL = {} as unknown as Pool;
const CLIENT = {} as unknown as PoolClient;

function runOn(client: PoolClient) {
  mockWithActorContext.mockImplementation(async (_pool: Pool, fn: (c: PoolClient) => unknown) => fn(client));
}

beforeEach(() => mockWithActorContext.mockReset());

describe('MarkNotificationReadUseCase (D-24 — isolamento entre destinatários)', () => {
  it('notificação é do requester: marca lida', async () => {
    runOn(CLIENT);
    const repo = {
      findRecipientUid: jest.fn().mockResolvedValue('me'),
      markRead: jest.fn().mockResolvedValue(undefined),
    } as unknown as NotificationRepository;
    const useCase = new MarkNotificationReadUseCase(repo);

    await useCase.execute(POOL, { notificationId: 'n1', requesterUid: 'me' });

    expect(repo.markRead).toHaveBeenCalledWith('n1', CLIENT);
  });

  it('notificação é de OUTRO uid: lança NotificationNotOwnedError (404, nunca 403), NUNCA marca', async () => {
    runOn(CLIENT);
    const repo = {
      findRecipientUid: jest.fn().mockResolvedValue('outro-uid'),
      markRead: jest.fn(),
    } as unknown as NotificationRepository;
    const useCase = new MarkNotificationReadUseCase(repo);

    await expect(useCase.execute(POOL, { notificationId: 'n1', requesterUid: 'me' })).rejects.toBeInstanceOf(
      NotificationNotOwnedError,
    );
    expect(repo.markRead).not.toHaveBeenCalled();
  });

  it('notificação não existe: MESMO erro/código de "não é sua" (anti-enumeração — nunca distingue as duas causas)', async () => {
    runOn(CLIENT);
    const repo = {
      findRecipientUid: jest.fn().mockResolvedValue(null),
      markRead: jest.fn(),
    } as unknown as NotificationRepository;
    const useCase = new MarkNotificationReadUseCase(repo);

    await expect(useCase.execute(POOL, { notificationId: 'inexistente', requesterUid: 'me' })).rejects.toMatchObject({
      code: 'NOTIFICATION_NOT_FOUND',
      status: 404,
    });
    expect(repo.markRead).not.toHaveBeenCalled();
  });
});
