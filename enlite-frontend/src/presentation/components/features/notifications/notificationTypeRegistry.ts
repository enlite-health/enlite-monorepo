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
import type { AdminNotification, AdmissionTactiqExtensionState, AdmissionTactiqLinkPayload, AdmissionTactiqLinkReason, ImportBlockedPayload, ItineraryUncoveredShiftsItem, NotificationTypeCode, PedidoIaAplicarPayload, PresenceAlertPayload, TalentumWebhookAlarmPayload } from '@infrastructure/http/AdminNotificationApiService';
import type { DrawerFocusRequest } from '@hooks/admin/useAutoOpenDrawer';
import { formatCaseNumber } from '@domain/value-objects/caseNumberFormat';
import { formatMessageDateTime } from '@presentation/components/features/admin/PatientDetail/conversation/messageDateFormat';

export type Translate = (key: string, opts?: Record<string, unknown>) => string;

export interface NotificationDeepLink {
  path: string;
  /** Ausente quando o alvo não é a ficha de um paciente (ex.: a página Perfil, seção Tactiq). */
  focusRequest?: DrawerFocusRequest;
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
  const fields = n.payload && 'fields' in n.payload ? n.payload.fields : [];
  return fields
    .map((f) => t(`admin.patients.detail.therapeuticProjectForm.${PT_FIELD_LABEL_KEY[f] ?? f}`))
    .join(', ');
}

/** Link para a ficha do paciente (a aba padrão mostra o card do PT); não abre drawer — a spec pede só o link. */
function patientFileDeepLink(n: AdminNotification): NotificationDeepLink | null {
  if (!n.patientId) return null;
  return { path: `/admin/patients/${n.patientId}`, focusRequest: { code: 'therapeuticProject', token: Date.now() } };
}

/** spec 049 (§3.0.1): o motivo decide a frase; payload ausente/estranho cai na frase de "sem vínculo". */
function tactiqReason(n: AdminNotification): AdmissionTactiqLinkReason {
  const reason = n.payload && 'reason' in n.payload ? n.payload.reason : null;
  return reason === 'wrong_account' || reason === 'broken' || reason === 'seat_missing' || reason === 'seat_pending' || reason === 'seat_ready'
    ? reason
    : 'missing';
}

/**
 * F3 (D11/D14): o texto do aviso do vínculo. `seat_missing` e `broken` do Master escolhem a chave por `audience`/`adminNotified`/
 * `autoReactivates`; nenhum texto de assento manda revincular. Payload sem os campos novos = comportamento de antes.
 */
function tactiqText(n: AdminNotification, t: Translate): string {
  const base = 'admin.notifications.tactiq';
  const reason = tactiqReason(n);
  const p = n.payload && 'reason' in n.payload && !('stage' in n.payload) ? (n.payload as AdmissionTactiqLinkPayload) : null;
  const isMaster = p?.audience === 'master';
  const host = (): string => p?.hostName ?? t('admin.notifications.importBlocked.hostFallbackStart');
  if (reason === 'seat_missing') {
    if (isMaster) {
      return t(`${base}.masterSeat`, { host: host() }) + t(`${base}.${p?.autoReactivates === false ? 'masterSeatWait' : 'masterSeatAuto'}`, { host: host() });
    }
    if (p?.adminNotified !== true) return t(`${base}.seatAskAdmin`);
    return t(`${base}.${p.autoReactivates === false ? 'seatWait' : 'seatAuto'}`);
  }
  // F5 (D16): `seat_pending` só existe para o Master e `seat_ready` só para o host; combinação estranha cai em "missing", nunca em texto trocado.
  if (reason === 'seat_pending' && isMaster) return t(`${base}.masterSeatPending`, { host: host() });
  if (reason === 'seat_ready' && !isMaster) return t(`${base}.${p?.firstLink === false ? 'seatReadyAgain' : 'seatReadyFirst'}`);
  if (reason === 'seat_pending' || reason === 'seat_ready') return t(`${base}.missing`);
  if (reason === 'broken' && isMaster) return t(`${base}.masterBroken`, { host: host() });
  return t(`${base}.${reason}`);
}

/** spec 050 F15: o estado novo decide a frase; payload ausente/estranho cai no texto de "não está ativa" (nunca no de "instalada"). */
function tactiqExtensionState(n: AdminNotification): AdmissionTactiqExtensionState {
  const state = n.payload && 'state' in n.payload ? n.payload.state : null;
  return state === 'installed' || state === 'disabled' ? state : 'missing';
}

/** spec 069 (FR-35): os itens do aviso diário, do mais urgente (primeiro turno mais cedo) ao mais tardio; payload ausente/estranho = nenhum item. */
function itineraryItems(n: AdminNotification): ItineraryUncoveredShiftsItem[] {
  const items = n.payload && 'items' in n.payload ? n.payload.items : [];
  return [...items].sort((a, b) => a.firstDate.localeCompare(b.firstDate));
}

/**
 * O aviso diário "Sin cubrir" leva a UM item por serviço; o clique abre o MAIS URGENTE direto no serviço
 * (`?tab=itinerary&serviceId=`, o mesmo atalho do e-mail). Sem item (payload estranho) não há para onde ir.
 */
function itineraryDeepLink(n: AdminNotification): NotificationDeepLink | null {
  const first = itineraryItems(n)[0];
  return first ? { path: `/admin/patients/${first.patientId}?tab=itinerary&serviceId=${first.serviceId}` } : null;
}

/** A tela do próprio operador, não a ficha de um paciente: sem `focusRequest`. */
export const TACTIQ_LINK_PATH = '/admin/mi-cuenta';

/** spec 078 (M3b-2): o aviso do pedido do Sol não carrega assunto nem texto; leva à página de pedidos (sem paciente, sem `focusRequest`). */
const PEDIDOS_IA_PATH = '/admin/pedidos-ia';

const pedidoIaHandler = (key: 'pedidoIaNovo' | 'pedidoIaGrave'): NotificationTypeHandler => ({
  buildText: (_n, t) => t(`admin.notifications.${key}`),
  getDeepLink: () => ({ path: PEDIDOS_IA_PATH }),
  actorLabel: (_n, t) => t('admin.notifications.pedidoIaActor'),
  contextLine: (_n, t) => t('admin.notifications.pedidoIaContext'),
});

/** spec 078 M4.4 (gatilho (d)): pedido aceito em degrau 3/4. Payload estranho/ausente = texto sem degrau e prazo, nunca crash. */
function pedidoIaAplicarPayload(n: AdminNotification): PedidoIaAplicarPayload | null {
  const p = n.payload as Partial<PedidoIaAplicarPayload> | null | undefined;
  return p && (p.degrau === 3 || p.degrau === 4) && (p.prazo === 'hoje' || p.prazo === 'semana') ? (p as PedidoIaAplicarPayload) : null;
}

const pedidoIaAplicarHandler: NotificationTypeHandler = {
  buildText: (n, t) => {
    const p = pedidoIaAplicarPayload(n);
    return p
      ? t('admin.notifications.pedidoIaAplicar', { degrau: p.degrau, prazo: t(`admin.notifications.pedidoIaAplicarPrazo.${p.prazo}`) })
      : t('admin.notifications.pedidoIaAplicarSemDados');
  },
  getDeepLink: () => ({ path: PEDIDOS_IA_PATH }),
  actorLabel: (_n, t) => t('admin.notifications.pedidoIaActor'),
  contextLine: (_n, t) => t('admin.notifications.pedidoIaContext'),
};

const IMPORT_BLOCKED_STAGES = ['blocked', 'reminder', 'expired', 'will_be_lost'] as const;

/** spec 083: payload ausente/estranho cai no aviso mais neutro (host, "bloqueou", sem vínculo, admissão) — nunca crash, nunca vaza campo cru. */
function importBlockedPayload(n: AdminNotification): Pick<ImportBlockedPayload, 'stage' | 'kind' | 'reason' | 'audience' | 'hostName'> & { meetingAt: string; deadlineAt: string } {
  const p = (n.payload ?? {}) as Partial<ImportBlockedPayload>;
  const stage = IMPORT_BLOCKED_STAGES.find((x) => x === p.stage) ?? 'blocked';
  return {
    stage,
    kind: p.kind === 'enquadre' ? 'enquadre' : 'admission',
    reason: p.reason === 'wrong_account' || p.reason === 'not_recorded' ? p.reason : 'no_link',
    audience: stage === 'will_be_lost' || p.audience === 'supervisor' ? 'supervisor' : 'host',
    meetingAt: typeof p.meetingAt === 'string' ? p.meetingAt : '',
    deadlineAt: typeof p.deadlineAt === 'string' ? p.deadlineAt : '',
    hostName: typeof p.hostName === 'string' && p.hostName.trim() ? p.hostName.trim() : undefined,
  };
}

/** Data/hora da tela: o MESMO formato do cartão (`formatMessageDateTime`, fuso do operador via `getInstantParts`). Data ausente = vazio. */
function importBlockedMoment(iso: string, t: Translate): string {
  if (!iso) return '';
  const language = t('admin.notifications.importBlocked.dateLanguage');
  const connector = t('admin.patients.detail.conversation.thread.dateConnector');
  return formatMessageDateTime(iso, language, connector);
}

/** Corpo (ou título, `part: 'title'`) do aviso. O supervisor vê o nome de quem fez a reunião; sem nome, `hostFallback`. */
function importBlockedText(n: AdminNotification, t: Translate, part: 'title' | 'body'): string {
  const p = importBlockedPayload(n);
  const base = 'admin.notifications.importBlocked';
  const host = p.hostName ?? t(`${base}.hostFallback`);
  // `hostStart`: o mesmo nome, mas com maiúscula quando abre frase (sem nome: "A pessoa responsável").
  const hostStart = p.hostName ?? t(`${base}.hostFallbackStart`);
  // `not_recorded` (reunião sem gravação, host, `expired`) tem título e corpo PRÓPRIOS: não há "motivo" nem prazo a cumprir.
  const notRecorded = p.reason === 'not_recorded' && p.stage === 'expired' && p.audience === 'host';
  const motivo = notRecorded ? '' : t(`${base}.reason.${p.audience}.${p.reason}`, { host });
  const key = notRecorded ? 'notRecorded' : p.stage === 'will_be_lost' ? 'willBeLost' : p.stage;
  return t(`${base}.${key}.${part}`, {
    host,
    hostStart,
    motivo,
    reuniao: t(`${base}.meeting.${p.kind}`),
    data: importBlockedMoment(p.meetingAt, t),
    prazo: importBlockedMoment(p.deadlineAt, t),
  });
}

const TALENTUM_ALARMS = ['inbox_falha', 'inbox_pendente', 'veredito_ausente', 'silencio', 'CONFLITO_HUMANO'] as const;

/** spec 095 §3.5: alarme fora do conjunto, quantidade inválida ou payload ausente = rótulo genérico, nunca crash. */
function talentumWebhookParts(n: AdminNotification, t: Translate): { quantidade: number; alarme: string } {
  const p = (n.payload ?? {}) as Partial<TalentumWebhookAlarmPayload>;
  const known = TALENTUM_ALARMS.find((a) => a === p.alarme);
  return {
    quantidade: typeof p.quantidade === 'number' && Number.isInteger(p.quantidade) && p.quantidade >= 1 ? p.quantidade : 1,
    alarme: known ? t(`admin.notifications.talentumWebhookAlarm.${known}`) : t('admin.notifications.talentumWebhookAlarmUnknown'),
  };
}

/** `silencio` é ausência de evento: não tem quantidade, o texto não a mostra. */
function isTalentumSilencio(n: AdminNotification): boolean {
  return (n.payload as Partial<TalentumWebhookAlarmPayload> | null)?.alarme === 'silencio';
}

/** Emenda 077 §6: os 2 avisos de presença levam à fila "Revisión de presencia" (sem paciente, sem `focusRequest`). */
export const PRESENCE_REVIEW_PATH = '/admin/presencia/revision';

/** `YYYY-MM-DD` -> `DD/MM/YYYY`; payload ausente/estranho = null (o texto cai na variante sem data, nunca "undefined"). */
function presenceDate(n: AdminNotification): string | null {
  const d = (n.payload as Partial<PresenceAlertPayload> | null | undefined)?.on_date;
  return typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) ? d.split('-').reverse().join('/') : null;
}

/** Os 2 avisos de presença são da operação argentina (D664); a hora do turno sai no fuso do país, nunca no do navegador. */
const PRESENCE_TIME_ZONE = 'America/Argentina/Buenos_Aires';
const PRESENCE_TIME_FORMAT = new Intl.DateTimeFormat('es-AR', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: PRESENCE_TIME_ZONE });

/** Instante ISO -> `HH:MM` no fuso do país; ausente/inválido = null (o texto cai na variante sem hora). */
function presenceTime(n: AdminNotification, field: 'start_time' | 'end_time'): string | null {
  const v = (n.payload as Partial<PresenceAlertPayload> | null | undefined)?.[field];
  const ms = typeof v === 'string' ? Date.parse(v) : NaN;
  return Number.isNaN(ms) ? null : PRESENCE_TIME_FORMAT.format(new Date(ms));
}

/** `presenceOpen4h` cita a hora do FIM previsto; `checkInRefusedNoEntry`, a do INÍCIO (§5.5). */
const presenceHandler = (key: 'presenceOpen4h' | 'checkInRefusedNoEntry'): NotificationTypeHandler => ({
  buildText: (n, t) => {
    const fecha = presenceDate(n);
    if (!fecha) return t(`admin.notifications.${key}NoDate`);
    const hora = presenceTime(n, key === 'presenceOpen4h' ? 'end_time' : 'start_time');
    return hora ? t(`admin.notifications.${key}WithTime`, { fecha, hora }) : t(`admin.notifications.${key}`, { fecha });
  },
  getDeepLink: () => ({ path: PRESENCE_REVIEW_PATH }),
  actorLabel: (_n, t) => t('admin.notifications.presenceActor'),
  contextLine: (_n, t) => t('admin.notifications.presenceContext'),
});

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
  ADMISSION_TACTIQ_LINK_REQUIRED: {
    buildText: tactiqText,
    getDeepLink: () => ({ path: TACTIQ_LINK_PATH }),
    actorLabel: (_n, t) => t('admin.notifications.ptContactsPendingActor'),
    contextLine: (_n, t) => t('admin.notifications.tactiq.action'),
    detailLine: tactiqText,
  },
  ADMISSION_TACTIQ_EXTENSION_CHANGED: {
    buildText: (n, t) => t(`admin.notifications.tactiqExtension.${tactiqExtensionState(n)}`),
    getDeepLink: () => ({ path: TACTIQ_LINK_PATH }),
    actorLabel: (_n, t) => t('admin.notifications.ptContactsPendingActor'),
    contextLine: (_n, t) => t('admin.notifications.tactiq.action'),
    detailLine: (n, t) => t(`admin.notifications.tactiqExtension.${tactiqExtensionState(n)}`),
  },
  ADMISSION_IMPORT_BLOCKED: {
    // O cartão não tem linha de título: o leitor de tela ouve título + corpo (aria-label); a tela mostra o corpo na linha 3.
    buildText: (n, t) => `${importBlockedText(n, t, 'title')}. ${importBlockedText(n, t, 'body')}`,
    getDeepLink: () => ({ path: TACTIQ_LINK_PATH }),
    actorLabel: (_n, t) => t('admin.notifications.ptContactsPendingActor'),
    contextLine: (_n, t) => t('admin.notifications.tactiq.action'),
    detailLine: (n, t) => importBlockedText(n, t, 'body'),
  },
  ITINERARY_UNCOVERED_SHIFTS: {
    // Dois plurais independentes ("1 turno en 3 servicios"): cada contagem tem a SUA chave `_one/_other` (i18next só pluraliza por `count`),
    // e a frase só costura os dois pedaços já pluralizados.
    buildText: (n, t) =>
      t('admin.notifications.itineraryUncoveredText', {
        shifts: t('admin.notifications.itineraryUncoveredShifts', { count: itineraryItems(n).reduce((sum, i) => sum + i.shifts, 0) }),
        services: t('admin.notifications.itineraryUncoveredServices', { count: itineraryItems(n).length }),
      }),
    getDeepLink: itineraryDeepLink,
    actorLabel: (_n, t) => t('admin.notifications.ptContactsPendingActor'),
    contextLine: (_n, t) => t('admin.notifications.itineraryUncoveredContext'),
    detailLine: (n, t) => {
      const first = itineraryItems(n)[0];
      return first ? t('admin.notifications.itineraryUncoveredDetail', { date: first.firstDate.split('-').reverse().slice(0, 2).join('/') }) : null;
    },
  },
  PEDIDO_IA_NOVO: pedidoIaHandler('pedidoIaNovo'),
  PEDIDO_IA_GRAVE: pedidoIaHandler('pedidoIaGrave'),
  PEDIDO_IA_APLICAR: pedidoIaAplicarHandler,
  TALENTUM_WEBHOOK_ALARM: {
    buildText: (n, t) => (isTalentumSilencio(n) ? t('admin.notifications.talentumWebhookTextSilencio') : t('admin.notifications.talentumWebhookText', talentumWebhookParts(n, t))),
    getDeepLink: () => null, // sem paciente e sem tela própria do alarme
    actorLabel: (_n, t) => t('admin.notifications.talentumWebhookActor'),
    contextLine: (_n, t) => t('admin.notifications.talentumWebhookContext'),
    detailLine: (n, t) => talentumWebhookParts(n, t).alarme,
  },
  PRESENCE_OPEN_4H: presenceHandler('presenceOpen4h'),
  CHECK_IN_REFUSED_NO_ENTRY: presenceHandler('checkInRefusedNoEntry'),
};

const FALLBACK_HANDLER: NotificationTypeHandler = {
  buildText: (n, t) => t('admin.notifications.generic', { actor: actorOrUid(n) }),
  getDeepLink: conversationDeepLink,
};

export function getNotificationTypeHandler(typeCode: string): NotificationTypeHandler {
  return REGISTRY[typeCode as NotificationTypeCode] ?? FALLBACK_HANDLER;
}
