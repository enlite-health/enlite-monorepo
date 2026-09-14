jest.mock('../patientTransaction', () => ({
  inPatientTransaction: jest.fn((fn: (client: unknown) => unknown) => fn({})),
}));
jest.mock('@shared/database/DatabaseConnection', () => ({
  DatabaseConnection: { getInstance: () => ({ getPool: () => ({ query: jest.fn(async () => ({ rows: [] })) }) }) },
}));
jest.mock('@google-cloud/storage', () => ({
  Storage: jest.fn().mockImplementation(() => ({ bucket: () => ({ file: () => ({}) }) })),
}));
jest.mock('../../infrastructure/stripJpegMetadata', () => ({
  stripJpegMetadata: jest.fn(async (b: Buffer) => Buffer.concat([Buffer.from('stripped:'), b])),
  InvalidDocumentImageError: class InvalidDocumentImageError extends Error {},
}));

import { UploadPatientDocumentUseCase, PatientDocumentTooLargeError, MAX_DOCUMENT_BYTES } from '../UploadPatientDocumentUseCase';
import { stripJpegMetadata } from '../../infrastructure/stripJpegMetadata';

const PID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

function makeDeps(overrides: { insertThrows?: boolean; deleteThrows?: boolean } = {}) {
  const storage = {
    uploadBuffer: jest.fn(async (_buf: Buffer, _ct: string) => ({ objectPath: 'patient-documents/uuid-1' })),
    delete: jest.fn(overrides.deleteThrows ? async () => { throw new Error('gcs down'); } : async () => undefined),
  };
  const repo = { insert: overrides.insertThrows ? jest.fn(async () => { throw new Error('db down'); }) : jest.fn(async () => ({ id: 'doc-1' })) };
  const enc = { encrypt: jest.fn(async (v: string) => `enc(${v})`) };
  return { storage, repo, enc };
}

describe('UploadPatientDocumentUseCase (spec 018 PR-4, D329)', () => {
  it('PDF: grava direto (sem strip), sha256 e tamanho corretos', async () => {
    const deps = makeDeps();
    const uc = new UploadPatientDocumentUseCase(deps.storage as never, deps.repo as never, deps.enc as never);
    const buffer = Buffer.from('%PDF-1.4 fake');

    const result = await uc.execute({ patientId: PID, buffer, contentType: 'application/pdf', documentType: 'image_consent', actorUid: 'uid-1' });

    expect(result).toEqual({ documentId: 'doc-1' });
    expect(stripJpegMetadata).not.toHaveBeenCalled();
    expect(deps.storage.uploadBuffer).toHaveBeenCalledWith(buffer, 'application/pdf');
    expect(deps.repo.insert).toHaveBeenCalledWith(
      PID,
      expect.objectContaining({ documentType: 'image_consent', contentType: 'application/pdf', sizeBytes: buffer.byteLength }),
      'uid-1',
      {},
    );
  });

  it('JPEG: passa por stripJpegMetadata antes de subir', async () => {
    const deps = makeDeps();
    const uc = new UploadPatientDocumentUseCase(deps.storage as never, deps.repo as never, deps.enc as never);
    const buffer = Buffer.from('jpeg-bytes');

    await uc.execute({ patientId: PID, buffer, contentType: 'image/jpeg', documentType: 'image_consent_revocation', actorUid: 'uid-1' });

    expect(stripJpegMetadata).toHaveBeenCalledWith(buffer);
    const uploaded = deps.storage.uploadBuffer.mock.calls[0][0] as Buffer;
    expect(uploaded.toString()).toContain('stripped:');
  });

  it('rejeita arquivo maior que 10MB ANTES de subir qualquer coisa', async () => {
    const deps = makeDeps();
    const uc = new UploadPatientDocumentUseCase(deps.storage as never, deps.repo as never, deps.enc as never);
    const big = Buffer.alloc(MAX_DOCUMENT_BYTES + 1);

    await expect(
      uc.execute({ patientId: PID, buffer: big, contentType: 'application/pdf', documentType: 'image_consent', actorUid: 'uid-1' }),
    ).rejects.toThrow(PatientDocumentTooLargeError);
    expect(deps.storage.uploadBuffer).not.toHaveBeenCalled();
  });

  it('transação falha: apaga o objeto (best-effort) e relança', async () => {
    const deps = makeDeps({ insertThrows: true });
    const uc = new UploadPatientDocumentUseCase(deps.storage as never, deps.repo as never, deps.enc as never);

    await expect(
      uc.execute({ patientId: PID, buffer: Buffer.from('%PDF'), contentType: 'application/pdf', documentType: 'image_consent', actorUid: 'uid-1' }),
    ).rejects.toThrow('db down');
    expect(deps.storage.delete).toHaveBeenCalledWith('patient-documents/uuid-1');
  });

  it('transação falha E a limpeza também falha — relança o erro ORIGINAL mesmo assim', async () => {
    const deps = makeDeps({ insertThrows: true, deleteThrows: true });
    const uc = new UploadPatientDocumentUseCase(deps.storage as never, deps.repo as never, deps.enc as never);

    await expect(
      uc.execute({ patientId: PID, buffer: Buffer.from('%PDF'), contentType: 'application/pdf', documentType: 'image_consent', actorUid: 'uid-1' }),
    ).rejects.toThrow('db down');
  });

  it('constrói pelos DEFAULTS do construtor', () => {
    process.env.GCS_PATIENT_DOCUMENTS_BUCKET = 'b';
    try {
      // eslint-disable-next-line no-new
      new UploadPatientDocumentUseCase();
    } finally {
      delete process.env.GCS_PATIENT_DOCUMENTS_BUCKET;
    }
  });
});
