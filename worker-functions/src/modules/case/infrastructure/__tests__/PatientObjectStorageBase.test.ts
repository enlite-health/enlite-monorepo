/**
 * PatientObjectStorageBase.test.ts — unit direto da base comum (`delete`/`getReadSignedUrl`/
 * `getClient`), com foco no conserto #5 da 2ª revisão do PR-4: o log de falha de `delete` NUNCA
 * pode carregar `err.message`/stack do `@google-cloud/storage` — essa mensagem costuma trazer o
 * NOME DO OBJETO (ex.: "No such object: bucket/uuid.jpg"), e este código deliberadamente nunca
 * loga caminho de objeto (comentário do topo do arquivo/lex-pr4-foto #6/#9). Só código/status.
 */
const mockWarn = jest.fn();
jest.mock('@shared/logging', () => ({ logger: { warn: mockWarn, error: jest.fn(), info: jest.fn() } }));

const fileDelete = jest.fn();
const fileGetSignedUrl = jest.fn(async (_opts: { version: string; action: string; expires: number }) => ['https://signed.example/x']);
const fileFn = jest.fn(() => ({ delete: fileDelete, getSignedUrl: fileGetSignedUrl }));
const bucketFn = jest.fn(() => ({ file: fileFn }));
const StorageCtor = jest.fn().mockImplementation(() => ({ bucket: bucketFn }));
jest.mock('@google-cloud/storage', () => ({ Storage: StorageCtor }));

import { PatientObjectStorageBase, READ_URL_TTL_SECONDS } from '../PatientObjectStorageBase';

class TestStorage extends PatientObjectStorageBase {
  constructor(client?: unknown) {
    super('TEST_BUCKET_ENV', () => new Error('not configured'), client as never);
  }
}

describe('PatientObjectStorageBase — delete/log (conserto #5 da 2ª revisão do PR-4)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.TEST_BUCKET_ENV = 'bucket-x';
  });
  afterEach(() => {
    delete process.env.TEST_BUCKET_ENV;
  });

  it('404 no delete: sucesso silencioso, NÃO loga', async () => {
    fileDelete.mockRejectedValueOnce(Object.assign(new Error('No such object: bucket-x/segredo-do-objeto.jpg'), { code: 404 }));
    const storage = new TestStorage({ bucket: bucketFn });

    await expect(storage.delete('segredo-do-objeto.jpg')).resolves.toBeUndefined();
    expect(mockWarn).not.toHaveBeenCalled();
  });

  it('erro diferente de 404: loga código/status, NUNCA a mensagem crua (que contém o nome do objeto)', async () => {
    const err = Object.assign(new Error('Permission denied on object bucket-x/segredo-do-objeto.jpg'), {
      code: 403,
      response: { status: 403 },
    });
    fileDelete.mockRejectedValueOnce(err);
    const storage = new TestStorage({ bucket: bucketFn });

    await expect(storage.delete('segredo-do-objeto.jpg')).rejects.toThrow('Permission denied');

    expect(mockWarn).toHaveBeenCalledTimes(1);
    const [loggedFields] = mockWarn.mock.calls[0];
    const loggedAsText = JSON.stringify(loggedFields);
    expect(loggedAsText).not.toContain('segredo-do-objeto.jpg');
    expect(loggedAsText).not.toContain('Permission denied');
    expect(loggedFields).toEqual({ code: 403, status: 403 });
  });

  it('erro sem `code`/`response` (ex.: erro de rede genérico): loga code/status undefined, sem a mensagem', async () => {
    fileDelete.mockRejectedValueOnce(new Error('ECONNRESET talking to bucket-x/segredo-do-objeto.jpg'));
    const storage = new TestStorage({ bucket: bucketFn });

    await expect(storage.delete('segredo-do-objeto.jpg')).rejects.toThrow('ECONNRESET');

    const [loggedFields] = mockWarn.mock.calls[0];
    expect(JSON.stringify(loggedFields)).not.toContain('segredo-do-objeto.jpg');
    expect(loggedFields).toEqual({ code: undefined, status: undefined });
  });

  it('getReadSignedUrl — v4, TTL de 300s, delega ao client', async () => {
    const storage = new TestStorage({ bucket: bucketFn });
    const before = Date.now();

    const url = await storage.getReadSignedUrl('obj.jpg');

    expect(url).toBe('https://signed.example/x');
    expect(fileGetSignedUrl).toHaveBeenCalledWith(expect.objectContaining({ version: 'v4', action: 'read' }));
    const opts = fileGetSignedUrl.mock.calls[0][0];
    expect(opts.expires).toBeGreaterThanOrEqual(before + READ_URL_TTL_SECONDS * 1000);
  });

  it('sem a env do bucket: lança o erro fabricado por `notConfigured`', () => {
    delete process.env.TEST_BUCKET_ENV;
    expect(() => new TestStorage({ bucket: bucketFn })).toThrow('not configured');
  });

  it('sem client explícito: constrói via getClient() default (Storage real, sem GCS_EMULATOR_HOST)', () => {
    delete process.env.GCS_EMULATOR_HOST;
    expect(() => new TestStorage()).not.toThrow();
  });
});
