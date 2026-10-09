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
import { formatCaseNumber } from '@domain/value-objects/caseNumberFormat';

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
  /** Linha 1 do card (quem "fala"). Ausente = o ator (nome ou uid) — o padrão dos tipos de conversa. */
  actorLabel?: (notification: AdminNotification, t: Translate) => string;
  /** Linha 2 do card (sobre o quê). Ausente = "en <paciente>" — o padrão dos tipos de conversa. */
  contextLine?: (notification: AdminNotification, t: Translate) => string;
  /** Linha 3 do card quando NÃO há trecho de mensagem (aviso de sistema). */
  detailLine?: (notification: AdminNotification, t: Translate) => string | null;
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

const PT_FIELD_LABEL_KEY: Record<string, string> = {
  RESPONSIBLE: 'responsibles',
  EXTERNAL: 'externalContacts',
  COVERAGE: 'coverageContacts',
  CARE_TEAM: 'careTeam',
};

/** spec 048 (Gabriel, 08/10): o aviso do PT mostra SÓ o número do Caso — nunca o nome do paciente; sem número, "Caso sin número". */
function ptCaseLabel(n: AdminNotification, t: Translate): string {
  const formatted = formatCaseNumber(n.patientCaseNumber ?? null);
  return formatted ? t('admin.notifications.ptContactsPendingCase', { number: formatted }) : t('admin.notifications.ptContactsPendingNoCase');
}

/** Os rótulos dos campos são as MESMAS chaves do formulário do PT — sem duplicar i18n. */
function ptFieldsLabel(n: AdminNotification, t: Translate): string {
  return (n.payload?.fields ?? [])
    .map((f) => t(`admin.patients.detail.therapeuticProjectForm.${PT_FIELD_LABEL_KEY[f] ?? f}`))
    .join(', ');
}

/** Link para a ficha do paciente (a aba padrão mostra o card do PT); não abre drawer — a spec pede só o link. */
function patientFileDeepLink(n: AdminNotification): NotificationDeepLink | null {
  if (!n.patientId) return null;
  return { path: `/admin/patients/${n.patientId}`, focusRequest: { code: 'therapeuticProject', token: Date.now() } };
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
  THERAPEUTIC_PROJECT_CONTACTS_PENDING: {
    buildText: (n, t) => t('admin.notifications.ptContactsPendingText', { case: ptCaseLabel(n, t), fields: ptFieldsLabel(n, t) }),
    getDeepLink: patientFileDeepLink,
    actorLabel: (_n, t) => t('admin.notifications.ptContactsPendingActor'),
    contextLine: (n, t) => ptCaseLabel(n, t),
    detailLine: (n, t) => t('admin.notifications.ptContactsPendingFields', { fields: ptFieldsLabel(n, t) }),
  },
};

const FALLBACK_HANDLER: NotificationTypeHandler = {
  buildText: (n, t) => t('admin.notifications.generic', { actor: actorOrUid(n) }),
  getDeepLink: conversationDeepLink,
};

export function getNotificationTypeHandler(typeCode: string): NotificationTypeHandler {
  return REGISTRY[typeCode as NotificationTypeCode] ?? FALLBACK_HANDLER;
}
