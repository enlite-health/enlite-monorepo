jest.mock('@shared/database/DatabaseConnection', () => ({
  DatabaseConnection: { getInstance: () => ({ getPool: () => ({ query: jest.fn(async () => ({ rows: [] })) }) }) },
}));
jest.mock('@google-cloud/storage', () => ({
  Storage: jest.fn().mockImplementation(() => ({ bucket: () => ({ file: () => ({}) }) })),
}));

import { GetPatientPhotoUrlUseCase } from '../GetPatientPhotoUrlUseCase';

const PID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

describe('GetPatientPhotoUrlUseCase', () => {
  it('sem foto — null (404 no controller)', async () => {
    const photoRepo = { findOne: jest.fn(async () => null) };
    const storage = { getReadSignedUrl: jest.fn() };
    const uc = new GetPatientPhotoUrlUseCase((() => storage) as never, photoRepo as never, {} as never);
    await expect(uc.execute(PID)).resolves.toBeNull();
    expect(storage.getReadSignedUrl).not.toHaveBeenCalled();
  });

  it('com foto — decifra e assina, 300s', async () => {
    const photoRepo = { findOne: jest.fn(async () => ({ object_path_encrypted: 'enc(x)' })) };
    const storage = { getReadSignedUrl: jest.fn(async () => 'https://signed/x') };
    const enc = { decrypt: jest.fn(async (v: string) => v.replace(/^enc\(|\)$/g, '')) };
    const uc = new GetPatientPhotoUrlUseCase((() => storage) as never, photoRepo as never, enc as never);

    await expect(uc.execute(PID)).resolves.toEqual({ url: 'https://signed/x', expiresInSeconds: 300 });
    expect(storage.getReadSignedUrl).toHaveBeenCalledWith('x');
  });

  it('constrói pelos DEFAULTS do construtor', () => {
    process.env.GCS_PATIENT_PHOTOS_BUCKET = 'b';
    try {
      // eslint-disable-next-line no-new
      new GetPatientPhotoUrlUseCase();
    } finally {
      delete process.env.GCS_PATIENT_PHOTOS_BUCKET;
    }
  });

  it('SEM GCS_PATIENT_PHOTOS_BUCKET: construir NÃO lança (fábrica preguiçosa) — só falha ao ter foto e tentar assinar', async () => {
    delete process.env.GCS_PATIENT_PHOTOS_BUCKET;
    expect(() => new GetPatientPhotoUrlUseCase()).not.toThrow();

    const photoRepo = { findOne: jest.fn(async () => ({ object_path_encrypted: 'enc(x)' })) };
    const enc = { decrypt: jest.fn(async (v: string) => v.replace(/^enc\(|\)$/g, '')) };
    const uc = new GetPatientPhotoUrlUseCase(undefined, photoRepo as never, enc as never);
    await expect(uc.execute(PID)).rejects.toThrow('GCS_PATIENT_PHOTOS_BUCKET não configurado');
  });
});
