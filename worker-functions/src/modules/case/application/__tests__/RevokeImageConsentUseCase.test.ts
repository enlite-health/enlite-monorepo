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

import { RevokeImageConsentUseCase } from '../RevokeImageConsentUseCase';

const PID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const CID = 'bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee';
const INPUT = { revocationChannel: 'EMAIL' as const };

function makeDeps(overrides: { consentFound?: boolean; photoRow?: { object_path_encrypted: string } | null; deleteThrows?: boolean } = {}) {
  const consentRepo = { revoke: jest.fn(async () => (overrides.consentFound === false ? null : { id: CID })) };
  const photoRepo = { deleteRow: jest.fn(async () => overrides.photoRow ?? null) };
  const storage = { delete: jest.fn(overrides.deleteThrows ? async () => { throw new Error('gcs down'); } : async () => undefined) };
  const orphanRepo = { record: jest.fn(async () => ({ id: 'o1' })) };
  const enc = { decrypt: jest.fn(async (v: string) => v.replace(/^enc\(|\)$/g, '')) };
  return { consentRepo, photoRepo, storage, orphanRepo, enc };
}

describe('RevokeImageConsentUseCase (D335 — revogação simples, sempre apaga a foto)', () => {
  it('consentimento não encontrado — revoked:false, nada de foto', async () => {
    const deps = makeDeps({ consentFound: false });
    const uc = new RevokeImageConsentUseCase(deps.consentRepo as never, deps.photoRepo as never, (() => deps.storage) as never, deps.orphanRepo as never, deps.enc as never);
    await expect(uc.execute(PID, CID, INPUT, 'uid-1')).resolves.toEqual({ revoked: false });
    expect(deps.photoRepo.deleteRow).not.toHaveBeenCalled();
  });

  it('revoga sem foto vigente — revoked:true, sem chamada de storage', async () => {
    const deps = makeDeps({ photoRow: null });
    const uc = new RevokeImageConsentUseCase(deps.consentRepo as never, deps.photoRepo as never, (() => deps.storage) as never, deps.orphanRepo as never, deps.enc as never);
    await expect(uc.execute(PID, CID, INPUT, 'uid-1')).resolves.toEqual({ revoked: true });
    expect(deps.storage.delete).not.toHaveBeenCalled();
  });

  it('revoga com foto vigente — apaga o objeto na mesma operação lógica', async () => {
    const deps = makeDeps({ photoRow: { object_path_encrypted: 'enc(x)' } });
    const uc = new RevokeImageConsentUseCase(deps.consentRepo as never, deps.photoRepo as never, (() => deps.storage) as never, deps.orphanRepo as never, deps.enc as never);
    await expect(uc.execute(PID, CID, INPUT, 'uid-1')).resolves.toEqual({ revoked: true });
    expect(deps.storage.delete).toHaveBeenCalledWith('x');
    expect(deps.orphanRepo.record).not.toHaveBeenCalled();
  });

  it('objeto falha ao apagar — vira órfão REVOKE, ainda revoked:true', async () => {
    const deps = makeDeps({ photoRow: { object_path_encrypted: 'enc(x)' }, deleteThrows: true });
    const uc = new RevokeImageConsentUseCase(deps.consentRepo as never, deps.photoRepo as never, (() => deps.storage) as never, deps.orphanRepo as never, deps.enc as never);
    await expect(uc.execute(PID, CID, INPUT, 'uid-1')).resolves.toEqual({ revoked: true });
    expect(deps.orphanRepo.record).toHaveBeenCalledWith('enc(x)', 'PHOTOS', 'REVOKE');
  });

  it('constrói pelos DEFAULTS do construtor', () => {
    process.env.GCS_PATIENT_PHOTOS_BUCKET = 'b';
    try {
      // eslint-disable-next-line no-new
      new RevokeImageConsentUseCase();
    } finally {
      delete process.env.GCS_PATIENT_PHOTOS_BUCKET;
    }
  });

  it('SEM GCS_PATIENT_PHOTOS_BUCKET: construir NÃO lança (fábrica preguiçosa) — só falha se houver foto pra apagar', async () => {
    delete process.env.GCS_PATIENT_PHOTOS_BUCKET;
    expect(() => new RevokeImageConsentUseCase()).not.toThrow();

    const deps = makeDeps({ photoRow: { object_path_encrypted: 'enc(x)' } });
    const uc = new RevokeImageConsentUseCase(deps.consentRepo as never, deps.photoRepo as never, undefined, deps.orphanRepo as never, deps.enc as never);
    await expect(uc.execute(PID, CID, INPUT, 'uid-1')).rejects.toThrow('GCS_PATIENT_PHOTOS_BUCKET não configurado');
  });
});
