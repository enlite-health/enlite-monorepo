import {
  ProposeWorkerProfileUpdateUseCase,
  NoFieldsToUpdateError,
} from '../ProposeWorkerProfileUpdateUseCase';
import type { PendingProfileChangeRepository } from '../../infrastructure/PendingProfileChangeRepository';
import type { KMSEncryptionService } from '@shared/security/KMSEncryptionService';

const WORKER_ID = '123e4567-e89b-12d3-a456-426614174000';

function makePending(): jest.Mocked<Pick<PendingProfileChangeRepository, 'insert'>> {
  return {
    insert: jest.fn().mockResolvedValue({
      id: '223e4567-e89b-12d3-a456-426614174999',
      expiresAt: new Date('2026-06-01T00:05:00.000Z'),
    }),
  };
}

function makeKms(): jest.Mocked<Pick<KMSEncryptionService, 'encrypt'>> {
  return { encrypt: jest.fn().mockResolvedValue('ENCRYPTED_BLOB') };
}

function makeUseCase(
  pending = makePending(),
  kms = makeKms(),
): ProposeWorkerProfileUpdateUseCase {
  return new ProposeWorkerProfileUpdateUseCase(
    pending as unknown as PendingProfileChangeRepository,
    kms as unknown as KMSEncryptionService,
  );
}

describe('ProposeWorkerProfileUpdateUseCase', () => {
  beforeEach(() => jest.clearAllMocks());

  it('encrypts the validated fields blob before staging (no plaintext PII at rest)', async () => {
    const kms = makeKms();
    const pending = makePending();
    const uc = makeUseCase(pending, kms);

    await uc.execute({
      workerId: WORKER_ID,
      fields: { documentType: 'DNI', documentNumber: '12345678' },
    });

    expect(kms.encrypt).toHaveBeenCalledWith(
      JSON.stringify({ documentType: 'DNI', documentNumber: '12345678' }),
    );
    expect(pending.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        workerId: WORKER_ID,
        payloadEncrypted: 'ENCRYPTED_BLOB',
        fieldNames: expect.arrayContaining(['documentType', 'documentNumber']),
      }),
    );
  });

  it('returns handle + summary with the new values for worker confirmation', async () => {
    const uc = makeUseCase();
    const result = await uc.execute({
      workerId: WORKER_ID,
      fields: { firstName: 'Ana', address: { city: 'Buenos Aires' } },
    });

    expect(result.handle).toBe('223e4567-e89b-12d3-a456-426614174999');
    expect(result.summary).toEqual(
      expect.arrayContaining([
        { field: 'firstName', newValue: 'Ana' },
        { field: 'address.city', newValue: 'Buenos Aires' },
      ]),
    );
  });

  it('throws NoFieldsToUpdateError when nothing is provided', async () => {
    const pending = makePending();
    const uc = makeUseCase(pending);
    await expect(uc.execute({ workerId: WORKER_ID, fields: {} })).rejects.toBeInstanceOf(
      NoFieldsToUpdateError,
    );
    expect(pending.insert).not.toHaveBeenCalled();
  });
});
