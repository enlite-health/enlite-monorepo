import type { PoolClient } from 'pg';
import { SystemNotificationPublisher } from '@modules/inapp-notification/application/SystemNotificationPublisher';
import type { AlertRecipient, AlertToDeliver, CoordinationAlertChannel, DeliveryOutcome, DeliveryTx } from '../application/ports/CoordinationAlertPorts';

/**
 * Canal in-app (sino): UM evento + uma notificação por destinatário, GRAVADOS NA TRANSAÇÃO DO ALERTA (`tx` = o client dela). Payload só-ids
 * (`{occurrence_id, slot_id, on_date, worker_id, service_id}`) e `patient_id` na coluna. O texto final é do frontend (registry por tipo).
 * Sem `tx` é erro de programação (lança): a entrega in-app fora da transação do alerta quebraria a idempotência.
 */
export class InAppCoordinationAlertChannel implements CoordinationAlertChannel {
  readonly channel = 'IN_APP' as const;

  constructor(private readonly publisher: Pick<SystemNotificationPublisher, 'publishCoordinationAlert'> = new SystemNotificationPublisher()) {}

  async deliver(alert: AlertToDeliver, recipient: AlertRecipient, tx?: DeliveryTx): Promise<DeliveryOutcome> {
    if (!tx) throw new Error('InAppCoordinationAlertChannel: a entrega in-app exige a transação do alerta');
    const s = alert.shift;
    const notificationEventId = await this.publisher.publishCoordinationAlert(tx as PoolClient, {
      typeCode: alert.kind,
      recipientUid: recipient.uid,
      patientId: s.patientId,
      payload: { occurrence_id: s.occurrenceId, slot_id: s.slotId, on_date: s.onDate, worker_id: s.workerId, service_id: s.serviceId },
    });
    return { status: 'SENT', notificationEventId };
  }
}
