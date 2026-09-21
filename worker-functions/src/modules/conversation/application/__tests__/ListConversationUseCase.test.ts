/**
 * ListConversationUseCase — T111 + T112 (spec 022, Bloco 1)
 * Testa paginação com cursor `(created_at, id)` do ÚLTIMO item da página.
 */
// Mocks para o ramo do PARÂMETRO PADRÃO do construtor (`repository = new ConversationRepository()`,
// linha 23) — o único caminho não exercitado pelos testes acima, que sempre injetam
// `mockRepository`. Sem estes mocks, construir sem argumento chamaria
// `DatabaseConnection.getInstance().getPool()` e `new KMSEncryptionService()` de verdade.
const mockDefaultRepoPoolQuery = jest.fn();
const mockDefaultRepoDecrypt = jest.fn();

jest.mock('@shared/database/DatabaseConnection', () => ({
  DatabaseConnection: { getInstance: () => ({ getPool: () => ({ query: mockDefaultRepoPoolQuery }) }) },
}));

jest.mock('@shared/security/KMSEncryptionService', () => ({
  KMSEncryptionService: jest.fn().mockImplementation(() => ({
    decrypt: mockDefaultRepoDecrypt,
    encrypt: jest.fn().mockResolvedValue(null),
  })),
}));

import { ListConversationUseCase } from '../ListConversationUseCase';
import { ConversationRepository, CONVERSATION_PAGE_SIZE } from '../../infrastructure/ConversationRepository';

const ACTOR_UID = 'staff:actor';

describe('ListConversationUseCase', () => {
  let useCase: ListConversationUseCase;
  let mockRepository: jest.Mocked<ConversationRepository>;

  beforeEach(() => {
    mockRepository = {
      listTopMessages: jest.fn(),
      getReadState: jest.fn().mockResolvedValue({ lastReadAt: null, unreadCount: 0 }),
    } as any;

    useCase = new ListConversationUseCase(mockRepository);
  });

  describe('execute', () => {
    it('should return empty array and no nextCursor when conversation has no messages', async () => {
      const conversationId = 'conv-123';
      mockRepository.listTopMessages.mockResolvedValue([]);

      const result = await useCase.execute({ conversationId, actorUid: ACTOR_UID });

      expect(result.messages).toEqual([]);
      expect(result.nextCursor).toBeUndefined();
      expect(mockRepository.listTopMessages).toHaveBeenCalledWith(conversationId, null, CONVERSATION_PAGE_SIZE);
    });

    it('should fetch and expose lastReadAt/unreadCount from repository.getReadState (D-11)', async () => {
      const conversationId = 'conv-123';
      const lastReadAt = new Date('2026-09-20T10:00:00Z');
      mockRepository.listTopMessages.mockResolvedValue([]);
      mockRepository.getReadState.mockResolvedValue({ lastReadAt, unreadCount: 3 });

      const result = await useCase.execute({ conversationId, actorUid: ACTOR_UID });

      expect(mockRepository.getReadState).toHaveBeenCalledWith(conversationId, ACTOR_UID);
      expect(result.lastReadAt).toEqual(lastReadAt);
      expect(result.unreadCount).toBe(3);
    });

    it('should expose lastReadAt: null and unreadCount: 0 when actor never read (no mark)', async () => {
      const conversationId = 'conv-123';
      mockRepository.listTopMessages.mockResolvedValue([]);
      mockRepository.getReadState.mockResolvedValue({ lastReadAt: null, unreadCount: 0 });

      const result = await useCase.execute({ conversationId, actorUid: ACTOR_UID });

      expect(result.lastReadAt).toBeNull();
      expect(result.unreadCount).toBe(0);
    });

    it('should return messages and no nextCursor when page has fewer items than limit', async () => {
      const conversationId = 'conv-123';
      const messages = [
        {
          id: 'msg-1',
          conversationId,
          authorUid: 'uid-1',
          body: 'msg-1',
          createdAt: new Date('2026-01-01T10:00:00Z'),
          editedAt: null,
          deletedAt: null,
          replyCount: 0,
          lastReplyAt: null,
          mentions: [],
          attachments: [],
        },
        {
          id: 'msg-2',
          conversationId,
          authorUid: 'uid-2',
          body: 'msg-2',
          createdAt: new Date('2026-01-01T11:00:00Z'),
          editedAt: null,
          deletedAt: null,
          replyCount: 0,
          lastReplyAt: null,
          mentions: [],
          attachments: [],
        },
      ];
      mockRepository.listTopMessages.mockResolvedValue(messages);

      const result = await useCase.execute({ conversationId, actorUid: ACTOR_UID });

      expect(result.messages).toEqual(messages);
      expect(result.nextCursor).toBeUndefined();
    });

    it('should return nextCursor from LAST item when page is full (limit items)', async () => {
      const conversationId = 'conv-123';
      const messages = Array.from({ length: CONVERSATION_PAGE_SIZE }, (_, i) => ({
        id: `msg-${i + 1}`,
        conversationId,
        authorUid: `uid-${i + 1}`,
        body: `msg-${i + 1}`,
        createdAt: new Date(`2026-01-01T${String(10 + Math.floor(i / 24)).padStart(2, '0')}:${String((i * 60) % 60).padStart(2, '0')}:00Z`),
        editedAt: null,
        deletedAt: null,
        replyCount: 0,
        lastReplyAt: null,
        mentions: [] as string[],
        attachments: [],
      }));
      mockRepository.listTopMessages.mockResolvedValue(messages);

      const result = await useCase.execute({ conversationId, actorUid: ACTOR_UID });

      expect(result.messages).toEqual(messages);
      expect(result.nextCursor).toBeDefined();
      expect(result.nextCursor?.id).toBe(messages[messages.length - 1].id);
      expect(result.nextCursor?.createdAt).toEqual(messages[messages.length - 1].createdAt);
    });

    it('should use provided cursor when fetching next page', async () => {
      const conversationId = 'conv-123';
      const afterCursor = {
        createdAt: new Date('2026-01-01T10:00:00Z'),
        id: 'msg-50',
      };
      const messages = [
        {
          id: 'msg-51',
          conversationId,
          authorUid: 'uid-51',
          body: 'msg-51',
          createdAt: new Date('2026-01-01T11:00:00Z'),
          editedAt: null,
          deletedAt: null,
          replyCount: 0,
          lastReplyAt: null,
          mentions: [],
          attachments: [],
        },
      ];
      mockRepository.listTopMessages.mockResolvedValue(messages);

      const result = await useCase.execute({ conversationId, actorUid: ACTOR_UID, after: afterCursor });

      expect(result.messages).toEqual(messages);
      expect(mockRepository.listTopMessages).toHaveBeenCalledWith(
        conversationId,
        afterCursor,
        CONVERSATION_PAGE_SIZE,
      );
    });

    it('should respect custom limit parameter', async () => {
      const conversationId = 'conv-123';
      const limit = 10;
      mockRepository.listTopMessages.mockResolvedValue([]);

      await useCase.execute({ conversationId, actorUid: ACTOR_UID, limit });

      expect(mockRepository.listTopMessages).toHaveBeenCalledWith(
        conversationId,
        null,
        limit,
      );
    });

    it('should preserve message order from repository', async () => {
      const conversationId = 'conv-123';
      const messages = [
        {
          id: 'msg-1',
          conversationId,
          authorUid: 'uid-1',
          body: 'first',
          createdAt: new Date('2026-01-01T10:00:00Z'),
          editedAt: null,
          deletedAt: null,
          replyCount: 2,
          lastReplyAt: new Date('2026-01-01T12:00:00Z'),
          mentions: [],
          attachments: [],
        },
        {
          id: 'msg-2',
          conversationId,
          authorUid: 'uid-2',
          body: 'second',
          createdAt: new Date('2026-01-01T11:00:00Z'),
          editedAt: new Date('2026-01-01T11:30:00Z'),
          deletedAt: null,
          replyCount: 0,
          lastReplyAt: null,
          mentions: [],
          attachments: [],
        },
        {
          id: 'msg-3',
          conversationId,
          authorUid: 'uid-3',
          body: 'third',
          createdAt: new Date('2026-01-01T12:00:00Z'),
          editedAt: null,
          deletedAt: new Date('2026-01-01T13:00:00Z'),
          replyCount: 1,
          lastReplyAt: new Date('2026-01-01T12:30:00Z'),
          mentions: [],
          attachments: [],
        },
      ];
      mockRepository.listTopMessages.mockResolvedValue(messages);

      const result = await useCase.execute({ conversationId, actorUid: ACTOR_UID });

      expect(result.messages).toEqual(messages);
      expect(result.messages[0].id).toBe('msg-1');
      expect(result.messages[1].id).toBe('msg-2');
      expect(result.messages[2].id).toBe('msg-3');
    });

    it('should build its own ConversationRepository when none is injected (default constructor param, line 23)', async () => {
      const conversationId = 'conv-default-123';
      mockDefaultRepoPoolQuery
        .mockResolvedValueOnce({
          rows: [
            {
              id: 'msg-default-1',
              conversationId,
              authorUid: 'uid-default-1',
              bodyEncrypted: Buffer.from('cipher'),
              createdAt: new Date('2026-01-01T09:00:00Z'),
              editedAt: null,
              deletedAt: null,
              replyCount: 0,
              lastReplyAt: null,
            },
          ],
        })
        // 2ª chamada do pool padrão: a agregação de mentions (UMA query com ANY, LACUNA 2).
        .mockResolvedValueOnce({ rows: [] })
        // 3ª chamada do pool padrão: a agregação de anexos (UMA query com JOIN+ANY, Bloco 3).
        .mockResolvedValueOnce({ rows: [] })
        // 4ª chamada do pool padrão: `getReadState` (D-11) — sem marca prévia, unreadCount 0 aqui
        // só prova que o ramo "sem argumento" chegou até o repositório default; o comportamento de
        // contagem em si é coberto por `ConversationRepository.test.ts`.
        .mockResolvedValueOnce({ rows: [{ lastReadAt: null, unreadCount: 0 }] });
      mockDefaultRepoDecrypt.mockResolvedValueOnce('mensagem decifrada via repositorio default');

      const useCaseWithDefaultRepository = new ListConversationUseCase();
      const result = await useCaseWithDefaultRepository.execute({ conversationId, actorUid: ACTOR_UID });

      // Prova que o ramo "sem argumento" rodou: a query do POOL PADRÃO (não do
      // mockRepository dos outros testes) foi chamada, e o corpo decifrado pelo
      // KMS padrão chegou até o resultado.
      expect(mockDefaultRepoPoolQuery).toHaveBeenCalledTimes(4);
      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].body).toBe('mensagem decifrada via repositorio default');
      expect(result.messages[0].mentions).toEqual([]);
      expect(result.messages[0].attachments).toEqual([]);
      expect(result.lastReadAt).toBeNull();
      expect(result.unreadCount).toBe(0);
      expect(result.nextCursor).toBeUndefined();
    });
  });
});
