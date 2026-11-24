/**
 * Unit — WorkerStatusRepository: fachada fina. A lógica (transação, flow, eventos, C7) é testada em
 * WorkerStatusTransitions.test.ts; aqui só a delegação e o `ctx` repassado intacto.
 */

jest.mock('../WorkerStatusTransitions', () => ({
  recalculate: jest.fn().mockResolvedValue('REGISTERED'),
  setStatus: jest.fn().mockResolvedValue(undefined),
}));

import { recalculateWorkerStatus, updateWorkerStatus } from '../WorkerStatusRepository';
import { recalculate, setStatus } from '../WorkerStatusTransitions';

afterEach(() => jest.clearAllMocks());

describe('WorkerStatusRepository (fachada)', () => {
  it('recalculateWorkerStatus delega a recalculate com o ctx intacto', async () => {
    const pool = {} as never;
    const ctx = { flow: 'WIZARD_STEP', pubsub: null } as const;

    await expect(recalculateWorkerStatus(pool, 'w-1', ctx)).resolves.toBe('REGISTERED');

    expect(recalculate).toHaveBeenCalledWith(pool, 'w-1', ctx);
  });

  it('updateWorkerStatus delega a setStatus com o ctx intacto', async () => {
    const pool = {} as never;
    const ctx = { flow: 'ADMIN_STATUS_CHANGE' } as const;

    await updateWorkerStatus(pool, 'w-2', 'INCOMPLETE_REGISTER', ctx);

    expect(setStatus).toHaveBeenCalledWith(pool, 'w-2', 'INCOMPLETE_REGISTER', ctx);
  });
});
