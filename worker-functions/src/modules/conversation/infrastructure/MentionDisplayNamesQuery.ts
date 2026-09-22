/**
 * MentionDisplayNamesQuery.ts — a query de "nome de cada uid mencionado" (G4, gate da change
 * 022-ux-mencao-e-notificacao).
 *
 * Extraída de `ConversationRepository.fetchMentionsByMessageIds` e
 * `NotificationRepository.findMentionDisplayNames` — as duas rodavam O MESMO SQL (JOIN em lote
 * `conversation_message_mentions` × `users`, `WHERE message_id = ANY($1)`, nunca uma query por
 * mensagem/menção), cada uma agregando o resultado no formato que o seu próprio caller precisa
 * (`ConversationRepository` monta `{ uids, displayNames }` por mensagem; `NotificationRepository`
 * monta `Record<uid, nome>` por mensagem). A duplicação era do SQL e do formato DE LINHA, não da
 * agregação — por isso só a query sai daqui; cada repositório continua dono da própria forma.
 */
import type { Pool, PoolClient } from 'pg';

export interface RawMentionDisplayNameRow {
  messageId: string;
  mentionedUid: string;
  mentionedDisplayName: string | null;
}

/**
 * Linha por (mensagem, uid mencionado), com o `display_name` resolvido por LEFT JOIN —
 * `mentionedDisplayName: null` quando o uid não tem `display_name` resolvível; o caller decide o
 * fallback (uid cru, `@usuario`), nunca esta função.
 */
export async function queryMentionDisplayNames(
  executor: Pool | PoolClient,
  messageIds: string[],
): Promise<RawMentionDisplayNameRow[]> {
  if (messageIds.length === 0) return [];

  const { rows } = await executor.query<RawMentionDisplayNameRow>(
    `SELECT message_id AS "messageId", mentioned_uid AS "mentionedUid", u.display_name AS "mentionedDisplayName"
       FROM conversation_message_mentions
       LEFT JOIN users u ON u.firebase_uid = conversation_message_mentions.mentioned_uid
      WHERE message_id = ANY($1::uuid[])
      ORDER BY message_id, mentioned_uid`,
    [messageIds],
  );
  return rows;
}
