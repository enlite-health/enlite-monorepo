jest.mock('@shared/database/DatabaseConnection', () => ({
  DatabaseConnection: { getInstance: () => ({ getPool: () => ({ query: jest.fn() }) }) },
}));
const mockGcsDelete = jest.fn(async () => undefined);
jest.mock('@google-cloud/storage', () => ({
  Storage: jest.fn().mockImplementation(() => ({ bucket: () => ({ file: () => ({ delete: mockGcsDelete }) }) })),
}));

import { PatientPhotoOrphanRetryService } from '../PatientPhotoOrphanRetryService';
import { PatientPhotoOrphanRepository } from '../../infrastructure/PatientPhotoOrphanRepository';
import type { PatientPhotoOrphanRow } from '../../infrastructure/PatientPhotoOrphanRepository';

function row(overrides: Partial<PatientPhotoOrphanRow> = {}): PatientPhotoOrphanRow {
  return { id: 'o1', object_path_encrypted: 'enc(x)', bucket: 'PHOTOS', reason: 'PURGE', created_at: '2026-09-14T00:00:00Z', ...overrides };
}

describe('PatientPhotoOrphanRetryService (task 4.3h)', () => {
  it('retryOnce — sucesso: apaga do storage certo e REMOVE da fila', async () => {
    const listPending = jest.fn(async () => [row({ bucket: 'PHOTOS' })]);
    const remove = jest.fn(async () => undefined);
    const repo = { listPending, remove } as never;
    const enc = { decrypt: jest.fn(async (v: string) => `plain(${v})`) } as never;
    const photoDelete = jest.fn(async () => undefined);
    const documentDelete = jest.fn(async () => undefined);
    const svc = new PatientPhotoOrphanRetryService(
      repo,
      enc,
      () => ({ delete: photoDelete }) as never,
      () => ({ delete: documentDelete }) as never,
    );

    const result = await svc.retryOnce(25);

    expect(result).toEqual({ attempted: 1, cleared: 1, stillFailing: 0 });
    expect(photoDelete).toHaveBeenCalledWith('plain(enc(x))');
    expect(documentDelete).not.toHaveBeenCalled();
    expect(remove).toHaveBeenCalledWith('o1');
    expect(listPending).toHaveBeenCalledWith(25);
  });

  it('retryOnce — bucket DOCUMENTS usa o storage de documentos', async () => {
    const repo = { listPending: jest.fn(async () => [row({ bucket: 'DOCUMENTS' })]), remove: jest.fn() } as never;
    const enc = { decrypt: jest.fn(async (v: string) => v) } as never;
    const documentDelete = jest.fn(async () => undefined);
    const svc = new PatientPhotoOrphanRetryService(repo, enc, () => ({ delete: jest.fn() }) as never, () => ({ delete: documentDelete }) as never);

    await svc.retryOnce();

    expect(documentDelete).toHaveBeenCalled();
  });

  it('retryOnce — falha ainda no delete: NÃO remove da fila, conta em stillFailing', async () => {
    const remove = jest.fn();
    const repo = { listPending: jest.fn(async () => [row()]), remove } as never;
    const enc = { decrypt: jest.fn(async (v: string) => v) } as never;
    const svc = new PatientPhotoOrphanRetryService(
      repo,
      enc,
      () => ({ delete: jest.fn(async () => { throw new Error('gcs down'); }) }) as never,
      () => ({ delete: jest.fn() }) as never,
    );

    const result = await svc.retryOnce();

    expect(result).toEqual({ attempted: 1, cleared: 0, stillFailing: 1 });
    expect(remove).not.toHaveBeenCalled();
  });

  it('retryOnce — fila vazia: 0/0/0', async () => {
    const repo = { listPending: jest.fn(async () => []), remove: jest.fn() } as never;
    const svc = new PatientPhotoOrphanRetryService(repo, {} as never);
    await expect(svc.retryOnce()).resolves.toEqual({ attempted: 0, cleared: 0, stillFailing: 0 });
  });

  it('constrói e roda pelos DEFAULTS do construtor (caminho de produção do cron/job de retry)', async () => {
    process.env.GCS_PATIENT_PHOTOS_BUCKET = 'b-photos';
    process.env.GCS_PATIENT_DOCUMENTS_BUCKET = 'b-docs';
    try {
      const repo = new PatientPhotoOrphanRepository({ query: jest.fn(async () => ({ rows: [row({ bucket: 'PHOTOS' })] })) } as never);
      const removeSpy = jest.spyOn(repo, 'remove').mockResolvedValue(undefined);
      const svc = new PatientPhotoOrphanRetryService(repo);

      const result = await svc.retryOnce();

      expect(result.cleared).toBe(1);
      expect(mockGcsDelete).toHaveBeenCalled();
      removeSpy.mockRestore();
    } finally {
      delete process.env.GCS_PATIENT_PHOTOS_BUCKET;
      delete process.env.GCS_PATIENT_DOCUMENTS_BUCKET;
    }
  });

  it('DEFAULTS do construtor — bucket DOCUMENTS também cobre o default do documentStorage', async () => {
    process.env.GCS_PATIENT_PHOTOS_BUCKET = 'b-photos';
    process.env.GCS_PATIENT_DOCUMENTS_BUCKET = 'b-docs';
    try {
      const repo = new PatientPhotoOrphanRepository({ query: jest.fn(async () => ({ rows: [row({ bucket: 'DOCUMENTS' })] })) } as never);
      jest.spyOn(repo, 'remove').mockResolvedValue(undefined);
      const svc = new PatientPhotoOrphanRetryService(repo);

      const result = await svc.retryOnce();
      expect(result.cleared).toBe(1);
    } finally {
      delete process.env.GCS_PATIENT_PHOTOS_BUCKET;
      delete process.env.GCS_PATIENT_DOCUMENTS_BUCKET;
    }
  });

  it('construção com ZERO argumentos (todos os defaults) não lança', () => {
    // eslint-disable-next-line no-new -- prova isolada do default de `repo` (DatabaseConnection mockada no topo)
    new PatientPhotoOrphanRetryService();
  });
});
