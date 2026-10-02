const mockDecrypt = jest.fn(async (v: string | null) => (v ? v.replace(/^enc:/, '') : ''));
jest.mock('@shared/security/KMSEncryptionService', () => ({
  KMSEncryptionService: jest.fn().mockImplementation(() => ({ decrypt: mockDecrypt })),
}));
jest.mock('@shared/logging', () => ({ reportError: jest.fn(), logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn() } }));

import { GetPatientDocumentUrlUseCase } from '../GetPatientDocumentUrlUseCase';
import type { ConversationAttachmentStorage } from '@modules/conversation/infrastructure/ConversationAttachmentStorage';
import { POOL, PATIENT_ID, DOC_ID, fakeRepository } from './patientDocumentTestKit';

function fakeStorage() {
  return { getReadSignedUrl: jest.fn(async () => 'https://signed.example/obj') } as unknown as ConversationAttachmentStorage & {
    getReadSignedUrl: jest.Mock;
  };
}

describe('GetPatientDocumentUrlUseCase (FR-006)', () => {
  it('documento inexistente, de outro paciente ou com arquivo já apagado → null (o controller dá 404, sem distinguir)', async () => {
    const storage = fakeStorage();
    const repo = fakeRepository({ findFileLocation: jest.fn(async () => null) });
    await expect(new GetPatientDocumentUrlUseCase(repo, () => storage).execute(POOL, { patientId: PATIENT_ID, docId: DOC_ID })).resolves.toBeNull();
    expect(storage.getReadSignedUrl).not.toHaveBeenCalled();
  });

  it('feliz: decifra caminho e nome, pede URL assinada de 300 s com o nome ORIGINAL (não o rótulo) no Content-Disposition', async () => {
    const storage = fakeStorage();
    const repo = fakeRepository({
      findFileLocation: jest.fn(async () => ({ pathEncrypted: 'enc:patient-documents/x.pdf', originalNameEncrypted: 'enc:scan0012.pdf' })),
    });

    const out = await new GetPatientDocumentUrlUseCase(repo, () => storage).execute(POOL, { patientId: PATIENT_ID, docId: DOC_ID });

    expect(repo.findFileLocation).toHaveBeenCalledWith(PATIENT_ID, DOC_ID, POOL);
    expect(storage.getReadSignedUrl).toHaveBeenCalledWith('patient-documents/x.pdf', {
      responseDisposition: expect.stringContaining('filename="scan0012.pdf"'),
    });
    expect(out).toEqual({ url: 'https://signed.example/obj', expiresInSeconds: 300 });
  });
});
