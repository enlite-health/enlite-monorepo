/**
 * RealAdmissionNotifier.claim.test.ts — spec 049, F2: o freio anti-duplicata do `onBooked` (A2-1, A2-3), os skips (A2-4),
 * a falha sem retry (A2-5) e o log sem PII (A2-8). Dublês das fronteiras (Twilio, Cloud Tasks) e do armazém em memória;
 * a prova contra Postgres real é `tests/e2e/admission-049-mensageria.e2e.test.ts`. Dados SINTÉTICOS.
 */
import type { BookedAppointmentNotice } from '../../application/AdmissionNotifier';
import { RealAdmissionNotifier, admissionReminderTaskId } from '../RealAdmissionNotifier';
import { buildAdmissionKit, KIT_FIRST_NAME, KIT_PHONE, type FakePatient } from '../doubles/admissionTestKit';

const APPT_ID = 'appt-001';
const NOW = '2026-08-01T00:00:00-03:00';
const APPT: BookedAppointmentNotice = {
  appointmentId: APPT_ID,
  patientId: '11111111-1111-1111-1111-111111111111',
  country: 'AR',
  hostEmail: 'ana@enlite.health',
  hostDisplayName: 'Ana',
  slotStartISO: '2026-08-03T10:00:00-03:00',
  slotEndISO: '2026-08-03T10:45:00-03:00',
  meetLink: 'https://meet.google.com/abc-defg-hij',
};

function build(patient?: FakePatient | null) {
  const kit = buildAdmissionKit({ patient, now: () => new Date(NOW) });
  const updates: unknown[][] = [];
  const db = {
    query: async (sql: string, params?: unknown[]) => {
      updates.push([sql, params]);
      return { rows: [] };
    },
  };
  const notifier = new RealAdmissionNotifier(
    kit.messaging,
    kit.content,
    kit.tasks,
    kit.store,
    db as never,
    () => new Date(NOW),
    kit.logs.log,
  );
  return { ...kit, notifier, updates };
}

describe('RealAdmissionNotifier — claim anti-duplicata (spec 049 F2)', () => {
  const OLD_ENV = process.env;
  beforeEach(() => {
    process.env = { ...OLD_ENV, TWILIO_TEMPLATE_ADMISSION_CONFIRMATION_ES: 'SID_CONF_ES' };
  });
  afterEach(() => {
    process.env = OLD_ENV;
  });

  it('A2-1: onBooked 2× com a mesma reunião → exatamente 1 envio, 1 confirmation_sent e 1 duplicate_blocked', async () => {
    const t = build();
    await t.notifier.onBooked(APPT);
    await t.notifier.onBooked(APPT);

    expect(t.whatsapp.calls).toHaveLength(1);
    expect(t.store.kinds().filter((k) => k === 'confirmation_sent')).toHaveLength(1);
    expect(t.store.kinds().filter((k) => k === 'duplicate_blocked')).toHaveLength(1);
    expect(t.store.messages).toHaveLength(1);
    // a repetição também não agenda outra task
    expect(t.tasks.tasks.size).toBe(1);
  });

  it('A2-1: duas chamadas SIMULTÂNEAS (Promise.all) → 1 envio', async () => {
    const t = build();
    await Promise.all([t.notifier.onBooked(APPT), t.notifier.onBooked(APPT)]);
    expect(t.whatsapp.calls).toHaveLength(1);
    expect(t.store.kinds().filter((k) => k === 'duplicate_blocked')).toHaveLength(1);
  });

  it('envia a confirmação com as vars posicionais corretas (es) e o claim fica `sent` com o SID', async () => {
    const t = build();
    await t.notifier.onBooked(APPT);

    const [call] = t.whatsapp.calls;
    expect(call.to).toBe(KIT_PHONE);
    expect(call.contentSid).toBe('SID_CONF_ES');
    expect(call.vars).toMatchObject({ '1': KIT_FIRST_NAME, '2': 'Ana', '4': '10:00', '5': APPT.meetLink });
    expect(t.store.messages[0]).toMatchObject({ kind: 'confirmation', attempt: 0, status: 'sent', twilioSid: expect.stringMatching(/^SMFAKE.*-1$/) });
  });

  it('A2-3: task com o MESMO nome 2× → 1 task no dublê; a 2ª vira duplicate_blocked', async () => {
    const t = build();
    // a task já existe (ex.: o 1º onBooked caiu entre o claim e o registro): o Cloud Tasks devolve ALREADY_EXISTS
    await t.tasks.schedule({ taskId: admissionReminderTaskId(APPT_ID), appointmentId: APPT_ID, runAtISO: '2026-08-03T12:30:00.000Z' });

    await t.notifier.onBooked(APPT);

    expect(t.tasks.tasks.size).toBe(1);
    const dup = t.store.events.find((e) => e.kind === 'duplicate_blocked');
    expect(dup).toMatchObject({ reason: 'task_already_exists', ref: { step: 'reminder_task', taskId: `admission-reminder-${APPT_ID}` } });
    expect(t.store.kinds()).not.toContain('reminder_scheduled');
  });

  it('agenda o lembrete 30 min antes com task NOMEADA, grava reminder_task_name e a trilha', async () => {
    const t = build();
    await t.notifier.onBooked(APPT);

    expect([...t.tasks.tasks.keys()]).toEqual([`admission-reminder-${APPT_ID}`]);
    // 10:00 -03:00 - 30min = 09:30 -03:00 = 12:30Z
    expect(t.tasks.tasks.get(`admission-reminder-${APPT_ID}`)?.runAtISO).toBe('2026-08-03T12:30:00.000Z');
    const update = t.updates.find((u) => String(u[0]).includes('UPDATE admission_appointments'));
    expect(String(update?.[0])).toContain('reminder_task_name');
    expect(update?.[1]).toEqual([APPT_ID, `admission-reminder-${APPT_ID}`]);
    expect(t.store.kinds()).toContain('reminder_scheduled');
  });

  it('slot a menos de 30 min de agora: NÃO agenda (mas confirma), e a trilha diz por quê', async () => {
    const kit = buildAdmissionKit({ now: () => new Date('2026-08-03T09:45:00-03:00') });
    const notifier = new RealAdmissionNotifier(kit.messaging, kit.content, kit.tasks, kit.store, { query: async () => ({ rows: [] }) } as never, () => new Date('2026-08-03T09:45:00-03:00'), kit.logs.log);
    await notifier.onBooked(APPT);
    expect(kit.tasks.tasks.size).toBe(0);
    expect(kit.whatsapp.calls).toHaveLength(1);
    expect(kit.store.events.find((e) => e.kind === 'skipped_slot_too_soon')).toMatchObject({ reason: 'slot_too_soon' });
  });

  describe('A2-4: todo skip vira linha com o motivo, 0 envios', () => {
    const base = { phone_whatsapp: KIT_PHONE, first_name: KIT_FIRST_NAME };
    it.each([
      ['paciente is_test', { ...base, has_consent: true, is_test: true }, 'skipped_test', 0],
      ['sem consentimento', { ...base, has_consent: false, is_test: false }, 'skipped_no_consent', 0],
      ['sem telefone', { phone_whatsapp: null, first_name: KIT_FIRST_NAME, has_consent: true, is_test: false }, 'skipped_no_phone', 1],
    ])('%s', async (_label, patient, status, tasksScheduled) => {
      const t = build(patient as FakePatient);
      await t.notifier.onBooked(APPT);
      expect(t.whatsapp.calls).toHaveLength(0);
      expect(t.store.messages).toHaveLength(1);
      expect(t.store.messages[0].status).toBe(status);
      expect(t.store.events.filter((e) => e.kind === status)).toHaveLength(1);
      // teste e sem consentimento: nem lembrete (como sempre foi); sem telefone: o lembrete ainda é agendado
      expect(t.tasks.tasks.size).toBe(tasksScheduled);
    });

    it('sem template configurado → skipped_no_template, 0 envios', async () => {
      delete process.env.TWILIO_TEMPLATE_ADMISSION_CONFIRMATION_ES;
      const t = build();
      await t.notifier.onBooked(APPT);
      expect(t.whatsapp.calls).toHaveLength(0);
      expect(t.store.messages[0].status).toBe('skipped_no_template');
    });

    it('o gate de teste vem ANTES do consentimento (is_test manda, qualquer que seja o consent)', async () => {
      const t = build({ ...base, has_consent: false, is_test: true });
      await t.notifier.onBooked(APPT);
      expect(t.store.messages[0].status).toBe('skipped_test');
    });

    it('paciente inexistente → skipped_no_consent (sem registro não há consentimento) e 0 envios', async () => {
      const t = build(null);
      await t.notifier.onBooked(APPT);
      expect(t.whatsapp.calls).toHaveLength(0);
      expect(t.store.messages[0].status).toBe('skipped_no_consent');
    });
  });

  it('A2-5: falha do sender → send_failed, 0 novas tentativas automáticas, nem numa 2ª onBooked', async () => {
    const t = build();
    t.whatsapp.failWith = `número inválido ${KIT_PHONE}`;
    await t.notifier.onBooked(APPT);
    expect(t.whatsapp.calls).toHaveLength(1);
    expect(t.store.messages).toHaveLength(1);
    expect(t.store.messages[0].status).toBe('send_failed');
    expect(t.store.kinds()).toContain('confirmation_failed');

    t.whatsapp.failWith = null; // mesmo com o canal já saudável
    await t.notifier.onBooked(APPT);
    expect(t.whatsapp.calls).toHaveLength(1); // nenhum reenvio automático
    expect(t.store.messages).toHaveLength(1);
    expect(t.store.messages[0].status).toBe('send_failed');
  });

  it('o sender LANÇANDO também vira send_failed (e onBooked não estoura no agendamento)', async () => {
    const t = build();
    t.whatsapp.sendWithContentSid = async () => {
      throw new Error(`boom ${KIT_PHONE}`);
    };
    await expect(t.notifier.onBooked(APPT)).resolves.toBeUndefined();
    expect(t.store.messages[0].status).toBe('send_failed');
    expect(t.tasks.tasks.size).toBe(1); // o lembrete é independente
  });

  it('A2-8: a saída do logger (confirmação + skip + falha + duplicata) NÃO contém telefone nem nome', async () => {
    const ok = build();
    await ok.notifier.onBooked(APPT);
    await ok.notifier.onBooked(APPT); // duplicata
    const skip = build({ phone_whatsapp: KIT_PHONE, first_name: KIT_FIRST_NAME, has_consent: false, is_test: false });
    await skip.notifier.onBooked({ ...APPT, appointmentId: 'appt-skip' });
    const failed = build();
    failed.whatsapp.failWith = `número inválido ${KIT_PHONE} de ${KIT_FIRST_NAME}`;
    await failed.notifier.onBooked({ ...APPT, appointmentId: 'appt-fail' });

    for (const t of [ok, skip, failed]) {
      const out = t.logs.output();
      expect(out.length).toBeGreaterThan(0); // não é saída vazia (contagem zero não prova nada)
      expect(out).not.toContain(KIT_PHONE);
      expect(out).not.toContain(KIT_FIRST_NAME);
      expect(out).not.toContain('Carla');
    }
    expect(ok.logs.output()).toContain('admission.confirmation_sent');
    expect(ok.logs.output()).toContain('admission.duplicate_blocked');
    expect(skip.logs.output()).toContain('admission.skipped_no_consent');
    expect(failed.logs.output()).toContain('admission.confirmation_failed');
  });
});
