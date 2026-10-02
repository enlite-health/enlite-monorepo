/**
 * notificationText — monta a frase da notificação NO CLIENTE (Spec 022, Bloco 4, FR-015).
 *
 * O servidor NUNCA monta o texto final nem devolve corpo de mensagem (regra dura,
 * `contracts/openapi-notifications.md` §Texto da notificação) — só ids/nomes resolvidos.
 *
 * 🔒 Rodada 2/R2-F: delega pro `notificationTypeRegistry` — este arquivo continua existindo
 * (e exportado com a mesma assinatura) porque `NotificationCard.tsx` já o importa; o `if/else`
 * por `typeCode` que vivia aqui morou para o registry (fonte ÚNICA, junto com o deep-link).
 */
import type { AdminNotification } from '@infrastructure/http/AdminNotificationApiService';
import { getNotificationTypeHandler, type Translate } from './notificationTypeRegistry';

export function buildNotificationText(notification: AdminNotification, t: Translate): string {
  return getNotificationTypeHandler(notification.typeCode).buildText(notification, t);
}
