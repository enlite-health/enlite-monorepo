/**
 * notificationText — monta a frase da notificação NO CLIENTE (Spec 022, Bloco 4, FR-015).
 *
 * O servidor NUNCA monta o texto final nem devolve corpo de mensagem (regra dura,
 * `contracts/openapi-notifications.md` §Texto da notificação) — só ids/nomes resolvidos. Esta
 * função pura faz a montagem, separada do componente visual para ser testável sem DOM.
 */
import type { AdminNotification } from '@infrastructure/http/AdminNotificationApiService';

type Translate = (key: string, opts?: Record<string, unknown>) => string;

/**
 * `patientDisplayName: null` (D-13 — ator perdeu a célula do paciente, ou notificação sem
 * paciente associado) cai no fallback `admin.notifications.unknownPatient` ("un paciente"/
 * "um paciente"). `actorDisplayName: null` (ator sem `users.display_name`, caso raro) cai no
 * `actorUid` cru — nunca quebra a frase, mas não inventa nome.
 */
export function buildNotificationText(notification: AdminNotification, t: Translate): string {
  const actor = notification.actorDisplayName ?? notification.actorUid;
  const patient = notification.patientDisplayName ?? t('admin.notifications.unknownPatient');

  const key =
    notification.typeCode === 'CONVERSATION_MENTIONED' ? 'admin.notifications.mentioned' : 'admin.notifications.replied';

  return t(key, { actor, patient });
}
