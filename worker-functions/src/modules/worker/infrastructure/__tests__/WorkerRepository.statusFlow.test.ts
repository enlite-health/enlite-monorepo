/**
 * Spec 093 / T008 — o repositório só repassa o fluxo declarado pelo chamador (não escolhe um fixo),
 * e o import declara WORKER_IMPORT.
 */

const mockRecalculate = jest.fn().mockResolvedValue(null);
const mockSetStatus = jest.fn().mockResolvedValue(undefined);
const mockUpdateFromImport = jest.fn().mockResolvedValue(undefined);

jest.mock('@shared/database/DatabaseConnection', () => ({
  DatabaseConnection: { getInstance: () => ({ getPool: () => ({ query: jest.fn() }) }) },
}));
jest.mock('@shared/security/KMSEncryptionService', () => ({ KMSEncryptionService: jest.fn().mockImplementation(() => ({})) }));
jest.mock('@shared/security/BlindIndexService', () => ({ BlindIndexService: jest.fn().mockImplementation(() => ({})) }));
jest.mock('../WorkerStatusRepository', () => ({
  recalculateWorkerStatus: (...a: unknown[]) => mockRecalculate(...a),
  updateWorkerStatus: (...a: unknown[]) => mockSetStatus(...a),
}));
jest.mock('../WorkerImportRepository', () => ({
  ...jest.requireActual('../WorkerImportRepository'),
  updateFromImport: (...a: unknown[]) => mockUpdateFromImport(...a),
}));

import { WorkerRepository } from '../WorkerRepository';

describe('WorkerRepository — fluxo de status declarado pelo chamador (093)', () => {
  const pubsub = { publish: jest.fn() };
  let repo: WorkerRepository;

  beforeEach(() => {
    jest.clearAllMocks();
    repo = new WorkerRepository(pubsub as never);
  });

  it('recalculateStatus repassa flow e junta o pubsub do repositório', async () => {
    await repo.recalculateStatus('w-1', { flow: 'WIZARD_STEP' });
    expect(mockRecalculate).toHaveBeenCalledWith(expect.anything(), 'w-1', { flow: 'WIZARD_STEP', pubsub });
  });

  it('updateStatus repassa a declaração intacta', async () => {
    await repo.updateStatus('w-1', 'DISABLED', { flow: 'ACCOUNT_DEACTIVATION' });
    expect(mockSetStatus).toHaveBeenCalledWith(expect.anything(), 'w-1', 'DISABLED', { flow: 'ACCOUNT_DEACTIVATION' });
  });

  it('updateFromImport recalcula com WORKER_IMPORT', async () => {
    await repo.updateFromImport('w-1', {} as never);
    const recalcCb = mockUpdateFromImport.mock.calls[0][5] as (id: string) => Promise<unknown>;
    await recalcCb('w-1');
    expect(mockRecalculate).toHaveBeenCalledWith(expect.anything(), 'w-1', { flow: 'WORKER_IMPORT', pubsub });
  });
});
