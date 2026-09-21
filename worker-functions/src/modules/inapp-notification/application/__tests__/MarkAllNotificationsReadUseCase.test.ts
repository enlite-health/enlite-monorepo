const mockWithActorContext = jest.fn();
jest.mock('@shared/database/actorContext', () => ({
  withActorContext: (...args: unknown[]) => mockWithActorContext(...args),
}));

import type { Pool, PoolClient } from 'pg';
import { MarkAllNotificationsReadUseCase } from '../MarkAllNotificationsReadUseCase';
import type { NotificationRepository } from '../../infrastructure/NotificationRepository';

const POOL = {} as unknown as Pool;
const CLIENT = {} as unknown as PoolClient;

describe('MarkAllNotificationsReadUseCase', () => {
  it('devolve a contagem de linhas afetadas pelo repositório', async () => {
    mockWithActorContext.mockImplementation(async (_pool: Pool, fn: (c: PoolClient) => unknown) => fn(CLIENT));
    const repo = { markAllRead: jest.fn().mockResolvedValue(4) } as unknown as NotificationRepository;
    const useCase = new MarkAllNotificationsReadUseCase(repo);

    const updated = await useCase.execute(POOL, 'me');

    expect(updated).toBe(4);
    expect(repo.markAllRead).toHaveBeenCalledWith('me', CLIENT);
  });
});
