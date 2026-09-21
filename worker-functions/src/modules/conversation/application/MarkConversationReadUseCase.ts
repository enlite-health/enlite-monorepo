/**
 * MarkConversationReadUseCase — marca uma conversa como lida para um usuário
 * (spec 022, Bloco 1, T116-T117).
 *
 * Regra fechada: `ON CONFLICT (conversation_id, user_uid) DO UPDATE` no repositório
 * garante que a segunda chamada para o mesmo par não duplica — sobrescreve o timestamp.
 *
 * A operação roda dentro de `withActorContext` para garantir que o carimbo de identidade
 * (`app.current_uid`) está disponível na RLS policy (mesma razão de `PostMessageUseCase`).
 */
import type { Pool } from 'pg';
import { withActorContext } from '@shared/database/actorContext';
import { ConversationRepository } from '../infrastructure/ConversationRepository';

export interface MarkConversationReadParams {
  conversationId: string;
  userUid: string;
}

export class MarkConversationReadUseCase {
  constructor(private readonly repository: ConversationRepository = new ConversationRepository()) {}

  async execute(pool: Pool, params: MarkConversationReadParams): Promise<void> {
    const { conversationId, userUid } = params;
    const lastReadAt = new Date();

    return withActorContext(pool, async (client) => {
      await this.repository.upsertReadMark(conversationId, userUid, lastReadAt, client);
    });
  }
}
