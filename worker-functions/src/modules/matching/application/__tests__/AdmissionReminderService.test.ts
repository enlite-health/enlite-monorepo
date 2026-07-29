/**
 * AdmissionReminderService.test.ts — endpoint de lembrete 30min.
 *
 * Cobertura:
 *  - envia quando status='booked' e não enviado ainda + grava reminder_30min_sent_at
 *  - idempotente: reminder_30min_sent_at preenchido → não reenvia
 *  - status != 'booked' → não envia
 *
 * I/O mockado (Twilio + Postgres). Envio real exige creds + template aprovado.
 */

import { Pool } from 'pg';
import { Result } from '@shared/utils/Result';
import { MessageSentResult } from '@modules/notification/domain/IMessagingService';
import type { AdmissionWhatsAppSender } from '../../infrastructure/admissionTemplates';
import { AdmissionReminderService } from '../AdmissionReminderService';

const APPT_ID = 'appt-777';
const PHONE = '+5491122334455';

interface ApptRow {
  patient_id: string;
  country: string;
  host_display_name: string | null;
  slot_start: Date;
  meet_link: string | null;
  status: string;
  reminder_30min_sent_at: Date | null;
}

function makeService(apptRow: ApptRow | null) {
  const query = jest.fn(async (sql: string, _params?: unknown[]) => {
    if (sql.includes('FROM admission_appointments')) {
      return { rows: apptRow ? [apptRow] : [] };
    }
    if (sql.includes('FROM patients')) {
      return { rows: [{ phone_whatsapp: PHONE }] };
    }
    return { rows: [] }; // UPDATE
  });
  const db = { query } as unknown as Pool;

  const sendWithContentSid = jest.fn(
    async (
      _to: string,
      _contentSid: string,
      _vars: Record<string, string>,
    ): Promise<Result<MessageSentResult>> =>
      Result.ok<MessageSentResult>({ externalId: 'SM9', status: 'queued', to: PHONE }),
  );
  const whatsapp: AdmissionWhatsAppSender = { sendWithContentSid };

  const service = new AdmissionReminderService(whatsapp, db);
  return { service, query, sendWithContentSid };
}

function bookedRow(overrides: Partial<ApptRow> = {}): ApptRow {
  return {
    patient_id: '11111111-1111-1111-1111-111111111111',
    country: 'AR',
    host_display_name: 'Ana',
    slot_start: new Date('2026-08-03T13:00:00Z'), // 10:00 AR
    meet_link: 'https://meet.google.com/abc-defg-hij',
    status: 'booked',
    reminder_30min_sent_at: null,
    ...overrides,
  };
}

describe('AdmissionReminderService.send30MinReminder', () => {
  const OLD_ENV = process.env;

  beforeEach(() => {
    process.env = { ...OLD_ENV };
    process.env.TWILIO_TEMPLATE_ADMISSION_REMINDER_ES = 'SID_REM_ES';
  });

  afterEach(() => {
    process.env = OLD_ENV;
    jest.clearAllMocks();
  });

  it('envia quando booked e grava reminder_30min_sent_at', async () => {
    const { service, sendWithContentSid, query } = makeService(bookedRow());

    const result = await service.send30MinReminder(APPT_ID);

    expect(result).toEqual({ sent: true });
    expect(sendWithContentSid).toHaveBeenCalledTimes(1);
    const [to, contentSid, vars] = sendWithContentSid.mock.calls[0];
    expect(to).toBe(PHONE);
    expect(contentSid).toBe('SID_REM_ES');
    expect(vars['1']).toBe('Ana'); // host
    expect(vars['2']).toBe('10:00'); // hora AR
    expect(vars['3']).toBe('https://meet.google.com/abc-defg-hij');

    const updateCall = query.mock.calls.find((c) => String(c[0]).includes('UPDATE admission_appointments'));
    expect(updateCall).toBeTruthy();
    expect(updateCall![0]).toContain('reminder_30min_sent_at');
    expect(updateCall![1]).toEqual([APPT_ID]);
  });

  it('idempotente: já enviado (reminder_30min_sent_at preenchido) → não reenvia', async () => {
    const { service, sendWithContentSid, query } = makeService(
      bookedRow({ reminder_30min_sent_at: new Date('2026-08-03T12:31:00Z') }),
    );

    const result = await service.send30MinReminder(APPT_ID);

    expect(result).toEqual({ sent: false, reason: 'already_sent' });
    expect(sendWithContentSid).not.toHaveBeenCalled();
    const updateCall = query.mock.calls.find((c) => String(c[0]).includes('UPDATE admission_appointments'));
    expect(updateCall).toBeUndefined();
  });

  it('status != booked (cancelled) → não envia', async () => {
    const { service, sendWithContentSid } = makeService(bookedRow({ status: 'cancelled' }));

    const result = await service.send30MinReminder(APPT_ID);

    expect(result).toEqual({ sent: false, reason: 'status_cancelled' });
    expect(sendWithContentSid).not.toHaveBeenCalled();
  });

  it('appointment inexistente → not_found', async () => {
    const { service, sendWithContentSid } = makeService(null);

    const result = await service.send30MinReminder(APPT_ID);

    expect(result).toEqual({ sent: false, reason: 'not_found' });
    expect(sendWithContentSid).not.toHaveBeenCalled();
  });
});
