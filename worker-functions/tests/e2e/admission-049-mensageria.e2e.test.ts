/**
 * admission-049-mensageria.e2e.test.ts — spec 049, F2: a mensageria de admissão contra POSTGRES REAL (migrations 503-507).
 * Só as fronteiras externas são dublês (Twilio, Cloud Tasks); o claim, a trilha append-only e o callback são os de produção.
 * Dados SINTÉTICOS (paciente `is_test` quando preciso, e-mails `@example.test`, telefone fictício). Nada toca canal real.
 *
 * A2-1 onBooked 2× → 1 envio · A2-2 lembrete 2× em paralelo (pools separados) → 1 envio · A2-3 task nomeada · A2-4 skips
 * A2-5 falha sem retry · A2-6 callback da Twilio via HTTP · A2-7 reenvio (2 cliques → 1, teto, entregue) · A2-8 log sem PII.
 */
import express from 'express';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import axios from 'axios';
import { Pool } from 'pg';
import { AdmissionMessagingService } from '../../src/modules/matching/application/AdmissionMessagingService';
import { AdmissionReminderService } from '../../src/modules/matching/application/AdmissionReminderService';
import { ResendLimitReached, ResendNotAllowed } from '../../src/modules/matching/application/AdmissionMessagingErrors';
import type { BookedAppointmentNotice } from '../../src/modules/matching/application/AdmissionNotifier';
import { AdmissionEventRepository } from '../../src/modules/matching/infrastructure/AdmissionEventRepository';
import { AdmissionMessageContent } from '../../src/modules/matching/infrastructure/AdmissionMessageContent';
import { AdmissionMessageRepository } from '../../src/modules/matching/infrastructure/AdmissionMessageRepository';
import { RealAdmissionNotifier, admissionReminderTaskId } from '../../src/modules/matching/infrastructure/RealAdmissionNotifier';
import { InMemoryAdmissionReminderTasks } from '../../src/modules/matching/infrastructure/doubles/InMemoryAdmissionReminderTasks';
import { RecordingAdmissionWhatsApp } from '../../src/modules/matching/infrastructure/doubles/RecordingAdmissionWhatsApp';
import { capturingLogger } from '../../src/modules/matching/infrastructure/doubles/admissionTestKit';
import { TwilioWebhookController } from '../../src/modules/notification/interfaces/controllers/TwilioWebhookController';

const DATABASE_URL =
  process.env.TEST_DATABASE_URL ||
  process.env.DATABASE_URL ||
  'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';
const PHONE = '+5491100000000';
const FIRST_NAME = 'Carla';

/** Um "processo" da API: pool próprio + serviços próprios (duas instâncias = duas conexões/transações reais). */
function node(whatsapp: RecordingAdmissionWhatsApp, tasks = new InMemoryAdmissionReminderTasks()) {
  const pool = new Pool({ connectionString: DATABASE_URL, max: 4 });
  const events = new AdmissionEventRepository(pool);
  const content = new AdmissionMessageContent(pool);
  const logs = capturingLogger();
  const messaging = new AdmissionMessagingService(new AdmissionMessageRepository(pool), events, whatsapp, content, logs.log);
  const notifier = new RealAdmissionNotifier(messaging, content, tasks, events, pool, () => new Date(), logs.log);
  const reminder = new AdmissionReminderService(messaging, content, pool, logs.log);
  return { pool, events, content, messaging, notifier, reminder, tasks, logs };
}

describe('mensageria de admissão — Postgres real (spec 049, F2)', () => {
  let admin: Pool;
  const patients: string[] = [];
  const nodes: ReturnType<typeof node>[] = [];
  let seq = 0;

  function mkNode(whatsapp: RecordingAdmissionWhatsApp, tasks?: InMemoryAdmissionReminderTasks) {
    const n = node(whatsapp, tasks);
    nodes.push(n);
    return n;
  }

  async function newPatient(o: { phone?: string | null; consent?: boolean; isTest?: boolean } = {}): Promise<string> {
    seq += 1;
    const { rows } = await admin.query(
      `INSERT INTO patients (clickup_task_id, first_name, last_name, country, is_test, phone_whatsapp, has_consent)
       VALUES ($1, $2, 'Sintetico', 'AR', $3, $4, $5) RETURNING id`,
      [`e2e-049-msg-${Date.now()}-${seq}`, FIRST_NAME, o.isTest ?? false, o.phone === undefined ? PHONE : o.phone, o.consent ?? true],
    );
    patients.push(rows[0].id);
    return rows[0].id;
  }

  async function newAppointment(patientId: string, status = 'booked', hoursAhead = 48): Promise<BookedAppointmentNotice> {
    seq += 1;
    const { rows } = await admin.query(
      `INSERT INTO admission_appointments (patient_id, country, host_email, host_display_name, slot_start, slot_end, meet_link, status)
       VALUES ($1, 'AR', $2, 'Ana', now() + ($3 || ' hours')::interval, now() + ($3 || ' hours')::interval + interval '45 minutes',
               'https://meet.google.com/abc-defg-hij', $4)
       RETURNING id, slot_start, slot_end`,
      [patientId, `host${Date.now()}${seq}@example.test`, String(hoursAhead), status],
    );
    const r = rows[0];
    return {
      appointmentId: r.id,
      patientId,
      country: 'AR',
      hostEmail: 'host@example.test',
      hostDisplayName: 'Ana',
      slotStartISO: new Date(r.slot_start).toISOString(),
      slotEndISO: new Date(r.slot_end).toISOString(),
      meetLink: 'https://meet.google.com/abc-defg-hij',
    };
  }

  const messagesOf = async (apptId: string) =>
    (await admin.query(`SELECT kind, attempt, status, twilio_sid FROM admission_messages WHERE appointment_id = $1 ORDER BY kind, attempt`, [apptId])).rows;
  const eventKinds = async (apptId: string) =>
    (await admin.query(`SELECT kind FROM admission_events WHERE appointment_id = $1 ORDER BY at, id`, [apptId])).rows.map((r) => r.kind as string);
  const count = (arr: string[], k: string) => arr.filter((x) => x === k).length;

  beforeAll(async () => {
    admin = new Pool({ connectionString: DATABASE_URL });
    process.env.TWILIO_TEMPLATE_ADMISSION_CONFIRMATION_ES = 'HX_CONF_ES_E2E';
    process.env.TWILIO_TEMPLATE_ADMISSION_REMINDER_ES = 'HX_REM_ES_E2E';
    delete process.env.TWILIO_STATUS_CALLBACK_URL;
    delete process.env.TWILIO_AUTH_TOKEN;
  });

  afterAll(async () => {
    for (const n of nodes) await n.pool.end();
    if (patients.length) {
      // A trilha só sai em cascata quando a reunião-mãe some; documento admission antes (FK RESTRICT).
      await admin.query(`DELETE FROM patient_documents WHERE patient_id = ANY($1)`, [patients]);
      await admin.query(`DELETE FROM admission_appointments WHERE patient_id = ANY($1)`, [patients]);
      await admin.query(`DELETE FROM patients WHERE id = ANY($1)`, [patients]);
    }
    await admin.end();
  });

  it('0. sanidade: as tabelas da F1 existem (o zero das provas abaixo não é banco sem migration)', async () => {
    const { rows } = await admin.query(`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_name IN ('admission_messages','admission_events')`);
    expect(rows[0].n).toBe(2);
  });

  it('A2-1: onBooked 2× com a mesma reunião → 1 envio; 1 confirmation_sent e 1 duplicate_blocked na trilha; 1 linha', async () => {
    const wa = new RecordingAdmissionWhatsApp();
    const n = mkNode(wa);
    const appt = await newAppointment(await newPatient());

    await n.notifier.onBooked(appt);
    await n.notifier.onBooked(appt);

    expect(wa.calls).toHaveLength(1);
    const rows = await messagesOf(appt.appointmentId);
    expect(rows.filter((r) => r.kind === 'confirmation')).toEqual([expect.objectContaining({ attempt: 0, status: 'sent', twilio_sid: expect.stringMatching(/^SMFAKE.*-1$/) })]);
    const kinds = await eventKinds(appt.appointmentId);
    expect(count(kinds, 'confirmation_sent')).toBe(1);
    expect(count(kinds, 'duplicate_blocked')).toBe(1);
    expect(kinds).toContain('reminder_scheduled');
    // task nomeada e persistida
    expect([...n.tasks.tasks.keys()]).toEqual([admissionReminderTaskId(appt.appointmentId)]);
    const { rows: ap } = await admin.query(`SELECT reminder_task_name FROM admission_appointments WHERE id = $1`, [appt.appointmentId]);
    expect(ap[0].reminder_task_name).toBe(admissionReminderTaskId(appt.appointmentId));
  });

  it('A2-1 (corrida): onBooked 2× em PARALELO por "processos" com pools separados → 1 envio', async () => {
    const wa = new RecordingAdmissionWhatsApp();
    const a = mkNode(wa);
    const b = mkNode(wa);
    const appt = await newAppointment(await newPatient());

    await Promise.all([a.notifier.onBooked(appt), b.notifier.onBooked(appt)]);

    expect(wa.calls).toHaveLength(1);
    expect((await messagesOf(appt.appointmentId)).filter((r) => r.kind === 'confirmation')).toHaveLength(1);
    expect(count(await eventKinds(appt.appointmentId), 'duplicate_blocked')).toBe(1);
  });

  it('A2-2: lembrete entregue 2× em PARALELO, duas conexões/pools reais → exatamente 1 envio', async () => {
    const wa = new RecordingAdmissionWhatsApp();
    const a = mkNode(wa);
    const b = mkNode(wa);
    const appt = await newAppointment(await newPatient());

    const results = await Promise.all([a.reminder.send30MinReminder(appt.appointmentId), b.reminder.send30MinReminder(appt.appointmentId)]);

    expect(wa.calls).toHaveLength(1);
    expect(wa.calls[0].contentSid).toBe('HX_REM_ES_E2E');
    expect(results.filter((r) => r.sent)).toHaveLength(1);
    expect(results.filter((r) => !r.sent).map((r) => r.reason)).toEqual(['already_sent']);
    expect((await messagesOf(appt.appointmentId)).filter((r) => r.kind === 'reminder_30min')).toEqual([expect.objectContaining({ attempt: 0, status: 'sent' })]);
    const kinds = await eventKinds(appt.appointmentId);
    expect(count(kinds, 'reminder_sent')).toBe(1);
    expect(count(kinds, 'duplicate_blocked')).toBe(1);

    // 3ª entrega tardia do Cloud Tasks (at-least-once, maxAttempts=100): continua 1
    await a.reminder.send30MinReminder(appt.appointmentId);
    expect(wa.calls).toHaveLength(1);
  });

  it('A2-3: duas onBooked com a task já criada → 1 task com o nome determinístico; a 2ª vira duplicate_blocked (task_already_exists)', async () => {
    const wa = new RecordingAdmissionWhatsApp();
    const tasks = new InMemoryAdmissionReminderTasks();
    const n = mkNode(wa, tasks);
    const appt = await newAppointment(await newPatient());
    await tasks.schedule({ taskId: admissionReminderTaskId(appt.appointmentId), appointmentId: appt.appointmentId, runAtISO: new Date().toISOString() });

    await n.notifier.onBooked(appt);

    expect(tasks.tasks.size).toBe(1);
    const { rows } = await admin.query(`SELECT reason FROM admission_events WHERE appointment_id = $1 AND kind = 'duplicate_blocked'`, [appt.appointmentId]);
    expect(rows).toEqual([{ reason: 'task_already_exists' }]);
  });

  describe('A2-4: paciente is_test / sem consentimento / sem telefone → 0 envios e 1 linha skipped_* com o motivo', () => {
    it.each([
      ['is_test', { isTest: true }, 'skipped_test'],
      ['sem consentimento', { consent: false }, 'skipped_no_consent'],
      ['sem telefone', { phone: null }, 'skipped_no_phone'],
    ])('%s', async (_l, patientOpts, expected) => {
      const wa = new RecordingAdmissionWhatsApp();
      const n = mkNode(wa);
      const appt = await newAppointment(await newPatient(patientOpts));

      await n.notifier.onBooked(appt);

      expect(wa.calls).toHaveLength(0);
      expect((await messagesOf(appt.appointmentId)).filter((r) => r.kind === 'confirmation')).toEqual([expect.objectContaining({ status: expected, twilio_sid: null })]);
      expect(count(await eventKinds(appt.appointmentId), expected)).toBe(1);
    });
  });

  it('A2-5: falha do sender → linha send_failed, 0 novas tentativas automáticas (nem numa 2ª onBooked)', async () => {
    const wa = new RecordingAdmissionWhatsApp();
    wa.failWith = `número inválido ${PHONE}`;
    const n = mkNode(wa);
    const appt = await newAppointment(await newPatient());

    await n.notifier.onBooked(appt);
    wa.failWith = null;
    await n.notifier.onBooked(appt);

    expect(wa.calls).toHaveLength(1);
    expect((await messagesOf(appt.appointmentId)).filter((r) => r.kind === 'confirmation')).toEqual([expect.objectContaining({ attempt: 0, status: 'send_failed' })]);
    const kinds = await eventKinds(appt.appointmentId);
    expect(count(kinds, 'confirmation_failed')).toBe(1);
    expect(count(kinds, 'duplicate_blocked')).toBe(1);
  });

  describe('A2-6: callback da Twilio (HTTP, assinatura desligada como no CI) atualiza a linha e a trilha', () => {
    let server: Server;
    let baseUrl: string;
    let wa: RecordingAdmissionWhatsApp;
    let n: ReturnType<typeof node>;

    beforeAll(async () => {
      wa = new RecordingAdmissionWhatsApp();
      n = mkNode(wa);
      const controller = new TwilioWebhookController(new AdmissionMessageRepository(n.pool), new AdmissionEventRepository(n.pool));
      const app = express();
      app.use(express.urlencoded({ extended: false }));
      app.post('/webhooks/twilio/status', (req, res) => void controller.handleStatusCallback(req, res));
      await new Promise<void>((resolve) => {
        server = app.listen(0, '127.0.0.1', resolve);
      });
      baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });
    afterAll(async () => {
      await new Promise((r) => server.close(r));
    });

    const callback = (sid: string, status: string, errorCode?: string) =>
      axios.post(`${baseUrl}/webhooks/twilio/status`, new URLSearchParams({ MessageSid: sid, MessageStatus: status, ...(errorCode ? { ErrorCode: errorCode } : {}) }).toString(), {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      });

    it('delivered → admission_messages.status=delivered + confirmation_delivered; callback atrasado não regride', async () => {
      const appt = await newAppointment(await newPatient());
      await n.notifier.onBooked(appt);
      const sid = (await messagesOf(appt.appointmentId)).find((r) => r.kind === 'confirmation')?.twilio_sid as string;
      expect(sid).toMatch(/^SMFAKE/);

      expect((await callback(sid, 'delivered')).status).toBe(200);
      expect((await messagesOf(appt.appointmentId)).find((r) => r.kind === 'confirmation')?.status).toBe('delivered');
      expect(await eventKinds(appt.appointmentId)).toContain('confirmation_delivered');

      await callback(sid, 'sent');
      await callback(sid, 'failed', '63024');
      expect((await messagesOf(appt.appointmentId)).find((r) => r.kind === 'confirmation')?.status).toBe('delivered');
      expect(count(await eventKinds(appt.appointmentId), 'confirmation_failed')).toBe(0);
    });

    it('undelivered com código → status undelivered + confirmation_failed com o errorCode (só id/código na ref)', async () => {
      const appt = await newAppointment(await newPatient());
      await n.notifier.onBooked(appt);
      const sid = (await messagesOf(appt.appointmentId)).find((r) => r.kind === 'confirmation')?.twilio_sid as string;

      expect((await callback(sid, 'undelivered', '63024')).status).toBe(200);

      expect((await messagesOf(appt.appointmentId)).find((r) => r.kind === 'confirmation')?.status).toBe('undelivered');
      const { rows } = await admin.query(`SELECT kind, reason, ref FROM admission_events WHERE appointment_id = $1 AND kind = 'confirmation_failed'`, [appt.appointmentId]);
      expect(rows).toHaveLength(1);
      expect(rows[0].reason).toBe('twilio_undelivered');
      expect(rows[0].ref).toMatchObject({ twilioSid: sid, errorCode: '63024', kind: 'confirmation', attempt: 0 });
      expect(JSON.stringify(rows[0].ref)).not.toContain(PHONE);
    });

    it('SID que não é de admissão → 200 e nenhuma linha/evento tocado', async () => {
      const before = (await admin.query(`SELECT count(*)::int AS n FROM admission_events`)).rows[0].n;
      expect((await callback('SM-DE-WORKER-XYZ', 'delivered')).status).toBe(200);
      expect((await admin.query(`SELECT count(*)::int AS n FROM admission_events`)).rows[0].n).toBe(before);
    });
  });

  describe('A2-7: reenvio humano (domínio; a rota HTTP/409 é da F3)', () => {
    it('2 cliques SIMULTÂNEOS em reenviar (2 pools) → exatamente 1 envio; 3º reenvio → ResendLimitReached', async () => {
      const wa = new RecordingAdmissionWhatsApp();
      const a = mkNode(wa);
      const b = mkNode(wa);
      const appt = await newAppointment(await newPatient());
      wa.failWith = 'canal fora';
      await a.notifier.onBooked(appt); // attempt 0 → send_failed
      wa.failWith = null;
      const base = wa.calls.length;

      // Os dois cliques LEEM "falhou, pode reenviar" antes de qualquer um enviar (barreira em `listAttempts`): quem decide é o
      // CLAIM no banco, não a leitura de status. O perdedor volta `duplicate_blocked`.
      let arrived = 0;
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      class BarrierRepo extends AdmissionMessageRepository {
        async listAttempts(...args: Parameters<AdmissionMessageRepository['listAttempts']>) {
          const rows = await super.listAttempts(...args);
          arrived += 1;
          if (arrived === 2) release();
          await gate;
          return rows;
        }
      }
      const clicker = (n: ReturnType<typeof node>) =>
        new AdmissionMessagingService(new BarrierRepo(n.pool), n.events, wa, n.content, n.logs.log);
      const results = await Promise.all([
        clicker(a).requestResend(appt.appointmentId, 'confirmation', 'uid-a'),
        clicker(b).requestResend(appt.appointmentId, 'confirmation', 'uid-b'),
      ]);
      expect(results.map((r) => r.outcome).sort()).toEqual(['duplicate_blocked', 'sent']);
      expect(wa.calls.length - base).toBe(1);
      const attempts = (await messagesOf(appt.appointmentId)).filter((r) => r.kind === 'confirmation');
      expect(attempts.map((r) => [r.attempt, r.status])).toEqual([[0, 'send_failed'], [1, 'sent']]);

      // o reenvio 1 falha no callback → 2º reenvio permitido → falha → 3º pedido bate no teto
      const sid1 = attempts[1].twilio_sid as string;
      await new AdmissionMessageRepository(a.pool).applyDeliveryStatus(sid1, 'undelivered');
      wa.failWith = 'canal fora';
      expect((await a.messaging.requestResend(appt.appointmentId, 'confirmation', 'uid-a')).outcome).toBe('send_failed'); // attempt 2
      wa.failWith = null;
      await expect(a.messaging.requestResend(appt.appointmentId, 'confirmation', 'uid-a')).rejects.toBeInstanceOf(ResendLimitReached);
      expect((await messagesOf(appt.appointmentId)).filter((r) => r.kind === 'confirmation')).toHaveLength(3);
    });

    it('mensagem entregue → ResendNotAllowed, 0 envios', async () => {
      const wa = new RecordingAdmissionWhatsApp();
      const n = mkNode(wa);
      const appt = await newAppointment(await newPatient());
      await n.notifier.onBooked(appt);
      const sid = (await messagesOf(appt.appointmentId)).find((r) => r.kind === 'confirmation')?.twilio_sid as string;
      await new AdmissionMessageRepository(n.pool).applyDeliveryStatus(sid, 'delivered');
      const before = wa.calls.length;

      await expect(n.messaging.requestResend(appt.appointmentId, 'confirmation', 'uid')).rejects.toBeInstanceOf(ResendNotAllowed);
      expect(wa.calls.length).toBe(before);
    });
  });

  it('A2-8: a saída do logger de uma rodada completa (confirmação + lembrete + skip + falha) não contém telefone nem nome', async () => {
    const wa = new RecordingAdmissionWhatsApp();
    const n = mkNode(wa);
    const ok = await newAppointment(await newPatient());
    const skip = await newAppointment(await newPatient({ consent: false }));
    const fail = await newAppointment(await newPatient());

    await n.notifier.onBooked(ok);
    await n.reminder.send30MinReminder(ok.appointmentId);
    await n.notifier.onBooked(skip);
    wa.failWith = `número inválido ${PHONE} de ${FIRST_NAME}`;
    await n.notifier.onBooked(fail);

    const out = n.logs.output();
    expect(out).toContain('admission.confirmation_sent');
    expect(out).toContain('admission.reminder_sent');
    expect(out).toContain('admission.skipped_no_consent');
    expect(out).toContain('admission.confirmation_failed');
    expect(out).not.toContain(PHONE);
    expect(out).not.toContain(FIRST_NAME);
    expect(out).not.toContain('example.test');
    // e a trilha também só guarda ids
    const { rows } = await admin.query(`SELECT ref::text AS r, reason FROM admission_events WHERE appointment_id = ANY($1)`, [[ok.appointmentId, skip.appointmentId, fail.appointmentId]]);
    expect(JSON.stringify(rows)).not.toContain(PHONE);
    expect(JSON.stringify(rows)).not.toContain(FIRST_NAME);
  });
});
