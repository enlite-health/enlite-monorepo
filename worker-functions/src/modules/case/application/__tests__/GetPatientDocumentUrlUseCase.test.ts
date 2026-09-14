jest.mock('@shared/database/DatabaseConnection', () => ({
  DatabaseConnection: { getInstance: () => ({ getPool: () => ({ query: jest.fn(async () => ({ rows: [] })) }) }) },
}));
jest.mock('@google-cloud/storage', () => ({
  Storage: jest.fn().mockImplementation(() => ({ bucket: () => ({ file: () => ({}) }) })),
}));

import { GetPatientDocumentUrlUseCase } from '../GetPatientDocumentUrlUseCase';

const PID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const DID = 'cccccccc-bbbb-cccc-dddd-eeeeeeeeeeee';

describe('GetPatientDocumentUrlUseCase (C10 — legível mesmo após revogação)', () => {
  it('sem documento — null', async () => {
    const repo = { findOne: jest.fn(async () => null) };
    const uc = new GetPatientDocumentUrlUseCase({} as never, repo as never, {} as never);
    await expect(uc.execute(PID, DID)).resolves.toBeNull();
  });

  it('com documento — decifra e assina, 300s; não filtra por revogação', async () => {
    const repo = { findOne: jest.fn(async () => ({ object_path_encrypted: 'enc(patient-documents/x)' })) };
    const storage = { getReadSignedUrl: jest.fn(async () => 'https://signed/doc') };
    const enc = { decrypt: jest.fn(async (v: string) => v.replace(/^enc\(|\)$/g, '')) };
    const uc = new GetPatientDocumentUrlUseCase(storage as never, repo as never, enc as never);

    await expect(uc.execute(PID, DID)).resolves.toEqual({ url: 'https://signed/doc', expiresInSeconds: 300 });
    expect(storage.getReadSignedUrl).toHaveBeenCalledWith('patient-documents/x');
    expect(repo.findOne).toHaveBeenCalledWith(PID, DID);
  });

  it('constrói pelos DEFAULTS do construtor', () => {
    process.env.GCS_PATIENT_DOCUMENTS_BUCKET = 'b';
    try {
      // eslint-disable-next-line no-new
      new GetPatientDocumentUrlUseCase();
    } finally {
      delete process.env.GCS_PATIENT_DOCUMENTS_BUCKET;
    }
  });
});
