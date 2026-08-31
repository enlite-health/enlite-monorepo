/**
 * twilioContentBody — a ÚNICA regra de "qual é o texto aprovado deste Content".
 *
 * Existiam duas: o sync (`scripts/sync-message-templates/twilio-client.ts`) e o
 * provider da tela. As duas escreviam a MESMA coluna (`message_templates.body_twilio`)
 * com semânticas diferentes — uma caía para `title` e devolvia um literal quando
 * não havia texto, a outra devolvia `null`. O resultado era o literal
 * `[Template não-textual — popular body manualmente]` sendo mostrado ao staff
 * como "assim a cuidadora recebe".
 *
 * REGRA DURA, e é ela que impede a classe inteira de voltar:
 *   `body_twilio` guarda TEXTO REAL ou NULL. Nunca um sentinela, nunca um
 *   ponteiro, nunca um título de card. Quem não tem texto é `null`, e a tela
 *   diz que não sabe — em vez de precisar reconhecer, por regex, cada literal
 *   que alguém invente no futuro.
 *
 * O sentinela sobrevive num lugar só: a coluna legada `body`, que é NOT NULL e é
 * contrato de ENVIO (a ordem dos placeholders nomeados). Para isso existe
 * `contentBodyOrSentinel`, e ela é a única porta por onde o literal passa.
 */

/** Ordem de preferência entre os tipos de Content — o texto que a pessoa lê primeiro. */
const TYPE_PREFERENCE = [
  'twilio/text',
  'twilio/quick-reply',
  'twilio/call-to-action',
  'twilio/list-picker',
  'twilio/card',
] as const;

/** Sentinela histórico. Vive SÓ na coluna `body`; nunca em `body_twilio`. */
export const NON_TEXTUAL_SENTINEL = '[Template não-textual — popular body manualmente]';

export type ContentTypes = Record<string, { body?: string; title?: string; subtitle?: string } | undefined>;

/**
 * O texto aprovado, ou `null` quando o Content não tem texto nenhum.
 * `title` NÃO conta: título de card não é a mensagem que a cuidadora recebe.
 */
export function extractContentBody(types: ContentTypes | null | undefined): string | null {
  if (!types) return null;
  for (const key of TYPE_PREFERENCE) {
    const body = types[key]?.body;
    if (typeof body === 'string' && body.trim()) return body;
  }
  // Tipo novo que a Twilio lance e que não esteja na preferência: ainda assim
  // vale o texto, se houver — a lista acima é ordem, não allowlist.
  for (const t of Object.values(types)) {
    if (typeof t?.body === 'string' && t.body.trim()) return t.body;
  }
  return null;
}

/**
 * Igual à de cima, mas nunca `null` — para a coluna legada `body`, que é NOT NULL.
 * Cai para `title` (melhor que nada quando é só um card) e, em último caso, para
 * o sentinela. USO EXCLUSIVO do sync ao INSERIR um template novo.
 */
export function contentBodyOrSentinel(types: ContentTypes | null | undefined): string {
  const body = extractContentBody(types);
  if (body) return body;
  for (const key of TYPE_PREFERENCE) {
    const title = types?.[key]?.title;
    if (typeof title === 'string' && title.trim()) return title;
  }
  return NON_TEXTUAL_SENTINEL;
}
