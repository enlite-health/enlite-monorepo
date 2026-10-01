/**
 * ListConversationUseCase — lista mensagens de topo de uma conversa com paginação por cursor
 * (spec 022, Bloco 1, T111-T112) e devolve o estado de leitura do ATOR (D-11, Bloco 2).
 *
 * Regra fechada: o `nextCursor` sempre usa o `(created_at, id)` do ÚLTIMO item da página.
 * Se a página tem < limit itens, não há próxima página — `nextCursor` é undefined.
 * Isso previne lacunas e repetições em paginação com timestamp+id.
 *
 * `lastReadAt`/`unreadCount` vêm de `repository.getReadState` — UMA query própria (não deriva da
 * página de `messages`, que é só uma FATIA paginada; o não-lido é sobre a conversa inteira).
 */
import { ConversationRepository, CONVERSATION_PAGE_SIZE, TopMessageRow, ConversationMessageCursor } from '../infrastructure/ConversationRepository';

export interface ListConversationParams {
  conversationId: string;
  actorUid: string;
  after?: ConversationMessageCursor | null;
  limit?: number;
}

export interface ListConversationResult {
  messages: TopMessageRow[];
  nextCursor?: ConversationMessageCursor;
  lastReadAt: Date | null;
  unreadCount: number;
}

export class ListConversationUseCase {
  constructor(private readonly repository: ConversationRepository = new ConversationRepository()) {}

  async execute(params: ListConversationParams): Promise<ListConversationResult> {
    const { conversationId, actorUid, after = null, limit = CONVERSATION_PAGE_SIZE } = params;

    const messages = await this.repository.listTopMessages(conversationId, after, limit);
    const readState = await this.repository.getReadState(conversationId, actorUid);

    // nextCursor só existe se a página está cheia (significa que há mais páginas)
    const nextCursor = messages.length === limit ? this.buildNextCursor(messages) : undefined;

    return {
      messages,
      nextCursor,
      lastReadAt: readState.lastReadAt,
      unreadCount: readState.unreadCount,
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
