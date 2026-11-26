/**
 * SystemNotificationPublisher — grava um aviso AUTOMÁTICO no sino (spec 048): sem conversa, sem mensagem, sem autor humano.
 *
 * Mesma disciplina de `FanOutNotificationUseCase`: o `client` vem de fora (a transação do chamador — a varredura
 * carimba `sent_at` na MESMA transação, é isso que torna o envio idempotente) e NUNCA se cria evento sem destinatário.
 *
 * `actor_uid` é a sentinela fixa de sistema (coluna `varchar(128) NOT NULL` sem FK, 461): o aviso não tem autor humano,
 * e a tela não mostra o uid (o registry do front pede o rótulo "Enlite").
 */
import type { PoolClient } from 'pg';
import {
  NotificationRepository,
  type AdmissionTactiqLinkPayload,
  type AdmissionTactiqLinkReason,
  type AdmissionTactiqLinkAudience,
  type AdmissionTactiqExtensionPayload,
  type AdmissionTactiqExtensionState,
  type PtContactsPendingPayload,
  type ItineraryUncoveredShiftsPayload,
  type PedidoIaAplicarPayload,
  type AdmissionImportBlockedPayload,
  type TalentumWebhookAlarmPayload,
  TALENTUM_WEBHOOK_ALARMS,
  IMPORT_STAGES,
  IMPORT_KINDS,
  IMPORT_REASONS,
  IMPORT_AUDIENCES,
} from '../infrastructure/NotificationRepository';

export const SYSTEM_NOTIFICATION_ACTOR_UID = 'system:pt-contact-reminders';
/** Sentinela do aviso automático da admissão (spec 049 T9): sem autor humano, sem FK (461). */
export const SYSTEM_ADMISSION_ACTOR_UID = 'system:admission';

/** Sentinela do aviso diário do itinerário (spec 069 F4): sem autor humano, sem FK (461). */
export const SYSTEM_ITINERARY_ACTOR_UID = 'system:itinerary-daily';

/** Sentinela do aviso da fila de pedidos do Sol (spec 078 M3b-2): sem autor humano, sem FK (461). */
export const SYSTEM_SOL_FILA_ACTOR_UID = 'system:sol-fila';

/** Sentinela do aviso do webhook do Talentum (spec 095 §3.5): sem autor humano, sem FK (461). A tela mostra "Enlite", nunca o uid. */
export const SYSTEM_TALENTUM_WEBHOOK_ACTOR_UID = 'system:talentum-webhook';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Payload fechado do aviso "aplicar" (spec 078 M4.4, gatilho (d)): id do pedido + degrau (3|4) + grave + prazo. `hoje` se grave, `semana`
 * se não — o prazo é DERIVADO do `grave`, nunca passado de fora. Valor fora do contrato é erro de programação (lança).
 */
export function buildPedidoIaAplicarPayload(input: { pedidoId: string; degrau: number; grave: boolean }): PedidoIaAplicarPayload {
  if (!UUID_RE.test(input.pedidoId)) throw new Error('PedidoIaAplicarPayload: pedidoId inválido');
  if (input.degrau !== 3 && input.degrau !== 4) throw new Error('PedidoIaAplicarPayload: degrau fora de {3,4}');
  return { pedido_id: input.pedidoId, degrau: input.degrau, grave: input.grave, prazo: input.grave ? 'hoje' : 'semana' };
}

/**
 * Payload fechado do aviso do webhook do Talentum: `{ alarme, quantidade, desde }`. Reconstrói chave a chave: QUALQUER chave extra (nome,
 * e-mail, id) faz LANÇAR, não ser ignorada — um chamador que tente passar dado a mais é erro de programação, não dado que some em silêncio.
 * `alarme` fora do conjunto fechado, `quantidade` não inteira ou < 1 e `desde` que não é data também lançam.
 */
export function buildTalentumWebhookAlarmPayload(input: { alarme: string; quantidade: number; desde: string }): TalentumWebhookAlarmPayload {
  const extra = Object.keys(input).filter((k) => k !== 'alarme' && k !== 'quantidade' && k !== 'desde');
  if (extra.length > 0) throw new Error('talentum_webhook_alarm_payload: chave fora do contrato');
  if (!inSet(TALENTUM_WEBHOOK_ALARMS, input.alarme) || !Number.isInteger(input.quantidade) || input.quantidade < 1 || !isIso(input.desde)) {
    throw new Error('talentum_webhook_alarm_payload: valor fora do contrato');
  }
  return { alarme: input.alarme as TalentumWebhookAlarmPayload['alarme'], quantidade: input.quantidade, desde: input.desde };
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Payload fechado do aviso diário de turnos sin cubrir: `operationDate` + itens de 4 chaves (ids e números). Reconstrói cada item
 * chave a chave — qualquer campo extra (nome, texto) que alguém passe NÃO entra. Valor fora do formato é erro de programação (lança).
 */
export function buildItineraryUncoveredShiftsPayload(input: {
  operationDate: string;
  items: ReadonlyArray<{ patientId: string; serviceId: string; shifts: number; firstDate: string }>;
}): ItineraryUncoveredShiftsPayload {
  const badItem = input.items.some((i) => !Number.isInteger(i.shifts) || i.shifts < 1 || !ISO_DATE.test(i.firstDate));
  if (!ISO_DATE.test(input.operationDate) || input.items.length === 0 || badItem) {
    throw new Error('itinerary_uncovered_shifts_payload: valor fora do contrato');
  }
  return {
    operationDate: input.operationDate,
    items: input.items.map((i) => ({ patientId: i.patientId, serviceId: i.serviceId, shifts: i.shifts, firstDate: i.firstDate })),
  };
}

const ADMISSION_TACTIQ_REASONS: readonly AdmissionTactiqLinkReason[] = ['missing', 'broken', 'wrong_account', 'seat_missing', 'seat_pending', 'seat_ready'];
const ADMISSION_TACTIQ_AUDIENCES: readonly AdmissionTactiqLinkAudience[] = ['host', 'master'];
/** Motivos que a cópia ao Acesso Master pode carregar (D11): o resto só existe para o próprio responsável. */
const MASTER_REASONS: readonly AdmissionTactiqLinkReason[] = ['seat_missing', 'broken', 'seat_pending'];

export interface AdmissionTactiqLinkExtras {
  audience?: string;
  hostName?: string | null;
  adminNotified?: boolean;
  autoReactivates?: boolean;
  firstLink?: boolean;
}

/**
 * Payload fechado do aviso do vínculo (D11). Motivo fora do conjunto é erro de programação (lança); sem `extras` o payload é só
 * `{ reason }` (o contrato antigo). Combinações proibidas lançam: `master` só com `seat_missing`/`broken`; `hostName` só em `master`;
 * `adminNotified` só em `seat_missing` ao `host`; `autoReactivates` só em `seat_missing`; `seat_missing` exige `audience` e os booleanos.
 * F5: `seat_pending` só `master`; `seat_ready` só `host` e exige `firstLink` boolean (que só existe em `seat_ready`).
 */
export function buildAdmissionTactiqLinkPayload(reason: string, extras: AdmissionTactiqLinkExtras = {}): AdmissionTactiqLinkPayload {
  if (!(ADMISSION_TACTIQ_REASONS as readonly string[]).includes(reason)) {
    throw new Error('admission_tactiq_link_payload: motivo fora do conjunto fechado');
  }
  const r = reason as AdmissionTactiqLinkReason;
  const { audience, hostName, adminNotified, autoReactivates, firstLink } = extras;
  const fail = (why: string): never => {
    throw new Error(`admission_tactiq_link_payload: ${why}`);
  };
  if (audience !== undefined && !(ADMISSION_TACTIQ_AUDIENCES as readonly string[]).includes(audience)) fail('audience fora do conjunto fechado');
  if (audience === 'master' && !MASTER_REASONS.includes(r)) fail('cópia do Acesso Master só com seat_missing, broken ou seat_pending');
  if (r === 'seat_pending' && audience !== 'master') fail('seat_pending só vai ao Acesso Master');
  if (r === 'seat_ready' && audience !== 'host') fail('seat_ready só vai ao host');
  if (firstLink !== undefined && (r !== 'seat_ready' || typeof firstLink !== 'boolean')) fail('firstLink só em seat_ready');
  if (r === 'seat_ready' && typeof firstLink !== 'boolean') fail('seat_ready exige firstLink');
  const hasName = hostName !== undefined && hostName !== null && hostName !== '';
  if (hasName && audience !== 'master') fail('hostName só na cópia do Acesso Master');
  if (adminNotified !== undefined && (r !== 'seat_missing' || audience !== 'host' || typeof adminNotified !== 'boolean')) {
    fail('adminNotified só em seat_missing ao host');
  }
  if (autoReactivates !== undefined && (r !== 'seat_missing' || typeof autoReactivates !== 'boolean')) fail('autoReactivates só em seat_missing');
  if (r === 'seat_missing') {
    if (audience === undefined) fail('seat_missing exige audience');
    if (typeof autoReactivates !== 'boolean') fail('seat_missing exige autoReactivates');
    if (audience === 'host' && typeof adminNotified !== 'boolean') fail('seat_missing ao host exige adminNotified');
  }
  const out: AdmissionTactiqLinkPayload = { reason: r };
  if (audience !== undefined) out.audience = audience as AdmissionTactiqLinkAudience;
  if (hasName) out.hostName = String(hostName);
  if (adminNotified !== undefined) out.adminNotified = adminNotified;
  if (autoReactivates !== undefined) out.autoReactivates = autoReactivates;
  if (firstLink !== undefined) out.firstLink = firstLink;
  return out;
}

const ADMISSION_EXTENSION_STATES: readonly AdmissionTactiqExtensionState[] = ['installed', 'missing', 'disabled'];

/** Payload fechado de 1 chave (spec 050 F15). Estado fora do conjunto é erro de programação (lança). */
export function buildAdmissionTactiqExtensionPayload(state: string): AdmissionTactiqExtensionPayload {
  if (!(ADMISSION_EXTENSION_STATES as readonly string[]).includes(state)) {
    throw new Error('admission_tactiq_extension_payload: estado fora do conjunto fechado');
  }
  return { state: state as AdmissionTactiqExtensionState };
}

const inSet = (set: readonly string[], v: unknown): boolean => typeof v === 'string' && set.includes(v);
const isIso = (v: unknown): v is string => typeof v === 'string' && !Number.isNaN(Date.parse(v));

/**
 * Payload fechado do aviso de importação bloqueada (spec 083, D-7). Reconstrói chave a chave: qualquer chave extra (nome de paciente,
 * código, id) NÃO entra. Lança em valor fora do contrato e em combinação inválida (`will_be_lost` só com `supervisor`; os outros só
 * com `host`; `hostName` só na cópia do supervisor).
 */
export function buildAdmissionImportBlockedPayload(input: {
  stage: string; kind: string; reason: string; audience: string; meetingAt: string; deadlineAt: string; hostName?: string | null;
}): AdmissionImportBlockedPayload {
  if (!inSet(IMPORT_STAGES, input.stage) || !inSet(IMPORT_KINDS, input.kind) || !inSet(IMPORT_REASONS, input.reason)
    || !inSet(IMPORT_AUDIENCES, input.audience) || !isIso(input.meetingAt) || !isIso(input.deadlineAt)) {
    throw new Error('admission_import_blocked_payload: valor fora do contrato');
  }
  if ((input.stage === 'will_be_lost') !== (input.audience === 'supervisor')) {
    throw new Error('admission_import_blocked_payload: combinação stage/audience inválida');
  }
  if (input.reason === 'not_recorded' && (input.stage !== 'expired' || input.audience !== 'host')) {
    throw new Error('admission_import_blocked_payload: combinação stage/audience inválida (not_recorded só expired ao host)');
  }
  const base = {
    stage: input.stage, kind: input.kind, reason: input.reason, audience: input.audience, meetingAt: input.meetingAt, deadlineAt: input.deadlineAt,
  } as AdmissionImportBlockedPayload;
  if (input.hostName === undefined || input.hostName === null || input.hostName === '') return base;
  if (input.audience !== 'supervisor') throw new Error('admission_import_blocked_payload: hostName só na cópia do supervisor');
  return { ...base, hostName: String(input.hostName) };
}

/** Os campos de contato que o aviso pode listar — espelha `ContactStatusKind` sem importar do módulo `case`. */
const PT_CONTACT_FIELDS = ['RESPONSIBLE', 'EXTERNAL', 'COVERAGE', 'CARE_TEAM'] as const;

/**
 * Payload tipado e fechado: 4 chaves, ids + nome de campo. Qualquer outra coisa (nome, caso, data) não tem como
 * entrar por aqui — a assinatura não aceita. `fields` fora do conjunto fechado é erro de programação (lança).
 */
export function buildPtContactsPendingPayload(input: {
  cycleId: string;
  versionId: string;
  dayOffset: number;
  fields: readonly string[];
}): PtContactsPendingPayload {
  const invalid = input.fields.filter((f) => !(PT_CONTACT_FIELDS as readonly string[]).includes(f));
  if (invalid.length > 0) throw new Error('pt_contacts_pending_payload: campo fora do conjunto fechado');
  return { cycleId: input.cycleId, versionId: input.versionId, dayOffset: input.dayOffset, fields: [...input.fields] };
}

export interface PtContactsPendingRecipient {
  uid: string;
  /** Os campos que ESTE destinatário vê no aviso (cada operador, os que ele marcou; o Master, todos os pendentes). */
  fields: readonly string[];
}

export interface PublishPtContactsPendingInput {
  patientId: string;
  cycleId: string;
  versionId: string;
  dayOffset: number;
  recipients: readonly PtContactsPendingRecipient[];
}

export class SystemNotificationPublisher {
  constructor(private readonly repository: NotificationRepository = new NotificationRepository()) {}

  /**
   * Spec 049 F4: UM aviso (evento + 1 notificação) para o responsável de admissão sem vínculo vivo com o Tactiq.
   * Quem decide SE avisa (por transição de estado) é o `TactiqLinkService`; aqui só se grava. Sem destinatário não
   * grava nada e devolve `null`. O `client` é a transação do chamador (o carimbo de "já avisei" vai na MESMA transação).
   */
  async publishAdmissionTactiqLinkRequired(
    client: PoolClient,
    input: { recipientUid: string | null; reason: string } & AdmissionTactiqLinkExtras,
  ): Promise<string | null> {
    const { recipientUid: _recipient, reason, ...extras } = input;
    const payload = buildAdmissionTactiqLinkPayload(reason, extras);
    if (!input.recipientUid) return null;
    const eventId = await this.repository.insertEvent(
      {
        typeCode: 'ADMISSION_TACTIQ_LINK_REQUIRED',
        actorUid: SYSTEM_ADMISSION_ACTOR_UID,
        patientId: null,
        conversationId: null,
        messageId: null,
        payload,
      },
      client,
    );
    await this.repository.insertNotifications(eventId, [input.recipientUid], client);
    return eventId;
  }

  /**
   * Spec 083: UM aviso (evento + 1 notificação) da importação bloqueada, na transação do chamador (o estado e o sino andam juntos: se
   * o INSERT falha, a transação inteira desfaz). `patientId` sempre `null`. Sem destinatário não grava e devolve `null`.
   */
  async publishAdmissionImportBlocked(
    client: PoolClient,
    input: { recipientUid: string | null; payload: Parameters<typeof buildAdmissionImportBlockedPayload>[0] },
  ): Promise<string | null> {
    const payload = buildAdmissionImportBlockedPayload(input.payload);
    if (!input.recipientUid) return null;
    const eventId = await this.repository.insertEvent(
      { typeCode: 'ADMISSION_IMPORT_BLOCKED', actorUid: SYSTEM_ADMISSION_ACTOR_UID, patientId: null, conversationId: null, messageId: null, payload },
      client,
    );
    await this.repository.insertNotifications(eventId, [input.recipientUid], client);
    return eventId;
  }

  /**
   * Spec 095 §3.5: UM evento + uma notificação por destinatário (coordenação de Recrutamento + Master), na transação do chamador (o estado
   * de dedup do alarme vai na MESMA transação). Sem destinatário não grava e devolve `null`. `patientId` sempre `null`.
   */
  async publishTalentumWebhookAlarm(
    client: PoolClient,
    input: { recipientUids: readonly string[]; payload: { alarme: string; quantidade: number; desde: string } },
  ): Promise<string | null> {
    const payload = buildTalentumWebhookAlarmPayload(input.payload);
    const uids = [...new Set(input.recipientUids)];
    if (uids.length === 0) return null;
    const eventId = await this.repository.insertEvent(
      { typeCode: 'TALENTUM_WEBHOOK_ALARM', actorUid: SYSTEM_TALENTUM_WEBHOOK_ACTOR_UID, patientId: null, conversationId: null, messageId: null, payload },
      client,
    );
    await this.repository.insertNotifications(eventId, uids, client);
    return eventId;
  }

  /**
   * Aviso da transição do relatório do Chrome (spec 050 F15, R-3): UM evento + UMA notificação para a operadora. Quem decide SE avisa
   * (1 por transição) é o `ChromeReportJob`; aqui só se grava, na transação do chamador. Sem destinatário não grava e devolve `null`.
   */
  async publishAdmissionTactiqExtensionChanged(
    client: PoolClient,
    input: { recipientUid: string | null; state: string },
  ): Promise<string | null> {
    const payload = buildAdmissionTactiqExtensionPayload(input.state);
    if (!input.recipientUid) return null;
    const eventId = await this.repository.insertEvent(
      {
        typeCode: 'ADMISSION_TACTIQ_EXTENSION_CHANGED',
        actorUid: SYSTEM_ADMISSION_ACTOR_UID,
        patientId: null,
        conversationId: null,
        messageId: null,
        payload,
      },
      client,
    );
    await this.repository.insertNotifications(eventId, [input.recipientUid], client);
    return eventId;
  }

  /**
   * Spec 069 F4: UM aviso agregado (evento + 1 notificação) por destinatário e dia, com os turnos sin cubrir dos próximos 7 dias
   * (payload só-ids, resolvido na tela). O `client` é a transação do chamador — o despacho (PK dia × destinatário) vai na MESMA
   * transação, é isso que dá a idempotência. Devolve o id do evento.
   */
  async publishItineraryUncoveredShifts(
    client: PoolClient,
    input: { recipientUid: string; operationDate: string; items: ReadonlyArray<{ patientId: string; serviceId: string; shifts: number; firstDate: string }> },
  ): Promise<string> {
    const eventId = await this.repository.insertEvent(
      {
        typeCode: 'ITINERARY_UNCOVERED_SHIFTS',
        actorUid: SYSTEM_ITINERARY_ACTOR_UID,
        patientId: null,
        conversationId: null,
        messageId: null,
        payload: buildItineraryUncoveredShiftsPayload({ operationDate: input.operationDate, items: input.items }),
      },
      client,
    );
    await this.repository.insertNotifications(eventId, [input.recipientUid], client);
    return eventId;
  }

  /**
   * Spec 078 M3b-2: UM evento + uma notificação por decisor, SEM payload (nem assunto, nem texto, nem id: o aviso só diz que há
   * pedido; a página é que mostra). Sem destinatário não grava e devolve `null`. O `client` é a transação de quem deposita o pedido.
   */
  async publishPedidoIa(
    client: PoolClient,
    input: { typeCode: 'PEDIDO_IA_NOVO' | 'PEDIDO_IA_GRAVE'; recipientUids: readonly string[] },
  ): Promise<string | null> {
    const uids = [...new Set(input.recipientUids)];
    if (uids.length === 0) return null;
    const eventId = await this.repository.insertEvent(
      { typeCode: input.typeCode, actorUid: SYSTEM_SOL_FILA_ACTOR_UID, patientId: null, conversationId: null, messageId: null },
      client,
    );
    await this.repository.insertNotifications(eventId, uids, client);
    return eventId;
  }

  /**
   * Spec 078 M4.4 (gatilho (d)): pedido ACEITO em degrau 3/4 — UM evento com payload só-ids + uma notificação por decisor. Sem destinatário
   * não grava e devolve `null`. O `client` é a transação de quem notifica.
   */
  async publishPedidoIaAplicar(
    client: PoolClient,
    input: { pedidoId: string; degrau: number; grave: boolean; recipientUids: readonly string[] },
  ): Promise<string | null> {
    const uids = [...new Set(input.recipientUids)];
    if (uids.length === 0) return null;
    const eventId = await this.repository.insertEvent(
      {
        typeCode: 'PEDIDO_IA_APLICAR',
        actorUid: SYSTEM_SOL_FILA_ACTOR_UID,
        patientId: null,
        conversationId: null,
        messageId: null,
        payload: buildPedidoIaAplicarPayload({ pedidoId: input.pedidoId, degrau: input.degrau, grave: input.grave }),
      },
      client,
    );
    await this.repository.insertNotifications(eventId, uids, client);
    return eventId;
  }

  /**
   * Um evento por conjunto DISTINTO de campos; cada destinatário (deduplicado por uid) recebe UMA notificação por
   * disparo. Devolve os ids dos eventos criados (vazio = sem destinatário, nenhuma linha gravada).
   */
  async publishPtContactsPending(client: PoolClient, input: PublishPtContactsPendingInput): Promise<string[]> {
    const byFields = new Map<string, { fields: string[]; uids: Set<string> }>();
    const seen = new Set<string>();
    for (const r of input.recipients) {
      if (seen.has(r.uid) || r.fields.length === 0) continue;
      seen.add(r.uid);
      const fields = [...r.fields];
      const key = fields.join(',');
      const group = byFields.get(key) ?? { fields, uids: new Set<string>() };
      group.uids.add(r.uid);
      byFields.set(key, group);
    }
    const eventIds: string[] = [];
    for (const group of byFields.values()) {
      const eventId = await this.repository.insertEvent(
        {
          typeCode: 'THERAPEUTIC_PROJECT_CONTACTS_PENDING',
          actorUid: SYSTEM_NOTIFICATION_ACTOR_UID,
          patientId: input.patientId,
          conversationId: null,
          messageId: null,
          payload: buildPtContactsPendingPayload({ cycleId: input.cycleId, versionId: input.versionId, dayOffset: input.dayOffset, fields: group.fields }),
        },
        client,
      );
      await this.repository.insertNotifications(eventId, [...group.uids], client);
      eventIds.push(eventId);
    }
    return eventIds;
  }
}
