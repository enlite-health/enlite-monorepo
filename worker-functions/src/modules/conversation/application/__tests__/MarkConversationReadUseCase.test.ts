/**
 * MarkConversationReadUseCase — T116 + T117 (spec 022, Bloco 1)
 * Testa upsert de `conversation_read_marks` sem duplicação.
 */
// Mocks para o ramo do PARÂMETRO PADRÃO do construtor (`repository = new ConversationRepository()`,
// linha 21) — o único caminho não exercitado pelos testes acima, que sempre injetam
// `mockRepository`. Sem estes mocks, construir sem argumento chamaria
// `DatabaseConnection.getInstance().getPool()` e `new KMSEncryptionService()` de verdade.
jest.mock('@shared/database/DatabaseConnection', () => ({
  DatabaseConnection: { getInstance: () => ({ getPool: () => ({ query: jest.fn() }) }) },
}));

jest.mock('@shared/security/KMSEncryptionService', () => ({
  KMSEncryptionService: jest.fn().mockImplementation(() => ({
    decrypt: jest.fn().mockResolvedValue(null),
    encrypt: jest.fn().mockResolvedValue(null),
  })),
}));

import { Pool, PoolClient } from 'pg';
import { MarkConversationReadUseCase } from '../MarkConversationReadUseCase';
import { ConversationRepository } from '../../infrastructure/ConversationRepository';

describe('MarkConversationReadUseCase', () => {
  let useCase: MarkConversationReadUseCase;
  let mockRepository: jest.Mocked<ConversationRepository>;
  let mockPool: jest.Mocked<Pool>;
  let mockClient: jest.Mocked<PoolClient>;

  beforeEach(() => {
    mockRepository = {
      upsertReadMark: jest.fn(),
    } as any;

    mockClient = {
      query: jest.fn(),
      release: jest.fn(),
    } as any;

    mockPool = {
      connect: jest.fn().mockResolvedValue(mockClient),
    } as any;

    useCase = new MarkConversationReadUseCase(mockRepository);
  });

  describe('execute', () => {
    it('should call upsertReadMark with correct parameters', async () => {
      const conversationId = 'conv-123';
      const userUid = 'uid-456';

      await useCase.execute(mockPool, { conversationId, userUid });

      expect(mockRepository.upsertReadMark).toHaveBeenCalledWith(
        conversationId,
        userUid,
        expect.any(Date),
        expect.any(Object),
      );
    });

    it('should use current timestamp for lastReadAt', async () => {
      const conversationId = 'conv-123';
      const userUid = 'uid-456';
      const beforeCall = new Date();

      await useCase.execute(mockPool, { conversationId, userUid });

      const callArgs = (mockRepository.upsertReadMark as jest.Mock).mock.calls[0];
      const lastReadAt = callArgs[2] as Date;

      expect(lastReadAt.getTime()).toBeGreaterThanOrEqual(beforeCall.getTime());
      expect(lastReadAt.getTime()).toBeLessThanOrEqual(new Date().getTime());
    });

    it('should not duplicate read mark when called twice for same conversation and user', async () => {
      const conversationId = 'conv-123';
      const userUid = 'uid-456';

      // First call
      await useCase.execute(mockPool, { conversationId, userUid });
      expect(mockRepository.upsertReadMark).toHaveBeenCalledTimes(1);

      // Second call
      await useCase.execute(mockPool, { conversationId, userUid });
      expect(mockRepository.upsertReadMark).toHaveBeenCalledTimes(2);

      // Verify both calls have the same conversationId and userUid
      const firstCall = (mockRepository.upsertReadMark as jest.Mock).mock.calls[0];
      const secondCall = (mockRepository.upsertReadMark as jest.Mock).mock.calls[1];

      expect(firstCall[0]).toBe(conversationId);
      expect(firstCall[1]).toBe(userUid);
      expect(secondCall[0]).toBe(conversationId);
      expect(secondCall[1]).toBe(userUid);
    });

    it('should return void', async () => {
      const conversationId = 'conv-123';
      const userUid = 'uid-456';

      const result = await useCase.execute(mockPool, { conversationId, userUid });

      expect(result).toBeUndefined();
    });

    it('should handle multiple conversations and users', async () => {
      const calls = [
        { conversationId: 'conv-1', userUid: 'uid-1' },
        { conversationId: 'conv-1', userUid: 'uid-2' },
        { conversationId: 'conv-2', userUid: 'uid-1' },
      ];

      for (const { conversationId, userUid } of calls) {
        await useCase.execute(mockPool, { conversationId, userUid });
      }

      expect(mockRepository.upsertReadMark).toHaveBeenCalledTimes(3);
    });

    it('should build its own ConversationRepository when none is injected (default constructor param, line 21)', async () => {
      const conversationId = 'conv-default-789';
      const userUid = 'uid-default-789';

      const useCaseWithDefaultRepository = new MarkConversationReadUseCase();
      const result = await useCaseWithDefaultRepository.execute(mockPool, { conversationId, userUid });

      expect(result).toBeUndefined();

      // Prova que o ramo "sem argumento" rodou: o UPSERT saiu do ConversationRepository
      // PADRÃO (construído sem mockRepository), via o client do mockPool desta chamada —
      // não do mockRepository.upsertReadMark usado nos testes acima.
      const upsertCall = (mockClient.query as jest.Mock).mock.calls.find(
        ([sql]: [string]) => typeof sql === 'string' && sql.includes('conversation_read_marks'),
      );
      expect(upsertCall).toBeDefined();
      expect(upsertCall![0]).toContain('INSERT INTO conversation_read_marks');
      expect(upsertCall![1][0]).toBe(conversationId);
      expect(upsertCall![1][1]).toBe(userUid);
    });
  });
});
