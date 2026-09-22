/**
 * NotificationRepository — leitura/escrita de `notification_events`/`notifications`
 * (Spec 022, Bloco 4, T402/T406). Molde: `ConversationRepository.ts` (mesma disciplina: escrita
 * nunca abre transação própria — `client: PoolClient` vem de fora, de `withActorContext` no use
 * case chamador; leitura aceita `executor` opcional, `Pool` por padrão).
 *
 * `payload` (`notification_events.payload`) nunca recebe texto livre aqui — D-09/D-08 são
 * explícitos ("SÓ com ids — PROIBIDO texto"); os IDs relevantes já são colunas próprias
 * (`actor_uid`, `patient_id`, `conversation_id`, `message_id`), então `insertEvent` grava
 * `payload = '{}'::jsonb` (o `DEFAULT` da migration 461) e nunca escreve nele.
 */
import type { Pool, PoolClient } from 'pg';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import { KMSEncryptionService } from '@shared/security/KMSEncryptionService';
import { mapWithConcurrency } from '@shared/async/mapWithConcurrency';
import { reportError } from '@shared/logging';
import { MENTION_PATTERN } from '@modules/conversation/domain/ConversationMention';

/** Limite de decifra KMS em paralelo — mesmo valor de `ConversationRepository` (D-01). */
const DECRYPT_CONCURRENCY_LIMIT = 10;

/** Trecho da notificação (item 2, design.md §2) — mesmo teto citado no contrato/spec. */
const MESSAGE_EXCERPT_MAX_LENGTH = 140;

/**
 * D2 (achado da revisão visual da Fase 2, 22/09): rótulo usado quando o uid mencionado não tem
 * `display_name` resolvível (JOIN vazio) — nunca o uid cru no trecho. Sem i18n no backend (não há
 * infra de locale aqui, só no frontend); espanhol argentino por ser a língua primária do produto
 * (CLAUDE.md), mesma decisão de "sem tradução server-side" já em uso no restante deste arquivo.
 */
const MENTION_FALLBACK_LABEL = 'usuario';

interface MentionSpan {
  start: number;
  end: number;
}

export type NotificationTypeCode = 'CONVERSATION_MENTIONED' | 'CONVERSATION_REPLIED';

export interface InsertNotificationEventInput {
  typeCode: NotificationTypeCode;
  actorUid: string;
  patientId: string | null;
  conversationId: string | null;
  messageId: string | null;
}

export interface NotificationEventRow {
  id: string;
  typeCode: NotificationTypeCode;
  actorUid: string;
  actorDisplayName: string | null;
  patientId: string | null;
  conversationId: string | null;
  messageId: string | null;
  createdAt: Date;
  readAt: Date | null;
}

interface RawNotificationEventRow {
  id: string;
  typeCode: NotificationTypeCode;
  actorUid: string;
  actorDisplayName: string | null;
  patientId: string | null;
  conversationId: string | null;
  messageId: string | null;
  createdAt: Date;
  readAt: Date | null;
}

export interface ListNotificationsOptions {
  unreadOnly?: boolean;
  limit: number;
}

export class NotificationRepository {
  private pool: Pool;
  private encryptionService: KMSEncryptionService;

  constructor(pool?: Pool, encryptionService?: KMSEncryptionService) {
    this.pool = pool ?? DatabaseConnection.getInstance().getPool();
    this.encryptionService = encryptionService ?? new KMSEncryptionService();
  }

  /**
   * Grava 1 `notification_events` — SEMPRE dentro da transação do POST message (D-09), o
   * `client` vem de `FanOutNotificationUseCase`, nunca de uma conexão própria.
   */
  async insertEvent(input: InsertNotificationEventInput, client: PoolClient): Promise<string> {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO notification_events (type_code, actor_uid, patient_id, conversation_id, message_id)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [input.typeCode, input.actorUid, input.patientId, input.conversationId, input.messageId],
    );
    return rows[0].id;
  }

  /**
   * Uma linha por destinatário, MESMO insert em lote (nunca um INSERT por uid — mesma disciplina
   * anti-N+1 de `ConversationRepository.insertMentions`). `recipientUids` já vem deduplicado por
   * quem chama (`FanOutNotificationUseCase` monta um `Set` antes) — este método não deduplica.
   */
  async insertNotifications(eventId: string, recipientUids: string[], client: PoolClient): Promise<void> {
    if (recipientUids.length === 0) return;
    const values = recipientUids.map((_, i) => `($1, $${i + 2})`).join(', ');
    await client.query(
      `INSERT INTO notifications (event_id, recipient_uid) VALUES ${values}`,
      [eventId, ...recipientUids],
    );
  }

  /**
   * Notificações do `recipientUid`, mais recente primeiro (T405/T406). `actorDisplayName` vem de
   * `users.display_name` (mesmo JOIN de `AdminRepository.searchStaffDirectory`) — sempre exibido
   * (D-13, revisado no fecho B5, não condiciona o NOME de quem mencionou/respondeu à célula de
   * ninguém, só o nome do PACIENTE é que depende da célula do DESTINATÁRIO, resolvido à parte
   * pelo use case).
   */
  async listForRecipient(
    recipientUid: string,
    options: ListNotificationsOptions,
    executor: Pool | PoolClient = this.pool,
  ): Promise<NotificationEventRow[]> {
    const unreadClause = options.unreadOnly ? 'AND n.read_at IS NULL' : '';
    const { rows } = await executor.query<RawNotificationEventRow>(
      `SELECT
          n.id,
          e.type_code AS "typeCode",
          e.actor_uid AS "actorUid",
          u.display_name AS "actorDisplayName",
          e.patient_id AS "patientId",
          e.conversation_id AS "conversationId",
          e.message_id AS "messageId",
          n.created_at AS "createdAt",
          n.read_at AS "readAt"
       FROM notifications n
       JOIN notification_events e ON e.id = n.event_id
       LEFT JOIN users u ON u.firebase_uid = e.actor_uid
       WHERE n.recipient_uid = $1
       ${unreadClause}
       ORDER BY n.created_at DESC
       LIMIT $2`,
      [recipientUid, options.limit],
    );
    return rows;
  }

  async countUnread(recipientUid: string, executor: Pool | PoolClient = this.pool): Promise<number> {
    const { rows } = await executor.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM notifications WHERE recipient_uid = $1 AND read_at IS NULL`,
      [recipientUid],
    );
    return rows[0]?.count ?? 0;
  }

  /**
   * Dono de UMA notificação — `AdminNotificationController`/`MarkNotificationReadUseCase` cruzam
   * isto com `req.user.uid` ANTES de marcar como lida (D-24: isolamento entre destinatários; a
   * decisão do orquestrador é 404 para notificação alheia, nunca 403 — não confirma existência).
   */
  async findRecipientUid(notificationId: string, executor: Pool | PoolClient = this.pool): Promise<string | null> {
    const { rows } = await executor.query<{ recipientUid: string }>(
      `SELECT recipient_uid AS "recipientUid" FROM notifications WHERE id = $1`,
      [notificationId],
    );
    return rows[0]?.recipientUid ?? null;
  }

  /** `client` de fora — mesma razão de `ConversationRepository.updateMessage`. */
  async markRead(notificationId: string, client: PoolClient): Promise<void> {
    await client.query(
      `UPDATE notifications SET read_at = now() WHERE id = $1 AND read_at IS NULL`,
      [notificationId],
    );
  }

  /** `RETURNING id` só para contar quantas linhas mudaram (resposta do contrato: `{ updated }`). */
  async markAllRead(recipientUid: string, client: PoolClient): Promise<number> {
    const { rowCount } = await client.query(
      `UPDATE notifications SET read_at = now() WHERE recipient_uid = $1 AND read_at IS NULL`,
      [recipientUid],
    );
    return rowCount ?? 0;
  }

  /**
   * Nome de exibição do paciente (Bloco 4, D-13, revisado no fecho B5) — SÓ chamado pelo use case
   * DEPOIS de confirmar que o DESTINATÁRIO da requisição tem `patient_conversation:read`
   * (checagem de permissão vive no use case, nunca aqui — este repositório não decide ABAC, só lê
   * dado).
   */
  async findPatientDisplayName(patientId: string, executor: Pool | PoolClient = this.pool): Promise<string | null> {
    const { rows } = await executor.query<{ firstName: string | null; lastName: string | null }>(
      `SELECT first_name AS "firstName", last_name AS "lastName" FROM patients WHERE id = $1`,
      [patientId],
    );
    const row = rows[0];
    if (!row) return null;
    const full = [row.firstName, row.lastName].filter(Boolean).join(' ').trim();
    return full.length > 0 ? full : null;
  }

  /**
   * Item 3 (deep-link, F10/F11 de `fatos-medidos.md`): `root_message_id` de cada mensagem de
   * origem das notificações, EM LOTE (mesma disciplina anti-N+1 de
   * `ConversationRepository.fetchMentionsByMessageIds`). Ungated de propósito — igual ao
   * `messageId` que a notificação já carrega hoje (F10), o alvo do deep-link não depende da
   * célula de leitura do paciente (a UI decide "sem acesso" separadamente, F-scenario "clique em
   * notificação sem célula"). `null` no Map (via `rootMessageId: null` na linha) significa que a
   * própria mensagem É o root; messageId sem linha correspondente (mensagem removida?) não entra
   * no Map — o caller trata ausência como "sem dado", nunca lança.
   */
  async findRootMessageIds(
    messageIds: string[],
    executor: Pool | PoolClient = this.pool,
  ): Promise<Map<string, string | null>> {
    const rootByMessageId = new Map<string, string | null>();
    if (messageIds.length === 0) return rootByMessageId;

    const { rows } = await executor.query<{ id: string; rootMessageId: string | null }>(
      `SELECT id, root_message_id AS "rootMessageId" FROM conversation_messages WHERE id = ANY($1::uuid[])`,
      [messageIds],
    );
    for (const row of rows) rootByMessageId.set(row.id, row.rootMessageId);
    return rootByMessageId;
  }

  /**
   * Item 2 (card com trecho, F8/F9 de `fatos-medidos.md`): trecho decifrado (~140 chars) do corpo
   * de cada mensagem — SÓ chamado pelo use case para as linhas em que o DESTINATÁRIO já tem
   * `patient_conversation:read` (mesmo gate de `findPatientDisplayName`, F7 — reusado, nunca
   * duplicado aqui). Decifra em LOTE com `mapWithConcurrency`, mesmo limite (10) e mesmo padrão de
   * `ConversationRepository.listTopMessages` (D-01). Corta em `MESSAGE_EXCERPT_MAX_LENGTH` chars
   * DEPOIS de decifrar — nunca corta o ciphertext. Falha de decifra de UMA linha isola só aquela
   * (`null`, mesmo padrão de `patientDisplayName` ausente); `reportError` leva só `messageId`,
   * NUNCA o corpo/ciphertext (regra dura: texto clínico nunca em log).
   */
  async findMessageExcerpts(
    messageIds: string[],
    executor: Pool | PoolClient = this.pool,
  ): Promise<Map<string, string | null>> {
    const excerptByMessageId = new Map<string, string | null>();
    if (messageIds.length === 0) return excerptByMessageId;

    const { rows } = await executor.query<{ id: string; bodyEncrypted: string | null }>(
      `SELECT id, body_encrypted AS "bodyEncrypted" FROM conversation_messages WHERE id = ANY($1::uuid[])`,
      [messageIds],
    );

    const decryptedBodies = await mapWithConcurrency(rows, DECRYPT_CONCURRENCY_LIMIT, async (row) => {
      try {
        return await this.encryptionService.decrypt(row.bodyEncrypted);
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        reportError(err, { source: 'NotificationRepository:findMessageExcerpts', messageId: row.id });
        return null;
      }
    });

    // D2 (achado da revisão visual da Fase 2, 22/09): o trecho saía com `<@uid>` cru. Só busca
    // nomes de menção para as mensagens cujo corpo DECIFRADO realmente contém `<@` — custo evitado
    // na maioria das notificações, que não mencionam ninguém no corpo.
    const messageIdsWithMentions = rows
      .filter((row, i) => typeof decryptedBodies[i] === 'string' && (decryptedBodies[i] as string).includes('<@'))
      .map((row) => row.id);
    const mentionNamesByMessageId =
      messageIdsWithMentions.length > 0
        ? await this.findMentionDisplayNames(messageIdsWithMentions, executor)
        : new Map<string, Record<string, string | null>>();

    rows.forEach((row, i) => {
      const body = decryptedBodies[i];
      if (body === null) {
        excerptByMessageId.set(row.id, null);
        return;
      }
      const { text, spans } = substituteMentionTokens(body, mentionNamesByMessageId.get(row.id) ?? {});
      excerptByMessageId.set(row.id, truncateExcerpt(text, MESSAGE_EXCERPT_MAX_LENGTH, spans));
    });

    return excerptByMessageId;
  }

  /**
   * D2: nome de cada uid mencionado no corpo das mensagens dadas — MESMO padrão de
   * `ConversationRepository.fetchMentionsByMessageIds` (JOIN `users`, uma query em lote via `ANY`,
   * nunca uma por mensagem). Só chamada por `findMessageExcerpts` quando o corpo decifrado contém
   * `<@` — nunca para o conjunto inteiro de mensagens.
   */
  private async findMentionDisplayNames(
    messageIds: string[],
    executor: Pool | PoolClient,
  ): Promise<Map<string, Record<string, string | null>>> {
    const byMessageId = new Map<string, Record<string, string | null>>();
    const { rows } = await executor.query<{
      messageId: string;
      mentionedUid: string;
      mentionedDisplayName: string | null;
    }>(
      `SELECT message_id AS "messageId", mentioned_uid AS "mentionedUid", u.display_name AS "mentionedDisplayName"
         FROM conversation_message_mentions
         LEFT JOIN users u ON u.firebase_uid = conversation_message_mentions.mentioned_uid
        WHERE message_id = ANY($1::uuid[])`,
      [messageIds],
    );
    for (const row of rows) {
      const existing = byMessageId.get(row.messageId) ?? {};
      existing[row.mentionedUid] = row.mentionedDisplayName;
      byMessageId.set(row.messageId, existing);
    }
    return byMessageId;
  }
}

/**
 * Troca cada `<@uid>` do corpo por `@<Nome>` (ou `@${MENTION_FALLBACK_LABEL}` sem nome
 * resolvível) e devolve também os `spans` — posição de início/fim de cada substituição no texto
 * RESULTANTE — que `truncateExcerpt` usa para nunca cortar um token no meio.
 */
function substituteMentionTokens(
  body: string,
  displayNames: Record<string, string | null>,
): { text: string; spans: MentionSpan[] } {
  const spans: MentionSpan[] = [];
  let result = '';
  let lastIndex = 0;
  MENTION_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = MENTION_PATTERN.exec(body)) !== null) {
    result += body.slice(lastIndex, match.index);
    const uid = match[1];
    const token = `@${displayNames[uid] ?? MENTION_FALLBACK_LABEL}`;
    spans.push({ start: result.length, end: result.length + token.length });
    result += token;
    lastIndex = match.index + match[0].length;
  }
  result += body.slice(lastIndex);
  return { text: result, spans };
}

/**
 * Corta em `maxLength` chars (mesmo teto de sempre). Se o corte cair NO MEIO de um token `@Nome`
 * (um dos `spans`), recua para o INÍCIO daquele token em vez de partir o nome — nunca um
 * `@Ana S` pela metade.
 */
function truncateExcerpt(text: string, maxLength: number, spans: MentionSpan[]): string {
  if (text.length <= maxLength) return text;
  const breaking = spans.find((s) => maxLength > s.start && maxLength < s.end);
  return text.slice(0, breaking ? breaking.start : maxLength);
}
