import { WorkerProfileProposeUpdateCapability } from '../WorkerProfileProposeUpdateCapability';
import type { ProposeWorkerProfileUpdateUseCase } from '@modules/worker/application/ProposeWorkerProfileUpdateUseCase';

const WORKER_ID = '123e4567-e89b-12d3-a456-426614174000';

function makeUseCase(): jest.Mocked<Pick<ProposeWorkerProfileUpdateUseCase, 'execute'>> {
  return {
    execute: jest.fn().mockResolvedValue({
      handle: '223e4567-e89b-12d3-a456-426614174999',
      expiresAt: '2026-06-01T00:05:00.000Z',
      summary: [{ field: 'firstName', newValue: 'Ana' }],
    }),
  };
}

function makeCap(
  useCase: jest.Mocked<Pick<ProposeWorkerProfileUpdateUseCase, 'execute'>>,
): WorkerProfileProposeUpdateCapability {
  return new WorkerProfileProposeUpdateCapability(
    useCase as unknown as ProposeWorkerProfileUpdateUseCase,
  );
}

describe('WorkerProfileProposeUpdateCapability', () => {
  beforeEach(() => jest.clearAllMocks());

  it('NAME is worker.profile.proposeUpdate', () => {
    expect(WorkerProfileProposeUpdateCapability.NAME).toBe('worker.profile.proposeUpdate');
  });

  it('happy path: firstName → delegates and returns handle + summary', async () => {
    const useCase = makeUseCase();
    const cap = makeCap(useCase);

    const result = await cap.execute({ workerId: WORKER_ID, fields: { firstName: 'Ana' } });

    expect(useCase.execute).toHaveBeenCalledWith(
      expect.objectContaining({ workerId: WORKER_ID, fields: { firstName: 'Ana' } }),
    );
    expect(result).toMatchObject({ handle: expect.any(String), summary: expect.any(Array) });
  });

  // ── Login fields are NEVER editable here ──────────────────────────────────────
  it('rejects email (login field → handover)', async () => {
    const useCase = makeUseCase();
    const cap = makeCap(useCase);
    await expect(
      cap.execute({ workerId: WORKER_ID, fields: { email: 'a@b.com' } }),
    ).rejects.toThrow();
    expect(useCase.execute).not.toHaveBeenCalled();
  });

  it('rejects phone (identifier → handover)', async () => {
    const useCase = makeUseCase();
    const cap = makeCap(useCase);
    await expect(
      cap.execute({ workerId: WORKER_ID, fields: { phone: '+5491122223333' } }),
    ).rejects.toThrow();
    expect(useCase.execute).not.toHaveBeenCalled();
  });

  // ── Document validation by type (Latam) ───────────────────────────────────────
  it('documentNumber without documentType is rejected', async () => {
    const useCase = makeUseCase();
    const cap = makeCap(useCase);
    await expect(
      cap.execute({ workerId: WORKER_ID, fields: { documentNumber: '12345678' } }),
    ).rejects.toThrow();
    expect(useCase.execute).not.toHaveBeenCalled();
  });

  it('valid DNI (8 digits) is accepted', async () => {
    const useCase = makeUseCase();
    const cap = makeCap(useCase);
    await expect(
      cap.execute({
        workerId: WORKER_ID,
        fields: { documentType: 'DNI', documentNumber: '12345678' },
      }),
    ).resolves.toMatchObject({ handle: expect.any(String) });
  });

  it('DNI with letters is rejected (format per type)', async () => {
    const useCase = makeUseCase();
    const cap = makeCap(useCase);
    await expect(
      cap.execute({
        workerId: WORKER_ID,
        fields: { documentType: 'DNI', documentNumber: 'AB12345' },
      }),
    ).rejects.toThrow();
    expect(useCase.execute).not.toHaveBeenCalled();
  });

  it('PASSPORT accepts alphanumeric', async () => {
    const useCase = makeUseCase();
    const cap = makeCap(useCase);
    await expect(
      cap.execute({
        workerId: WORKER_ID,
        fields: { documentType: 'PASSPORT', documentNumber: 'AB123456' },
      }),
    ).resolves.toMatchObject({ handle: expect.any(String) });
  });

  it('unknown documentType is rejected by enum', async () => {
    const useCase = makeUseCase();
    const cap = makeCap(useCase);
    await expect(
      cap.execute({
        workerId: WORKER_ID,
        fields: { documentType: 'SSN', documentNumber: '123456789' },
      }),
    ).rejects.toThrow();
    expect(useCase.execute).not.toHaveBeenCalled();
  });

  it('partial address is accepted', async () => {
    const useCase = makeUseCase();
    const cap = makeCap(useCase);
    await expect(
      cap.execute({
        workerId: WORKER_ID,
        fields: { address: { city: 'Buenos Aires', state: 'CABA' } },
      }),
    ).resolves.toMatchObject({ handle: expect.any(String) });
  });

  it('invalid workerId rejects with ZodError', async () => {
    const useCase = makeUseCase();
    const cap = makeCap(useCase);
    await expect(
      cap.execute({ workerId: 'not-a-uuid', fields: { firstName: 'Ana' } }),
    ).rejects.toThrow();
    expect(useCase.execute).not.toHaveBeenCalled();
  });
});
