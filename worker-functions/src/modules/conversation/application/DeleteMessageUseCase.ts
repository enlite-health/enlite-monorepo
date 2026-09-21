/**
 * DeleteMessageUseCase — soft delete de uma mensagem de conversa (spec 022, Bloco 1, T115).
 *
 * D-04 (fechada, não replanejar): SÓ o autor apaga a própria mensagem, sem janela de tempo —
 * mesmo guard de `EditMessageUseCase` (`assertIsMessageAuthor`, reusado daqui, sem duplicar
 * SQL). Autor diferente é `NotMessageAuthorError` (o controller converte em 403).
 *
 * Exclusão é SOFT: `deleted_at = now()` E `body_encrypted = NULL` na MESMA instrução — é
 * `ConversationRepository.softDeleteMessage` quem grava os dois efeitos (já testado em
 * `ConversationRepository.test.ts`). Este use case NUNCA cascateia para replies: a thread de
 * 1 nível (D-03) não tem "apagar filhos" — a reply de uma mensagem apagada permanece legível
 * (o corpo `NULL` da mãe já sinaliza "mensagem removida" para quem renderiza a thread).
 *
 * ⚠️ Nunca `pool.connect()` cru: roda dentro de `withActorContext(pool, fn)` — mesma razão de
 * `EditMessageUseCase`/`PostMessageUseCase` (BLOCKER-3, RLS fail-closed sem identidade carimbada).
 */
import type { Pool } from 'pg';
import { withActorContext } from '@shared/database/actorContext';
import { ConversationRepository } from '../infrastructure/ConversationRepository';
import { assertIsMessageAuthor } from './EditMessageUseCase';

export interface DeleteMessageParams {
  messageId: string;
  requesterUid: string;
}

export interface DeleteMessageResult {
  id: string;
}

export class DeleteMessageUseCase {
  constructor(private readonly repository: ConversationRepository = new ConversationRepository()) {}

  async execute(pool: Pool, params: DeleteMessageParams): Promise<DeleteMessageResult> {
    const { messageId, requesterUid } = params;

    return withActorContext(pool, async (client) => {
      await assertIsMessageAuthor(client, messageId, requesterUid);
      await this.repository.softDeleteMessage(messageId, client);
      return { id: messageId };
    });
  }
}
