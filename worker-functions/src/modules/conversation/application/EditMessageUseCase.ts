/**
 * EditMessageUseCase — edita o corpo de uma mensagem de conversa (spec 022, Bloco 1, T114).
 *
 * D-04 (fechada, não replanejar): SÓ o autor edita a própria mensagem, sem janela de tempo —
 * não existe "só nos primeiros N minutos". Autor diferente é erro de domínio
 * (`NotMessageAuthorError`, o controller converte em 403). A re-cifra do novo corpo e o
 * carimbo `edited_at` são responsabilidade de `ConversationRepository.updateMessage` (já
 * testado em `ConversationRepository.test.ts`) — este use case nunca monta esse UPDATE.
 *
 * `findMessageAuthorUid` é consulta direta (não passa pela `ConversationRepository`, que não
 * expõe leitura de autor por id) — mesmo padrão de `PostMessageUseCase.assertMentionsExist`:
 * use case consulta direto pelo `client` da transação para o que o repositório não cobre.
 * Exportada para `DeleteMessageUseCase` reusar (mesmo guard de autoria, sem duplicar SQL).
 *
 * ⚠️ Nunca `pool.connect()` cru: roda dentro de `withActorContext(pool, fn)` — sem isso a
 * policy de RLS derruba a query com sessão sem identidade (BLOCKER-3, já visto neste repo).
 */
import type { Pool, PoolClient } from 'pg';
import { withActorContext } from '@shared/database/actorContext';
import { ConversationRepository } from '../infrastructure/ConversationRepository';

export interface EditMessageParams {
  messageId: string;
  requesterUid: string;
  body: string;
}

export interface EditMessageResult {
  id: string;
}

/** Mensagem inexistente — recusa (o controller converte em 404). */
export class MessageNotFoundError extends Error {
  readonly code = 'MESSAGE_NOT_FOUND';
  readonly status = 404;

  constructor(readonly messageId: string) {
    super(`message ${messageId} not found`);
    this.name = 'MessageNotFoundError';
  }
}

/** Quem pediu não é o autor da mensagem — recusa (o controller converte em 403). Sem janela de tempo. */
export class NotMessageAuthorError extends Error {
  readonly code = 'NOT_MESSAGE_AUTHOR';
  readonly status = 403;

  constructor(readonly messageId: string) {
    super(`only the author can modify message ${messageId}`);
    this.name = 'NotMessageAuthorError';
  }
}

/**
 * Mensagem já apagada (soft delete) — recusa (o controller converte em 409). Achado do gate
 * revisao-pr (Bloco 1): editar uma mensagem apagada re-populava `body_encrypted`, desfazendo o
 * soft delete. 409 (não 404) porque a mensagem EXISTE — só está num estado que não aceita edição;
 * 404 apagaria a distinção entre "nunca existiu" e "existiu e foi apagada".
 */
export class MessageAlreadyDeletedError extends Error {
  readonly code = 'MESSAGE_ALREADY_DELETED';
  readonly status = 409;

  constructor(readonly messageId: string) {
    super(`message ${messageId} was already deleted`);
    this.name = 'MessageAlreadyDeletedError';
  }
}

interface MessageAuthorInfo {
  authorUid: string;
  deletedAt: Date | null;
}

/**
 * `author_uid`/`deleted_at` de uma mensagem, ou `null` se não existe — consulta direta pelo
 * `client` da transação. `deletedAt` viaja junto (mesma linha, sem 2ª query) para quem precisar
 * decidir sobre soft delete sem duplicar o SELECT — só o `EditMessageUseCase` usa esse campo hoje;
 * `DeleteMessageUseCase` (via `assertIsMessageAuthor`) continua ignorando-o, sem mudança de
 * comportamento no delete (fora do escopo deste achado).
 */
export async function findMessageAuthorUid(client: PoolClient, messageId: string): Promise<MessageAuthorInfo | null> {
  const { rows } = await client.query<MessageAuthorInfo>(
    `SELECT author_uid AS "authorUid", deleted_at AS "deletedAt" FROM conversation_messages WHERE id = $1`,
    [messageId],
  );
  return rows[0] ?? null;
}

/**
 * Recusa se `messageId` não existe, ou se `requesterUid` não é o autor. Compartilhado com o
 * delete. Devolve a linha (`authorUid`/`deletedAt`) para quem precisar do `deletedAt` sem 2ª query.
 */
export async function assertIsMessageAuthor(
  client: PoolClient,
  messageId: string,
  requesterUid: string,
): Promise<MessageAuthorInfo> {
  const info = await findMessageAuthorUid(client, messageId);
  if (info === null) throw new MessageNotFoundError(messageId);
  if (info.authorUid !== requesterUid) throw new NotMessageAuthorError(messageId);
  return info;
}

export class EditMessageUseCase {
  constructor(private readonly repository: ConversationRepository = new ConversationRepository()) {}

  async execute(pool: Pool, params: EditMessageParams): Promise<EditMessageResult> {
    const { messageId, requesterUid, body } = params;

    return withActorContext(pool, async (client) => {
      const info = await assertIsMessageAuthor(client, messageId, requesterUid);
      if (info.deletedAt) throw new MessageAlreadyDeletedError(messageId);
      await this.repository.updateMessage(messageId, body, client);
      return { id: messageId };
    });
  }
}
