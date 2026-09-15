jest.mock('../scheduleOpportunisticOrphanRetry', () => ({ scheduleOpportunisticOrphanRetry: jest.fn() }));
jest.mock('../patientTransaction', () => ({
  inPatientTransaction: jest.fn((fn: (client: unknown) => unknown) => fn({})),
}));
jest.mock('@shared/database/DatabaseConnection', () => ({
  DatabaseConnection: { getInstance: () => ({ getPool: () => ({ query: jest.fn(async () => ({ rows: [] })) }) }) },
}));
jest.mock('@google-cloud/storage', () => ({
  Storage: jest.fn().mockImplementation(() => ({ bucket: () => ({ file: () => ({}) }) })),
}));

import { DeletePatientPhotoUseCase } from '../DeletePatientPhotoUseCase';

const PID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

describe('DeletePatientPhotoUseCase', () => {
  it('sem foto — deleted:false, nada de storage/orphan', async () => {
    const storage = { delete: jest.fn() };
    const photoRepo = { deleteRow: jest.fn(async () => null) };
    const orphanRepo = { record: jest.fn() };
    const enc = { decrypt: jest.fn() };
    const uc = new DeletePatientPhotoUseCase((() => storage) as never, photoRepo as never, orphanRepo as never, enc as never);

    await expect(uc.execute(PID)).resolves.toEqual({ deleted: false });
    expect(storage.delete).not.toHaveBeenCalled();
  });

  it('com foto — apaga a linha e o objeto', async () => {
    const storage = { delete: jest.fn(async () => undefined) };
    const photoRepo = { deleteRow: jest.fn(async () => ({ object_path_encrypted: 'enc(x)' })) };
    const orphanRepo = { record: jest.fn() };
    const enc = { decrypt: jest.fn(async (v: string) => v.replace(/^enc\(|\)$/g, '')) };
    const uc = new DeletePatientPhotoUseCase((() => storage) as never, photoRepo as never, orphanRepo as never, enc as never);

    await expect(uc.execute(PID)).resolves.toEqual({ deleted: true });
    expect(storage.delete).toHaveBeenCalledWith('x');
    expect(orphanRepo.record).not.toHaveBeenCalled();
  });

  it('objeto falha ao apagar — vira órfão DELETE, ainda deleted:true', async () => {
    const storage = { delete: jest.fn(async () => { throw new Error('gcs down'); }) };
    const photoRepo = { deleteRow: jest.fn(async () => ({ object_path_encrypted: 'enc(x)' })) };
    const orphanRepo = { record: jest.fn(async () => ({ id: 'o1' })) };
    const enc = { decrypt: jest.fn(async (v: string) => v) };
    const uc = new DeletePatientPhotoUseCase((() => storage) as never, photoRepo as never, orphanRepo as never, enc as never);

    await expect(uc.execute(PID)).resolves.toEqual({ deleted: true });
    expect(orphanRepo.record).toHaveBeenCalledWith('enc(x)', 'PHOTOS', 'DELETE');
  });

  it('objeto E órfão falham ao registrar — NÃO vira 500 (conserto #3 da 2ª revisão): resolve deleted:true mesmo assim', async () => {
    const storage = { delete: jest.fn(async () => { throw new Error('gcs down'); }) };
    const photoRepo = { deleteRow: jest.fn(async () => ({ object_path_encrypted: 'enc(x)' })) };
    const orphanRepo = { record: jest.fn(async () => { throw new Error('db down também'); }) };
    const enc = { decrypt: jest.fn(async (v: string) => v) };
    const uc = new DeletePatientPhotoUseCase((() => storage) as never, photoRepo as never, orphanRepo as never, enc as never);

    await expect(uc.execute(PID)).resolves.toEqual({ deleted: true });
    expect(orphanRepo.record).toHaveBeenCalledWith('enc(x)', 'PHOTOS', 'DELETE');
  });

  it('constrói pelos DEFAULTS do construtor', () => {
    process.env.GCS_PATIENT_PHOTOS_BUCKET = 'b';
    try {
      // eslint-disable-next-line no-new
      new DeletePatientPhotoUseCase();
    } finally {
      delete process.env.GCS_PATIENT_PHOTOS_BUCKET;
    }
  });

  it('SEM GCS_PATIENT_PHOTOS_BUCKET: construir o use case NÃO lança (fábrica é preguiçosa — achado item 1 da revisão: boot não cai sem env)', () => {
    delete process.env.GCS_PATIENT_PHOTOS_BUCKET;
    expect(() => new DeletePatientPhotoUseCase()).not.toThrow();
  });

  it('SEM GCS_PATIENT_PHOTOS_BUCKET, mas COM foto para apagar: só falha ao tentar de fato usar o storage', async () => {
    delete process.env.GCS_PATIENT_PHOTOS_BUCKET;
    const photoRepo = { deleteRow: jest.fn(async () => ({ object_path_encrypted: 'enc(x)' })) };
    const enc = { decrypt: jest.fn(async (v: string) => v.replace(/^enc\(|\)$/g, '')) };
    const orphanRepo = { record: jest.fn() };
    const uc = new DeletePatientPhotoUseCase(undefined, photoRepo as never, orphanRepo as never, enc as never);

    await expect(uc.execute(PID)).rejects.toThrow('GCS_PATIENT_PHOTOS_BUCKET não configurado');
  });
});
