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
import { NotificationRepository, type PtContactsPendingPayload } from '../infrastructure/NotificationRepository';

export const SYSTEM_NOTIFICATION_ACTOR_UID = 'system:pt-contact-reminders';

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
