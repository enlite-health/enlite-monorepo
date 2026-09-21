/**
 * PostMessageUseCase — grava uma mensagem de conversa (spec 022, Bloco 1, T110).
 *
 * Três regras que este use case fecha, nesta ordem:
 *  1. Normaliza `rootMessageId` para o ROOT DO ROOT (D-03 — "resposta de resposta" do Slack):
 *     responder a uma reply nunca cria 2º nível; vira reply do MESMO root da reply original,
 *     sem erro para quem pediu. Resolvido via `ConversationRepository.findMessageThreadInfo`.
 *  2. Extrai `<@uid>` do corpo (`extractMentionedUids`) e valida contra `users` — uid
 *     inexistente recusa com `MentionedUserNotFoundError` (o controller converte em 400).
 *  3. Grava mensagem + menções + anexos NUMA transação. A cifra do corpo é responsabilidade
 *     de `ConversationRepository.insertMessage` (já teste em `ConversationRepository.test.ts`,
 *     T108) — este use case NUNCA monta um INSERT próprio com o corpo em claro.
 *
 * Fan-out (D-09): roda dentro da MESMA transação, recebendo o client dela — aqui é STUB
 * (`PostMessageFanOutHook`, no-op por padrão); a implementação real fica para o Bloco 4.
 *
 * ⚠️ Nunca `pool.connect()` cru: a operação inteira roda dentro de `withActorContext(pool, fn)`
 * (`@shared/database/actorContext`), que carimba `app.current_uid`/`app.user_country` no client —
 * sem isso a policy de RLS derruba a query com sessão sem identidade (BLOCKER-3, já visto neste
 * repo). O ROLLBACK em erro é responsabilidade do PRÓPRIO `withActorContext` (try/catch já
 * embutido nele — ver `actorContext.ts`); este use case não abre try/catch de transação por
 * fora, só deixa o erro propagar de dentro de `fn` para que o wrapper reverta.
 */
import type { Pool, PoolClient } from 'pg';
import { withActorContext } from '@shared/database/actorContext';
import { ConversationRepository } from '../infrastructure/ConversationRepository';
import { extractMentionedUids, MentionedUserNotFoundError } from '../domain/ConversationMention';
import { messageBelongsToConversation } from '../domain/MessageThreadOwnership';
import { MessageNotFoundError } from './EditMessageUseCase';

export interface PostMessageParams {
  conversationId: string;
  authorUid: string;
  body: string;
  rootMessageId?: string | null;
  fileIds?: string[];
}

/**
 * `fileIds` com uuid que não existe em `stored_files` — recusa (o controller converte em 400).
 * Achado do gate revisao-pr (Bloco 1, Tarefa 3): sem esta checagem, um id arbitrário virava FK
 * violation → 500 (não 400), e o `ON DELETE RESTRICT` de `conversation_message_attachments`
 * (migration 459) deixava quem tivesse a célula `patient_conversation:create` anexar um id
 * QUALQUER de `stored_files` — inclusive de outro registro — tornando aquele arquivo
 * indeletável. O cruzamento completo (arquivo pertence a este paciente/conversa) fica fora de
 * escopo: exige o schema de anexos do Bloco 3.
 */
export class AttachedFileNotFoundError extends Error {
  readonly code = 'ATTACHED_FILE_NOT_FOUND';
  readonly status = 400;

  constructor(readonly fileId: string) {
    super(`attached file ${fileId} not found`);
    this.name = 'AttachedFileNotFoundError';
  }
}

export interface PostMessageResult {
  id: string;
  conversationId: string;
  rootMessageId: string | null;
  authorUid: string;
  createdAt: Date;
  mentionedUids: string[];
}

/** Hook de fan-out — STUB nesta task; o Bloco 4 substitui pela notificação real. */
export interface PostMessageFanOutHook {
  execute(client: PoolClient, message: PostMessageResult): Promise<void>;
}

class NoopFanOutHook implements PostMessageFanOutHook {
  async execute(): Promise<void> {
    /* stub — Bloco 4 implementa a notificação real */
  }
}

export class PostMessageUseCase {
  constructor(
    private readonly repository: ConversationRepository = new ConversationRepository(),
    private readonly fanOutHook: PostMessageFanOutHook = new NoopFanOutHook(),
  ) {}

  async execute(pool: Pool, params: PostMessageParams): Promise<PostMessageResult> {
    const { conversationId, authorUid, body, rootMessageId = null, fileIds = [] } = params;

    return withActorContext(pool, async (client) => {
      const resolvedRootId = await this.resolveRoot(client, conversationId, rootMessageId);
      const mentionedUids = extractMentionedUids(body);
      await this.assertMentionsExist(client, mentionedUids);
      await this.assertFilesExist(client, fileIds);

      const inserted = await this.repository.insertMessage(
        { conversationId, rootMessageId: resolvedRootId, authorUid, body },
        client,
      );

      if (mentionedUids.length > 0) {
        await this.insertMentions(client, inserted.id, mentionedUids);
      }
      if (fileIds.length > 0) {
        await this.attachFiles(client, inserted.id, fileIds);
      }

      const result: PostMessageResult = {
        id: inserted.id,
        conversationId,
        rootMessageId: resolvedRootId,
        authorUid,
        createdAt: inserted.createdAt,
        mentionedUids,
      };

      await this.fanOutHook.execute(client, result);
      return result;
    });
  }

  /**
   * Root do root (D-03): se `replyToId` já é uma reply (tem `rootMessageId` próprio),
   * normaliza para ELE — nunca aponta para uma reply. Mensagem de topo devolve o próprio
   * `replyToId`.
   *
   * ⚠️ Cruza `replyToId` com o `conversationId` da rota (`messageBelongsToConversation`, MESMO
   * guard de `AdminConversationController.assertMessageBelongsToPatientConversation`) — achado
   * do gate revisao-pr (Bloco 1, vetor de BODY): sem este cruzamento, `rootMessageId` de OUTRO
   * paciente era aceito e a reply gravava `conversation_id` do paciente A com `root_message_id`
   * apontando pra mensagem do paciente B — o GET replies de B então incluía essa reply, vazando
   * corpo de mensagem entre pacientes. `replyToId` inexistente OU de outra conversa recusa da
   * MESMA forma (404, `MessageNotFoundError`) — nunca distingue as duas causas (evita enumeração
   * de id, mesmo padrão dos irmãos `editMessage`/`deleteMessage`/`listReplies`).
   */
  private async resolveRoot(
    client: PoolClient,
    conversationId: string,
    replyToId: string | null,
  ): Promise<string | null> {
    if (!replyToId) return null;
    const info = await this.repository.findMessageThreadInfo(replyToId, client);
    if (!info || !messageBelongsToConversation(info, conversationId)) {
      throw new MessageNotFoundError(replyToId);
    }
    return info.rootMessageId ?? replyToId;
  }

  private async assertMentionsExist(client: PoolClient, uids: string[]): Promise<void> {
    if (uids.length === 0) return;
    const { rows } = await client.query<{ firebaseUid: string }>(
      `SELECT firebase_uid AS "firebaseUid" FROM users WHERE firebase_uid = ANY($1::varchar[])`,
      [uids],
    );
    const found = new Set(rows.map((r) => r.firebaseUid));
    const missing = uids.find((uid) => !found.has(uid));
    if (missing) throw new MentionedUserNotFoundError(missing);
  }

  private async insertMentions(client: PoolClient, messageId: string, uids: string[]): Promise<void> {
    const values = uids.map((_, i) => `($1, $${i + 2})`).join(', ');
    await client.query(
      `INSERT INTO conversation_message_mentions (message_id, mentioned_uid) VALUES ${values}`,
      [messageId, ...uids],
    );
  }

  /** `fileIds` que não existem em `stored_files` — recusa ANTES de gravar mensagem/anexo (400). */
  private async assertFilesExist(client: PoolClient, fileIds: string[]): Promise<void> {
    if (fileIds.length === 0) return;
    const { rows } = await client.query<{ id: string }>(
      `SELECT id FROM stored_files WHERE id = ANY($1::uuid[])`,
      [fileIds],
    );
    const found = new Set(rows.map((r) => r.id));
    const missing = fileIds.find((id) => !found.has(id));
    if (missing) throw new AttachedFileNotFoundError(missing);
  }

  private async attachFiles(client: PoolClient, messageId: string, fileIds: string[]): Promise<void> {
    const values = fileIds.map((_, i) => `($1, $${i + 2})`).join(', ');
    await client.query(
      `INSERT INTO conversation_message_attachments (message_id, file_id) VALUES ${values}`,
      [messageId, ...fileIds],
    );
  }
}
