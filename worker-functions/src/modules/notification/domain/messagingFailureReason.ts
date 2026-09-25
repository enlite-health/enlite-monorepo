/**
 * Categoriza a mensagem de falha de `IMessagingService.sendWhatsApp` (Twilio/Periskope,
 * `Result<MessageSentResult>.error`) num CÓDIGO estável — nunca a string crua do provedor.
 *
 * Por quê (achado do gate 25/09): `TwilioMessagingService.sendWhatsApp` devolve
 * `Twilio error: ${error.message}` (o SDK da Twilio costuma ecoar o próprio número no
 * message, ex.: "The 'To' number +54911... is not a valid phone number"), e
 * `PeriskopeMessagingService.sendWhatsApp` devolve `Periskope error: ${error.message} —
 * ${JSON.stringify(error.response.data)}` (o body de erro da API pode ecoar o número
 * enviado). Os dois chamadores (`BulkDispatchIncompleteWorkersUseCase`,
 * `BulkDispatchTalentumIncompleteUseCase`) gravavam esse texto CRU em
 * `worker_message_audit.skip_reason` — a tabela tem garantia explícita de não ter PII
 * (`COMMENT ON TABLE`, migration 474: "Sem PII: só worker_id, ids, enums.") e requisito
 * duro do dono do produto ("só o ID do prestador é suficiente").
 *
 * Vocabulário no mesmo estilo já usado nos outros guards que escrevem em skip_reason
 * (migration 474, COMMENT ON COLUMN: "vocabulário aberto entre os vários guards") —
 * `VacancyInviteGuard.code` (OPTED_OUT, COOLDOWN, ALREADY_INVITED, ...) e
 * `StageMessageHandler.STAGE_SKIP_REASONS` (DISABLED, WORKER_DISABLED, ...): SCREAMING_SNAKE
 * curto, fechado, sem interpolar nenhum valor de runtime.
 *
 * Detecção por PREFIXO fixo das mensagens que os dois providers hoje emitem (nunca por
 * substring do meio da mensagem, que é onde o dado variável — e potencialmente o telefone —
 * aparece). Mensagem que não bate nenhum prefixo conhecido → UNKNOWN_ERROR: nunca vaza o
 * texto original, mesmo que a categoria fique menos específica.
 *
 * Se o detalhe cru for necessário pra depurar, ele vai pro LOG (política própria — ver
 * `safeErrorFields`/`maskPhoneForLog`), nunca para esta coluna.
 */
export type MessagingFailureReason =
  | 'PROVIDER_NOT_CONFIGURED'
  | 'INVALID_PHONE'
  | 'TEMPLATE_NOT_FOUND'
  | 'UNRESOLVED_TOKEN'
  | 'PROVIDER_ERROR'
  | 'UNKNOWN_ERROR';

const RULES: ReadonlyArray<{ pattern: RegExp; reason: MessagingFailureReason }> = [
  // PeriskopeMessagingService/TwilioMessagingService: "<provider> service not configured..."
  { pattern: /service not configured/i, reason: 'PROVIDER_NOT_CONFIGURED' },
  // PeriskopeMessagingService.ts / TwilioMessagingService.ts: `Invalid phone number: ${to}`
  { pattern: /^Invalid phone number:/i, reason: 'INVALID_PHONE' },
  // "Template '<slug>' não encontrado ou inativo" — <slug> é config nossa, não PII, mas o
  // código ainda assim não interpola: fica estável mesmo se a mensagem mudar de idioma/texto.
  { pattern: /não encontrado ou inativo/i, reason: 'TEMPLATE_NOT_FOUND' },
  // guardUnresolvedTokens: "Unresolved PII tokens in message variables (...)"
  { pattern: /^Unresolved PII tokens/i, reason: 'UNRESOLVED_TOKEN' },
  // TwilioMessagingService: `Twilio error: ${error.message}`
  // PeriskopeMessagingService: `Periskope error: ${error.message}${detail}`
  { pattern: /^(Twilio error|Periskope error):/i, reason: 'PROVIDER_ERROR' },
];

export function classifyMessagingFailureReason(rawError: string | null | undefined): MessagingFailureReason {
  if (!rawError) return 'UNKNOWN_ERROR';
  for (const rule of RULES) {
    if (rule.pattern.test(rawError)) return rule.reason;
  }
  return 'UNKNOWN_ERROR';
}
