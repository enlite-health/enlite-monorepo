/**
 * AdmissionMessagingService.resend.test.ts — reenvio humano com teto (spec 049 §4.2.1, A2-7) e anti-duplicata do domínio:
 * 2 cliques simultâneos → 1 envio; 3º reenvio → ResendLimitReached; entregue → ResendNotAllowed. A rota HTTP/409 é da F3.
 */
import { ResendLimitReached, ResendNotAllowed } from '../AdmissionMessagingErrors';
import { buildAdmissionKit, KIT_PHONE } from '../../infrastructure/doubles/admissionTestKit';
import type { AdmissionMessageKind, AdmissionMessageStatus } from '../ports/AdmissionMessagingPorts';

const APPT_ID = 'appt-resend';
const NOW = new Date('2026-08-03T10:00:00Z');
const APPT = {
  patient_id: 'p-1',
  country: 'AR',
  host_display_name: 'Ana',
  slot_start: new Date('2026-08-03T13:00:00Z'),
  meet_link: 'https://meet.google.com/abc-defg-hij',
  status: 'booked',
};

function setup(opts: { attempts: { kind?: AdmissionMessageKind; attempt: number; status: AdmissionMessageStatus }[]; window?: { slotStart: Date; status: string } | null }) {
  const kit = buildAdmissionKit({ appointment: APPT, now: () => NOW });
  for (const a of opts.attempts) {
    kit.store.messages.push({ id: `m-${a.attempt}`, appointmentId: APPT_ID, kind: a.kind ?? 'confirmation', attempt: a.attempt, status: a.status, twilioSid: null, requestedByUid: null });
  }
  kit.store.appointments.set(APPT_ID, opts.window === undefined ? { slotStart: APPT.slot_start, status: 'booked' } : (opts.window as never));
  return kit;
}

describe('AdmissionMessagingService.requestResend', () => {
  const OLD_ENV = process.env;
  beforeEach(() => {
    process.env = { ...OLD_ENV, TWILIO_TEMPLATE_ADMISSION_CONFIRMATION_ES: 'SID_CONF_ES', TWILIO_TEMPLATE_ADMISSION_REMINDER_ES: 'SID_REM_ES' };
  });
  afterEach(() => {
    process.env = OLD_ENV;
  });

  it.each(['send_failed', 'failed', 'undelivered'] as const)('A2-7: mensagem %s → reenvia (attempt 1), 1 envio, evento resend_requested + resend_sent', async (status) => {
    const kit = setup({ attempts: [{ attempt: 0, status }] });
    const res = await kit.messaging.requestResend(APPT_ID, 'confirmation', 'uid-staff-1');

    expect(res.outcome).toBe('sent');
    expect(kit.whatsapp.calls).toHaveLength(1);
    expect(kit.whatsapp.calls[0].to).toBe(KIT_PHONE);
    expect(kit.store.messages.find((m) => m.attempt === 1)).toMatchObject({ status: 'sent', requestedByUid: 'uid-staff-1' });
    expect(kit.store.kinds()).toEqual(expect.arrayContaining(['resend_requested', 'resend_sent']));
    expect(kit.store.events.find((e) => e.kind === 'resend_requested')?.ref).toMatchObject({ requestedByUid: 'uid-staff-1', attempt: 1 });
  });

  it('A2-7: 3ª tentativa (já houve 2 reenvios e o último falhou) → ResendLimitReached, 0 envios', async () => {
    const kit = setup({ attempts: [{ attempt: 0, status: 'send_failed' }, { attempt: 1, status: 'failed' }, { attempt: 2, status: 'undelivered' }] });
    await expect(kit.messaging.requestResend(APPT_ID, 'confirmation', 'uid')).rejects.toBeInstanceOf(ResendLimitReached);
    expect(kit.whatsapp.calls).toHaveLength(0);
    expect(kit.store.messages).toHaveLength(3);
  });

  it.each(['delivered', 'read', 'sent', 'claimed', 'cancelled', 'skipped_test'] as const)('A2-7: mensagem %s → ResendNotAllowed, 0 envios', async (status) => {
    const kit = setup({ attempts: [{ attempt: 0, status }] });
    await expect(kit.messaging.requestResend(APPT_ID, 'confirmation', 'uid')).rejects.toBeInstanceOf(ResendNotAllowed);
    expect(kit.whatsapp.calls).toHaveLength(0);
  });

  it('o status que vale é o da ÚLTIMA tentativa: reenvio entregue depois do original falho não reenvia de novo', async () => {
    const kit = setup({ attempts: [{ attempt: 0, status: 'send_failed' }, { attempt: 1, status: 'delivered' }] });
    await expect(kit.messaging.requestResend(APPT_ID, 'confirmation', 'uid')).rejects.toMatchObject({ reason: 'status_delivered' });
  });

  it('sem mensagem anterior → ResendNotAllowed(no_message); reunião cancelada/inexistente → ResendNotAllowed', async () => {
    await expect(setup({ attempts: [] }).messaging.requestResend(APPT_ID, 'confirmation', 'uid')).rejects.toMatchObject({ reason: 'no_message' });
    const cancelled = setup({ attempts: [{ attempt: 0, status: 'send_failed' }], window: { slotStart: APPT.slot_start, status: 'cancelled' } });
    await expect(cancelled.messaging.requestResend(APPT_ID, 'confirmation', 'uid')).rejects.toMatchObject({ reason: 'appointment_not_booked' });
    const gone = setup({ attempts: [{ attempt: 0, status: 'send_failed' }], window: null });
    await expect(gone.messaging.requestResend(APPT_ID, 'confirmation', 'uid')).rejects.toBeInstanceOf(ResendNotAllowed);
  });

  it('lembrete só ANTES do início da reunião', async () => {
    const started = setup({ attempts: [{ kind: 'reminder_30min', attempt: 0, status: 'send_failed' }], window: { slotStart: new Date('2026-08-03T09:00:00Z'), status: 'booked' } });
    await expect(started.messaging.requestResend(APPT_ID, 'reminder_30min', 'uid')).rejects.toMatchObject({ reason: 'reminder_after_start' });
    const before = setup({ attempts: [{ kind: 'reminder_30min', attempt: 0, status: 'send_failed' }] });
    expect((await before.messaging.requestResend(APPT_ID, 'reminder_30min', 'uid')).outcome).toBe('sent');
    expect(before.whatsapp.calls[0].contentSid).toBe('SID_REM_ES');
  });

  it('2 cliques SIMULTÂNEOS em reenviar → exatamente 1 envio (o outro perde o claim e vira duplicate_blocked)', async () => {
    const kit = setup({ attempts: [{ attempt: 0, status: 'send_failed' }] });
    const results = await Promise.all([
      kit.messaging.requestResend(APPT_ID, 'confirmation', 'uid-a'),
      kit.messaging.requestResend(APPT_ID, 'confirmation', 'uid-b'),
    ]);
    expect(results.map((r) => r.outcome).sort()).toEqual(['duplicate_blocked', 'sent']);
    expect(kit.whatsapp.calls).toHaveLength(1);
    expect(kit.store.messages.filter((m) => m.attempt === 1)).toHaveLength(1);
    expect(kit.store.kinds().filter((k) => k === 'duplicate_blocked')).toHaveLength(1);
  });

  it('sem resolver configurado o reenvio é erro de programação, não envio silencioso', async () => {
    const kit = setup({ attempts: [{ attempt: 0, status: 'send_failed' }] });
    const { AdmissionMessagingService } = await import('../AdmissionMessagingService');
    const bare = new AdmissionMessagingService(kit.store, kit.store, kit.whatsapp);
    await expect(bare.requestResend(APPT_ID, 'confirmation', 'uid')).rejects.toThrow(/resolver/);
  });
});
