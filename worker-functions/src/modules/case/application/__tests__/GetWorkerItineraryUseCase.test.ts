const mockClient = { query: jest.fn() };
jest.mock('@shared/database/actorContext', () => ({
  withActorContext: jest.fn((_pool: unknown, fn: (c: unknown) => Promise<unknown>) => fn(mockClient)),
}));
const mockRead = jest.fn();
jest.mock('../../infrastructure/WorkerItineraryReader', () => ({ readWorkerWindow: (...a: unknown[]) => mockRead(...a) }));

import type { Pool } from 'pg';
import { withActorContext } from '@shared/database/actorContext';
import { GetWorkerItineraryUseCase, AccountInactiveError } from '../GetWorkerItineraryUseCase';

const W = '11111111-1111-4111-8111-111111111111';
const ENVELOPE = { worker_id: W, items: [], tombstones: [], cursor: 'c', full: true };
const pool = {} as Pool;

describe('GetWorkerItineraryUseCase', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRead.mockResolvedValue(ENVELOPE);
  });

  it('sucesso: resolve workers.id por auth_uid via withActorContext e devolve o envelope', async () => {
    mockClient.query.mockResolvedValueOnce({ rows: [{ id: W, status: 'REGISTERED' }] });
    const out = await new GetWorkerItineraryUseCase(pool).execute({ uid: 'uid-1', today: '2026-10-29' });
    expect(out).toBe(ENVELOPE);
    expect(withActorContext).toHaveBeenCalledTimes(1);
    expect(mockClient.query.mock.calls[0][1]).toEqual(['uid-1']);
    expect(mockRead).toHaveBeenCalledWith(mockClient, { workerId: W, today: '2026-10-29' });
  });

  it('worker inativo (DISABLED) -> AccountInactiveError e não lê a janela', async () => {
    mockClient.query.mockResolvedValueOnce({ rows: [{ id: W, status: 'DISABLED' }] });
    await expect(new GetWorkerItineraryUseCase(pool).execute({ uid: 'uid-1', today: '2026-10-29' })).rejects.toBeInstanceOf(AccountInactiveError);
    expect(mockRead).not.toHaveBeenCalled();
  });

  it('sem worker para o uid -> AccountInactiveError e não lê a janela', async () => {
    mockClient.query.mockResolvedValueOnce({ rows: [] });
    await expect(new GetWorkerItineraryUseCase(pool).execute({ uid: 'x', today: '2026-10-29' })).rejects.toBeInstanceOf(AccountInactiveError);
    expect(mockRead).not.toHaveBeenCalled();
  });

  it('INCOMPLETE_REGISTER conta como ativo (só DISABLED é inativo)', async () => {
    mockClient.query.mockResolvedValueOnce({ rows: [{ id: W, status: 'INCOMPLETE_REGISTER' }] });
    await expect(new GetWorkerItineraryUseCase(pool).execute({ uid: 'uid-1', today: '2026-10-29' })).resolves.toBe(ENVELOPE);
  });
});
