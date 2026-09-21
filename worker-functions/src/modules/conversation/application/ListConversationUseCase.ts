/**
 * ListConversationUseCase — lista mensagens de topo de uma conversa com paginação por cursor
 * (spec 022, Bloco 1, T111-T112).
 *
 * Regra fechada: o `nextCursor` sempre usa o `(created_at, id)` do ÚLTIMO item da página.
 * Se a página tem < limit itens, não há próxima página — `nextCursor` é undefined.
 * Isso previne lacunas e repetições em paginação com timestamp+id.
 */
import { ConversationRepository, CONVERSATION_PAGE_SIZE, TopMessageRow, ConversationMessageCursor } from '../infrastructure/ConversationRepository';

export interface ListConversationParams {
  conversationId: string;
  after?: ConversationMessageCursor | null;
  limit?: number;
}

export interface ListConversationResult {
  messages: TopMessageRow[];
  nextCursor?: ConversationMessageCursor;
}

export class ListConversationUseCase {
  constructor(private readonly repository: ConversationRepository = new ConversationRepository()) {}

  async execute(params: ListConversationParams): Promise<ListConversationResult> {
    const { conversationId, after = null, limit = CONVERSATION_PAGE_SIZE } = params;

    const messages = await this.repository.listTopMessages(conversationId, after, limit);

    // nextCursor só existe se a página está cheia (significa que há mais páginas)
    const nextCursor = messages.length === limit ? this.buildNextCursor(messages) : undefined;

    return {
      messages,
      nextCursor,
    };
  }

  /**
   * Constrói o cursor para a próxima página usando o ÚLTIMO item da página atual.
   * Essa técnica evita lacunas/repetições quando duas mensagens têm o mesmo `created_at`.
   */
  private buildNextCursor(messages: TopMessageRow[]): ConversationMessageCursor {
    const lastMessage = messages[messages.length - 1];
    return {
      createdAt: lastMessage.createdAt,
      id: lastMessage.id,
    };
  }
}
