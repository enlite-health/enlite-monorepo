/**
 * UploadConversationAttachmentUseCase.test.ts — spec 022, Bloco 3 (T311/T312). Molde de mock:
 * `PostMessageUseCase.test.ts` (`withActorContext` mockado inteiro, `KMSEncryptionService`
 * mockado por módulo).
 */
const mockEncrypt = jest.fn(async (v: string) => `enc:${v}`);
jest.mock('@shared/security/KMSEncryptionService', () => ({
  KMSEncryptionService: jest.fn().mockImplementation(() => ({ encrypt: mockEncrypt })),
}));

const mockWithActorContext = jest.fn();
jest.mock('@shared/database/actorContext', () => ({
  withActorContext: (...args: unknown[]) => mockWithActorContext(...args),
}));

import type { Pool, PoolClient } from 'pg';
import {
  UploadConversationAttachmentUseCase,
  AttachmentRejectedError,
} from '../UploadConversationAttachmentUseCase';
import type { ConversationAttachmentValidator, AttachmentValidationResult } from '../../infrastructure/ConversationAttachmentValidator';
import type { ConversationAttachmentStorage } from '../../infrastructure/ConversationAttachmentStorage';

const POOL = {} as unknown as Pool;

function fakeValidator(result: AttachmentValidationResult): ConversationAttachmentValidator {
  return { validate: jest.fn(async () => result) } as unknown as ConversationAttachmentValidator;
}

function fakeStorage(overrides: Partial<ConversationAttachmentStorage> = {}): ConversationAttachmentStorage {
  return {
    uploadBuffer: jest.fn(async () => ({ objectPath: 'uuid-123.pdf' })),
    getBucketName: jest.fn(() => 'bucket-teste'),
    delete: jest.fn(async () => undefined),
    ...overrides,
  } as unknown as ConversationAttachmentStorage;
}

beforeEach(() => {
  mockWithActorContext.mockReset();
  mockEncrypt.mockClear();
});

describe('UploadConversationAttachmentUseCase', () => {
  it('validação recusa (ex.: UNSUPPORTED_MEDIA_TYPE) — lança AttachmentRejectedError com status 415, NUNCA sobe ao storage', async () => {
    const storage = fakeStorage();
    const useCase = new UploadConversationAttachmentUseCase(
      fakeValidator({ ok: false, code: 'UNSUPPORTED_MEDIA_TYPE', message: 'tipo não suportado' }),
      () => storage,
    );

    await expect(
      useCase.execute(POOL, { conversationId: 'c1', actorUid: 'staff:1', buffer: Buffer.from('x'), originalFilename: 'a.exe' }),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_MEDIA_TYPE', status: 415 });

    expect(storage.uploadBuffer).not.toHaveBeenCalled();
  });

  it('FILE_TOO_LARGE — status 413', async () => {
    const useCase = new UploadConversationAttachmentUseCase(
      fakeValidator({ ok: false, code: 'FILE_TOO_LARGE', message: 'grande demais' }),
      () => fakeStorage(),
    );
    await expect(
      useCase.execute(POOL, { conversationId: 'c1', actorUid: 'staff:1', buffer: Buffer.from('x'), originalFilename: 'a.pdf' }),
    ).rejects.toMatchObject({ status: 413 });
  });

  it('validação ok — sobe ao storage, cifra objectPath+nome original, grava stored_files dentro de withActorContext e devolve fileId', async () => {
    const storage = fakeStorage();
    const validBuffer = Buffer.from('conteudo-final-reencodado');
    let insertSql = '';
    let insertParams: unknown[] = [];
    mockWithActorContext.mockImplementation(async (_pool: Pool, fn: (c: PoolClient) => unknown) => {
      const client = {
        query: jest.fn(async (sql: string, params: unknown[]) => {
          insertSql = sql;
          insertParams = params;
          return { rows: [{ id: 'file-abc' }] };
        }),
      } as unknown as PoolClient;
      return fn(client);
    });

    const useCase = new UploadConversationAttachmentUseCase(
      fakeValidator({ ok: true, contentType: 'application/pdf', buffer: validBuffer }),
      () => storage,
    );

    const result = await useCase.execute(POOL, {
      conversationId: 'c1',
      actorUid: 'staff:1',
      buffer: Buffer.from('bruto-antes-de-validar'),
      originalFilename: 'contrato.pdf',
    });

    expect(result).toEqual({ fileId: 'file-abc' });
    expect(storage.uploadBuffer).toHaveBeenCalledWith(validBuffer, 'application/pdf');
    expect(mockEncrypt).toHaveBeenCalledWith('uuid-123.pdf');
    expect(mockEncrypt).toHaveBeenCalledWith('contrato.pdf');
    expect(insertSql).toContain('INSERT INTO stored_files');
    expect(insertParams).toEqual([
      'bucket-teste',
      'enc:uuid-123.pdf',
      'enc:contrato.pdf',
      'application/pdf',
      validBuffer.byteLength,
      expect.any(Buffer), // sha256
      'staff:1',
      'c1',
    ]);
  });

  it('INSERT falha depois do upload — apaga o objeto órfão (best-effort) e relança o erro original', async () => {
    const storage = fakeStorage();
    mockWithActorContext.mockRejectedValue(new Error('RLS recusou'));

    const useCase = new UploadConversationAttachmentUseCase(
      fakeValidator({ ok: true, contentType: 'application/pdf', buffer: Buffer.from('x') }),
      () => storage,
    );

    await expect(
      useCase.execute(POOL, { conversationId: 'c1', actorUid: 'staff:1', buffer: Buffer.from('x'), originalFilename: 'a.pdf' }),
    ).rejects.toThrow('RLS recusou');

    expect(storage.delete).toHaveBeenCalledWith('uuid-123.pdf');
  });

  it('INSERT falha E o delete do órfão TAMBÉM falha — ainda relança o erro ORIGINAL (nunca engole)', async () => {
    const storage = fakeStorage({ delete: jest.fn().mockRejectedValue(new Error('delete falhou')) });
    mockWithActorContext.mockRejectedValue(new Error('RLS recusou'));

    const useCase = new UploadConversationAttachmentUseCase(
      fakeValidator({ ok: true, contentType: 'application/pdf', buffer: Buffer.from('x') }),
      () => storage,
    );

    await expect(
      useCase.execute(POOL, { conversationId: 'c1', actorUid: 'staff:1', buffer: Buffer.from('x'), originalFilename: 'a.pdf' }),
    ).rejects.toThrow('RLS recusou');
  });

  it('AttachmentRejectedError expõe code/status/message', () => {
    const err = new AttachmentRejectedError('MALICIOUS_CONTENT_DETECTED', 'conteúdo ativo');
    expect(err.code).toBe('MALICIOUS_CONTENT_DETECTED');
    expect(err.status).toBe(415);
    expect(err.message).toBe('conteúdo ativo');
  });

  it('construção sem dependências explícitas (produção real) não lança', () => {
    expect(() => new UploadConversationAttachmentUseCase()).not.toThrow();
  });
});
