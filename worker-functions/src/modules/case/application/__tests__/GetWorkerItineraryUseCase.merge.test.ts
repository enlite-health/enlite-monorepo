/**
 * T-F3c-31 — spec 077 F3c (C-47, FR-91): o itinerário segue `merged_into_id`, como `findByAuthUid`.
 * Repositório em dublê; o SQL do resolver real é provado contra Postgres em tests/e2e/077-itinerario-segue-merge.e2e.test.ts.
 */
const mockClient = { query: jest.fn() };
jest.mock('@shared/database/actorContext', () => ({
  withActorContext: jest.fn((_pool: unknown, fn: (c: unknown) => Promise<unknown>) => fn(mockClient)),
}));
const mockRead = jest.fn();
jest.mock('../../infrastructure/WorkerItineraryReader', () => ({ readWorkerWindow: (...a: unknown[]) => mockRead(...a) }));
const mockResolve = jest.fn();
jest.mock('@shared/database/resolveCanonicalWorkerId', () => ({
  resolveCanonicalWorkerId: (...a: unknown[]) => mockResolve(...a),
}));

import type { Pool } from 'pg';
import { GetWorkerItineraryUseCase } from '../GetWorkerItineraryUseCase';

const ABSORBED = '22222222-2222-4222-8222-222222222222';
const SURVIVOR = '33333333-3333-4333-8333-333333333333';
const LIVE = '11111111-1111-4111-8111-111111111111';
const ENVELOPE = { worker_id: SURVIVOR, items: [], tombstones: [], cursor: 'c', full: true };
const pool = {} as Pool;

describe('GetWorkerItineraryUseCase — segue o merge (C-47/FR-91)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockClient.query.mockReset();
    mockResolve.mockReset();
    mockRead.mockResolvedValue(ENVELOPE);
  });

  it('T-F3c-31 uid absorvido numa união cai no itinerário do sobrevivente', async () => {
    mockClient.query
      .mockResolvedValueOnce({ rows: [{ id: ABSORBED, status: 'REGISTERED', merged_into_id: SURVIVOR }] })
      .mockResolvedValueOnce({ rows: [{ status: 'REGISTERED' }] });
    mockResolve.mockResolvedValueOnce(SURVIVOR);

    const out = await new GetWorkerItineraryUseCase(pool).execute({ uid: 'uid-antigo', today: '2026-11-20' });

    expect(out).toBe(ENVELOPE);
    expect(mockResolve).toHaveBeenCalledWith(mockClient, ABSORBED);
    expect(mockRead).toHaveBeenCalledWith(mockClient, { workerId: SURVIVOR, today: '2026-11-20' });
  });

  it('T-F3c-31 uid sem merge lê o itinerário do próprio worker, como hoje', async () => {
    mockClient.query.mockResolvedValueOnce({ rows: [{ id: LIVE, status: 'REGISTERED', merged_into_id: null }] });

    await new GetWorkerItineraryUseCase(pool).execute({ uid: 'uid-1', today: '2026-11-20' });

    expect(mockResolve).not.toHaveBeenCalled();
    expect(mockRead).toHaveBeenCalledWith(mockClient, { workerId: LIVE, today: '2026-11-20' });
  });
});
