import {
  ConfirmWorkerProfileUpdateUseCase,
  PendingChangeNotFoundError,
} from '../ConfirmWorkerProfileUpdateUseCase';
import type {
  PendingProfileChangeRepository,
  PendingProfileChangeRecord,
} from '../../infrastructure/PendingProfileChangeRepository';
import type { UpdateWorkerProfileFieldsUseCase } from '../UpdateWorkerProfileFieldsUseCase';
import type { KMSEncryptionService } from '@shared/security/KMSEncryptionService';

const WORKER_ID = '123e4567-e89b-12d3-a456-426614174000';
const HANDLE = '223e4567-e89b-12d3-a456-426614174999';

function makeRecord(): PendingProfileChangeRecord {
  return {
    id: HANDLE,
    workerId: WORKER_ID,
    conversationRef: 'conv-1',
    payloadEncrypted: 'ENC',
    fieldNames: ['documentType', 'documentNumber'],
    status: 'pending',
    createdAt: new Date('2026-06-01T00:00:00.000Z'),
    expiresAt: new Date('2026-06-01T00:05:00.000Z'),
  };
}

interface Mocks {
  pending: jest.Mocked<Pick<PendingProfileChangeRepository, 'findActive' | 'markConsumed'>>;
  kms: jest.Mocked<Pick<KMSEncryptionService, 'decrypt'>>;
  update: jest.Mocked<Pick<UpdateWorkerProfileFieldsUseCase, 'execute'>>;
}

function makeMocks(over: Partial<Mocks> = {}): Mocks {
  return {
    pending: {
      findActive: jest.fn().mockResolvedValue(makeRecord()),
      markConsumed: jest.fn().mockResolvedValue(true),
      ...over.pending,
    } as Mocks['pending'],
    kms: {
      decrypt: jest
        .fn()
        .mockResolvedValue(JSON.stringify({ documentType: 'DNI', documentNumber: '12345678' })),
      ...over.kms,
    } as Mocks['kms'],
    update: {
      execute: jest
        .fn()
        .mockResolvedValue({ workerId: WORKER_ID, fieldsUpdated: ['documentType', 'documentNumber'] }),
      ...over.update,
    } as Mocks['update'],
  };
}

function makeUseCase(m: Mocks): ConfirmWorkerProfileUpdateUseCase {
  return new ConfirmWorkerProfileUpdateUseCase(
    m.pending as unknown as PendingProfileChangeRepository,
    m.kms as unknown as KMSEncryptionService,
    m.update as unknown as UpdateWorkerProfileFieldsUseCase,
  );
}

describe('ConfirmWorkerProfileUpdateUseCase', () => {
  beforeEach(() => jest.clearAllMocks());

  it('applies the staged value with luz_conversation attribution', async () => {
    const m = makeMocks();
    const uc = makeUseCase(m);

    const result = await uc.execute({ workerId: WORKER_ID, handle: HANDLE });

    // applies EXACTLY the decrypted staged fields — Luz passes no value here;
    // the source trail is written by the update use case in the same transaction
    expect(m.update.execute).toHaveBeenCalledWith(
      {
        workerId: WORKER_ID,
        documentType: 'DNI',
        documentNumber: '12345678',
      },
      {
        source: 'luz_conversation',
        actorUid: 'luz:profile-confirm',
        conversationRef: 'conv-1',
        pendingChangeId: HANDLE,
      },
    );
    expect(result).toMatchObject({ applied: true, fieldsUpdated: expect.any(Array) });
  });

  it('caller-provided conversationRef and source take precedence', async () => {
    const m = makeMocks();
    const uc = makeUseCase(m);

    await uc.execute({
      workerId: WORKER_ID,
      handle: HANDLE,
      conversationRef: 'conv-override',
      source: 'luz_conversation',
    });

    expect(m.update.execute).toHaveBeenCalledWith(
      expect.objectContaining({ workerId: WORKER_ID }),
      expect.objectContaining({
        source: 'luz_conversation',
        conversationRef: 'conv-override',
      }),
    );
  });

  it('claims (markConsumed) BEFORE applying — idempotency ordering', async () => {
    const m = makeMocks();
    const uc = makeUseCase(m);
    await uc.execute({ workerId: WORKER_ID, handle: HANDLE });

    const consumeOrder = m.pending.markConsumed.mock.invocationCallOrder[0];
    const applyOrder = m.update.execute.mock.invocationCallOrder[0];
    expect(consumeOrder).toBeLessThan(applyOrder);
  });

  it('throws when no active pending change exists', async () => {
    const m = makeMocks({ pending: { findActive: jest.fn().mockResolvedValue(null) } as never });
    const uc = makeUseCase(m);
    await expect(uc.execute({ workerId: WORKER_ID })).rejects.toBeInstanceOf(
      PendingChangeNotFoundError,
    );
    expect(m.update.execute).not.toHaveBeenCalled();
  });

  it('throws (and does NOT apply) when the change was already consumed concurrently', async () => {
    const m = makeMocks({
      pending: {
        findActive: jest.fn().mockResolvedValue(makeRecord()),
        markConsumed: jest.fn().mockResolvedValue(false),
      } as never,
    });
    const uc = makeUseCase(m);
    await expect(uc.execute({ workerId: WORKER_ID, handle: HANDLE })).rejects.toBeInstanceOf(
      PendingChangeNotFoundError,
    );
    expect(m.update.execute).not.toHaveBeenCalled();
  });
});
