/**
 * GetNotificationsUseCase — `GET /api/admin/notifications` (Spec 022, Bloco 4, T406).
 *
 * `patientDisplayName`: resolvido SOB A CÉLULA DO DESTINATÁRIO da notificação (quem faz a
 * requisição) — revisão de D-13 no gate fecho B5 (21/09). A versão original resolvia pela célula
 * do ATOR do evento; achado do gate: quem posta sempre tem a célula, então o nome do paciente
 * vazava para QUALQUER destinatário mencionado, mesmo sem célula nenhuma — o efeito de
 * privacidade era o inverso do fallback "um paciente" pretendido. Sem célula de leitura do
 * paciente, `patientDisplayName = null`. Cache de UMA checagem por chamada (`recipientUid` é
 * sempre o mesmo dentro de uma resposta — não é mais por ator), sem cache entre requests
 * (decisão em tempo real).
 */
import {
  NotificationRepository,
  IMPORT_STAGES,
  IMPORT_KINDS,
  IMPORT_REASONS,
  IMPORT_AUDIENCES,
  TALENTUM_WEBHOOK_ALARMS,
  type TalentumWebhookAlarmPayload,
  type AdmissionTactiqLinkPayload,
  type AdmissionTactiqExtensionPayload,
  type AdmissionImportBlockedPayload,
  type ItineraryUncoveredShiftsPayload,
  type PedidoIaAplicarPayload,
  type NotificationTypeCode,
  type PtContactsPendingPayload,
  type CoordinationAlertPayload,
} from '../infrastructure/NotificationRepository';
import type { ActorPatientConversationAccessChecker } from './ports';

export interface GetNotificationsParams {
  recipientUid: string;
  unreadOnly?: boolean;
  limit: number;
}

export interface NotificationDto {
  id: string;
  typeCode: NotificationTypeCode;
  actorUid: string;
  actorDisplayName: string | null;
  patientId: string | null;
  patientDisplayName: string | null;
  conversationId: string | null;
  messageId: string | null;
  /** Item 3 (deep-link, F10/F11): UNGATED, igual ao `messageId` — nunca depende da célula de
   *  leitura do paciente (a UI decide "sem acesso" separadamente). `null` quando a mensagem de
   *  origem É o root, ou quando não há `messageId` no evento. */
  rootMessageId: string | null;
  /** spec 048: SÓ no tipo `THERAPEUTIC_PROJECT_CONTACTS_PENDING` (4 chaves, ids + nome de campo); `null` nos de conversa. */
  payload: PtContactsPendingPayload | AdmissionTactiqLinkPayload | AdmissionTactiqExtensionPayload | ItineraryUncoveredShiftsPayload | PedidoIaAplicarPayload | AdmissionImportBlockedPayload | TalentumWebhookAlarmPayload | CoordinationAlertPayload | null;
  /** spec 048: número do Caso (`patients.case_number`) do tipo do PT — o sino NUNCA mostra o nome do paciente nele. */
  patientCaseNumber: number | null;
  /** Item 2 (card com trecho, F7/F8): MESMO gate de `patientDisplayName` — só resolvido quando o
   *  destinatário tem `patient_conversation:read` para o paciente da conversa. `null` sem célula,
   *  sem `messageId`, ou se a decifra falhar. */
  messageExcerpt: string | null;
  createdAt: Date;
  readAt: Date | null;
}

export class GetNotificationsUseCase {
  constructor(
    private readonly repository: NotificationRepository = new NotificationRepository(),
    private readonly accessChecker?: ActorPatientConversationAccessChecker,
  ) {}

  async execute(params: GetNotificationsParams): Promise<NotificationDto[]> {
    const rows = await this.repository.listForRecipient(params.recipientUid, {
      unreadOnly: params.unreadOnly,
      limit: params.limit,
    });

    // rootMessageId (item 3) é UNGATED — resolvido para TODO messageId presente, antes de
    // qualquer checagem de célula (o alvo do deep-link não depende da permissão de leitura).
    const allMessageIds = dedupNonNull(rows.map((row) => row.messageId));
    const rootMessageIds = await this.repository.findRootMessageIds(allMessageIds);

    // recipientAllowed (D-13/F7): UMA checagem por chamada, é sempre o mesmo destinatário —
    // mesmo cache já existente, agora também usado para gatear o trecho (item 2).
    let recipientAllowed: boolean | undefined;
    for (const row of rows) {
      if (row.patientId && this.accessChecker && !isSystemAlertType(row.typeCode)) {
        if (recipientAllowed === undefined) {
          recipientAllowed = await this.accessChecker.canReadPatientConversation(params.recipientUid);
        }
        break;
      }
    }

    // messageExcerpt (item 2) É gated: só para linhas com patientId E recipientAllowed — MESMO
    // conjunto que teria patientDisplayName resolvido, decifrado em LOTE (F8).
    const eligibleMessageIds = recipientAllowed
      ? dedupNonNull(rows.filter((row) => row.patientId && !isSystemAlertType(row.typeCode)).map((row) => row.messageId))
      : [];
    const excerpts = await this.repository.findMessageExcerpts(eligibleMessageIds);

    const results: NotificationDto[] = [];
    for (const row of rows) {
      let patientDisplayName: string | null = null;
      let messageExcerpt: string | null = null;

      // spec 048 (Gabriel, 08/10): o aviso do PT NUNCA leva o nome do paciente, mesmo para quem tem a célula de
      // conversa — só o número do Caso. Por isso o tipo de sistema nem entra na resolução do nome/trecho.
      if (row.patientId && this.accessChecker && recipientAllowed && !isSystemAlertType(row.typeCode)) {
        patientDisplayName = await this.repository.findPatientDisplayName(row.patientId);
        if (row.messageId) messageExcerpt = excerpts.get(row.messageId) ?? null;
      }

      const rootMessageId = row.messageId ? rootMessageIds.get(row.messageId) ?? null : null;

      const { payload: rawPayload, ...rest } = row;
      results.push({
        ...rest,
        patientDisplayName,
        rootMessageId,
        messageExcerpt,
        payload: payloadOf(row.typeCode, rawPayload),
        patientCaseNumber: isSystemPtType(row.typeCode) ? row.patientCaseNumber : null,
      });
    }

    return results;
  }
}

const isSystemPtType = (code: NotificationTypeCode): boolean => code === 'THERAPEUTIC_PROJECT_CONTACTS_PENDING';

/** Aviso de sistema sem nome de paciente: o do PT e os 2 de presença (§5.5 — o sino mostra data e hora; nome/caso só na tela da fila, sob a célula dela). */
const isSystemAlertType = (code: NotificationTypeCode): boolean =>
  isSystemPtType(code) || code === 'PRESENCE_OPEN_4H' || code === 'CHECK_IN_REFUSED_NO_ENTRY';

/** Payload por tipo: o do PT (4 chaves) ou o da admissão (`reason`); conversa não tem payload. */
function payloadOf(
  code: NotificationTypeCode,
  raw: Record<string, unknown> | null,
): PtContactsPendingPayload | AdmissionTactiqLinkPayload | AdmissionTactiqExtensionPayload | ItineraryUncoveredShiftsPayload | PedidoIaAplicarPayload | AdmissionImportBlockedPayload | TalentumWebhookAlarmPayload | CoordinationAlertPayload | null {
  if (code === 'PRESENCE_OPEN_4H' || code === 'CHECK_IN_REFUSED_NO_ENTRY') return coordinationAlertPayloadOf(raw);
  if (isSystemPtType(code)) return ptPayloadOf(raw);
  if (code === 'ADMISSION_TACTIQ_LINK_REQUIRED') {
    return tactiqLinkPayloadOf(raw);
  }
  if (code === 'ITINERARY_UNCOVERED_SHIFTS') return itineraryPayloadOf(raw);
  if (code === 'PEDIDO_IA_APLICAR') return pedidoAplicarPayloadOf(raw);
  if (code === 'ADMISSION_IMPORT_BLOCKED') return importBlockedPayloadOf(raw);
  if (code === 'TALENTUM_WEBHOOK_ALARM') return talentumAlarmPayloadOf(raw);
  if (code === 'ADMISSION_TACTIQ_EXTENSION_CHANGED') {
    const state = raw?.state;
    return state === 'installed' || state === 'missing' || state === 'disabled' ? { state } : null;
  }
  return null;
}

/**
 * Emenda 077 §5.5: o aviso de presença à coordenação leva SÓ as 5 chaves de id/data do contrato, reconstruídas uma a uma (chave extra gravada por
 * engano nunca passa). Linha malformada = sem payload (o front cai no texto sem data). Nenhum nome, endereço nem dado clínico — o `patient_id` vai na coluna.
 */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
function coordinationAlertPayloadOf(raw: Record<string, unknown> | null): CoordinationAlertPayload | null {
  if (!raw) return null;
  const { occurrence_id, slot_id, on_date, worker_id, service_id } = raw;
  const ids = [occurrence_id, slot_id, worker_id, service_id];
  if (!ids.every((v) => typeof v === 'string' && v !== '') || typeof on_date !== 'string' || !ISO_DATE.test(on_date)) return null;
  return { occurrence_id, slot_id, on_date, worker_id, service_id } as CoordinationAlertPayload;
}

/**
 * Aviso do vínculo do Tactiq (D11): reconstrói chave a chave, nunca repassa o `raw`. `audience` só vale `master` em `seat_missing`/`broken`/`seat_pending`
 * (senão cai para o responsável); `hostName` só na cópia `master`; `adminNotified` só em `seat_missing` ao `host`; `autoReactivates` só em
 * `seat_missing`; `firstLink` só em `seat_ready` (host). `seat_missing` sem `audience` válida é estranho = sem payload (o front cai no texto `missing`).
 */
function tactiqLinkPayloadOf(raw: Record<string, unknown> | null): AdmissionTactiqLinkPayload | null {
  const reason = raw?.reason;
  const known = ['missing', 'broken', 'wrong_account', 'seat_missing', 'seat_pending', 'seat_ready'] as const;
  if (!known.includes(reason as (typeof known)[number])) return null;
  const { audience: rawAudience, hostName, adminNotified, autoReactivates, firstLink } = raw as Record<string, unknown>;
  const masterAllowed = reason === 'seat_missing' || reason === 'broken' || reason === 'seat_pending';
  const audience = rawAudience === 'host' || (rawAudience === 'master' && masterAllowed) ? rawAudience : undefined;
  if (reason === 'seat_missing' && !audience) return null;
  // F5 (D11): `seat_pending` só existe para o Master; `seat_ready` só para o host e com `firstLink` boolean — fora disso é estranho = sem payload.
  if (reason === 'seat_pending' && audience !== 'master') return null;
  if (reason === 'seat_ready' && (audience !== 'host' || typeof firstLink !== 'boolean')) return null;
  const out: AdmissionTactiqLinkPayload = { reason: reason as AdmissionTactiqLinkPayload['reason'] };
  if (audience) out.audience = audience;
  if (audience === 'master' && typeof hostName === 'string' && hostName !== '') out.hostName = hostName;
  if (reason === 'seat_missing') {
    if (audience === 'host' && typeof adminNotified === 'boolean') out.adminNotified = adminNotified;
    if (typeof autoReactivates === 'boolean') out.autoReactivates = autoReactivates;
  }
  if (reason === 'seat_ready' && typeof firstLink === 'boolean') out.firstLink = firstLink;
  return out;
}

/** Spec 095 §3.5: as 3 chaves do contrato (`alarme` do conjunto fechado, `quantidade` inteira >= 1, `desde` string); chave extra não passa; malformado = sem payload. */
function talentumAlarmPayloadOf(raw: Record<string, unknown> | null): TalentumWebhookAlarmPayload | null {
  if (!raw) return null;
  const { alarme, quantidade, desde } = raw;
  if (typeof alarme !== 'string' || !(TALENTUM_WEBHOOK_ALARMS as readonly string[]).includes(alarme)) return null;
  if (typeof quantidade !== 'number' || !Number.isInteger(quantidade) || quantidade < 1 || typeof desde !== 'string') return null;
  return { alarme: alarme as TalentumWebhookAlarmPayload['alarme'], quantidade, desde };
}

/** Spec 083 D-7: lê chave a chave (enums conferidos); linha malformada = sem payload; `hostName` só se for string não vazia. */
function importBlockedPayloadOf(raw: Record<string, unknown> | null): AdmissionImportBlockedPayload | null {
  if (!raw) return null;
  const { stage, kind, reason, audience, meetingAt, deadlineAt, hostName } = raw;
  const inSet = (v: unknown, set: readonly string[]): boolean => typeof v === 'string' && set.includes(v);
  if (!inSet(stage, IMPORT_STAGES) || !inSet(kind, IMPORT_KINDS) || !inSet(reason, IMPORT_REASONS) || !inSet(audience, IMPORT_AUDIENCES)) return null;
  if (typeof meetingAt !== 'string' || typeof deadlineAt !== 'string') return null;
  const base = { stage, kind, reason, audience, meetingAt, deadlineAt } as AdmissionImportBlockedPayload;
  return typeof hostName === 'string' && hostName !== '' ? { ...base, hostName } : base;
}

/** Spec 078 M4.4: as 4 chaves do contrato, com tipos e enums conferidos; qualquer outra coisa = sem payload (o front cai no texto neutro). */
function pedidoAplicarPayloadOf(raw: Record<string, unknown> | null): PedidoIaAplicarPayload | null {
  if (!raw || typeof raw.pedido_id !== 'string' || typeof raw.grave !== 'boolean') return null;
  if (raw.degrau !== 3 && raw.degrau !== 4) return null;
  if (raw.prazo !== 'hoje' && raw.prazo !== 'semana') return null;
  return { pedido_id: raw.pedido_id, degrau: raw.degrau, grave: raw.grave, prazo: raw.prazo };
}

/** Spec 069 F4: filtra o payload bruto às chaves do contrato (data + itens só-ids); item malformado é descartado, nunca repassado. */
function itineraryPayloadOf(raw: Record<string, unknown> | null): ItineraryUncoveredShiftsPayload | null {
  if (!raw || typeof raw.operationDate !== 'string' || !Array.isArray(raw.items)) return null;
  const items = raw.items.flatMap((i: unknown) => {
    const it = i as Record<string, unknown>;
    return typeof it.patientId === 'string' && typeof it.serviceId === 'string' && typeof it.shifts === 'number' && typeof it.firstDate === 'string'
      ? [{ patientId: it.patientId, serviceId: it.serviceId, shifts: it.shifts, firstDate: it.firstDate }]
      : [];
  });
  return { operationDate: raw.operationDate, items };
}

/** Filtra o payload bruto às 4 chaves do contrato — nunca devolve chave extra que alguém tenha gravado. */
function ptPayloadOf(raw: Record<string, unknown> | null): PtContactsPendingPayload | null {
  if (!raw || typeof raw.cycleId !== 'string' || typeof raw.versionId !== 'string' || typeof raw.dayOffset !== 'number' || !Array.isArray(raw.fields)) {
    return null;
  }
  return {
    cycleId: raw.cycleId,
    versionId: raw.versionId,
    dayOffset: raw.dayOffset,
    fields: raw.fields.filter((f): f is string => typeof f === 'string'),
  };
}

/** uids/ids não-nulos, sem repetição, na ordem de 1ª aparição — evita decifrar/ler o MESMO
 *  messageId duas vezes quando várias notificações apontam pra mesma mensagem (custo de KMS). */
function dedupNonNull(ids: Array<string | null>): string[] {
  return [...new Set(ids.filter((id): id is string => id !== null))];
}
