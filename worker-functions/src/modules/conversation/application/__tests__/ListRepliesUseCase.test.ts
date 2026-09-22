/**
 * ListRepliesUseCase — spec 022, Bloco 1, LACUNA 1 (contrato: `GET .../messages/:mid/replies`).
 *
 * Regra do contrato (`openapi-conversation.md`): `:mid` PRECISA ser mensagem de TOPO
 * (`root_message_id IS NULL`) — responder a uma reply não tem replies próprias (thread de 1
 * nível, D-03). Se `:mid` já é uma reply, 400 (`RootMessageIsReplyError`, o controller converte).
 *
 * `:mid` inexistente: `findMessageThreadInfo` devolve `null` — não há como saber se É uma reply,
 * então segue para `listReplies` (que devolve lista vazia, honesto: não achou nada, não inventou
 * erro que o contrato não pede). Mesmo padrão de fallback de `PostMessageUseCase.resolveRoot`.
 */
// Mocks para o ramo do PARÂMETRO PADRÃO do construtor (`repository = new ConversationRepository()`) —
// molde: ListConversationUseCase.test.ts, linhas 9-21.
const mockDefaultRepoPoolQuery = jest.fn();
const mockDefaultRepoDecrypt = jest.fn();

jest.mock('@shared/database/DatabaseConnection', () => ({
  DatabaseConnection: { getInstance: () => ({ getPool: () => ({ query: mockDefaultRepoPoolQuery }) }) },
}));

jest.mock('@shared/security/KMSEncryptionService', () => ({
  ...jest.requireActual('@shared/security/KMSEncryptionService'),
  KMSEncryptionService: jest.fn().mockImplementation(() => ({
    decrypt: mockDefaultRepoDecrypt,
    encrypt: jest.fn().mockResolvedValue(null),
  })),
}));

import { ListRepliesUseCase, RootMessageIsReplyError } from '../ListRepliesUseCase';
import { ConversationRepository } from '../../infrastructure/ConversationRepository';

describe('ListRepliesUseCase', () => {
  let useCase: ListRepliesUseCase;
  let mockRepository: jest.Mocked<ConversationRepository>;

  beforeEach(() => {
    mockRepository = {
      findMessageThreadInfo: jest.fn(),
      listReplies: jest.fn(),
    } as any;

    useCase = new ListRepliesUseCase(mockRepository);
  });

  describe('execute', () => {
    it('delega a listReplies(rootMessageId) quando o id É uma mensagem de topo (rootMessageId null)', async () => {
      mockRepository.findMessageThreadInfo.mockResolvedValue({ id: 'm1', conversationId: 'conv-1', rootMessageId: null });
      const replies = [
        {
          id: 'r1',
          conversationId: 'conv-1',
          rootMessageId: 'm1',
          authorUid: 'uid-1',
          authorDisplayName: null,
          body: 'msg-1',
          createdAt: new Date('2026-01-01T10:00:00Z'),
          editedAt: null,
          deletedAt: null,
          mentions: [],
          mentionDisplayNames: {},
          attachments: [],
        },
      ];
      mockRepository.listReplies.mockResolvedValue(replies);

      const result = await useCase.execute({ rootMessageId: 'm1' });

      expect(result).toEqual(replies);
      expect(mockRepository.listReplies).toHaveBeenCalledWith('m1');
    });

    it('devolve array vazio quando a thread de topo não tem replies', async () => {
      mockRepository.findMessageThreadInfo.mockResolvedValue({ id: 'm1', conversationId: 'conv-1', rootMessageId: null });
      mockRepository.listReplies.mockResolvedValue([]);

      const result = await useCase.execute({ rootMessageId: 'm1' });

      expect(result).toEqual([]);
    });

    it('rejeita com RootMessageIsReplyError (400) quando o id É uma reply (tem rootMessageId próprio)', async () => {
      mockRepository.findMessageThreadInfo.mockResolvedValue({ id: 'r1', conversationId: 'conv-1', rootMessageId: 'm1' });

      await expect(useCase.execute({ rootMessageId: 'r1' })).rejects.toThrow(RootMessageIsReplyError);
      expect(mockRepository.listReplies).not.toHaveBeenCalled();
    });

    it('RootMessageIsReplyError carrega code=ROOT_MESSAGE_IS_REPLY e status=400', async () => {
      mockRepository.findMessageThreadInfo.mockResolvedValue({ id: 'r1', conversationId: 'conv-1', rootMessageId: 'm1' });

      await expect(useCase.execute({ rootMessageId: 'r1' })).rejects.toMatchObject({
        code: 'ROOT_MESSAGE_IS_REPLY',
        status: 400,
      });
    });

    it('id inexistente (findMessageThreadInfo null): segue para listReplies (lista vazia, sem inventar erro)', async () => {
      mockRepository.findMessageThreadInfo.mockResolvedValue(null);
      mockRepository.listReplies.mockResolvedValue([]);

      const result = await useCase.execute({ rootMessageId: 'nao-existe' });

      expect(result).toEqual([]);
      expect(mockRepository.listReplies).toHaveBeenCalledWith('nao-existe');
    });

    it('constrói seu próprio ConversationRepository quando nenhum é injetado (default constructor param)', async () => {
      mockDefaultRepoPoolQuery
        .mockResolvedValueOnce({ rows: [{ id: 'm1', rootMessageId: null }] })
        .mockResolvedValueOnce({ rows: [] });

      const useCaseWithDefaultRepository = new ListRepliesUseCase();
      const result = await useCaseWithDefaultRepository.execute({ rootMessageId: 'm1' });

      expect(mockDefaultRepoPoolQuery).toHaveBeenCalledTimes(2);
      expect(result).toEqual([]);
    });
  });
});
