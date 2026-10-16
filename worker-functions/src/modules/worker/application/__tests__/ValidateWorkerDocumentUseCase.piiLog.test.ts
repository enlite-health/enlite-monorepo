const logCalls: unknown[][] = [];
jest.mock('@shared/logging', () => {
  const rec = (...a: unknown[]) => { logCalls.push(a); };
  const fake = { info: rec, warn: rec, error: rec, debug: rec, child: () => fake };
  return { logger: fake };
});

import { ValidateWorkerDocumentUseCase } from '../ValidateWorkerDocumentUseCase';
import { WorkerDocumentsRepository } from '../../infrastructure/WorkerDocumentsRepository';

const SENTINEL = 'sentinela.zz@exemplo.test';
const MASKED = '***@exemplo.test';
const logged = () => JSON.stringify(logCalls);

describe('PII: e-mail do funcionário não vai em claro ao log da validação de documento', () => {
  beforeEach(() => { logCalls.length = 0; });

  it('ValidateWorkerDocumentUseCase: START loga mascarado e o repositório recebe o valor real', async () => {
    const repo = {
      findByWorkerId: jest.fn().mockResolvedValue({ identityDocumentUrl: 'gs://x/y' }),
      validateDocument: jest.fn().mockResolvedValue({}),
    };
    const uc = new ValidateWorkerDocumentUseCase(repo as never);
    await uc.execute({ workerId: 'w1', docType: 'identity_document', adminEmail: SENTINEL });

    expect(logged()).not.toContain(SENTINEL);
    expect(logged()).toContain(MASKED);
    expect(repo.validateDocument).toHaveBeenCalledWith('w1', 'identity_document', SENTINEL);
  });

  it('WorkerDocumentsRepository.validateDocument: loga mascarado e grava o valor real no banco', async () => {
    const pool = { query: jest.fn().mockResolvedValue({ rows: [{ worker_id: 'w1' }] }) };
    const repo = new WorkerDocumentsRepository(pool as never);
    await repo.validateDocument('w1', 'identity_document', SENTINEL);

    expect(logged()).not.toContain(SENTINEL);
    expect(logged()).toContain(MASKED);
    expect(pool.query.mock.calls[0][1]).toEqual(['w1', 'identity_document', SENTINEL]);
  });
});
