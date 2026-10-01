/**
 * notificationTypeRegistry — `Record<typeCode, { buildText, getDeepLink }>` (spec 022, Rodada 2/
 * R2-F). Fonte ÚNICA de "o que cada TIPO de notificação faz": o texto (FR-015, montado no
 * CLIENTE — o servidor nunca monta a frase final) e o deep-link (pra onde navegar ao clicar).
 *
 * Antes, os dois `if (typeCode === 'CONVERSATION_MENTIONED')` viviam em lugares DIFERENTES —
 * `notificationText.ts` (texto) e `NotificationPanel.handleClick` (deep-link, inline) — e um tipo
 * novo exigiria lembrar de editar os dois. Centralizado aqui: adicionar um tipo é adicionar UMA
 * entrada no `REGISTRY`.
 *
 * Fallback GENÉRICO para um `typeCode` que o front ainda não conhece (regra dura: nunca crash em
 * enum novo, mesma classe de defesa de `buildNotificationText` para `actorDisplayName`/
 * `patientDisplayName` nulos) — texto neutro com o nome do ator, deep-link igual ao padrão
 * (navega se houver `patientId`, D-08).
 */
import type { AdminNotification, NotificationTypeCode } from '@infrastructure/http/AdminNotificationApiService';
import type { DrawerFocusRequest } from '@hooks/admin/useAutoOpenDrawer';

export type Translate = (key: string, opts?: Record<string, unknown>) => string;

export interface NotificationDeepLink {
  path: string;
  focusRequest: DrawerFocusRequest;
}

export interface NotificationTypeHandler {
  buildText: (notification: AdminNotification, t: Translate) => string;
  /** `null` quando não há `patientId` (D-08: notificação sem paciente associado, hoje raro mas
   * permitido pelo schema) — não há para onde navegar. */
  getDeepLink: (notification: AdminNotification) => NotificationDeepLink | null;
}

function actorOrUid(n: AdminNotification): string {
  return n.actorDisplayName ?? n.actorUid;
}

function patientOrFallback(n: AdminNotification, t: Translate): string {
  return n.patientDisplayName ?? t('admin.notifications.unknownPatient');
}

/** Os tipos de hoje (e o fallback) navegam pra MESMA forma de alvo — a conversa do paciente,
 * focando a mensagem de origem (root, quando é reply). Item 3, F10/F11/F12. */
function conversationDeepLink(n: AdminNotification): NotificationDeepLink | null {
  if (!n.patientId) return null;
  return {
    path: `/admin/patients/${n.patientId}`,
    focusRequest: {
      code: 'conversation',
      token: Date.now(),
      messageId: n.messageId ?? undefined,
      rootMessageId: n.rootMessageId,
    },
  };
}

const REGISTRY: Record<NotificationTypeCode, NotificationTypeHandler> = {
  CONVERSATION_MENTIONED: {
    buildText: (n, t) => t('admin.notifications.mentioned', { actor: actorOrUid(n), patient: patientOrFallback(n, t) }),
    getDeepLink: conversationDeepLink,
  },
  CONVERSATION_REPLIED: {
    buildText: (n, t) => t('admin.notifications.replied', { actor: actorOrUid(n), patient: patientOrFallback(n, t) }),
    getDeepLink: conversationDeepLink,
  },
};

const FALLBACK_HANDLER: NotificationTypeHandler = {
  buildText: (n, t) => t('admin.notifications.generic', { actor: actorOrUid(n) }),
  getDeepLink: conversationDeepLink,
};

export function getNotificationTypeHandler(typeCode: string): NotificationTypeHandler {
  return REGISTRY[typeCode as NotificationTypeCode] ?? FALLBACK_HANDLER;
}
