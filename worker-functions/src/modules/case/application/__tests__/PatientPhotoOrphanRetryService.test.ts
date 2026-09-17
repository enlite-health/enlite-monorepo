jest.mock('@shared/database/DatabaseConnection', () => ({
  DatabaseConnection: { getInstance: () => ({ getPool: () => ({ query: jest.fn(), connect: jest.fn(async () => ({ query: jest.fn(async () => ({ rows: [] })), release: jest.fn() })) }) }) },
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

/**
 * Fábrica de repo fake com `withPendingLocked` (conserto #4 da 2ª revisão — `FOR UPDATE SKIP
 * LOCKED`). Simula o método real: chama `fn` com as linhas dadas e um client fake — o service não
 * sabe nem precisa saber o que o client faz, só repassa para `remove`.
 */
function fakeRepoWithPending(pending: PatientPhotoOrphanRow[], remove: jest.Mock = jest.fn(async () => undefined)) {
  const FAKE_CLIENT = { query: jest.fn() };
  const withPendingLocked = jest.fn(async (limit: number, fn: (rows: PatientPhotoOrphanRow[], client: unknown) => Promise<unknown>) => {
    return fn(pending, FAKE_CLIENT);
  });
  return { withPendingLocked, remove, __client: FAKE_CLIENT };
}

describe('PatientPhotoOrphanRetryService (task 4.3h; lock — conserto #4 da 2ª revisão)', () => {
  it('retryOnce — sucesso: apaga do storage e REMOVE da fila (repassando o client travado)', async () => {
    const repo = fakeRepoWithPending([row({ bucket: 'PHOTOS' })]);
    const enc = { decrypt: jest.fn(async (v: string) => `plain(${v})`) } as never;
    const photoDelete = jest.fn(async () => undefined);
    const svc = new PatientPhotoOrphanRetryService(
      repo as never,
      enc,
      () => ({ delete: photoDelete }) as never,
    );

    const result = await svc.retryOnce(25);

    expect(result).toEqual({ attempted: 1, cleared: 1, stillFailing: 0 });
    expect(photoDelete).toHaveBeenCalledWith('plain(enc(x))');
    expect(repo.remove).toHaveBeenCalledWith('o1', repo.__client);
    expect(repo.withPendingLocked).toHaveBeenCalledWith(25, expect.any(Function));
  });

  // `patient_documents`/`PatientDocumentStorage` foram REMOVIDOS por completo
  // (fix/018-remover-documentos-consentimento). Uma linha antiga com `bucket='DOCUMENTS'` (se
  // sobrar alguma na stage) não tem mais storage para reprocessar — fica sempre `stillFailing`,
  // sem lançar e sem chamar `remove`.
  it('retryOnce — bucket DOCUMENTS não tem mais storage: conta em stillFailing, nunca remove da fila', async () => {
    const repo = fakeRepoWithPending([row({ bucket: 'DOCUMENTS' })]);
    const enc = { decrypt: jest.fn(async (v: string) => v) } as never;
    const svc = new PatientPhotoOrphanRetryService(repo as never, enc, () => ({ delete: jest.fn() }) as never);

    const result = await svc.retryOnce();

    expect(result).toEqual({ attempted: 1, cleared: 0, stillFailing: 1 });
    expect(repo.remove).not.toHaveBeenCalled();
  });

  it('retryOnce — falha ainda no delete: NÃO remove da fila, conta em stillFailing', async () => {
    const repo = fakeRepoWithPending([row()]);
    const enc = { decrypt: jest.fn(async (v: string) => v) } as never;
    const svc = new PatientPhotoOrphanRetryService(
      repo as never,
      enc,
      () => ({ delete: jest.fn(async () => { throw new Error('gcs down'); }) }) as never,
    );

    const result = await svc.retryOnce();

    expect(result).toEqual({ attempted: 1, cleared: 0, stillFailing: 1 });
    expect(repo.remove).not.toHaveBeenCalled();
  });

  it('retryOnce — fila vazia: 0/0/0', async () => {
    const repo = fakeRepoWithPending([]);
    const svc = new PatientPhotoOrphanRetryService(repo as never, {} as never);
    await expect(svc.retryOnce()).resolves.toEqual({ attempted: 0, cleared: 0, stillFailing: 0 });
  });

  it('constrói e roda pelos DEFAULTS do construtor (caminho de produção do cron/job de retry) — withPendingLocked real (BEGIN/SELECT FOR UPDATE SKIP LOCKED/COMMIT)', async () => {
    process.env.GCS_PATIENT_PHOTOS_BUCKET = 'b-photos';
    try {
      const client = { query: jest.fn(async (sql: string) => (sql.includes('SELECT') ? { rows: [row({ bucket: 'PHOTOS' })] } : undefined)), release: jest.fn() };
      const repo = new PatientPhotoOrphanRepository({ query: jest.fn(), connect: jest.fn(async () => client) } as never);
      const removeSpy = jest.spyOn(repo, 'remove').mockResolvedValue(undefined);
      const svc = new PatientPhotoOrphanRetryService(repo);

      const result = await svc.retryOnce();

      expect(result.cleared).toBe(1);
      expect(mockGcsDelete).toHaveBeenCalled();
      expect(client.release).toHaveBeenCalledTimes(1);
      removeSpy.mockRestore();
    } finally {
      delete process.env.GCS_PATIENT_PHOTOS_BUCKET;
    }
  });

  it('construção com ZERO argumentos (todos os defaults) não lança', () => {
    // eslint-disable-next-line no-new -- prova isolada do default de `repo` (DatabaseConnection mockada no topo)
    new PatientPhotoOrphanRetryService();
  });
});
