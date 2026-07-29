/**
 * RealAdmissionNotifier.test.ts
 *
 * Cobertura:
 *  - onBooked: envia a confirmação (Twilio Content API) com as vars corretas
 *  - onBooked: agenda o Cloud Task 30min antes e grava reminder_task_name
 *  - slot a <30min de agora: NÃO agenda reminder (mas ainda confirma)
 *  - sem template de env: WARN e não quebra (não envia, mas ainda agenda)
 *
 * Todo I/O é mockado — envio real de WhatsApp exige creds Twilio + template
 * aprovado pela Meta, o que não roda local (provado por payload/scheduling).
 */

import { Pool } from 'pg';
import { Result } from '@shared/utils/Result';
import { MessageSentResult } from '@modules/notification/domain/IMessagingService';
import { CloudTasksClient, ScheduleTaskOptions } from '@shared/events/CloudTasksClient';
import type { BookedAppointmentNotice } from '../../application/AdmissionNotifier';
import type { AdmissionWhatsAppSender } from '../admissionTemplates';
import { RealAdmissionNotifier, ADMISSION_REMINDER_QUEUE } from '../RealAdmissionNotifier';

const PATIENT_ID = '11111111-1111-1111-1111-111111111111';
const SLOT_ISO = '2026-08-03T10:00:00-03:00'; // segunda 10:00 AR
const PHONE = '+5491122334455';

function makeNotifier(opts: {
  patientRow?: { phone_whatsapp: string | null; first_name: string | null } | null;
  now: string;
  scheduleReturns?: string | null;
}) {
  const query = jest.fn(async (sql: string, _params?: unknown[]) => {
    if (sql.includes('FROM patients')) {
      return { rows: opts.patientRow === undefined
        ? [{ phone_whatsapp: PHONE, first_name: 'Carla' }]
        : opts.patientRow
          ? [opts.patientRow]
          : [] };
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
      Result.ok<MessageSentResult>({ externalId: 'SM1', status: 'queued', to: PHONE }),
  );
  const whatsapp: AdmissionWhatsAppSender = { sendWithContentSid };

  const schedule = jest.fn(async (_o: ScheduleTaskOptions) =>
    opts.scheduleReturns === undefined ? 'task-abc' : opts.scheduleReturns,
  );
  const cloudTasks = { schedule } as unknown as CloudTasksClient;

  const notifier = new RealAdmissionNotifier(
    whatsapp,
    cloudTasks,
    db,
    () => new Date(opts.now),
  );

  return { notifier, query, sendWithContentSid, schedule };
}

const APPT: BookedAppointmentNotice = {
  appointmentId: 'appt-001',
  patientId: PATIENT_ID,
  country: 'AR',
  hostEmail: 'ana@enlite.health',
  hostDisplayName: 'Ana',
  slotStartISO: SLOT_ISO,
  slotEndISO: '2026-08-03T10:45:00-03:00',
  meetLink: 'https://meet.google.com/abc-defg-hij',
};

describe('RealAdmissionNotifier', () => {
  const OLD_ENV = process.env;

  beforeEach(() => {
    process.env = { ...OLD_ENV };
    process.env.TWILIO_TEMPLATE_ADMISSION_CONFIRMATION_ES = 'SID_CONF_ES';
  });

  afterEach(() => {
    process.env = OLD_ENV;
    jest.clearAllMocks();
  });

  it('envia a confirmação com as vars posicionais corretas (es)', async () => {
    const { notifier, sendWithContentSid } = makeNotifier({ now: '2026-08-01T00:00:00-03:00' });

    await notifier.onBooked(APPT);

    expect(sendWithContentSid).toHaveBeenCalledTimes(1);
    const [to, contentSid, vars] = sendWithContentSid.mock.calls[0];
    expect(to).toBe(PHONE);
    expect(contentSid).toBe('SID_CONF_ES');
    expect(vars['1']).toBe('Carla'); // nome
    expect(vars['2']).toBe('Ana'); // dra
    expect(vars['4']).toBe('10:00'); // hora no tz AR
    expect(vars['5']).toBe(APPT.meetLink); // meet link
  });

  it('agenda o reminder 30min antes e grava reminder_task_name', async () => {
    const { notifier, schedule, query } = makeNotifier({ now: '2026-08-01T00:00:00-03:00' });

    await notifier.onBooked(APPT);

    expect(schedule).toHaveBeenCalledTimes(1);
    const arg = schedule.mock.calls[0][0];
    expect(arg.queue).toBe(ADMISSION_REMINDER_QUEUE);
    expect(arg.url).toBe('/api/internal/reminders/admission-30min');
    expect(arg.body).toEqual({ appointmentId: 'appt-001' });
    // 10:00 -03:00 - 30min = 09:30 -03:00 = 12:30Z
    expect(new Date(arg.scheduleTime as string).toISOString()).toBe('2026-08-03T12:30:00.000Z');

    const updateCall = query.mock.calls.find((c) => String(c[0]).includes('UPDATE admission_appointments'));
    expect(updateCall).toBeTruthy();
    expect(updateCall![0]).toContain('reminder_task_name');
    expect(updateCall![1]).toEqual(['appt-001', 'task-abc']);
  });

  it('slot a menos de 30min de agora: NÃO agenda reminder (mas ainda confirma)', async () => {
    const { notifier, schedule, sendWithContentSid } = makeNotifier({
      now: '2026-08-03T09:45:00-03:00', // 15min antes do slot
    });

    await notifier.onBooked(APPT);

    expect(schedule).not.toHaveBeenCalled();
    expect(sendWithContentSid).toHaveBeenCalledTimes(1); // confirmação independe
  });

  it('sem template de confirmação configurado: WARN e não envia, mas ainda agenda', async () => {
    delete process.env.TWILIO_TEMPLATE_ADMISSION_CONFIRMATION_ES;
    const { notifier, schedule, sendWithContentSid } = makeNotifier({ now: '2026-08-01T00:00:00-03:00' });

    await notifier.onBooked(APPT);

    expect(sendWithContentSid).not.toHaveBeenCalled();
    expect(schedule).toHaveBeenCalledTimes(1);
  });
});
