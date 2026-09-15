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

import { UploadPatientPhotoUseCase } from '../UploadPatientPhotoUseCase';

const PID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

function makeDeps(overrides: Partial<{
  processResult: { buffer: Buffer; contentType: 'image/jpeg' };
  oldRow: { object_path_encrypted: string } | null;
  vigente: { id: string } | null;
  deleteThrows: boolean;
  insertThrows: boolean;
  orphanRecordThrows: boolean;
}> = {}) {
  const processor = { process: jest.fn(async () => overrides.processResult ?? { buffer: Buffer.from('jpeg'), contentType: 'image/jpeg' }) };
  const storage = {
    uploadBuffer: jest.fn(async () => ({ objectPath: 'new-uuid.jpg' })),
    delete: jest.fn(overrides.deleteThrows ? async () => { throw new Error('gcs down'); } : async () => undefined),
  };
  const photoRepo = {
    deleteRow: jest.fn(async () => overrides.oldRow ?? null),
    insert: overrides.insertThrows ? jest.fn(async () => { throw new Error('db down'); }) : jest.fn(async () => ({ id: 'photo-1' })),
  };
  const orphanRepo = {
    record: overrides.orphanRecordThrows
      ? jest.fn(async () => { throw new Error('orphan insert down'); })
      : jest.fn(async () => ({ id: 'o1' })),
  };
  const consentRepo = { findVigente: jest.fn(async () => overrides.vigente ?? null) };
  const enc = { encrypt: jest.fn(async (v: string) => `enc(${v})`), decrypt: jest.fn(async (v: string) => v.replace(/^enc\(|\)$/g, '')) };
  return { processor, storage, photoRepo, orphanRepo, consentRepo, enc };
}

/** Fábrica que sempre devolve o MESMO mock — prova que `storageFactory` (item 1 da revisão do
 *  PR-4) não muda o comportamento observável, só adia a construção para dentro de `execute()`. */
const storageFactoryOf = (storage: unknown) => (() => storage) as never;

describe('UploadPatientPhotoUseCase (spec 018 PR-4, D335 — sem checagem de consentimento)', () => {
  it('feliz: processa, sobe, troca a linha, sem foto anterior — não apaga nada do storage', async () => {
    const deps = makeDeps();
    const uc = new UploadPatientPhotoUseCase(deps.processor as never, storageFactoryOf(deps.storage), deps.photoRepo as never, deps.orphanRepo as never, deps.consentRepo as never, deps.enc as never);

    const result = await uc.execute({ patientId: PID, buffer: Buffer.from('in'), actorUid: 'uid-1' });

    expect(result).toEqual({ hasPhoto: true });
    expect(deps.storage.uploadBuffer).toHaveBeenCalledWith(Buffer.from('jpeg'), 'image/jpeg');
    expect(deps.photoRepo.insert).toHaveBeenCalledWith(PID, { objectPathEncrypted: 'enc(new-uuid.jpg)', consentId: null }, 'uid-1', {});
    expect(deps.storage.delete).not.toHaveBeenCalled();
  });

  it('anexa consentId quando há consentimento vigente (referência informativa, não bloqueio)', async () => {
    const deps = makeDeps({ vigente: { id: 'consent-1' } });
    const uc = new UploadPatientPhotoUseCase(deps.processor as never, storageFactoryOf(deps.storage), deps.photoRepo as never, deps.orphanRepo as never, deps.consentRepo as never, deps.enc as never);

    await uc.execute({ patientId: PID, buffer: Buffer.from('in'), actorUid: 'uid-1' });

    expect(deps.photoRepo.insert).toHaveBeenCalledWith(PID, expect.objectContaining({ consentId: 'consent-1' }), 'uid-1', {});
  });

  it('troca a foto: apaga o objeto ANTIGO depois do commit', async () => {
    const deps = makeDeps({ oldRow: { object_path_encrypted: 'enc(old-uuid.jpg)' } });
    const uc = new UploadPatientPhotoUseCase(deps.processor as never, storageFactoryOf(deps.storage), deps.photoRepo as never, deps.orphanRepo as never, deps.consentRepo as never, deps.enc as never);

    await uc.execute({ patientId: PID, buffer: Buffer.from('in'), actorUid: 'uid-1' });

    expect(deps.storage.delete).toHaveBeenCalledWith('old-uuid.jpg');
    expect(deps.orphanRepo.record).not.toHaveBeenCalled();
  });

  it('objeto antigo falha ao apagar — vira órfão REPLACE, não lança', async () => {
    const deps = makeDeps({ oldRow: { object_path_encrypted: 'enc(old-uuid.jpg)' } });
    // Única chamada de delete neste cenário (sem erro de transação) é a do objeto ANTIGO.
    deps.storage.delete = jest.fn(async () => { throw new Error('gcs down'); });
    const uc = new UploadPatientPhotoUseCase(deps.processor as never, storageFactoryOf(deps.storage), deps.photoRepo as never, deps.orphanRepo as never, deps.consentRepo as never, deps.enc as never);

    const result = await uc.execute({ patientId: PID, buffer: Buffer.from('in'), actorUid: 'uid-1' });

    expect(result).toEqual({ hasPhoto: true });
    expect(deps.orphanRepo.record).toHaveBeenCalledWith('enc(old-uuid.jpg)', 'PHOTOS', 'REPLACE');
  });

  it('objeto antigo falha ao apagar E o registro do órfão TAMBÉM falha — NÃO vira 500 (conserto #3 da 2ª revisão): resolve hasPhoto:true mesmo assim (a troca já comitou)', async () => {
    const deps = makeDeps({ oldRow: { object_path_encrypted: 'enc(old-uuid.jpg)' }, orphanRecordThrows: true });
    deps.storage.delete = jest.fn(async () => { throw new Error('gcs down'); });
    const uc = new UploadPatientPhotoUseCase(deps.processor as never, storageFactoryOf(deps.storage), deps.photoRepo as never, deps.orphanRepo as never, deps.consentRepo as never, deps.enc as never);

    const result = await uc.execute({ patientId: PID, buffer: Buffer.from('in'), actorUid: 'uid-1' });

    expect(result).toEqual({ hasPhoto: true });
    expect(deps.orphanRepo.record).toHaveBeenCalledWith('enc(old-uuid.jpg)', 'PHOTOS', 'REPLACE');
  });

  it('transação falha: apaga o objeto NOVO (best-effort) e relança o erro ORIGINAL', async () => {
    const deps = makeDeps({ insertThrows: true });
    const uc = new UploadPatientPhotoUseCase(deps.processor as never, storageFactoryOf(deps.storage), deps.photoRepo as never, deps.orphanRepo as never, deps.consentRepo as never, deps.enc as never);

    await expect(uc.execute({ patientId: PID, buffer: Buffer.from('in'), actorUid: 'uid-1' })).rejects.toThrow('db down');
    expect(deps.storage.delete).toHaveBeenCalledWith('new-uuid.jpg');
    // Achado da revisão do PR-4 (task 4.3h/item 4): a exclusão do objeto novo teve sucesso aqui,
    // então NÃO deve virar órfão registrado — só falha de delete vira órfão.
    expect(deps.orphanRepo.record).not.toHaveBeenCalled();
  });

  it('transação falha E a limpeza do objeto novo também falha — registra órfão REPLACE e relança o erro ORIGINAL (não mais silencioso)', async () => {
    const deps = makeDeps({ insertThrows: true, deleteThrows: true });
    const uc = new UploadPatientPhotoUseCase(deps.processor as never, storageFactoryOf(deps.storage), deps.photoRepo as never, deps.orphanRepo as never, deps.consentRepo as never, deps.enc as never);

    await expect(uc.execute({ patientId: PID, buffer: Buffer.from('in'), actorUid: 'uid-1' })).rejects.toThrow('db down');
    expect(deps.orphanRepo.record).toHaveBeenCalledWith('enc(new-uuid.jpg)', 'PHOTOS', 'REPLACE');
  });

  it('transação falha, limpeza falha E o registro do órfão TAMBÉM falha — ainda assim relança só o erro ORIGINAL', async () => {
    const deps = makeDeps({ insertThrows: true, deleteThrows: true, orphanRecordThrows: true });
    const uc = new UploadPatientPhotoUseCase(deps.processor as never, storageFactoryOf(deps.storage), deps.photoRepo as never, deps.orphanRepo as never, deps.consentRepo as never, deps.enc as never);

    await expect(uc.execute({ patientId: PID, buffer: Buffer.from('in'), actorUid: 'uid-1' })).rejects.toThrow('db down');
    expect(deps.orphanRepo.record).toHaveBeenCalledWith('enc(new-uuid.jpg)', 'PHOTOS', 'REPLACE');
  });

  it('constrói pelos DEFAULTS do construtor (caminho de produção)', () => {
    process.env.GCS_PATIENT_PHOTOS_BUCKET = 'b';
    try {
      // eslint-disable-next-line no-new -- só prova que os defaults são construíveis
      new UploadPatientPhotoUseCase();
    } finally {
      delete process.env.GCS_PATIENT_PHOTOS_BUCKET;
    }
  });

  it('SEM GCS_PATIENT_PHOTOS_BUCKET: construir o use case NÃO lança (fábrica é preguiçosa) — só execute() lança', async () => {
    delete process.env.GCS_PATIENT_PHOTOS_BUCKET;
    // eslint-disable-next-line no-new -- prova do achado item 1 da revisão: boot não cai sem env.
    const uc = new UploadPatientPhotoUseCase();
    await expect(uc.execute({ patientId: PID, buffer: Buffer.from('in'), actorUid: 'uid-1' }))
      .rejects.toThrow('GCS_PATIENT_PHOTOS_BUCKET não configurado');
  });
});
