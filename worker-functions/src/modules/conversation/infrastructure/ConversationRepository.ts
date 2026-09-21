/**
 * ConversationRepository — leitura/escrita de `conversation_messages` e `conversation_read_marks`
 * (Spec 022, Bloco 1, T108).
 *
 * `body_encrypted` nunca sai em claro do banco sem passar pelo KMS (padrão de uso:
 * `PatientRepository.ts` / `PatientResponsibleRepository.ts`). Toda LEITURA que decifra corpo
 * passa por `mapWithConcurrency` com limite fixo — decifra em série estoura a latência da
 * listagem, decifra sem limite estoura a cota da API do KMS (D-01 da spec 022).
 *
 * Escrita nunca abre transação própria (`pool.connect()` cru): quem tem `client: PoolClient`
 * já está dentro de uma transação aberta por `withActorContext` no use case (T110) — abrir uma
 * segunda aqui duplicaria conexão por request (BLOCKER-3, ver `actorContext.ts`) e, pior, um
 * client cru sem `app.user_country` cai em RLS fail-closed. Leitura aceita `executor` opcional
 * (Pool por padrão) porque não precisa desse carimbo — molde: `PatientPhotoRepository.findOne`.
 */
import type { Pool, PoolClient } from 'pg';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import { KMSEncryptionService } from '@shared/security/KMSEncryptionService';
import { mapWithConcurrency } from '@shared/async/mapWithConcurrency';

/** Página padrão da listagem de mensagens de topo (spec 022, Bloco 1). */
export const CONVERSATION_PAGE_SIZE = 50;

/** Limite de decifra KMS em paralelo — D-01: acima disso estoura cota da API. */
const DECRYPT_CONCURRENCY_LIMIT = 10;

export interface ConversationMessageCursor {
  createdAt: Date;
  id: string;
}

export interface TopMessageRow {
  id: string;
  conversationId: string;
  authorUid: string;
  body: string;
  createdAt: Date;
  editedAt: Date | null;
  deletedAt: Date | null;
  replyCount: number;
  lastReplyAt: Date | null;
  mentions: string[];
  attachments: AttachmentRow[];
}

/** Anexo de uma mensagem, forma do contrato (`contracts/openapi-conversation.md`): sem `originalName` — o nome decifrado só sai no download (`GET .../files/:fileId/url`), nunca na listagem. */
export interface AttachmentRow {
  fileId: string;
  contentType: string;
  sizeBytes: number;
}

/**
 * Marca de leitura do ATOR + contagem de não lidas (D-11 da spec 022: `created_at > last_read_at`
 * E `author_uid` diferente do ator, contando mensagem de TOPO e REPLY — nunca só topo). Sem marca
 * de leitura (`lastReadAt: null`), conta TUDO que não é do próprio ator (baseline `-infinity`).
 */
export interface ConversationReadState {
  lastReadAt: Date | null;
  unreadCount: number;
}

export interface ReplyMessageRow {
  id: string;
  conversationId: string;
  rootMessageId: string;
  authorUid: string;
  body: string;
  createdAt: Date;
  editedAt: Date | null;
  deletedAt: Date | null;
  mentions: string[];
  attachments: AttachmentRow[];
}

export interface InsertMessageInput {
  conversationId: string;
  rootMessageId: string | null;
  authorUid: string;
  body: string;
}

/**
 * Info mínima de thread de uma mensagem — o que `PostMessageUseCase` precisa para normalizar.
 * `conversationId` foi acrescentado pelo conserto do gate revisao-pr (Bloco 1) — achado que
 * `AdminConversationController.editMessage`/`deleteMessage` não cruzavam `:mid` com `:id`; campo
 * aditivo, `ListRepliesUseCase`/`PostMessageUseCase` continuam usando só `rootMessageId`.
 */
export interface MessageThreadInfo {
  id: string;
  conversationId: string;
  rootMessageId: string | null;
}

interface RawTopMessageRow {
  id: string;
  conversationId: string;
  authorUid: string;
  bodyEncrypted: string | null;
  createdAt: Date;
  editedAt: Date | null;
  deletedAt: Date | null;
  replyCount: number;
  lastReplyAt: Date | null;
}

interface RawReplyRow {
  id: string;
  conversationId: string;
  rootMessageId: string;
  authorUid: string;
  bodyEncrypted: string | null;
  createdAt: Date;
  editedAt: Date | null;
  deletedAt: Date | null;
}

interface RawMentionRow {
  messageId: string;
  mentionedUid: string;
}

interface RawAttachmentRow {
  messageId: string;
  fileId: string;
  contentType: string;
  sizeBytes: number;
}

export class ConversationRepository {
  private pool: Pool;
  private encryptionService: KMSEncryptionService;

  constructor(pool?: Pool) {
    this.pool = pool ?? DatabaseConnection.getInstance().getPool();
    this.encryptionService = new KMSEncryptionService();
  }

  /**
   * Mensagens de topo (`root_message_id IS NULL`) de uma conversa, paginadas por cursor.
   *
   * O cursor é `(created_at, id)` do ÚLTIMO item da página anterior — nunca do primeiro. É o
   * `id` que desempata quando duas linhas têm o MESMO `created_at`: a comparação de tupla do
   * Postgres (`(a,b) > (c,d)`) só avança para o campo seguinte quando o anterior é igual, então
   * duas mensagens com timestamp idêntico nunca são repetidas nem puladas entre páginas.
   *
   * `replyCount`/`lastReplyAt` vêm de UMA query com `GROUP BY root_message_id` (subquery
   * agregada em LEFT JOIN) — nunca uma query por mensagem de topo (evita N+1).
   */
  async listTopMessages(
    conversationId: string,
    after: ConversationMessageCursor | null,
    limit: number = CONVERSATION_PAGE_SIZE,
    executor: Pool | PoolClient = this.pool,
  ): Promise<TopMessageRow[]> {
    const values: unknown[] = [conversationId];
    let cursorClause = '';
    if (after) {
      values.push(after.createdAt, after.id);
      cursorClause = `AND (m.created_at, m.id) > ($${values.length - 1}::timestamptz, $${values.length}::uuid)`;
    }
    values.push(limit);

    const { rows } = await executor.query<RawTopMessageRow>(
      `SELECT
          m.id,
          m.conversation_id AS "conversationId",
          m.author_uid AS "authorUid",
          m.body_encrypted AS "bodyEncrypted",
          m.created_at AS "createdAt",
          m.edited_at AS "editedAt",
          m.deleted_at AS "deletedAt",
          COALESCE(r.reply_count, 0)::int AS "replyCount",
          r.last_reply_at AS "lastReplyAt"
       FROM conversation_messages m
       LEFT JOIN (
         SELECT root_message_id, COUNT(*) AS reply_count, MAX(created_at) AS last_reply_at
         FROM conversation_messages
         WHERE root_message_id IS NOT NULL
         GROUP BY root_message_id
       ) r ON r.root_message_id = m.id
       WHERE m.conversation_id = $1
         AND m.root_message_id IS NULL
         ${cursorClause}
       ORDER BY m.created_at ASC, m.id ASC
       LIMIT $${values.length}`,
      values,
    );

    const bodies = await mapWithConcurrency(rows, DECRYPT_CONCURRENCY_LIMIT, (row) =>
      this.encryptionService.decrypt(row.bodyEncrypted),
    );
    const mentionsByMessageId = await this.fetchMentionsByMessageIds(rows.map((row) => row.id), executor);
    const attachmentsByMessageId = await this.fetchAttachmentsByMessageIds(rows.map((row) => row.id), executor);

    return rows.map((row, i) => ({
      id: row.id,
      conversationId: row.conversationId,
      authorUid: row.authorUid,
      body: bodies[i],
      createdAt: row.createdAt,
      editedAt: row.editedAt,
      deletedAt: row.deletedAt,
      replyCount: row.replyCount,
      lastReplyAt: row.lastReplyAt,
      mentions: mentionsByMessageId.get(row.id) ?? [],
      attachments: attachmentsByMessageId.get(row.id) ?? [],
    }));
  }

  /**
   * `mentioned_uid` de todas as mensagens dadas, EM UMA query com `WHERE ... = ANY($1)` — nunca
   * uma query por mensagem (evita N+1; mesma disciplina do `replyCount` em `listTopMessages`).
   * Ordem alfabética do uid dentro de cada mensagem (a tabela `conversation_message_mentions`,
   * mig 458, não guarda a ordem de aparição no corpo — só existência do par
   * `(message_id, mentioned_uid)`; a ordem de leitura do corpo, se algum dia importar para a UI,
   * é responsabilidade de quem grava, não desta leitura).
   */
  private async fetchMentionsByMessageIds(
    messageIds: string[],
    executor: Pool | PoolClient,
  ): Promise<Map<string, string[]>> {
    const mentionsByMessageId = new Map<string, string[]>();
    if (messageIds.length === 0) return mentionsByMessageId;

    const { rows } = await executor.query<RawMentionRow>(
      `SELECT message_id AS "messageId", mentioned_uid AS "mentionedUid"
         FROM conversation_message_mentions
        WHERE message_id = ANY($1::uuid[])
        ORDER BY message_id, mentioned_uid`,
      [messageIds],
    );

    for (const row of rows) {
      const existing = mentionsByMessageId.get(row.messageId);
      if (existing) existing.push(row.mentionedUid);
      else mentionsByMessageId.set(row.messageId, [row.mentionedUid]);
    }
    return mentionsByMessageId;
  }

  /**
   * Anexos de todas as mensagens dadas, EM UMA query com `JOIN` + `WHERE ... = ANY($1)` — mesma
   * disciplina anti-N+1 de `fetchMentionsByMessageIds`. Achado do Bloco 3 (`evidencias/b3-backend-anexo.md`):
   * `toMessageDto`/`toReplyDto` devolviam `attachments: []` sempre, mesmo para mensagem com anexo
   * real gravado por `PostMessageUseCase.attachFiles`. Forma da linha = contrato
   * (`contracts/openapi-conversation.md`): `{ fileId, contentType, sizeBytes }`, sem `originalName`
   * — o nome decifrado só sai no download (`GetConversationAttachmentUrlUseCase`), nunca aqui.
   *
   * RLS: mesma proteção de `conversation_message_mentions`/`conversation_messages` — as policies
   * de `stored_files`/`conversation_message_attachments` (migration 461) seguem `conversations`
   * via `EXISTS`, que por sua vez já filtra por país sob `app_runtime`; esta query não abre
   * exceção nenhuma (nenhum `WHERE` adicional necessário além do `JOIN`, o RLS já filtra as
   * linhas visíveis à sessão).
   */
  private async fetchAttachmentsByMessageIds(
    messageIds: string[],
    executor: Pool | PoolClient,
  ): Promise<Map<string, AttachmentRow[]>> {
    const attachmentsByMessageId = new Map<string, AttachmentRow[]>();
    if (messageIds.length === 0) return attachmentsByMessageId;

    const { rows } = await executor.query<RawAttachmentRow>(
      `SELECT cma.message_id AS "messageId",
              sf.id AS "fileId",
              sf.content_type AS "contentType",
              sf.size_bytes AS "sizeBytes"
         FROM conversation_message_attachments cma
         JOIN stored_files sf ON sf.id = cma.file_id
        WHERE cma.message_id = ANY($1::uuid[])
        ORDER BY cma.message_id, sf.created_at`,
      [messageIds],
    );

    for (const row of rows) {
      const entry: AttachmentRow = { fileId: row.fileId, contentType: row.contentType, sizeBytes: row.sizeBytes };
      const existing = attachmentsByMessageId.get(row.messageId);
      if (existing) existing.push(entry);
      else attachmentsByMessageId.set(row.messageId, [entry]);
    }
    return attachmentsByMessageId;
  }

  /** Todas as replies de uma thread de 1 nível, em ordem cronológica. */
  async listReplies(
    rootMessageId: string,
    executor: Pool | PoolClient = this.pool,
  ): Promise<ReplyMessageRow[]> {
    const { rows } = await executor.query<RawReplyRow>(
      `SELECT
          id,
          conversation_id AS "conversationId",
          root_message_id AS "rootMessageId",
          author_uid AS "authorUid",
          body_encrypted AS "bodyEncrypted",
          created_at AS "createdAt",
          edited_at AS "editedAt",
          deleted_at AS "deletedAt"
       FROM conversation_messages
       WHERE root_message_id = $1
       ORDER BY created_at ASC, id ASC`,
      [rootMessageId],
    );

    const bodies = await mapWithConcurrency(rows, DECRYPT_CONCURRENCY_LIMIT, (row) =>
      this.encryptionService.decrypt(row.bodyEncrypted),
    );
    const mentionsByMessageId = await this.fetchMentionsByMessageIds(rows.map((row) => row.id), executor);
    const attachmentsByMessageId = await this.fetchAttachmentsByMessageIds(rows.map((row) => row.id), executor);

    return rows.map((row, i) => ({
      id: row.id,
      conversationId: row.conversationId,
      rootMessageId: row.rootMessageId,
      authorUid: row.authorUid,
      body: bodies[i],
      createdAt: row.createdAt,
      editedAt: row.editedAt,
      deletedAt: row.deletedAt,
      mentions: mentionsByMessageId.get(row.id) ?? [],
      attachments: attachmentsByMessageId.get(row.id) ?? [],
    }));
  }

  /**
   * `id`/`root_message_id` de uma mensagem — o que `PostMessageUseCase` (T110) consulta ANTES
   * de inserir uma reply, para normalizar `rootMessageId` para o ROOT DO ROOT (D-03: responder
   * a uma reply não cria 2º nível). `rootMessageId: null` na resposta significa que a própria
   * mensagem É o root; mensagem inexistente devolve `null` (o caller decide o fallback — o
   * trigger `trg_conversation_messages_one_level` é a rede de segurança final).
   */
  async findMessageThreadInfo(
    messageId: string,
    executor: Pool | PoolClient = this.pool,
  ): Promise<MessageThreadInfo | null> {
    const { rows } = await executor.query<MessageThreadInfo>(
      `SELECT id, conversation_id AS "conversationId", root_message_id AS "rootMessageId"
         FROM conversation_messages WHERE id = $1`,
      [messageId],
    );
    return rows[0] ?? null;
  }

  /**
   * Insere mensagem. Recebe `client` de fora (quem abre/carimba a transação é o use case via
   * `withActorContext` — T110): a normalização de reply-de-reply para o ROOT e a validação de
   * menções rodam ANTES, na mesma transação, e o trigger `trg_conversation_messages_one_level`
   * é a rede de segurança do banco.
   */
  async insertMessage(
    input: InsertMessageInput,
    client: PoolClient,
  ): Promise<{ id: string; createdAt: Date }> {
    const bodyEncrypted = await this.encryptionService.encrypt(input.body);
    const { rows } = await client.query<{ id: string; createdAt: Date }>(
      `INSERT INTO conversation_messages (conversation_id, root_message_id, author_uid, body_encrypted)
       VALUES ($1, $2, $3, $4)
       RETURNING id, created_at AS "createdAt"`,
      [input.conversationId, input.rootMessageId, input.authorUid, bodyEncrypted],
    );
    return rows[0];
  }

  /**
   * Edita o corpo de uma mensagem. `client` de fora — mesma razão de `insertMessage`.
   *
   * `AND deleted_at IS NULL` (achado do gate revisao-pr, Bloco 1): sem esse filtro, editar uma
   * mensagem JÁ apagada re-populava `body_encrypted` — desfazendo o soft delete que
   * `softDeleteMessage` existe para garantir. A camada de cima (`EditMessageUseCase`) já recusa
   * ANTES de chegar aqui (`MessageAlreadyDeletedError`); este filtro é defesa em profundidade —
   * nunca o único gate.
   */
  async updateMessage(messageId: string, body: string, client: PoolClient): Promise<void> {
    const bodyEncrypted = await this.encryptionService.encrypt(body);
    await client.query(
      `UPDATE conversation_messages SET body_encrypted = $2, edited_at = now() WHERE id = $1 AND deleted_at IS NULL`,
      [messageId, bodyEncrypted],
    );
  }

  /**
   * Soft delete: `deleted_at = now()` E `body_encrypted = NULL` na MESMA instrução — nunca só o
   * carimbo, porque o corpo cifrado sobrevivendo ao "apagar" reabriria a mensagem por qualquer
   * leitura direta da coluna.
   */
  async softDeleteMessage(messageId: string, client: PoolClient): Promise<void> {
    await client.query(
      `UPDATE conversation_messages SET deleted_at = now(), body_encrypted = NULL WHERE id = $1`,
      [messageId],
    );
  }

  /**
   * `lastReadAt` do ator + `unreadCount` (D-11) — UMA query (CTE `mark` + duas subqueries
   * agregadas no SELECT), nunca uma query de contagem por mensagem. `unreadCount` conta
   * `conversation_messages` da conversa (topo E reply — sem filtro de `root_message_id`) com
   * `author_uid <> actorUid` e `created_at > COALESCE(lastReadAt, '-infinity')`: sem marca prévia,
   * "tudo que não é meu" conta como não lido — é o comportamento correto de primeira visita,
   * não um bug (o front decide se mostra o badge sem histórico).
   */
  async getReadState(
    conversationId: string,
    actorUid: string,
    executor: Pool | PoolClient = this.pool,
  ): Promise<ConversationReadState> {
    const { rows } = await executor.query<{ lastReadAt: Date | null; unreadCount: number }>(
      `WITH mark AS (
         SELECT last_read_at FROM conversation_read_marks
          WHERE conversation_id = $1 AND user_uid = $2
       )
       SELECT
         (SELECT last_read_at FROM mark) AS "lastReadAt",
         (
           SELECT COUNT(*)::int FROM conversation_messages m
            WHERE m.conversation_id = $1
              AND m.author_uid <> $2
              AND m.created_at > COALESCE((SELECT last_read_at FROM mark), '-infinity'::timestamptz)
         ) AS "unreadCount"`,
      [conversationId, actorUid],
    );
    const row = rows[0];
    return {
      lastReadAt: row?.lastReadAt ?? null,
      unreadCount: row?.unreadCount ?? 0,
    };
  }

  /**
   * `ON CONFLICT (conversation_id, user_uid) DO UPDATE` — nunca um INSERT que duplicaria a
   * marca de leitura (a PK composta é exatamente esse par).
   */
  async upsertReadMark(
    conversationId: string,
    userUid: string,
    lastReadAt: Date,
    client: PoolClient,
  ): Promise<void> {
    await client.query(
      `INSERT INTO conversation_read_marks (conversation_id, user_uid, last_read_at)
       VALUES ($1, $2, $3)
       ON CONFLICT (conversation_id, user_uid) DO UPDATE SET last_read_at = EXCLUDED.last_read_at`,
      [conversationId, userUid, lastReadAt],
    );
  }
}
