/**
 * admission-050-is-test.e2e.test.ts — spec 050, F2: paciente `is_test` NUNCA chega ao caminho pago, por regra do SERVIDOR (R-18),
 * e toda chamada paga deixa rastro contável (R-20). POSTGRES REAL; as fronteiras de terceiros são dublês que CONTAM chamadas
 * (Meet, Tactiq, cofre, Vertex, Twilio). Nada toca Google, Twilio, Tactiq, Vertex nem bucket. Dados SINTÉTICOS (@example.test).
 *
 * Cada cenário roda o MESMO fluxo para `is_test` e para paciente real: o zero só vale com o controle positivo (o real chama
 * TODAS as portas). As chamadas são contadas POR REUNIÃO (código do Meet, código ADM, nome do objeto): outra linha no banco
 * não infla nem esvazia a conta.
 *
 * A2-1 0 chamadas em cada porta (+ controle positivo) · A2-2 1 `skipped_test` por etapa, 0 na real · A2-3 log `admission.paid_call`
 * (Vertex e Twilio) com `realm`, ANTES da chamada, e 0 para `is_test`.
 */
import { Pool } from 'pg';
import { AdmissionPostCallJob } from '../../src/modules/matching/application/AdmissionPostCallJob';
import { AdmissionImportService } from '../../src/modules/matching/application/AdmissionImportService';
import { AdmissionMessagingService } from '../../src/modules/matching/application/AdmissionMessagingService';
import { AdmissionSummaryError } from '../../src/modules/matching/application/ports/AdmissionImportPorts';
import type { TactiqAccessResult, TactiqMeetingItem, TactiqTranscriptPage } from '../../src/modules/matching/application/ports/TactiqPorts';
import { AdmissionEventRepository } from '../../src/modules/matching/infrastructure/AdmissionEventRepository';
import { AdmissionImportRepository } from '../../src/modules/matching/infrastructure/AdmissionImportRepository';
import { AdmissionMessageContent } from '../../src/modules/matching/infrastructure/AdmissionMessageContent';
import { AdmissionMessageRepository } from '../../src/modules/matching/infrastructure/AdmissionMessageRepository';
import { AdmissionPostCallRepository } from '../../src/modules/matching/infrastructure/AdmissionPostCallRepository';
import { RealAdmissionNotifier } from '../../src/modules/matching/infrastructure/RealAdmissionNotifier';
import { FakeMeetConference } from '../../src/modules/matching/infrastructure/doubles/FakeMeetConference';
import { FakeTactiqMcp } from '../../src/modules/matching/infrastructure/doubles/FakeTactiq';
import { FakeAdmissionSummaryGenerator } from '../../src/modules/matching/infrastructure/doubles/FakeAdmissionSummaryGenerator';
import { InMemoryTranscriptVault } from '../../src/modules/matching/infrastructure/doubles/InMemoryTranscriptVault';
import { InMemoryAdmissionReminderTasks } from '../../src/modules/matching/infrastructure/doubles/InMemoryAdmissionReminderTasks';
import { RecordingAdmissionWhatsApp } from '../../src/modules/matching/infrastructure/doubles/RecordingAdmissionWhatsApp';
import { capturingLogger } from '../../src/modules/matching/infrastructure/doubles/admissionTestKit';
import type { StoreAdmissionSummaryDocument } from '../../src/modules/patient-documents/application/StoreAdmissionSummaryDocument';

const DATABASE_URL =
  process.env.TEST_DATABASE_URL ||
  process.env.DATABASE_URL ||
  'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';
const RUN = Date.now().toString(36);
const MIN = 60_000;
const PHONE = '+5491155550150';
const PAID_CALL = 'admission.paid_call';

/** Vertex que registra se o log `admission.paid_call` JÁ existia no instante da chamada (prova "antes"). */
class SpyVertex extends FakeAdmissionSummaryGenerator {
  logExistedAtCall: boolean[] = [];
  constructor(private readonly seen: () => boolean) {
    super();
  }
  async generate(input: { transcript: string; entrevistaId?: string; fecha?: string }) {
    this.logExistedAtCall.push(this.seen());
    return super.generate(input);
  }
}

/** Twilio que registra o mesmo e, se mandado, LANÇA (a chamada falha; o log já existe). */
class SpyWhatsApp extends RecordingAdmissionWhatsApp {
  logExistedAtCall: boolean[] = [];
  throwOnSend = false;
  constructor(private readonly seen: () => boolean) {
    super();
  }
  async sendWithContentSid(to: string, contentSid: string, vars: Record<string, string>) {
    this.logExistedAtCall.push(this.seen());
    if (this.throwOnSend) throw new Error('twilio-fora-do-ar');
    return super.sendWithContentSid(to, contentSid, vars);
  }
}

/** Letras para o código do Meet (`aaa-bbbb-ccc`), único por reunião. */
function meetCodeFor(n: number): string {
  const l = (k: number, len: number): string => {
    let x = k;
    let out = '';
    for (let i = 0; i < len; i += 1) {
      out += String.fromCharCode(97 + (x % 26));
      x = Math.floor(x / 26);
    }
    return out;
  };
  const base = parseInt(RUN.slice(-5), 36) + n * 7919;
  return `${l(base, 3)}-${l(base + 3, 4)}-${l(base + 11, 3)}`;
}

describe('paciente is_test fora do caminho pago + rastro contável (spec 050, F2)', () => {
  let admin: Pool;
  let pool: Pool;
  let clock = new Date();
  let seq = 0;
  const patientIds: string[] = [];
  const patient: { real: string; test: string } = { real: '', test: '' };

  const meet = new FakeMeetConference();
  const mcp = new FakeTactiqMcp();
  const vault = new InMemoryTranscriptVault();
  const logs = capturingLogger();
  const seenPaidCall = (): boolean => logs.output().includes(`"message":"${PAID_CALL}"`);
  const vertex = new SpyVertex(seenPaidCall);
  const tokenCalls: string[] = [];
  const tokens = {
    accessTokenFor: async (email: string): Promise<TactiqAccessResult> => {
      tokenCalls.push(email);
      return { ok: true, accessToken: `at-${email}` };
    },
    markBroken: async () => true,
    markWrongAccount: async () => true,
  };
  const documentsStub = {
    prepare: async () => ({
      commit: async () => ({ outcome: 'stored' as const, documentId: '00000000-0000-4000-8000-000000000050', sizeBytes: 1, sha256: 'x' }),
      discard: async () => undefined,
    }),
  } as unknown as StoreAdmissionSummaryDocument;

  let job: AdmissionPostCallJob;
  let importer: AdmissionImportService;
  let postCallRepo: AdmissionPostCallRepository;
  let importRepo: AdmissionImportRepository;

  interface Appt { id: string; code: string; host: string; meetCode: string; start: Date }

  async function appt(patientId: string, o: { endedMinAgo?: number | null } = {}): Promise<Appt> {
    seq += 1;
    const start = new Date(clock.getTime() - 120 * MIN);
    const end = new Date(start.getTime() + 30 * MIN);
    const host = `op${seq}.${RUN}@example.test`;
    const code = `ADM-${(RUN + String(seq).padStart(3, '0')).toUpperCase().slice(-6)}`;
    const meetCode = meetCodeFor(seq);
    const ended = o.endedMinAgo === undefined || o.endedMinAgo === null ? null : new Date(clock.getTime() - o.endedMinAgo * MIN);
    const { rows } = await admin.query(
      `INSERT INTO admission_appointments
         (patient_id, country, host_email, host_display_name, slot_start, slot_end, status, meet_link, admission_code,
          created_at, conference_ended_at, import_status)
       VALUES ($1,'AR',$2,'Operadora Sintetica',$3,$4,'booked',$5,$6,$7,$8,$9) RETURNING id`,
      [patientId, host, start, end, `https://meet.google.com/${meetCode}`, code, new Date(start.getTime() - 300 * MIN), ended, ended ? 'pending' : null],
    );
    return { id: rows[0].id as string, code, host, meetCode, start };
  }

  /** Conferência terminada para o código do Meet da reunião (a Meet API "enxerga" o fim). */
  function meetEnded(a: Appt): void {
    meet.setRecords(a.meetCode, [{ name: `conferenceRecords/${a.meetCode}`, startTime: new Date(a.start.getTime()), endTime: new Date(a.start.getTime() + 25 * MIN) }]);
  }

  /** O Tactiq "enxerga" a reunião do responsável (código exato, janela, 1 candidata) com transcrição SINTÉTICA. */
  function tactiqSees(a: Appt): void {
    const item: TactiqMeetingItem = { id: `tq-${a.code}`, title: `${a.code} Admisión`, createdAt: a.start.toISOString(), durationSeconds: 1800 };
    mcp.meetingsByToken.set(`at-${a.host}`, [item]);
    const texts = ['TEXTO-SINTETICO-UM', 'dois'];
    mcp.pagesByMeeting.set(item.id, [{
      page: 1, totalPages: 1, totalChars: texts.reduce((n, t) => n + t.length, 0), hasMore: false,
      entries: texts.map((t, j) => ({ text: t, speaker: 'Operadora', startSeconds: j * 10, endSeconds: j * 10 + 9 })),
    }]);
  }

  /** Chamadas por porta, SÓ desta reunião. */
  function paid(a: Appt) {
    return {
      meet: [...meet.resolveCalls, ...meet.listCalls].filter((c) => c.includes(a.meetCode)).length,
      tactiq: mcp.searchCalls.filter((c) => c.query === a.code).length + mcp.transcriptCalls.filter((c) => c.meetingId === `tq-${a.code}`).length + tokenCalls.filter((e) => e === a.host).length,
      vault: vault.putCalls.filter((o) => o.includes(a.id)).length,
      vertex: vertex.inputs.filter((i) => i.entrevistaId === a.code).length,
    };
  }

  const eventsOf = async (id: string, kind: string) =>
    (await admin.query(`SELECT reason, outcome, ref FROM admission_events WHERE appointment_id = $1 AND kind = $2 ORDER BY at`, [id, kind])).rows as Array<{ reason: string | null; outcome: string | null; ref: unknown }>;
  const paidLines = (): Array<{ provider: string; appointmentId: string; realm: string }> =>
    logs.output().split('\n').filter((l) => l.includes(`"message":"${PAID_CALL}"`)).map((l) => JSON.parse(l));
  const paidFor = (id: string) => paidLines().filter((l) => l.appointmentId === id);

  async function mkPatient(tag: string, isTest: boolean): Promise<string> {
    const { rows } = await admin.query(
      `INSERT INTO patients (clickup_task_id, first_name, last_name, country, is_test, has_consent, phone_whatsapp)
       VALUES ($1,'Carlota',$2,'AR',$3,true,$4) RETURNING id`,
      [`e2e-050-${tag}-${RUN}`, `Sintetica${RUN}`, isTest, PHONE],
    );
    patientIds.push(rows[0].id);
    return rows[0].id;
  }

  beforeAll(async () => {
    admin = new Pool({ connectionString: DATABASE_URL });
    pool = new Pool({ connectionString: DATABASE_URL, max: 4 });
    process.env.TWILIO_TEMPLATE_ADMISSION_CONFIRMATION_ES = 'HX_CONF_ES_E2E';
    process.env.TWILIO_TEMPLATE_ADMISSION_REMINDER_ES = 'HX_REM_ES_E2E';
    patient.real = await mkPatient('real', false);
    patient.test = await mkPatient('test', true);

    postCallRepo = new AdmissionPostCallRepository(pool);
    importRepo = new AdmissionImportRepository(pool);
    const events = new AdmissionEventRepository(pool);
    job = new AdmissionPostCallJob({ repo: postCallRepo, meet, events, db: pool, log: logs.log, now: () => clock });
    importer = new AdmissionImportService({
      repo: importRepo, events, tokens, mcp, vault, summary: vertex, documents: documentsStub, db: pool, log: logs.log, now: () => clock,
    });
  }, 60000);

  beforeEach(() => {
    clock = new Date();
    meet.reset();
    mcp.reset();
    vertex.reset();
    vertex.logExistedAtCall = [];
    tokenCalls.length = 0;
  });

  afterAll(async () => {
    await admin.query(`DELETE FROM patient_documents WHERE patient_id = ANY($1)`, [patientIds]).catch(() => undefined);
    await admin.query(`DELETE FROM admission_appointments WHERE patient_id = ANY($1)`, [patientIds]);
    await admin.query(`DELETE FROM patients WHERE id = ANY($1)`, [patientIds]);
    await pool.end();
    await admin.end();
  });

  it('0. sanidade: as duas filas enxergam a reunião ANTES de rodar (o zero abaixo não é "fila vazia")', async () => {
    const pc = await appt(patient.test);
    const im = await appt(patient.test, { endedMinAgo: 80 });
    expect(await postCallRepo.listCandidateIds(clock)).toContain(pc.id);
    expect(await importRepo.listDueIds(clock)).toContain(im.id);
  });

  // ── A2-1 ─────────────────────────────────────────────────────────────────────────────────────────
  describe('A2-1: pós-call e importação — is_test → 0 chamadas em CADA porta; o mesmo cenário sem is_test → ≥ 1 (controle positivo)', () => {
    it('is_test: 0 em Meet, Tactiq, cofre e Vertex', async () => {
      const pc = await appt(patient.test);
      const im = await appt(patient.test, { endedMinAgo: 80 });
      meetEnded(pc);
      tactiqSees(im);

      await job.runOnce(clock);
      await importer.runOnce(clock);

      expect(paid(pc)).toEqual({ meet: 0, tactiq: 0, vault: 0, vertex: 0 });
      expect(paid(im)).toEqual({ meet: 0, tactiq: 0, vault: 0, vertex: 0 });
      // o estado da reunião NÃO andou: o servidor não "fingiu" que importou
      const { rows } = await admin.query(`SELECT id, import_status, conference_ended_at FROM admission_appointments WHERE id = ANY($1)`, [[pc.id, im.id]]);
      expect(rows.find((r) => r.id === pc.id)).toMatchObject({ import_status: null, conference_ended_at: null });
      expect(rows.find((r) => r.id === im.id)).toMatchObject({ import_status: 'pending' });
    });

    it('CONTROLE POSITIVO — paciente real, mesmo cenário: ≥ 1 chamada em CADA porta', async () => {
      const pc = await appt(patient.real);
      const im = await appt(patient.real, { endedMinAgo: 80 });
      meetEnded(pc);
      tactiqSees(im);

      await job.runOnce(clock);
      await importer.runOnce(clock);

      expect(paid(pc).meet).toBeGreaterThanOrEqual(1);
      const p = paid(im);
      expect(p.tactiq).toBeGreaterThanOrEqual(1);
      expect(p.vault).toBeGreaterThanOrEqual(1);
      expect(p.vertex).toBeGreaterThanOrEqual(1);
      expect((await eventsOf(pc.id, 'conference_ended')).length).toBe(1);
      expect((await eventsOf(im.id, 'summary_saved')).length).toBe(1);
    });
  });

  // ── A2-2 ─────────────────────────────────────────────────────────────────────────────────────────
  describe('A2-2: job rodado várias vezes → exatamente 1 skipped_test por etapa; 0 na reunião real', () => {
    it('is_test: 1 `skipped_test` de pós-call e 1 de importação, e a reunião sai das duas filas', async () => {
      const pc = await appt(patient.test);
      const im = await appt(patient.test, { endedMinAgo: 80 });
      meetEnded(pc);
      tactiqSees(im);

      for (let i = 0; i < 4; i += 1) {
        await job.runOnce(clock);
        await importer.runOnce(clock);
      }
      // a importação chamada diretamente (sem passar pela fila) também não duplica o evento
      expect(await importer.importOne(im.id, clock)).toBe('skipped_test');
      expect(await importer.importOne(im.id, clock)).toBe('skipped_test');

      expect((await eventsOf(pc.id, 'skipped_test')).map((e) => e.reason)).toEqual(['post_call']);
      expect((await eventsOf(im.id, 'skipped_test')).map((e) => e.reason)).toEqual(['import']);
      expect(await postCallRepo.listCandidateIds(clock)).not.toContain(pc.id);
      expect(await importRepo.listDueIds(clock)).not.toContain(im.id);
      // nenhuma outra trilha foi gravada para a reunião de teste
      const total = await admin.query(`SELECT count(*)::int AS n FROM admission_events WHERE appointment_id = ANY($1)`, [[pc.id, im.id]]);
      expect(total.rows[0].n).toBe(2);
    });

    it('real: 0 `skipped_test`', async () => {
      const pc = await appt(patient.real);
      const im = await appt(patient.real, { endedMinAgo: 80 });
      meetEnded(pc);
      tactiqSees(im);
      for (let i = 0; i < 2; i += 1) {
        await job.runOnce(clock);
        await importer.runOnce(clock);
      }
      expect(await eventsOf(pc.id, 'skipped_test')).toEqual([]);
      expect(await eventsOf(im.id, 'skipped_test')).toEqual([]);
    });
  });

  // ── A2-3 ─────────────────────────────────────────────────────────────────────────────────────────
  describe('A2-3: `admission.paid_call` com provider, appointmentId e realm — ANTES da chamada; 0 para is_test', () => {
    async function book(patientId: string, wa: SpyWhatsApp) {
      const n = (await appt(patientId));
      const events = new AdmissionEventRepository(pool);
      const content = new AdmissionMessageContent(pool);
      const messaging = new AdmissionMessagingService(new AdmissionMessageRepository(pool), events, wa, content, logs.log);
      const notifier = new RealAdmissionNotifier(messaging, content, new InMemoryAdmissionReminderTasks(), events, pool, () => new Date(), logs.log);
      const notice = {
        appointmentId: n.id, patientId, country: 'AR' as const, hostEmail: n.host, hostDisplayName: 'Ana',
        slotStartISO: new Date(clock.getTime() + 48 * 60 * MIN).toISOString(), slotEndISO: new Date(clock.getTime() + 49 * 60 * MIN).toISOString(),
        meetLink: `https://meet.google.com/${n.meetCode}`,
      };
      return { a: n, notifier, notice };
    }

    it('real: Vertex e Twilio, ambos com realm=real e appointmentId; o log existe no instante da chamada', async () => {
      const im = await appt(patient.real, { endedMinAgo: 80 });
      tactiqSees(im);
      await importer.runOnce(clock);
      const wa = new SpyWhatsApp(seenPaidCall);
      const { a, notifier, notice } = await book(patient.real, wa);
      await notifier.onBooked(notice);

      const v = paidFor(im.id);
      expect(v).toEqual([expect.objectContaining({ provider: 'vertex', appointmentId: im.id, realm: 'real' })]);
      const t = paidFor(a.id);
      expect(t).toEqual([expect.objectContaining({ provider: 'twilio', appointmentId: a.id, realm: 'real' })]);
      expect(wa.calls).toHaveLength(1);
      expect(vertex.logExistedAtCall.every(Boolean)).toBe(true);
      expect(vertex.logExistedAtCall.length).toBeGreaterThanOrEqual(1);
      expect(wa.logExistedAtCall).toEqual([true]);
    });

    it('as chamadas FALHAM (Vertex e Twilio lançam) e o log existe do mesmo jeito', async () => {
      const im = await appt(patient.real, { endedMinAgo: 80 });
      tactiqSees(im);
      vertex.failWith = new AdmissionSummaryError('vertex_failed');
      await importer.runOnce(clock);
      const wa = new SpyWhatsApp(seenPaidCall);
      wa.throwOnSend = true;
      const { a, notifier, notice } = await book(patient.real, wa);
      await notifier.onBooked(notice);

      expect(vertex.logExistedAtCall.length).toBeGreaterThanOrEqual(1);
      expect(paidFor(im.id).map((l) => l.provider)).toEqual(['vertex']);
      expect(paidFor(a.id).map((l) => l.provider)).toEqual(['twilio']);
      expect((await eventsOf(im.id, 'summary_failed')).length).toBeGreaterThanOrEqual(1); // a chamada de fato falhou
      expect((await eventsOf(a.id, 'confirmation_failed')).length).toBe(1);
    });

    it('is_test: 0 `admission.paid_call` (nem Vertex, nem Twilio) e 0 chamadas', async () => {
      const im = await appt(patient.test, { endedMinAgo: 80 });
      tactiqSees(im);
      await importer.runOnce(clock);
      const wa = new SpyWhatsApp(seenPaidCall);
      const { a, notifier, notice } = await book(patient.test, wa);
      await notifier.onBooked(notice);

      expect(paidFor(im.id)).toEqual([]);
      expect(paidFor(a.id)).toEqual([]);
      expect(wa.calls).toHaveLength(0);
      expect(wa.logExistedAtCall).toEqual([]);
      expect(paid(im).vertex).toBe(0);
      // o WhatsApp de is_test segue `skipped_test` (não regrediu)
      const msg = await admin.query(`SELECT status FROM admission_messages WHERE appointment_id = $1`, [a.id]);
      expect(msg.rows).toEqual([{ status: 'skipped_test' }]);
    });

    it('o log não carrega telefone, nome, e-mail nem texto (só provider, appointmentId, realm)', async () => {
      const lines = logs.output().split('\n').filter((l) => l.includes(`"message":"${PAID_CALL}"`));
      expect(lines.length).toBeGreaterThanOrEqual(1);
      for (const l of lines) {
        expect(l).not.toContain(PHONE);
        expect(l).not.toContain('Carlota');
        expect(l).not.toContain('@example.test');
        expect(l).not.toContain('TEXTO-SINTETICO');
      }
    });
  });
});
