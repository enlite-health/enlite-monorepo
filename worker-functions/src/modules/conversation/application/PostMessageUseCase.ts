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
 * Fan-out (D-09): roda dentro da MESMA transação, recebendo o client dela — desde o Bloco 4
 * (T403), o default de produção é `FanOutNotificationUseCase` REAL (`@modules/inapp-notification`);
 * o Bloco 1 usava um stub no-op, hoje removido.
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
import { FanOutNotificationUseCase } from '@modules/inapp-notification/application/FanOutNotificationUseCase';
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
 * `fileIds` com uuid que não existe em `stored_files`, OU que existe mas não passa no cruzamento
 * de posse (T305-T317, Bloco 3) — recusa (o controller converte em 400), SEMPRE com a mesma
 * mensagem/código para as 4 causas (anti-enumeração, mesmo padrão de `MessageNotFoundError` em
 * `resolveRoot`): não existe, pertence a OUTRA conversa/paciente, não foi enviado por este autor,
 * ou já está anexado a outra mensagem.
 *
 * Histórico: achado do gate revisao-pr (Bloco 1, Tarefa 3) fechou só a existência — sem ela, um id
 * arbitrário virava FK violation → 500, e o `ON DELETE RESTRICT` de `conversation_message_attachments`
 * (migration 459) deixava quem tivesse a célula `patient_conversation:create` anexar um id
 * QUALQUER de `stored_files` — inclusive de outro registro — tornando aquele arquivo indeletável.
 * O cruzamento de posse (arquivo pertence a ESTE paciente/conversa/autor, e não está reutilizado)
 * ficou registrado como requisito de entrada do Bloco 3 (`evidencias/achados.md`) — fechado aqui
 * com `stored_files.conversation_id` (migration 461, T305-T317).
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
  /** Bloco 4 (T403): paciente-dono da conversa — `FanOutNotificationUseCase` grava em
   * `notification_events.patient_id`. `null` só se a conversa não existir mais (defesa em
   * profundidade; `resolveConversationForPatient` já validou antes de chegar aqui). */
  patientId: string | null;
  rootMessageId: string | null;
  authorUid: string;
  createdAt: Date;
  mentionedUids: string[];
}

/**
 * Hook de fan-out (D-09) — no Bloco 1 era STUB (`NoopFanOutHook`, no-op); Bloco 4 (T403)
 * substitui o DEFAULT por `FanOutNotificationUseCase` real (`@modules/inapp-notification`),
 * chamado dentro da MESMA transação do POST message (mesmo `client`, nunca uma conexão à parte).
 * A interface continua existindo para permitir injetar um mock em teste (`PostMessageUseCase.test.ts`
 * já fazia isso ANTES do B4 — nenhuma mudança de contrato aqui, só do default de produção).
 */
export interface PostMessageFanOutHook {
  execute(client: PoolClient, message: PostMessageResult): Promise<void>;
}

export class PostMessageUseCase {
  constructor(
    private readonly repository: ConversationRepository = new ConversationRepository(),
    private readonly fanOutHook: PostMessageFanOutHook = new FanOutNotificationUseCase(),
  ) {}

  async execute(pool: Pool, params: PostMessageParams): Promise<PostMessageResult> {
    const { conversationId, authorUid, body, rootMessageId = null, fileIds = [] } = params;

    return withActorContext(pool, async (client) => {
      const resolvedRootId = await this.resolveRoot(client, conversationId, rootMessageId);
      const mentionedUids = extractMentionedUids(body);
      await this.assertMentionsExist(client, mentionedUids);
      await this.assertFilesOwnedByAuthor(client, conversationId, authorUid, fileIds);

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

      // Bloco 4 (T403): `patientId` só é preciso para o fan-out (notification_events.patient_id)
      // — leitura extra, MESMA transação/client, nunca abre conexão própria.
      const patientId = await this.repository.findPatientIdByConversationId(conversationId, client);

      const result: PostMessageResult = {
        id: inserted.id,
        conversationId,
        patientId,
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

  /**
   * Cruzamento de posse completo (T305-T317, Bloco 3) — recusa ANTES de gravar mensagem/anexo
   * (400), com a MESMA `AttachedFileNotFoundError` para as 4 causas (nunca distingue qual, mesmo
   * padrão anti-enumeração de `resolveRoot`/`MessageNotFoundError`):
   *  1. `fileId` não existe em `stored_files`;
   *  2. existe, mas `conversation_id` é de OUTRO paciente/conversa (não o da rota);
   *  3. existe nesta conversa, mas foi enviado por OUTRO uid (`uploaded_by_uid !== authorUid`);
   *  4. já está anexado a outra mensagem (`conversation_message_attachments`, mesmo `ON DELETE
   *     RESTRICT` da migration 459 — reusar o mesmo arquivo em 2 mensagens duplicaria posse).
   */
  private async assertFilesOwnedByAuthor(
    client: PoolClient,
    conversationId: string,
    authorUid: string,
    fileIds: string[],
  ): Promise<void> {
    if (fileIds.length === 0) return;
    const { rows } = await client.query<{ id: string; owned: boolean }>(
      `SELECT sf.id,
              (
                sf.conversation_id = $2
                AND sf.uploaded_by_uid = $3
                AND NOT EXISTS (
                  SELECT 1 FROM conversation_message_attachments cma WHERE cma.file_id = sf.id
                )
              ) AS owned
         FROM stored_files sf
        WHERE sf.id = ANY($1::uuid[])`,
      [fileIds, conversationId, authorUid],
    );
    const ownedById = new Map(rows.map((r) => [r.id, r.owned]));
    const rejected = fileIds.find((id) => !ownedById.get(id));
    if (rejected) throw new AttachedFileNotFoundError(rejected);
  }

  private async attachFiles(client: PoolClient, messageId: string, fileIds: string[]): Promise<void> {
    const values = fileIds.map((_, i) => `($1, $${i + 2})`).join(', ');
    try {
      await client.query(
        `INSERT INTO conversation_message_attachments (message_id, file_id) VALUES ${values}`,
        [messageId, ...fileIds],
      );
    } catch (err: unknown) {
      // Corrida entre 2 POSTs concorrentes que passaram os DOIS pelo SELECT de
      // `assertFilesOwnedByAuthor` (sem lock) antes de qualquer um inserir — a UNIQUE (file_id)
      // da migration 461 fecha a janela no banco; aqui só traduz a violação (23505) para o MESMO
      // 400 anti-enumeração que a checagem de posse já usa (nunca 500 pra este caso).
      if ((err as { code?: string } | null)?.code === '23505') {
        throw new AttachedFileNotFoundError(fileIds[0]);
      }
      throw err;
    }
  }
}
