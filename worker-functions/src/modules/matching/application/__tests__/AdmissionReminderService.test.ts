/**
 * AdmissionReminderService.test.ts — lembrete 30 min (spec 049 F2: idempotência é o CLAIM, não o carimbo depois do envio).
 * Dublês das fronteiras e armazém em memória; a corrida de 2 entregas com Postgres real está em
 * `tests/e2e/admission-049-mensageria.e2e.test.ts`.
 */
import { AdmissionReminderService } from '../AdmissionReminderService';
import { buildAdmissionKit, KIT_PHONE, type FakeAppointment, type FakePatient } from '../../infrastructure/doubles/admissionTestKit';

const APPT_ID = 'appt-777';

function bookedRow(overrides: Partial<FakeAppointment> = {}): FakeAppointment {
  return {
    patient_id: '11111111-1111-1111-1111-111111111111',
    country: 'AR',
    host_display_name: 'Ana',
    slot_start: new Date('2026-08-03T13:00:00Z'), // 10:00 AR
    meet_link: 'https://meet.google.com/abc-defg-hij',
    status: 'booked',
    ...overrides,
  };
}

function makeService(appointment: FakeAppointment | null, patient?: FakePatient | null) {
  const kit = buildAdmissionKit({ patient, appointment });
  const service = new AdmissionReminderService(kit.messaging, kit.content, kit.db, kit.logs.log);
  return { ...kit, service };
}

describe('AdmissionReminderService.send30MinReminder', () => {
  const OLD_ENV = process.env;
  beforeEach(() => {
    process.env = { ...OLD_ENV, TWILIO_TEMPLATE_ADMISSION_REMINDER_ES: 'SID_REM_ES' };
  });
  afterEach(() => {
    process.env = OLD_ENV;
  });

  it('envia quando booked, com as vars certas, e deixa a linha reminder_30min `sent` + evento reminder_sent', async () => {
    const { service, whatsapp, store } = makeService(bookedRow());

    expect(await service.send30MinReminder(APPT_ID)).toEqual({ sent: true });

    expect(whatsapp.calls).toHaveLength(1);
    const { to, contentSid, vars } = whatsapp.calls[0];
    expect(to).toBe(KIT_PHONE);
    expect(contentSid).toBe('SID_REM_ES');
    expect(vars).toEqual({ '1': 'Ana', '2': '10:00', '3': 'https://meet.google.com/abc-defg-hij' });
    expect(store.messages[0]).toMatchObject({ kind: 'reminder_30min', attempt: 0, status: 'sent' });
    expect(store.kinds()).toContain('reminder_sent');
  });

  it('2ª entrega do Cloud Tasks (at-least-once) perde o claim → NÃO reenvia, grava duplicate_blocked', async () => {
    const { service, whatsapp, store } = makeService(bookedRow());

    await service.send30MinReminder(APPT_ID);
    const second = await service.send30MinReminder(APPT_ID);

    expect(second).toEqual({ sent: false, reason: 'already_sent' });
    expect(whatsapp.calls).toHaveLength(1);
    expect(store.kinds().filter((k) => k === 'duplicate_blocked')).toHaveLength(1);
  });

  it('2 entregas SIMULTÂNEAS → 1 envio', async () => {
    const { service, whatsapp } = makeService(bookedRow());
    await Promise.all([service.send30MinReminder(APPT_ID), service.send30MinReminder(APPT_ID)]);
    expect(whatsapp.calls).toHaveLength(1);
  });

  it('sem consentimento → não envia, linha skipped_no_consent', async () => {
    const { service, whatsapp, store } = makeService(bookedRow(), { phone_whatsapp: KIT_PHONE, first_name: 'Carla', has_consent: false, is_test: false });
    expect(await service.send30MinReminder(APPT_ID)).toEqual({ sent: false, reason: 'no_consent' });
    expect(whatsapp.calls).toHaveLength(0);
    expect(store.messages[0].status).toBe('skipped_no_consent');
  });

  it('paciente is_test → não envia, linha skipped_test', async () => {
    const { service, whatsapp, store } = makeService(bookedRow(), { phone_whatsapp: KIT_PHONE, first_name: 'Carla', has_consent: true, is_test: true });
    expect(await service.send30MinReminder(APPT_ID)).toEqual({ sent: false, reason: 'test_patient' });
    expect(whatsapp.calls).toHaveLength(0);
    expect(store.messages[0].status).toBe('skipped_test');
  });

  it('sem telefone → skipped_no_phone; sem template → skipped_no_template', async () => {
    const noPhone = makeService(bookedRow(), { phone_whatsapp: null, first_name: 'Carla', has_consent: true, is_test: false });
    expect(await noPhone.service.send30MinReminder(APPT_ID)).toEqual({ sent: false, reason: 'no_phone' });
    expect(noPhone.store.messages[0].status).toBe('skipped_no_phone');

    delete process.env.TWILIO_TEMPLATE_ADMISSION_REMINDER_ES;
    const noTpl = makeService(bookedRow());
    expect(await noTpl.service.send30MinReminder(APPT_ID)).toEqual({ sent: false, reason: 'no_template' });
    expect(noTpl.store.messages[0].status).toBe('skipped_no_template');
  });

  it('status != booked (cancelled) → não envia; a linha fica `cancelled` e a trilha registra', async () => {
    const { service, whatsapp, store } = makeService(bookedRow({ status: 'cancelled' }));
    expect(await service.send30MinReminder(APPT_ID)).toEqual({ sent: false, reason: 'status_cancelled' });
    expect(whatsapp.calls).toHaveLength(0);
    expect(store.messages[0].status).toBe('cancelled');
    expect(store.kinds()).toContain('cancelled');
  });

  it('falha do envio → send_failed, sem nova tentativa automática', async () => {
    const { service, whatsapp, store } = makeService(bookedRow());
    whatsapp.failWith = 'canal fora';
    expect(await service.send30MinReminder(APPT_ID)).toEqual({ sent: false, reason: 'send_failed' });
    await service.send30MinReminder(APPT_ID); // a Cloud Task re-entrega: o claim já existe
    expect(whatsapp.calls).toHaveLength(1);
    expect(store.messages[0].status).toBe('send_failed');
    expect(store.kinds()).toContain('reminder_failed');
  });

  it('appointment inexistente → not_found; país inválido → bad_country (sem linha, sem envio)', async () => {
    const missing = makeService(null);
    expect(await missing.service.send30MinReminder(APPT_ID)).toEqual({ sent: false, reason: 'not_found' });
    const bad = makeService(bookedRow({ country: 'XX' }));
    expect(await bad.service.send30MinReminder(APPT_ID)).toEqual({ sent: false, reason: 'bad_country' });
    expect(missing.whatsapp.calls).toHaveLength(0);
    expect(bad.whatsapp.calls).toHaveLength(0);
  });

  it('A2-8: a saída do logger do lembrete não contém telefone nem nome', async () => {
    const { service, logs, whatsapp } = makeService(bookedRow());
    await service.send30MinReminder(APPT_ID);
    await service.send30MinReminder(APPT_ID);
    whatsapp.failWith = `x ${KIT_PHONE}`;
    const out = logs.output();
    expect(out).toContain('admission.reminder_sent');
    expect(out).not.toContain(KIT_PHONE);
    expect(out).not.toContain('Carla');
  });
});
