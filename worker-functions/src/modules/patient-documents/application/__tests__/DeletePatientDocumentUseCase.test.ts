const mockDecrypt = jest.fn(async (v: string | null) => (v ? v.replace(/^enc:/, '') : ''));
jest.mock('@shared/security/KMSEncryptionService', () => ({
  KMSEncryptionService: jest.fn().mockImplementation(() => ({ decrypt: mockDecrypt })),
}));
const mockWithActorContext = jest.fn();
jest.mock('@shared/database/actorContext', () => ({
  withActorContext: (...args: unknown[]) => mockWithActorContext(...args),
}));
const mockLoggerWarn = jest.fn();
jest.mock('@shared/logging', () => ({
  reportError: jest.fn(),
  logger: { warn: (...a: unknown[]) => mockLoggerWarn(...a), info: jest.fn(), error: jest.fn() },
}));

import type { PoolClient } from 'pg';
import { DeletePatientDocumentUseCase } from '../DeletePatientDocumentUseCase';
import { PatientDocumentNotFoundError } from '../../domain/PatientDocument';
import type { ConversationAttachmentStorage } from '@modules/conversation/infrastructure/ConversationAttachmentStorage';
import { POOL, PATIENT_ID, DOC_ID, fakeRepository, runWithActorContext } from './patientDocumentTestKit';

const CLIENT = { query: jest.fn() } as unknown as PoolClient;
let order: string[];

function fakeStorage(del: () => Promise<void> = async () => undefined) {
  return {
    delete: jest.fn(async (path: string) => {
      order.push(`bucket:delete:${path}`);
      await del();
    }),
  } as unknown as ConversationAttachmentStorage & { delete: jest.Mock };
}

beforeEach(() => {
  mockWithActorContext.mockReset();
  mockLoggerWarn.mockClear();
  order = [];
  runWithActorContext(mockWithActorContext, CLIENT, order);
});

describe('DeletePatientDocumentUseCase (FR-014: exclusão definitiva)', () => {
  it('inexistente OU de outro paciente → 404 e o bucket nunca é tocado', async () => {
    const storage = fakeStorage();
    const repo = fakeRepository({ deleteDocument: jest.fn(async () => null) });
    await expect(
      new DeletePatientDocumentUseCase(repo, () => storage).execute(POOL, { patientId: PATIENT_ID, docId: DOC_ID }),
    ).rejects.toBeInstanceOf(PatientDocumentNotFoundError);
    expect(storage.delete).not.toHaveBeenCalled();
  });

  it.each([
    ['aba', { origin: 'tab', storedFileId: null, pathEncrypted: 'enc:patient-documents/a.pdf' }, 'patient-documents/a.pdf'],
    ['chat', { origin: 'chat', storedFileId: 'sf-1', pathEncrypted: 'enc:b.pdf' }, 'b.pdf'],
  ] as const)('origem %s: apaga a linha na transação e SÓ DEPOIS do commit apaga o objeto do bucket', async (_o, deleted, path) => {
    const storage = fakeStorage();
    const repo = fakeRepository({
      deleteDocument: jest.fn(async () => {
        order.push('db:delete');
        return deleted;
      }),
    });

    await new DeletePatientDocumentUseCase(repo, () => storage).execute(POOL, { patientId: PATIENT_ID, docId: DOC_ID });

    expect(repo.deleteDocument).toHaveBeenCalledWith(PATIENT_ID, DOC_ID, CLIENT);
    expect(order).toEqual(['tx:begin', 'db:delete', 'tx:commit', `bucket:delete:${path}`]);
  });

  it('falha no bucket depois do commit NÃO falha a exclusão (a linha já se foi): loga só código/UUID, nunca o caminho', async () => {
    const storage = fakeStorage(async () => {
      throw Object.assign(new Error('boom bucket/patient-documents/segredo.pdf'), { code: 503 });
    });
    const repo = fakeRepository({
      deleteDocument: jest.fn(async () => ({ origin: 'tab' as const, storedFileId: null, pathEncrypted: 'enc:patient-documents/segredo.pdf' })),
    });

    await expect(
      new DeletePatientDocumentUseCase(repo, () => storage).execute(POOL, { patientId: PATIENT_ID, docId: DOC_ID }),
    ).resolves.toBeUndefined();

    expect(mockLoggerWarn).toHaveBeenCalledTimes(1);
    const logged = JSON.stringify(mockLoggerWarn.mock.calls);
    expect(logged).toContain(DOC_ID);
    expect(logged).not.toContain('segredo');
  });

  it('sem caminho para apagar (arquivo do chat já marcado antes) → só a linha sai; bucket intocado', async () => {
    const storage = fakeStorage();
    const repo = fakeRepository({ deleteDocument: jest.fn(async () => ({ origin: 'chat' as const, storedFileId: 'sf-1', pathEncrypted: null })) });
    await new DeletePatientDocumentUseCase(repo, () => storage).execute(POOL, { patientId: PATIENT_ID, docId: DOC_ID });
    expect(storage.delete).not.toHaveBeenCalled();
  });

  it('transação falha → relança e o bucket NÃO é tocado (o objeto não some se a linha ficou)', async () => {
    const storage = fakeStorage();
    const repo = fakeRepository({
      deleteDocument: jest.fn(async () => {
        throw new Error('db caiu');
      }),
    });
    await expect(
      new DeletePatientDocumentUseCase(repo, () => storage).execute(POOL, { patientId: PATIENT_ID, docId: DOC_ID }),
    ).rejects.toThrow('db caiu');
    expect(storage.delete).not.toHaveBeenCalled();
    expect(order).toEqual(['tx:begin', 'tx:rollback']);
  });
});
