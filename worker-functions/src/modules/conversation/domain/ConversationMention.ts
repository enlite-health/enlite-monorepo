/**
 * Menção `<@uid>` no corpo de uma mensagem de conversa (spec 022, Bloco 1, T110).
 *
 * Sintaxe: `<@uid>` — `uid` é o `author_uid`/`firebase_uid` (varchar(128), sem `<`, `>` nem
 * espaço). Duplicatas no corpo colapsam numa única entrada, na ORDEM em que aparecem — a UI
 * lista "menciona X, Y" uma vez cada, não uma por ocorrência.
 */
/**
 * Exportado (D2, change 022-ux-mencao-e-notificacao): `NotificationRepository.findMessageExcerpts`
 * reusa o MESMO padrão para trocar `<@uid>` por `@Nome` no trecho da notificação — nunca uma 2ª
 * definição divergente da sintaxe de menção.
 */
export const MENTION_PATTERN = /<@([^<>\s]+)>/g;

/** Uids únicos mencionados no corpo, na ordem em que aparecem. */
export function extractMentionedUids(body: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const match of body.matchAll(MENTION_PATTERN)) {
    const uid = match[1];
    if (!seen.has(uid)) {
      seen.add(uid);
      out.push(uid);
    }
  }
  return out;
}

/** Menção a um uid que não existe em `users` — recusa (o controller converte em 400). */
export class MentionedUserNotFoundError extends Error {
  readonly code = 'MENTIONED_USER_NOT_FOUND';
  readonly status = 400;

  constructor(readonly uid: string) {
    super(`mentioned user ${uid} not found`);
    this.name = 'MentionedUserNotFoundError';
  }
}
