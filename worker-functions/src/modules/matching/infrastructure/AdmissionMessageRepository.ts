import type { Pool } from 'pg';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import type {
  AdmissionMessageKind,
  AdmissionMessageRecord,
  AdmissionMessageStatus,
  AdmissionMessageStore,
} from '../application/ports/AdmissionMessagingPorts';

interface MessageRow {
  id: string;
  appointment_id: string;
  kind: AdmissionMessageKind;
  attempt: number;
  status: AdmissionMessageStatus;
  twilio_sid: string | null;
}

function toRecord(r: MessageRow): AdmissionMessageRecord {
  return { id: r.id, appointmentId: r.appointment_id, kind: r.kind, attempt: r.attempt, status: r.status, twilioSid: r.twilio_sid };
}

/**
 * AdmissionMessageRepository — `admission_messages` (migration 504). O claim é UMA instrução atômica
 * (`INSERT … ON CONFLICT DO NOTHING RETURNING`): não abre transação nem `connect()` cru (T11). A tabela não tem DELETE.
 */
export class AdmissionMessageRepository implements AdmissionMessageStore {
  constructor(private readonly db: Pool = DatabaseConnection.getInstance().getPool()) {}

  async claim(input: {
    appointmentId: string;
    kind: AdmissionMessageKind;
    attempt: number;
    requestedByUid?: string | null;
  }): Promise<string | null> {
    const res = await this.db.query<{ id: string }>(
      `INSERT INTO admission_messages (appointment_id, kind, attempt, requested_by_uid)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (appointment_id, kind, attempt) DO NOTHING
       RETURNING id`,
      [input.appointmentId, input.kind, input.attempt, input.requestedByUid ?? null],
    );
    return res.rows[0]?.id ?? null;
  }

  async setStatus(id: string, status: AdmissionMessageStatus, twilioSid?: string | null): Promise<void> {
    await this.db.query(
      `UPDATE admission_messages
          SET status = $2, twilio_sid = COALESCE($3, twilio_sid), updated_at = now()
        WHERE id = $1`,
      [id, status, twilioSid ?? null],
    );
  }

  async listAttempts(appointmentId: string, kind: AdmissionMessageKind): Promise<AdmissionMessageRecord[]> {
    const res = await this.db.query<MessageRow>(
      `SELECT id, appointment_id, kind, attempt, status, twilio_sid
         FROM admission_messages
        WHERE appointment_id = $1 AND kind = $2
        ORDER BY attempt ASC`,
      [appointmentId, kind],
    );
    return res.rows.map(toRecord);
  }

  async loadAppointmentWindow(appointmentId: string): Promise<{ slotStart: Date; status: string } | null> {
    const res = await this.db.query<{ slot_start: Date; status: string }>(
      `SELECT slot_start, status FROM admission_appointments WHERE id = $1`,
      [appointmentId],
    );
    const row = res.rows[0];
    return row ? { slotStart: new Date(row.slot_start), status: row.status } : null;
  }

  async applyDeliveryStatus(
    twilioSid: string,
    status: 'sent' | 'delivered' | 'read' | 'failed' | 'undelivered',
  ): Promise<AdmissionMessageRecord | null> {
    // Callbacks da Twilio chegam fora de ordem: entregue/lida nunca regride para enviada/falha.
    const res = await this.db.query<MessageRow>(
      `UPDATE admission_messages
          SET status = $2::text, updated_at = now()
        WHERE twilio_sid = $1
          AND status IS DISTINCT FROM $2::text
          AND CASE $2::text
                WHEN 'sent' THEN status IN ('claimed')
                WHEN 'read' THEN TRUE
                ELSE status NOT IN ('delivered', 'read')
              END
      RETURNING id, appointment_id, kind, attempt, status, twilio_sid`,
      [twilioSid, status],
    );
    return res.rows[0] ? toRecord(res.rows[0]) : null;
  }
}
