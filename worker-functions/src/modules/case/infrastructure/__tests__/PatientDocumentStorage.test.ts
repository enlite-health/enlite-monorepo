/**
 * PatientDocumentStorage — mesmo molde de PatientPhotoStorage.test.ts, bucket SEPARADO. Ver a nota
 * sobre `GCS_EMULATOR_HOST` × `STORAGE_EMULATOR_HOST` lá (achado medido em integração real).
 */
const fileSave = jest.fn(async () => undefined);
const fileDelete = jest.fn(async () => undefined);
const fileGetSignedUrl = jest.fn(async (_opts: { version: string; action: string; expires: number }) => ['https://signed.example/doc']);
const fileFn = jest.fn(() => ({ save: fileSave, delete: fileDelete, getSignedUrl: fileGetSignedUrl }));
const bucketFn = jest.fn(() => ({ file: fileFn }));
const StorageCtor = jest.fn().mockImplementation((opts?: unknown) => ({ __opts: opts, bucket: bucketFn }));
jest.mock('@google-cloud/storage', () => ({ Storage: StorageCtor }));

import { PatientDocumentStorage, PatientDocumentBucketNotConfiguredError } from '../PatientDocumentStorage';

const ORIGINAL_ENV = { ...process.env };

describe('PatientDocumentStorage (spec 018 PR-4, D329)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...ORIGINAL_ENV };
    delete process.env.GCS_PATIENT_DOCUMENTS_BUCKET;
    delete process.env.GCS_EMULATOR_HOST;
    delete process.env.GCP_PROJECT_ID;
  });

  it('lança PatientDocumentBucketNotConfiguredError sem GCS_PATIENT_DOCUMENTS_BUCKET', () => {
    expect(() => new PatientDocumentStorage()).toThrow(PatientDocumentBucketNotConfiguredError);
  });

  it('uploadBuffer grava sob prefixo patient-documents/<uuid>, sem patient_id nem nome original', async () => {
    process.env.GCS_PATIENT_DOCUMENTS_BUCKET = 'enlite-patient-documents-stg';
    const storage = new PatientDocumentStorage({ bucket: bucketFn } as never);

    const { objectPath } = await storage.uploadBuffer(Buffer.from('pdf-bytes'), 'application/pdf');

    expect(objectPath).toMatch(/^patient-documents\/[0-9a-f-]{36}$/);
    expect(bucketFn).toHaveBeenCalledWith('enlite-patient-documents-stg');
    expect(fileSave).toHaveBeenCalledWith(
      Buffer.from('pdf-bytes'),
      expect.objectContaining({ metadata: expect.objectContaining({ contentType: 'application/pdf', cacheControl: 'private, no-store' }) }),
    );
  });

  it('delete: 404 não lança', async () => {
    process.env.GCS_PATIENT_DOCUMENTS_BUCKET = 'b';
    fileDelete.mockRejectedValueOnce(Object.assign(new Error('not found'), { code: 404 }));
    const storage = new PatientDocumentStorage({ bucket: bucketFn } as never);
    await expect(storage.delete('patient-documents/x')).resolves.toBeUndefined();
  });

  it('delete: erro diferente de 404 propaga', async () => {
    process.env.GCS_PATIENT_DOCUMENTS_BUCKET = 'b';
    fileDelete.mockRejectedValueOnce(Object.assign(new Error('boom'), { code: 500 }));
    const storage = new PatientDocumentStorage({ bucket: bucketFn } as never);
    await expect(storage.delete('patient-documents/x')).rejects.toThrow('boom');
  });

  it('getReadSignedUrl: v4, read, 300s — legível independente de revogação (não filtra nada aqui)', async () => {
    process.env.GCS_PATIENT_DOCUMENTS_BUCKET = 'b';
    const storage = new PatientDocumentStorage({ bucket: bucketFn } as never);
    const url = await storage.getReadSignedUrl('patient-documents/x');
    expect(url).toBe('https://signed.example/doc');
    const call = fileGetSignedUrl.mock.calls[0][0];
    expect(call.version).toBe('v4');
    expect(call.action).toBe('read');
  });

  it('sem client explícito e sem GCS_EMULATOR_HOST/GCP_PROJECT_ID, Storage real é construído sem argumento', () => {
    jest.resetModules();
    process.env.GCS_PATIENT_DOCUMENTS_BUCKET = 'b';
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { PatientDocumentStorage: Isolated } = require('../PatientDocumentStorage');
    // eslint-disable-next-line no-new
    new Isolated();
    expect(StorageCtor).toHaveBeenCalledWith(undefined);
  });

  it('com GCP_PROJECT_ID (sem emulador), Storage real recebe { projectId }', () => {
    jest.resetModules();
    process.env.GCS_PATIENT_DOCUMENTS_BUCKET = 'b';
    process.env.GCP_PROJECT_ID = 'enlite-test';
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { PatientDocumentStorage: Isolated } = require('../PatientDocumentStorage');
    // eslint-disable-next-line no-new
    new Isolated();
    expect(StorageCtor).toHaveBeenCalledWith({ projectId: 'enlite-test' });
  });

  it('com GCS_EMULATOR_HOST, Storage real recebe apiEndpoint', () => {
    jest.resetModules();
    process.env.GCS_PATIENT_DOCUMENTS_BUCKET = 'b';
    process.env.GCS_EMULATOR_HOST = 'http://fake-gcs:4443';
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { PatientDocumentStorage: Isolated } = require('../PatientDocumentStorage');
    // eslint-disable-next-line no-new
    new Isolated();
    expect(StorageCtor).toHaveBeenCalledWith({ apiEndpoint: 'http://fake-gcs:4443', projectId: 'enlite-test' });
  });
});
