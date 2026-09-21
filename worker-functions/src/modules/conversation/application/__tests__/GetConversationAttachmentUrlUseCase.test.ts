/**
 * GetConversationAttachmentUrlUseCase.test.ts — spec 022, Bloco 3 (T314/T315).
 */
const mockDecrypt = jest.fn(async (v: string) => v.replace(/^enc:/, ''));
jest.mock('@shared/security/KMSEncryptionService', () => ({
  KMSEncryptionService: jest.fn().mockImplementation(() => ({ decrypt: mockDecrypt })),
}));

import type { Pool } from 'pg';
import { GetConversationAttachmentUrlUseCase } from '../GetConversationAttachmentUrlUseCase';
import { READ_URL_TTL_SECONDS } from '@modules/case';
import type { ConversationAttachmentStorage } from '../../infrastructure/ConversationAttachmentStorage';

function fakePool(rows: unknown[]): Pool {
  return { query: jest.fn(async () => ({ rows })) } as unknown as Pool;
}

function fakeStorage(url = 'https://signed.example/obj'): ConversationAttachmentStorage {
  return { getReadSignedUrl: jest.fn(async () => url) } as unknown as ConversationAttachmentStorage;
}

beforeEach(() => mockDecrypt.mockClear());

describe('GetConversationAttachmentUrlUseCase', () => {
  it('fileId anexado a mensagem da conversa do paciente da rota — devolve URL assinada com Content-Disposition do nome DECIFRADO', async () => {
    const pool = fakePool([{ objectPathEncrypted: 'enc:uuid-1.pdf', originalNameEncrypted: 'enc:contrato-2026.pdf' }]);
    const storage = fakeStorage();
    const useCase = new GetConversationAttachmentUrlUseCase(() => storage);

    const result = await useCase.execute(pool, { patientId: 'p1', fileId: 'f1' });

    expect(result).toEqual({ url: 'https://signed.example/obj', expiresInSeconds: READ_URL_TTL_SECONDS });
    expect(storage.getReadSignedUrl).toHaveBeenCalledWith('uuid-1.pdf', {
      responseDisposition: 'attachment; filename="contrato-2026.pdf"',
    });
  });

  it('fileId inexistente OU de OUTRO paciente — devolve null (controller decide 404, sem distinguir a causa)', async () => {
    const pool = fakePool([]);
    const useCase = new GetConversationAttachmentUrlUseCase(() => fakeStorage());

    const result = await useCase.execute(pool, { patientId: 'p1', fileId: 'f-alheio' });

    expect(result).toBeNull();
  });

  it('a query cruza fileId (:fileId) COM patientId (:id da rota) — nunca confia só no fileId', async () => {
    const pool = fakePool([]);
    const useCase = new GetConversationAttachmentUrlUseCase(() => fakeStorage());

    await useCase.execute(pool, { patientId: 'p1', fileId: 'f1' });

    expect(pool.query).toHaveBeenCalledWith(expect.stringContaining('c.patient_id = $2'), ['f1', 'p1']);
  });

  it('nome original com aspas/quebra de linha — sanitiza antes de ir para o header (nunca confiar em nome de arquivo enviado por usuário)', async () => {
    const pool = fakePool([{ objectPathEncrypted: 'enc:uuid-1.pdf', originalNameEncrypted: 'enc:nome "malicioso"\r\n.pdf' }]);
    const storage = fakeStorage();
    const useCase = new GetConversationAttachmentUrlUseCase(() => storage);

    await useCase.execute(pool, { patientId: 'p1', fileId: 'f1' });

    const [, options] = (storage.getReadSignedUrl as jest.Mock).mock.calls[0];
    // A única aspa dupla aceitável é o PAR que delimita o valor do header (`filename="..."`) —
    // sem sanitização, a aspa/quebra de linha do nome de arquivo quebraria essa delimitação.
    expect(options.responseDisposition).toBe('attachment; filename="nome malicioso.pdf"');
  });

  it('construção sem dependências explícitas (produção real) não lança', () => {
    expect(() => new GetConversationAttachmentUrlUseCase()).not.toThrow();
  });
});
