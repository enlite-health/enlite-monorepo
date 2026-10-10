/**
 * AdmissionPanelService.test.ts — spec 049 F3: cancelar, reenviar (os dois tipos de perdedor) e listar.
 * Banco por script de SQL; Google, agendador e WhatsApp são dublês. Nada sai da máquina; dados sintéticos.
 */
import type { Pool } from 'pg';
import { AdmissionMessagingService } from '../AdmissionMessagingService';
import { ResendLimitReached, ResendNotAllowed } from '../AdmissionMessagingErrors';
import { AdmissionPanelService } from '../AdmissionPanelService';
import { AppointmentNotCancellableError, AppointmentNotFoundError, ResendInProgressError } from '../AdmissionPanelErrors';
import { PatientNotFoundError } from '../AdmissionSchedulingService';
import { FakeAdmissionCalendar } from '../../infrastructure/doubles/FakeAdmissionCalendar';
import { InMemoryAdmissionReminderTasks } from '../../infrastructure/doubles/InMemoryAdmissionReminderTasks';
import { InMemoryAdmissionStore } from '../../infrastructure/doubles/InMemoryAdmissionStore';
import { RecordingAdmissionWhatsApp } from '../../infrastructure/doubles/RecordingAdmissionWhatsApp';
import { capturingLogger } from '../../infrastructure/doubles/admissionTestKit';

const PATIENT = '11111111-1111-1111-1111-111111111111';
const APPT = '22222222-2222-2222-2222-222222222222';
const TASK = 'admission-reminder-22222222-2222-2222-2222-222222222222';
const NOW = new Date('2026-10-10T12:00:00Z');

interface DbFx {
  patientExists?: boolean;
  /** Linha devolvida pelo UPDATE ... RETURNING do cancelamento (null = 0 linhas). */
  cancelRow?: { country: string; calendar_event_id: string | null; reminder_task_name: string | null } | null;
  /** Status atual quando o UPDATE não pegou (null = a reunião não existe / não é deste paciente). */
  currentStatus?: string | null;
  apptRows?: Record<string, unknown>[];
  msgRows?: Record<string, unknown>[];
  ownsAppointment?: boolean;
}

function fakeDb(fx: DbFx) {
  const calls: { sql: string; params: unknown[] }[] = [];
  const query = async (sql: string, params: unknown[] = []) => {
    calls.push({ sql, params });
    if (sql.includes('FROM patients')) return { rows: fx.patientExists === false ? [] : [{ '?column?': 1 }] };
    if (sql.includes('UPDATE admission_appointments')) return { rows: fx.cancelRow ? [fx.cancelRow] : [] };
    if (sql.includes('UPDATE admission_messages')) return { rows: [] };
    if (sql.includes('SELECT status FROM admission_appointments')) {
      return { rows: fx.currentStatus == null ? [] : [{ status: fx.currentStatus }] };
    }
    if (sql.includes('SELECT 1 FROM admission_appointments')) return { rows: fx.ownsAppointment === false ? [] : [{ '?column?': 1 }] };
    if (sql.includes('FROM admission_appointments a')) return { rows: fx.apptRows ?? [] };
    if (sql.includes('FROM admission_messages')) return { rows: fx.msgRows ?? [] };
    return { rows: [] };
  };
  return { db: { query } as unknown as Pool, calls };
}

function build(fx: DbFx = {}) {
  const { db, calls } = fakeDb(fx);
  const calendar = new FakeAdmissionCalendar();
  const reminderTasks = new InMemoryAdmissionReminderTasks();
  const store = new InMemoryAdmissionStore();
  const whatsapp = new RecordingAdmissionWhatsApp();
  const logs = capturingLogger();
  const resolver = { resolve: jest.fn(async () => ({ send: { to: '+5491100000000', contentSid: 'HX', vars: { 1: 'Carla' } } })) };
  const messaging = new AdmissionMessagingService(store, store, whatsapp, resolver, logs.log, () => NOW);
  const panel = new AdmissionPanelService({
    db,
    calendar,
    reminderTasks,
    events: store,
    messaging,
    hosts: { listActiveByCountry: async () => [{ email: 'ana@example.test', displayName: 'Ana' }] },
    tactiq: { statesFor: async (emails: string[]) => new Map(emails.map((e) => [e.toLowerCase(), 'linked' as const])) },
    impersonateEmail: 'enlite@enlite.health',
    log: logs.log,
    now: () => NOW,
  });
  return { panel, calls, calendar, reminderTasks, store, whatsapp, logs, messaging };
}

describe('AdmissionPanelService.cancel', () => {
  beforeEach(() => { process.env.ADMISSION_CALENDAR_ID_AR = 'cal-ar@example.test'; });
  afterEach(() => { delete process.env.ADMISSION_CALENDAR_ID_AR; });

  const row = { country: 'AR', calendar_event_id: 'evt-1', reminder_task_name: TASK };

  it('A3-4: cancela com UPDATE atômico (WHERE status=booked), apaga a TASK pelo nome guardado e o EVENTO no Google', async () => {
    const { panel, calls, reminderTasks, calendar, store } = build({ cancelRow: row });
    const out = await panel.cancel({ patientId: PATIENT, appointmentId: APPT, actorUid: 'staff-1' });

    expect(out).toEqual({ appointmentId: APPT, status: 'cancelled', calendarEventDeleted: true, reminderTaskDeleted: true });
    const update = calls.find((c) => c.sql.includes('UPDATE admission_appointments'))!;
    expect(update.sql).toContain(`status = 'booked'`);
    expect(update.params).toEqual([APPT, PATIENT, 'staff-1']);
    expect(reminderTasks.cancelled).toEqual([TASK]);
    expect(calendar.deleted).toEqual([{ calendarId: 'cal-ar@example.test', eventId: 'evt-1' }]);
    expect(store.events.map((e) => e.kind)).toContain('cancelled');
  });

  it('mensagens ainda pendentes (claimed) viram cancelled', async () => {
    const { panel, calls } = build({ cancelRow: row });
    await panel.cancel({ patientId: PATIENT, appointmentId: APPT, actorUid: 'staff-1' });
    const upd = calls.find((c) => c.sql.includes('UPDATE admission_messages'))!;
    expect(upd.sql).toContain(`status = 'cancelled'`);
    expect(upd.sql).toContain(`status = 'claimed'`);
    expect(upd.params).toEqual([APPT]);
  });

  it('segundo cancelamento (já cancelled) → AppointmentNotCancellableError e NENHUM efeito externo', async () => {
    const { panel, reminderTasks, calendar } = build({ cancelRow: null, currentStatus: 'cancelled' });
    await expect(panel.cancel({ patientId: PATIENT, appointmentId: APPT, actorUid: 's' })).rejects.toBeInstanceOf(AppointmentNotCancellableError);
    expect(reminderTasks.cancelled).toHaveLength(0);
    expect(calendar.deleted).toHaveLength(0);
  });

  it('reunião inexistente ou de OUTRO paciente → AppointmentNotFoundError', async () => {
    const { panel } = build({ cancelRow: null, currentStatus: null });
    await expect(panel.cancel({ patientId: PATIENT, appointmentId: APPT, actorUid: 's' })).rejects.toBeInstanceOf(AppointmentNotFoundError);
  });

  it('falha do Google NÃO desfaz o cancelamento: flag false, linha cancel_calendar_failed na trilha, log de erro sem o texto do erro', async () => {
    const { panel, calendar, store, logs } = build({ cancelRow: row });
    calendar.deleteEvent = async () => { throw new Error('google 500 para carla@example.test'); };
    const out = await panel.cancel({ patientId: PATIENT, appointmentId: APPT, actorUid: 's' });

    expect(out.calendarEventDeleted).toBe(false);
    expect(store.events.map((e) => e.kind)).toEqual(expect.arrayContaining(['cancelled', 'cancel_calendar_failed']));
    expect(logs.output()).toContain('admission.cancel.calendar_event_failed');
    expect(logs.output()).not.toContain('carla@example.test');
  });

  it('falha ao apagar a task vira cancel_reminder_task_failed e o evento ainda é apagado', async () => {
    const { panel, reminderTasks, calendar, store } = build({ cancelRow: row });
    reminderTasks.cancel = async () => { throw new Error('boom'); };
    const out = await panel.cancel({ patientId: PATIENT, appointmentId: APPT, actorUid: 's' });
    expect(out).toMatchObject({ reminderTaskDeleted: false, calendarEventDeleted: true });
    expect(store.events.map((e) => e.kind)).toContain('cancel_reminder_task_failed');
    expect(calendar.deleted).toHaveLength(1);
  });

  it('sem task e sem evento guardados → nada a apagar (null, não false)', async () => {
    const { panel, reminderTasks, calendar } = build({ cancelRow: { country: 'AR', calendar_event_id: null, reminder_task_name: null } });
    const out = await panel.cancel({ patientId: PATIENT, appointmentId: APPT, actorUid: 's' });
    expect(out).toMatchObject({ calendarEventDeleted: null, reminderTaskDeleted: null });
    expect(reminderTasks.cancelled).toHaveLength(0);
    expect(calendar.deleted).toHaveLength(0);
  });
});

describe('AdmissionPanelService.resend — os dois tipos de perdedor viram erro de domínio (409 na rota)', () => {
  async function seedFailed(b: ReturnType<typeof build>, status: 'send_failed' | 'delivered' = 'send_failed', attempt = 0) {
    b.store.appointments.set(APPT, { slotStart: new Date('2026-10-12T12:00:00Z'), status: 'booked' });
    const id = (await b.store.claim({ appointmentId: APPT, kind: 'confirmation', attempt }))!;
    await b.store.setStatus(id, status);
  }

  it('mensagem entregue → ResendNotAllowed (exceção do núcleo)', async () => {
    const b = build();
    await seedFailed(b, 'delivered');
    await expect(b.panel.resend({ patientId: PATIENT, appointmentId: APPT, kind: 'confirmation', actorUid: 's' })).rejects.toBeInstanceOf(ResendNotAllowed);
    expect(b.whatsapp.calls).toHaveLength(0);
  });

  it('3º reenvio → ResendLimitReached', async () => {
    const b = build();
    await seedFailed(b, 'send_failed', 2);
    await expect(b.panel.resend({ patientId: PATIENT, appointmentId: APPT, kind: 'confirmation', actorUid: 's' })).rejects.toBeInstanceOf(ResendLimitReached);
  });

  it('retorno `duplicate_blocked` SEM exceção (perdeu o claim da tentativa) → ResendInProgressError, 0 envios', async () => {
    const b = build();
    await seedFailed(b);
    // A corrida: este clique leu a tentativa 0 (falhou) ANTES de o outro clique tomar o claim da tentativa 1.
    const attempt0 = await b.store.listAttempts(APPT, 'confirmation');
    await b.store.claim({ appointmentId: APPT, kind: 'confirmation', attempt: 1 });
    b.store.listAttempts = async () => attempt0;
    await expect(b.panel.resend({ patientId: PATIENT, appointmentId: APPT, kind: 'confirmation', actorUid: 's' })).rejects.toBeInstanceOf(ResendInProgressError);
    expect(b.whatsapp.calls).toHaveLength(0);
  });

  it('reenvio válido → outcome sent, 1 envio, claim da tentativa 1 com o ator', async () => {
    const b = build();
    await seedFailed(b);
    const out = await b.panel.resend({ patientId: PATIENT, appointmentId: APPT, kind: 'confirmation', actorUid: 'staff-9' });
    expect(out).toEqual({ outcome: 'sent' });
    expect(b.whatsapp.calls).toHaveLength(1);
    expect(b.store.events.find((e) => e.kind === 'resend_requested')?.ref).toMatchObject({ requestedByUid: 'staff-9', attempt: 1 });
  });

  it('falha de envio no reenvio NÃO é erro de HTTP: volta outcome send_failed (a tentativa foi gasta)', async () => {
    const b = build();
    await seedFailed(b);
    b.whatsapp.failWith = 'twilio down';
    await expect(b.panel.resend({ patientId: PATIENT, appointmentId: APPT, kind: 'confirmation', actorUid: 's' })).resolves.toEqual({ outcome: 'send_failed' });
  });

  it('reunião de outro paciente → AppointmentNotFoundError, sem tocar na mensageria', async () => {
    const b = build({ ownsAppointment: false });
    await expect(b.panel.resend({ patientId: PATIENT, appointmentId: APPT, kind: 'confirmation', actorUid: 's' })).rejects.toBeInstanceOf(AppointmentNotFoundError);
    expect(b.whatsapp.calls).toHaveLength(0);
  });
});

describe('AdmissionPanelService.list', () => {
  const apptRow = (over: Record<string, unknown> = {}) => ({
    id: APPT, admission_code: 'ADM-ABC234', created_via: 'panel', country: 'AR', host_email: 'ana@example.test',
    slot_start: new Date('2026-10-11T12:00:00Z'), slot_end: new Date('2026-10-11T12:45:00Z'), status: 'booked',
    meet_link: 'https://meet.google.com/abc', reminder_task_name: TASK, import_status: null, document_id: null, ...over,
  });

  it('paciente inexistente/de outro país → PatientNotFoundError', async () => {
    const { panel } = build({ patientExists: false });
    await expect(panel.list(PATIENT)).rejects.toBeInstanceOf(PatientNotFoundError);
  });

  it('monta os 4 selos; Meet só se ativa e futura', async () => {
    const { panel } = build({
      apptRows: [apptRow(), apptRow({ id: 'p', status: 'cancelled' }), apptRow({ id: 'q', slot_end: new Date('2026-10-09T12:45:00Z'), slot_start: new Date('2026-10-09T12:00:00Z') })],
      msgRows: [{ appointment_id: APPT, kind: 'confirmation', attempt: 0, status: 'send_failed' }],
    });
    const [a, b, c] = await panel.list(PATIENT);
    expect(a.seals.confirmation).toEqual({ seal: 'failed', attempt: 0, canResend: true });
    expect(a.seals.reminder.seal).toBe('scheduled');
    expect(a.seals).toMatchObject({ import: null, document: null });
    expect(a.meetLink).toBe('https://meet.google.com/abc');
    expect(b.meetLink).toBeNull();
    expect(c.meetLink).toBeNull();
    expect(JSON.stringify(a)).not.toMatch(/phone|telefone|\+549/);
  });

  it('sem reuniões → lista vazia (e não consulta mensagens)', async () => {
    const { panel, calls } = build({ apptRows: [] });
    expect(await panel.list(PATIENT)).toEqual([]);
    expect(calls.some((c) => c.sql.includes('FROM admission_messages'))).toBe(false);
  });

  it('documento ligado à reunião aparece no selo Documento', async () => {
    const { panel } = build({ apptRows: [apptRow({ document_id: 'doc-1', import_status: 'done' })] });
    const [a] = await panel.list(PATIENT);
    expect(a.seals.document).toEqual({ id: 'doc-1' });
    expect(a.seals.import).toBe('done');
  });
});
