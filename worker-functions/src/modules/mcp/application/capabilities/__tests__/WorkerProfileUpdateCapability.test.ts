import { WorkerProfileUpdateCapability } from '../WorkerProfileUpdateCapability';
import type { UpdateWorkerProfileFieldsUseCase } from '@modules/worker/application/UpdateWorkerProfileFieldsUseCase';

// ── Helpers ───────────────────────────────────────────────────────────────────

const WORKER_ID = '123e4567-e89b-12d3-a456-426614174000';

function makeUseCase(
  result?: { workerId: string; fieldsUpdated: string[] },
  throws?: Error,
): jest.Mocked<Pick<UpdateWorkerProfileFieldsUseCase, 'execute'>> {
  return {
    execute: throws
      ? jest.fn().mockRejectedValue(throws)
      : jest.fn().mockResolvedValue(
          result ?? { workerId: WORKER_ID, fieldsUpdated: ['firstName'] },
        ),
  };
}

function makeCap(
  useCase: jest.Mocked<Pick<UpdateWorkerProfileFieldsUseCase, 'execute'>>,
): WorkerProfileUpdateCapability {
  return new WorkerProfileUpdateCapability(
    useCase as unknown as UpdateWorkerProfileFieldsUseCase,
  );
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('WorkerProfileUpdateCapability', () => {
  beforeEach(() => jest.clearAllMocks());

  // Static metadata
  it('NAME is worker.profile.update', () => {
    expect(WorkerProfileUpdateCapability.NAME).toBe('worker.profile.update');
  });

  it('DESCRIPTION is a non-empty string', () => {
    expect(typeof WorkerProfileUpdateCapability.DESCRIPTION).toBe('string');
    expect(WorkerProfileUpdateCapability.DESCRIPTION.length).toBeGreaterThan(0);
  });

  it('INPUT_SHAPE has workerId and fields', () => {
    expect(WorkerProfileUpdateCapability.INPUT_SHAPE).toHaveProperty('workerId');
    expect(WorkerProfileUpdateCapability.INPUT_SHAPE).toHaveProperty('fields');
  });

  // 1. Happy path: firstName + lastName
  it('happy path: firstName + lastName → useCase called, returns updated=true with fieldsUpdated', async () => {
    const useCase = makeUseCase({ workerId: WORKER_ID, fieldsUpdated: ['firstName', 'lastName'] });
    const cap = makeCap(useCase);

    const result = await cap.execute({
      workerId: WORKER_ID,
      fields: { firstName: 'Ana', lastName: 'Silva' },
    });

    expect(useCase.execute).toHaveBeenCalledWith(
      expect.objectContaining({ workerId: WORKER_ID, firstName: 'Ana', lastName: 'Silva' }),
    );
    expect(result).toEqual({
      updated: true,
      workerId: WORKER_ID,
      fieldsUpdated: ['firstName', 'lastName'],
    });
  });

  // 2. Zod strict rejects phone (not in whitelist)
  it('Zod rejects phone field (not in whitelist)', async () => {
    const useCase = makeUseCase();
    const cap = makeCap(useCase);

    await expect(
      cap.execute({ workerId: WORKER_ID, fields: { phone: '+5511999999999' } }),
    ).rejects.toThrow();
    expect(useCase.execute).not.toHaveBeenCalled();
  });

  // 3. Zod strict rejects status
  it('Zod rejects status field (not in whitelist)', async () => {
    const useCase = makeUseCase();
    const cap = makeCap(useCase);

    await expect(
      cap.execute({ workerId: WORKER_ID, fields: { status: 'REGISTERED' } }),
    ).rejects.toThrow();
    expect(useCase.execute).not.toHaveBeenCalled();
  });

  // 4. Zod strict rejects bankAccount
  it('Zod rejects bankAccount field (strict mode)', async () => {
    const useCase = makeUseCase();
    const cap = makeCap(useCase);

    await expect(
      cap.execute({ workerId: WORKER_ID, fields: { bankAccount: '12345-6' } }),
    ).rejects.toThrow();
    expect(useCase.execute).not.toHaveBeenCalled();
  });

  // 5. cpf valid accepted; invalid rejected
  it('valid cpf is accepted', async () => {
    const useCase = makeUseCase({ workerId: WORKER_ID, fieldsUpdated: ['cpf'] });
    const cap = makeCap(useCase);

    await expect(
      cap.execute({ workerId: WORKER_ID, fields: { cpf: '123.456.789-01' } }),
    ).resolves.toMatchObject({ updated: true });
  });

  it('invalid cpf (too short) is rejected by Zod', async () => {
    const useCase = makeUseCase();
    const cap = makeCap(useCase);

    await expect(
      cap.execute({ workerId: WORKER_ID, fields: { cpf: '123' } }),
    ).rejects.toThrow();
    expect(useCase.execute).not.toHaveBeenCalled();
  });

  // 6. address partial accepted; address with invalid key rejected
  it('partial address is accepted', async () => {
    const useCase = makeUseCase({ workerId: WORKER_ID, fieldsUpdated: ['address'] });
    const cap = makeCap(useCase);

    await expect(
      cap.execute({
        workerId: WORKER_ID,
        fields: { address: { city: 'São Paulo', state: 'SP' } },
      }),
    ).resolves.toMatchObject({ updated: true });
  });

  it('address with unknown key is rejected (strict mode)', async () => {
    const useCase = makeUseCase();
    const cap = makeCap(useCase);

    await expect(
      cap.execute({
        workerId: WORKER_ID,
        fields: { address: { city: 'SP', unknownKey: 'x' } },
      }),
    ).rejects.toThrow();
    expect(useCase.execute).not.toHaveBeenCalled();
  });

  // 7. email invalid rejected
  it('invalid email is rejected by Zod', async () => {
    const useCase = makeUseCase();
    const cap = makeCap(useCase);

    await expect(
      cap.execute({ workerId: WORKER_ID, fields: { email: 'not-an-email' } }),
    ).rejects.toThrow();
    expect(useCase.execute).not.toHaveBeenCalled();
  });

  it('valid email is accepted', async () => {
    const useCase = makeUseCase({ workerId: WORKER_ID, fieldsUpdated: ['email'] });
    const cap = makeCap(useCase);

    await expect(
      cap.execute({ workerId: WORKER_ID, fields: { email: 'ana@example.com' } }),
    ).resolves.toMatchObject({ updated: true });
  });

  // 8. Empty fields object → error
  it('empty fields object throws "At least one field must be provided"', async () => {
    const useCase = makeUseCase();
    const cap = makeCap(useCase);

    await expect(
      cap.execute({ workerId: WORKER_ID, fields: {} }),
    ).rejects.toThrow('At least one field must be provided');
    expect(useCase.execute).not.toHaveBeenCalled();
  });

  // 9. UseCase failure propagates
  it('propagates error from use case', async () => {
    const useCase = makeUseCase(undefined, new Error('Worker not found: uuid'));
    const cap = makeCap(useCase);

    await expect(
      cap.execute({ workerId: WORKER_ID, fields: { firstName: 'Ana' } }),
    ).rejects.toThrow('Worker not found: uuid');
  });

  // 10. Invalid workerId (not a UUID) rejected
  it('invalid workerId rejects with ZodError', async () => {
    const useCase = makeUseCase();
    const cap = makeCap(useCase);

    await expect(
      cap.execute({ workerId: 'not-a-uuid', fields: { firstName: 'Ana' } }),
    ).rejects.toThrow();
    expect(useCase.execute).not.toHaveBeenCalled();
  });
});
