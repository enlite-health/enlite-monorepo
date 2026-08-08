/**
 * PatientChatId — o `chat_id` do grupo de WhatsApp (Periskope) preso a um paciente.
 *
 * O Periskope distingue GRUPO (`@g.us`) de conversa 1-1 (`@c.us`). Aqui só
 * grupo entra: a auditoria de informes da Candela conta mensagens de grupo, e
 * um `@c.us` gravado neste campo é bug, não feature. Mesma trava que existe em
 * PeriskopeGroupNotifyService.sendToGroup.
 *
 * Formatos reais observados na API de produção (774 grupos, 08/08/2026):
 *   '<13 dígitos>-<10 dígitos>@g.us'  (legado, "criador-timestamp")
 *   '<18 dígitos>@g.us'               (formato novo)
 * O padrão aceita os dois e nada além disso. Espelhado no CHECK da migration 260.
 */
export const GROUP_CHAT_ID_PATTERN = /^[0-9]+(-[0-9]+)?@g\.us$/;

/** Comprimento da coluna `patients.family_chat_id` / `providers_chat_id`. */
export const CHAT_ID_MAX_LENGTH = 64;

/** True quando `value` é um chat_id de GRUPO do Periskope. */
export function isGroupChatId(value: string): boolean {
  return value.length <= CHAT_ID_MAX_LENGTH && GROUP_CHAT_ID_PATTERN.test(value);
}

/** Os dois chat IDs presos a um paciente. `null` = ainda não vinculado. */
export interface PatientChatIds {
  familyChatId: string | null;
  providersChatId: string | null;
}
