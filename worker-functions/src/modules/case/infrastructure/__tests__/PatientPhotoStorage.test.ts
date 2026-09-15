/**
 * PatientPhotoStorage — unit com `@google-cloud/storage` mockado na fronteira (sem rede real).
 * Prova: (a) fail-closed sem env, (b) nome UUID sem patient_id/nome original, (c) 404 no delete
 * não lança, outro erro lança, (d) URL de leitura v4/300s, (e) `GCS_EMULATOR_HOST` vira
 * `apiEndpoint` do cliente real (não `STORAGE_EMULATOR_HOST` — achado medido em integração real
 * contra fake-gcs-server, docker, spec 018 PR-4: essa env é lida pelo PRÓPRIO SDK no construtor e
 * derruba o `/storage/v1` do `baseUrl`, quebrando `delete()` com 405. Por isso este código usa um
 * nome de env PRÓPRIO e passa `apiEndpoint` explícito).
 */
const fileSave = jest.fn(async () => undefined);
const fileDelete = jest.fn(async () => undefined);
const fileGetSignedUrl = jest.fn(async (_opts: { version: string; action: string; expires: number }) => ['https://signed.example/photo']);
const fileFn = jest.fn(() => ({ save: fileSave, delete: fileDelete, getSignedUrl: fileGetSignedUrl }));
const bucketFn = jest.fn(() => ({ file: fileFn }));
const StorageCtor = jest.fn().mockImplementation((opts?: unknown) => ({ __opts: opts, bucket: bucketFn }));
jest.mock('@google-cloud/storage', () => ({ Storage: StorageCtor }));

import { PatientPhotoStorage, PatientPhotoBucketNotConfiguredError } from '../PatientPhotoStorage';

const ORIGINAL_ENV = { ...process.env };

describe('PatientPhotoStorage (spec 018 PR-4, lex-pr4-foto)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...ORIGINAL_ENV };
    delete process.env.GCS_PATIENT_PHOTOS_BUCKET;
    delete process.env.GCS_EMULATOR_HOST;
    delete process.env.GCP_PROJECT_ID;
  });

  it('lança PatientPhotoBucketNotConfiguredError sem GCS_PATIENT_PHOTOS_BUCKET — fail-closed', () => {
    expect(() => new PatientPhotoStorage()).toThrow(PatientPhotoBucketNotConfiguredError);
  });

  it('uploadBuffer grava com nome UUID.jpg, cacheControl private/no-store, sem patient_id no caminho', async () => {
    process.env.GCS_PATIENT_PHOTOS_BUCKET = 'enlite-patient-photos-stg';
    const client = { bucket: bucketFn } as never;
    const storage = new PatientPhotoStorage(client);

    const { objectPath } = await storage.uploadBuffer(Buffer.from('jpeg-bytes'), 'image/jpeg');

    expect(objectPath).toMatch(/^[0-9a-f-]{36}\.jpg$/);
    expect(bucketFn).toHaveBeenCalledWith('enlite-patient-photos-stg');
    expect(fileSave).toHaveBeenCalledWith(
      Buffer.from('jpeg-bytes'),
      expect.objectContaining({ metadata: expect.objectContaining({ contentType: 'image/jpeg', cacheControl: expect.stringContaining('no-store') }) }),
    );
  });

  it('delete: 404 não lança (já não existe = sucesso do ponto de vista do chamador)', async () => {
    process.env.GCS_PATIENT_PHOTOS_BUCKET = 'b';
    fileDelete.mockRejectedValueOnce(Object.assign(new Error('not found'), { code: 404 }));
    const storage = new PatientPhotoStorage({ bucket: bucketFn } as never);
    await expect(storage.delete('x.jpg')).resolves.toBeUndefined();
  });

  it('delete: erro diferente de 404 propaga (chamador decide órfão)', async () => {
    process.env.GCS_PATIENT_PHOTOS_BUCKET = 'b';
    fileDelete.mockRejectedValueOnce(Object.assign(new Error('permission denied'), { code: 403 }));
    const storage = new PatientPhotoStorage({ bucket: bucketFn } as never);
    await expect(storage.delete('x.jpg')).rejects.toThrow('permission denied');
  });

  it('getReadSignedUrl: v4, read, 300s', async () => {
    process.env.GCS_PATIENT_PHOTOS_BUCKET = 'b';
    const storage = new PatientPhotoStorage({ bucket: bucketFn } as never);
    const before = Date.now();
    const url = await storage.getReadSignedUrl('x.jpg');
    expect(url).toBe('https://signed.example/photo');
    const call = fileGetSignedUrl.mock.calls[0][0] as { version: string; action: string; expires: number };
    expect(call.version).toBe('v4');
    expect(call.action).toBe('read');
    expect(call.expires).toBeGreaterThanOrEqual(before + 299_000);
    expect(call.expires).toBeLessThanOrEqual(before + 301_000);
  });

  // `sharedClient` é singleton de MÓDULO (1 cliente por processo) — `jest.resetModules` +
  // `require` isolado em cada teste evita que o cache de um teste vaze pro outro.
  it('sem client explícito e sem GCS_EMULATOR_HOST/GCP_PROJECT_ID, Storage real é construído sem argumento', () => {
    jest.resetModules();
    process.env.GCS_PATIENT_PHOTOS_BUCKET = 'b';
    // eslint-disable-next-line @typescript-eslint/no-var-requires -- isolamento de singleton de módulo
    const { PatientPhotoStorage: Isolated } = require('../PatientPhotoStorage');
    // eslint-disable-next-line no-new -- só prova a construção do client default
    new Isolated();
    expect(StorageCtor).toHaveBeenCalledWith(undefined);
  });

  it('com GCP_PROJECT_ID (sem emulador), Storage real recebe { projectId }', () => {
    jest.resetModules();
    process.env.GCS_PATIENT_PHOTOS_BUCKET = 'b';
    process.env.GCP_PROJECT_ID = 'enlite-test';
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { PatientPhotoStorage: Isolated } = require('../PatientPhotoStorage');
    // eslint-disable-next-line no-new
    new Isolated();
    expect(StorageCtor).toHaveBeenCalledWith({ projectId: 'enlite-test' });
  });

  it('com GCS_EMULATOR_HOST, Storage real recebe apiEndpoint (preserva /storage/v1 no baseUrl do SDK)', () => {
    jest.resetModules();
    process.env.GCS_PATIENT_PHOTOS_BUCKET = 'b';
    process.env.GCS_EMULATOR_HOST = 'http://fake-gcs:4443';
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { PatientPhotoStorage: Isolated } = require('../PatientPhotoStorage');
    // eslint-disable-next-line no-new
    new Isolated();
    expect(StorageCtor).toHaveBeenCalledWith({ apiEndpoint: 'http://fake-gcs:4443', projectId: 'enlite-test' });
  });
});
