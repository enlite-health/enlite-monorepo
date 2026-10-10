/**
 * admission-050-ensaio.e2e.test.ts — spec 050, F3: "ensaio pago" = liberação por REUNIÃO, com prazo (R-19), e roteamento da
 * transcrição de ensaio para o BUCKET DE ENSAIO (R-29). POSTGRES REAL + HTTP real com o ENGINE DE PERMISSÃO LIGADO; o cofre e o
 * bucket de ensaio são o `GcsTranscriptVault` de verdade contra um EMULADOR (fake-gcs). As fronteiras de terceiros são dublês que
 * CONTAM chamadas (Meet, Tactiq, Vertex, Twilio, cofre). Nada toca Google, Twilio, Tactiq, Vertex nem bucket real. Dados SINTÉTICOS.
 *
 * Relógio injetado nos jobs (sem `sleep`): a liberação nasce com o relógio real (+48 h); "expirou" = o job roda com `clock + 49 h`.
 *
 * A3-1 célula: sem ela 403, com ela 201, e ela está NO CATÁLOGO (rota literal + `iam.permissions` + só o Master)
 * A3-2 liberada e vigente → o caminho roda (Meet, Tactiq, Vertex, 1 objeto no bucket de ENSAIO, 0 no cofre); expirada → 0 chamadas novas
 * A3-3 alcance: liberar A não libera B (nem do mesmo paciente) · A3-4 roteamento nos 3 sentidos + fail-closed
 * A3-5 409 paciente real / reunião cancelada / liberação vigente · 404 outro país · A3-6 trilha e `admission.paid_call realm=ensaio`
 */
import { Pool } from 'pg';
import { Storage } from '@google-cloud/storage';
import { AdmissionPostCallJob } from '../../src/modules/matching/application/AdmissionPostCallJob';
import { AdmissionImportService } from '../../src/modules/matching/application/AdmissionImportService';
import { AdmissionMessagingService } from '../../src/modules/matching/application/AdmissionMessagingService';
import { AdmissionReminderService } from '../../src/modules/matching/application/AdmissionReminderService';
import { AdmissionPanelService } from '../../src/modules/matching/application/AdmissionPanelService';
import { PatientNotFoundError } from '../../src/modules/matching/application/AdmissionSchedulingService';
import type { TactiqAccessResult, TactiqMeetingItem } from '../../src/modules/matching/application/ports/TactiqPorts';
import { AdmissionEventRepository } from '../../src/modules/matching/infrastructure/AdmissionEventRepository';
import { AdmissionImportRepository } from '../../src/modules/matching/infrastructure/AdmissionImportRepository';
import { AdmissionMessageContent } from '../../src/modules/matching/infrastructure/AdmissionMessageContent';
import { AdmissionMessageRepository } from '../../src/modules/matching/infrastructure/AdmissionMessageRepository';
import { AdmissionPostCallRepository } from '../../src/modules/matching/infrastructure/AdmissionPostCallRepository';
import { GcsTranscriptVault } from '../../src/modules/matching/infrastructure/GcsTranscriptVault';
import { FakeMeetConference } from '../../src/modules/matching/infrastructure/doubles/FakeMeetConference';
import { FakeTactiqMcp } from '../../src/modules/matching/infrastructure/doubles/FakeTactiq';
import { FakeAdmissionSummaryGenerator } from '../../src/modules/matching/infrastructure/doubles/FakeAdmissionSummaryGenerator';
import { FakeAdmissionCalendar } from '../../src/modules/matching/infrastructure/doubles/FakeAdmissionCalendar';
import { InMemoryAdmissionReminderTasks } from '../../src/modules/matching/infrastructure/doubles/InMemoryAdmissionReminderTasks';
import { RecordingAdmissionWhatsApp } from '../../src/modules/matching/infrastructure/doubles/RecordingAdmissionWhatsApp';
import { capturingLogger } from '../../src/modules/matching/infrastructure/doubles/admissionTestKit';
import type { StoreAdmissionSummaryDocument } from '../../src/modules/patient-documents/application/StoreAdmissionSummaryDocument';
import { TENANT_E2E, tokenMock, montarAppDeFamilia, limparIamFixtures, grupoComCelulas, type AppDeFamilia } from './helpers/permissionFamilyHarness';

const DATABASE_URL =
  process.env.TEST_DATABASE_URL ||
  process.env.DATABASE_URL ||
  'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';
const FAKE_GCS_URL = process.env.GCS_EMULATOR_HOST || 'http://localhost:54443';
const RUN = Date.now().toString(36);
const VAULT_BUCKET = `f050-cofre-${RUN}`;
const REHEARSAL_BUCKET = `f050-ensaio-${RUN}`;
const MIN = 60_000;
const HOUR = 60 * MIN;
const PHONE = '+5491155550151';
const PAID_CALL = 'admission.paid_call';
const MASTER_GROUP = 'a0000000-0000-0000-0000-000000000001';

const U = { master: 'adm050-master', agendadora: 'adm050-agendadora', semGrupo: 'adm050-sem-grupo' };
const GRUPOS = { master: 'Adm050 Master', agendadora: 'Adm050 Agendadora' };
const CELULAS_049: Array<[string, string]> = [
  ['patient_admission', 'read'], ['patient_admission', 'create'], ['patient_admission', 'update'], ['patient_admission', 'resend_message'],
];
const CELULA_ENSAIO: [string, string] = ['patient_admission', 'release_paid_rehearsal'];

/** Cofre real contra o emulador que CONTA os `putOnce` (a chamada, não só o objeto). */
class CountingVault extends GcsTranscriptVault {
  puts: string[] = [];
  async putOnce(objectName: string, body: Buffer, meta: { sha256: string }) {
    this.puts.push(objectName);
    return super.putOnce(objectName, body, meta);
  }
}

class SpyVertex extends FakeAdmissionSummaryGenerator {}

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
  const base = parseInt(RUN.slice(-5), 36) + n * 6151;
  return `${l(base, 3)}-${l(base + 5, 4)}-${l(base + 13, 3)}`;
}

describe('ensaio pago por reunião + roteamento ao bucket de ensaio (spec 050, F3)', () => {
  let admin: Pool;
  let pool: Pool;
  let app: AppDeFamilia;
  let clock = new Date();
  let seq = 0;
  const patientIds: string[] = [];
  const patient = { real: '', test: '', test2: '' };
  const envAnterior: Record<string, string | undefined> = {};
  const setEnv = (k: string, v: string | undefined): void => {
    if (!(k in envAnterior)) envAnterior[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  };

  const meet = new FakeMeetConference();
  const mcp = new FakeTactiqMcp();
  const logs = capturingLogger();
  const vertex = new SpyVertex();
  const whatsapp = new RecordingAdmissionWhatsApp();
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
      commit: async () => ({ outcome: 'stored' as const, documentId: '00000000-0000-4000-8000-000000000051', sizeBytes: 1, sha256: 'x' }),
      discard: async () => undefined,
    }),
  } as unknown as StoreAdmissionSummaryDocument;

  let storage: Storage;
  let vault: CountingVault;
  let rehearsalVault: CountingVault;
  let job: AdmissionPostCallJob;
  let importer: AdmissionImportService;
  let postCallRepo: AdmissionPostCallRepository;
  let importRepo: AdmissionImportRepository;
  let reminders: AdmissionReminderService;
  let panelEvents: AdmissionEventRepository;

  interface Appt { id: string; code: string; host: string; meetCode: string; start: Date }

  async function appt(patientId: string, o: { endedMinAgo?: number | null; status?: string; country?: string } = {}): Promise<Appt> {
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
       VALUES ($1,$10,$2,'Operadora Sintetica',$3,$4,$11,$5,$6,$7,$8,$9) RETURNING id`,
      [patientId, host, start, end, `https://meet.google.com/${meetCode}`, code, new Date(start.getTime() - 300 * MIN), ended, ended ? 'pending' : null, o.country ?? 'AR', o.status ?? 'booked'],
    );
    return { id: rows[0].id as string, code, host, meetCode, start };
  }

  function meetEnded(a: Appt): void {
    meet.setRecords(a.meetCode, [{ name: `conferenceRecords/${a.meetCode}`, startTime: new Date(a.start.getTime()), endTime: new Date(a.start.getTime() + 25 * MIN) }]);
  }

  function tactiqSees(a: Appt): void {
    const item: TactiqMeetingItem = { id: `tq-${a.code}`, title: `${a.code} Admisión`, createdAt: a.start.toISOString(), durationSeconds: 1800 };
    mcp.meetingsByToken.set(`at-${a.host}`, [item]);
    const texts = ['TEXTO-SINTETICO-UM', 'dois'];
    mcp.pagesByMeeting.set(item.id, [{
      page: 1, totalPages: 1, totalChars: texts.reduce((n, t) => n + t.length, 0), hasMore: false,
      entries: texts.map((t, j) => ({ text: t, speaker: 'Operadora', startSeconds: j * 10, endSeconds: j * 10 + 9 })),
    }]);
  }

  /** Chamadas por porta, SÓ desta reunião (cofre = os dois buckets juntos; objetos por bucket abaixo). */
  function paid(a: Appt) {
    return {
      meet: [...meet.resolveCalls, ...meet.listCalls].filter((c) => c.includes(a.meetCode)).length,
      tactiq: mcp.searchCalls.filter((c) => c.query === a.code).length + mcp.transcriptCalls.filter((c) => c.meetingId === `tq-${a.code}`).length + tokenCalls.filter((e) => e === a.host).length,
      vault: [...vault.puts, ...rehearsalVault.puts].filter((o) => o.includes(a.id)).length,
      vertex: vertex.inputs.filter((i) => i.entrevistaId === a.code).length,
    };
  }
  const ZERO = { meet: 0, tactiq: 0, vault: 0, vertex: 0 };
  const objectsIn = async (bucket: string, a: Appt) => (await storage.bucket(bucket).getFiles({ prefix: `AR/${a.id}/` }))[0].length;

  const eventsOf = async (id: string, kind: string) =>
    (await admin.query(`SELECT reason, outcome, ref FROM admission_events WHERE appointment_id = $1 AND kind = $2 ORDER BY at`, [id, kind])).rows as Array<{ reason: string | null; outcome: string | null; ref: Record<string, unknown> | null }>;
  const paidLines = (): Array<{ provider: string; appointmentId: string; realm: string }> =>
    logs.output().split('\n').filter((l) => l.includes(`"message":"${PAID_CALL}"`)).map((l) => JSON.parse(l));
  const paidFor = (id: string) => paidLines().filter((l) => l.appointmentId === id);

  async function mkPatient(tag: string, isTest: boolean, country = 'AR'): Promise<string> {
    const { rows } = await admin.query(
      `INSERT INTO patients (clickup_task_id, first_name, last_name, country, is_test, has_consent, phone_whatsapp)
       VALUES ($1,'Carlota',$2,$5,$3,true,$4) RETURNING id`,
      [`e2e-050f3-${tag}-${RUN}`, `Sintetica${RUN}`, isTest, PHONE, country],
    );
    patientIds.push(rows[0].id);
    return rows[0].id;
  }

  async function http(method: string, path: string, uid: string | null, body?: unknown) {
    const res = await fetch(`${app.url}${path}`, {
      method,
      headers: { ...(uid ? { Authorization: tokenMock(uid, 'admin', 'AR') } : {}), 'Content-Type': 'application/json' },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, any> };
  }
  const release = (patientId: string, a: Appt, uid = U.master) =>
    http('POST', `/api/admin/patients/${patientId}/admission-appointments/${a.id}/paid-rehearsal`, uid);

  async function createBucket(name: string): Promise<void> {
    const res = await fetch(`${FAKE_GCS_URL}/storage/v1/b?project=enlite-test`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }),
    });
    if (!res.ok && res.status !== 409) throw new Error(`fake-gcs: bucket ${name} -> ${res.status}`);
  }

  async function rodarJobs(at: Date = clock): Promise<void> {
    await job.runOnce(at);
    await importer.runOnce(at);
  }

  /** Reunião de teste com pós-call E importação pendentes, já enxergadas por Meet e Tactiq. */
  async function parDeTeste(patientId: string) {
    const pc = await appt(patientId);
    const im = await appt(patientId, { endedMinAgo: 80 });
    meetEnded(pc);
    tactiqSees(im);
    return { pc, im };
  }

  beforeAll(async () => {
    admin = new Pool({ connectionString: DATABASE_URL });
    pool = new Pool({ connectionString: DATABASE_URL, max: 4 });
    await limparIamFixtures(admin, { uids: Object.values(U), grupos: Object.values(GRUPOS) });

    setEnv('USE_MOCK_AUTH', 'true');
    setEnv('PERMISSION_ENGINE_ENABLED', 'true');
    setEnv('PERMISSION_ENFORCED_ROUTES', 'admin.patients');
    setEnv('PERMISSION_CACHE_TTL_MS', '0');
    setEnv('DATABASE_URL', DATABASE_URL);
    setEnv('TWILIO_TEMPLATE_ADMISSION_CONFIRMATION_ES', 'HX_CONF_ES_E2E');
    setEnv('TWILIO_TEMPLATE_ADMISSION_REMINDER_ES', 'HX_REM_ES_E2E');
    setEnv('TWILIO_STATUS_CALLBACK_URL', undefined);
    setEnv('GCS_EMULATOR_HOST', FAKE_GCS_URL);
    setEnv('ADMISSION_TRANSCRIPT_VAULT_BUCKET', VAULT_BUCKET);
    setEnv('ADMISSION_REHEARSAL_BUCKET', REHEARSAL_BUCKET);

    storage = new Storage({ apiEndpoint: FAKE_GCS_URL, projectId: 'enlite-test' });
    await createBucket(VAULT_BUCKET);
    await createBucket(REHEARSAL_BUCKET);
    const client = () => new Storage({ apiEndpoint: FAKE_GCS_URL, projectId: 'enlite-test' });
    vault = new CountingVault({ env: process.env, client: client() });
    rehearsalVault = new CountingVault({ env: process.env, client: client(), bucketEnv: 'ADMISSION_REHEARSAL_BUCKET' });

    await admin.query(
      `INSERT INTO users (firebase_uid, email, role, status, is_active, tenant_id) VALUES
         ($1,'adm050-master@e2e.local','admin','ACTIVE',true,$4),
         ($2,'adm050-agendadora@e2e.local','admin','ACTIVE',true,$4),
         ($3,'adm050-sem-grupo@e2e.local','admin','ACTIVE',true,$4)`,
      [U.master, U.agendadora, U.semGrupo, TENANT_E2E],
    );
    await grupoComCelulas(admin, { nome: GRUPOS.master, uid: U.master, celulas: [...CELULAS_049, CELULA_ENSAIO] });
    await grupoComCelulas(admin, { nome: GRUPOS.agendadora, uid: U.agendadora, celulas: CELULAS_049 });

    patient.real = await mkPatient('real', false);
    patient.test = await mkPatient('test', true);
    patient.test2 = await mkPatient('test2', true);

    postCallRepo = new AdmissionPostCallRepository(pool);
    importRepo = new AdmissionImportRepository(pool);
    panelEvents = new AdmissionEventRepository(pool);
    job = new AdmissionPostCallJob({ repo: postCallRepo, meet, events: panelEvents, db: pool, log: logs.log, now: () => clock });
    importer = new AdmissionImportService({
      repo: importRepo, events: panelEvents, tokens, mcp, vault, rehearsalVault, summary: vertex, documents: documentsStub, db: pool, log: logs.log, now: () => clock,
    });
    const content = new AdmissionMessageContent(pool, () => clock);
    const messaging = new AdmissionMessagingService(new AdmissionMessageRepository(pool), panelEvents, whatsapp, content, logs.log, () => clock);
    reminders = new AdmissionReminderService(messaging, content, pool, logs.log);

    app = await montarAppDeFamilia({
      enforcedRoutes: 'admin.patients',
      montarRotas: async ({ app: express, auth, permissions }) => {
        const { AdmissionSchedulingService } = await import('../../src/modules/matching/application/AdmissionSchedulingService');
        const { AdmissionPanelController } = await import('../../src/modules/matching/interfaces/controllers/AdmissionPanelController');
        const { createAdminAdmissionRoutes } = await import('../../src/modules/matching/interfaces/routes/adminAdmissionRoutes');
        const { RealAdmissionNotifier } = await import('../../src/modules/matching/infrastructure/RealAdmissionNotifier');
        const { interviewHostRepository } = await import('../../src/modules/matching/infrastructure/InterviewHostRepository');
        const { DatabaseConnection } = await import('@shared/database/DatabaseConnection');
        const dbPool = DatabaseConnection.getInstance().getPool();
        const tasks = new InMemoryAdmissionReminderTasks();
        const calendar = new FakeAdmissionCalendar();
        const notifier = new RealAdmissionNotifier(messaging, content, tasks, panelEvents, dbPool, () => new Date(), logs.log);
        const tactiq = { statesFor: async () => new Map() } as never;
        const scheduling = new AdmissionSchedulingService(calendar, notifier, { decrypt: async () => 'x@example.test' } as never, 'enlite@enlite.health', interviewHostRepository, tactiq);
        const panel = new AdmissionPanelService({
          db: dbPool, calendar, reminderTasks: tasks, events: panelEvents, messaging, hosts: interviewHostRepository, tactiq,
          impersonateEmail: 'enlite@enlite.health', log: logs.log,
        });
        express.use('/api/admin', createAdminAdmissionRoutes(auth, permissions, new AdmissionPanelController(scheduling, panel)));
      },
    });
  }, 90000);

  beforeEach(() => {
    clock = new Date();
    meet.reset();
    mcp.reset();
    vertex.reset();
    whatsapp.calls.length = 0;
    tokenCalls.length = 0;
    setEnv('ADMISSION_REHEARSAL_BUCKET', REHEARSAL_BUCKET);
  });

  afterAll(async () => {
    await app?.fechar();
    const { DatabaseConnection } = await import('@shared/database/DatabaseConnection');
    await DatabaseConnection.getInstance().close();
    await admin.query(`DELETE FROM admission_appointments WHERE patient_id = ANY($1)`, [patientIds]);
    await admin.query(`DELETE FROM patients WHERE id = ANY($1)`, [patientIds]);
    await limparIamFixtures(admin, { uids: Object.values(U), grupos: Object.values(GRUPOS) });
    await pool.end();
    await admin.end();
    for (const [k, v] of Object.entries(envAnterior)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('0. sanidade: as duas filas enxergam a reunião de teste e os dois buckets existem no emulador (o zero abaixo não é "fila vazia")', async () => {
    const { pc, im } = await parDeTeste(patient.test);
    expect(await postCallRepo.listCandidateIds(clock)).toContain(pc.id);
    expect(await importRepo.listDueIds(clock)).toContain(im.id);
    expect((await storage.bucket(VAULT_BUCKET).exists())[0]).toBe(true);
    expect((await storage.bucket(REHEARSAL_BUCKET).exists())[0]).toBe(true);
    expect(VAULT_BUCKET).not.toBe(REHEARSAL_BUCKET);
  });

  // ── A3-1 ─────────────────────────────────────────────────────────────────────────────────────────
  describe('A3-1: a célula — sem ela 403, com ela 201, e ela está NO CATÁLOGO', () => {
    it('catálogo: a rota declara a célula LITERAL, `iam.permissions` a tem (sem deprecated_at, descrição do código) e só o Acesso Master a recebeu', async () => {
      const { scanExpressRouter, declaredCells } = await import('@modules/identity/permissions');
      const routes = scanExpressRouter(app.servidor.listeners('request')[0] as never).filter((r) => r.path.includes('paid-rehearsal'));
      expect(routes).toHaveLength(1);
      expect(routes[0].cell).toMatchObject({ resource: 'patient_admission', action: 'release_paid_rehearsal' });
      expect(declaredCells(routes).map((c) => `${c.resource}:${c.action}`)).toEqual(['patient_admission:release_paid_rehearsal']);

      const cell = await admin.query(`SELECT id, deprecated_at, description FROM iam.permissions WHERE resource = 'patient_admission' AND action = 'release_paid_rehearsal'`);
      expect(cell.rows).toHaveLength(1);
      expect(cell.rows[0].deprecated_at).toBeNull();
      const { CELL_DESCRIPTION } = await import('@modules/identity/permissions/domain/PermissionCell');
      expect((CELL_DESCRIPTION as Record<string, string>)['patient_admission:release_paid_rehearsal']).toBeTruthy();

      const grupos = await admin.query(
        `SELECT g.id, g.name FROM iam.group_permissions gp JOIN iam.permission_groups g ON g.id = gp.group_id
          WHERE gp.permission_id = $1 AND g.name <> ALL($2)`,
        [cell.rows[0].id, Object.values(GRUPOS)],
      );
      expect(grupos.rows.map((r) => r.id)).toEqual([MASTER_GROUP]);
    });

    it('sem a célula (agendadora com as 4 da 049, e staff sem grupo) → 403 missing_cell e a trilha NÃO ganha liberação', async () => {
      const a = await appt(patient.test);
      for (const [uid, code] of [[U.agendadora, 'missing_cell'], [U.semGrupo, 'no_group']]) {
        const res = await release(patient.test, a, uid);
        expect(res.status).toBe(403);
        expect(res.body).toMatchObject({ code });
      }
      expect(await eventsOf(a.id, 'paid_rehearsal_released')).toEqual([]);
    });

    it('com a célula (Master) → 201 com o prazo de 48 h, e a trilha ganha UMA liberação', async () => {
      const a = await appt(patient.test);
      const antes = Date.now();
      const res = await release(patient.test, a);
      expect(res.status).toBe(201);
      expect(res.body.data.appointmentId).toBe(a.id);
      const prazo = new Date(res.body.data.expiresAt).getTime();
      expect(prazo).toBeGreaterThanOrEqual(antes + 48 * HOUR - 1000);
      expect(prazo).toBeLessThanOrEqual(Date.now() + 48 * HOUR + 1000);
      expect((await eventsOf(a.id, 'paid_rehearsal_released')).length).toBe(1);
    });
  });

  // ── A3-5 + A3-6 (trilha) ─────────────────────────────────────────────────────────────────────────
  describe('A3-5: os 409 e o 404', () => {
    it('paciente REAL → 409 PAID_REHEARSAL_NOT_ALLOWED e 0 eventos (não existe ensaio de paciente real)', async () => {
      const a = await appt(patient.real);
      const res = await release(patient.real, a);
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ code: 'PAID_REHEARSAL_NOT_ALLOWED' });
      expect(await eventsOf(a.id, 'paid_rehearsal_released')).toEqual([]);
      // e o paciente real segue `real` no caminho pago (controle: a trava não o atrapalha)
      const im = await appt(patient.real, { endedMinAgo: 80 });
      tactiqSees(im);
      await importer.runOnce(clock);
      expect(paid(im).vertex).toBeGreaterThanOrEqual(1);
    });

    it('reunião CANCELADA → 409 e 0 eventos', async () => {
      const a = await appt(patient.test, { status: 'cancelled' });
      const res = await release(patient.test, a);
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ code: 'PAID_REHEARSAL_NOT_ALLOWED' });
      expect(await eventsOf(a.id, 'paid_rehearsal_released')).toEqual([]);
    });

    it('segunda liberação com a primeira VIGENTE → 409 PAID_REHEARSAL_ALREADY_ACTIVE; a trilha segue com UMA e o prazo não se estende', async () => {
      const a = await appt(patient.test);
      const first = await release(patient.test, a);
      expect(first.status).toBe(201);
      const second = await release(patient.test, a);
      expect(second.status).toBe(409);
      expect(second.body).toMatchObject({ code: 'PAID_REHEARSAL_ALREADY_ACTIVE' });
      const ev = await eventsOf(a.id, 'paid_rehearsal_released');
      expect(ev).toHaveLength(1);
      expect(ev[0].ref?.expiresAt).toBe(first.body.data.expiresAt);
    });

    it('reunião inexistente, de OUTRO paciente, ou paciente inexistente → 404', async () => {
      const a = await appt(patient.test);
      const naoExiste = '00000000-0000-4000-8000-0000000000aa';
      expect((await http('POST', `/api/admin/patients/${patient.test}/admission-appointments/${naoExiste}/paid-rehearsal`, U.master)).status).toBe(404);
      expect((await http('POST', `/api/admin/patients/${patient.test2}/admission-appointments/${a.id}/paid-rehearsal`, U.master)).status).toBe(404);
      expect((await http('POST', `/api/admin/patients/${naoExiste}/admission-appointments/${a.id}/paid-rehearsal`, U.master)).status).toBe(404);
      expect(await eventsOf(a.id, 'paid_rehearsal_released')).toEqual([]);
    });

    it('paciente de OUTRO PAÍS → PatientNotFoundError (a classe que a rota mapeia a 404) pelo pool do runtime com a RLS de país; o mesmo país libera', async () => {
      const { createRlsAwarePool } = await import('@shared/database/rlsAwarePool');
      const { releaseDbSession } = await import('@shared/database/requestDbSession');
      const { loggingAls } = await import('@shared/logging');
      const RUNTIME_USER = `adm050_rt_${RUN}`;
      const SYSTEM_USER = `adm050_sys_${RUN}`;
      const PASSWORD = 'adm050_pw';
      for (const [user, grp] of [[RUNTIME_USER, 'app_runtime'], [SYSTEM_USER, 'app_system']]) {
        await admin.query(`CREATE ROLE ${user} LOGIN PASSWORD '${PASSWORD}'`);
        await admin.query(`GRANT ${grp} TO ${user}`);
      }
      const url = new URL(DATABASE_URL);
      url.username = RUNTIME_USER;
      url.password = PASSWORD;
      const runtimePool = new Pool({ connectionString: url.toString(), max: 2 });
      const prev = process.env.COUNTRY_RLS_ENABLED;
      process.env.COUNTRY_RLS_ENABLED = 'true';
      try {
        const br = await mkPatient('br', true, 'BR');
        const brAppt = await appt(br, { country: 'BR' });
        const ar = await appt(patient.test);
        const rls = createRlsAwarePool(runtimePool);
        const panel = new AdmissionPanelService({ db: rls, events: panelEvents, log: logs.log } as never);
        const comoRequest = async <T>(fn: () => Promise<T>): Promise<T> => {
          const session = { context: { kind: 'staff' as const, uid: U.master, country: 'AR' as const }, released: false };
          try {
            return await loggingAls.run({ traceId: 'adm050-pais', dbSession: session }, fn);
          } finally {
            await releaseDbSession(session);
          }
        };
        await expect(comoRequest(() => panel.releasePaidRehearsal({ patientId: br, appointmentId: brAppt.id, actorUid: U.master }))).rejects.toBeInstanceOf(PatientNotFoundError);
        expect(await eventsOf(brAppt.id, 'paid_rehearsal_released')).toEqual([]);
        const ok = await comoRequest(() => panel.releasePaidRehearsal({ patientId: patient.test, appointmentId: ar.id, actorUid: U.master }));
        expect(ok.appointmentId).toBe(ar.id);
        expect((await eventsOf(ar.id, 'paid_rehearsal_released')).length).toBe(1);
      } finally {
        if (prev === undefined) delete process.env.COUNTRY_RLS_ENABLED;
        else process.env.COUNTRY_RLS_ENABLED = prev;
        await runtimePool.end();
        for (const user of [RUNTIME_USER, SYSTEM_USER]) await admin.query(`DROP ROLE IF EXISTS ${user}`);
      }
    });
  });

  // ── A3-2 / A3-4 ──────────────────────────────────────────────────────────────────────────────────
  describe('A3-2: liberada e vigente → o caminho roda e a transcrição vai ao bucket de ENSAIO; expirada → 0 chamadas novas', () => {
    it('ciclo completo: skipped_test → liberação devolve à fila → ≥ 1 chamada em Meet, Tactiq e Vertex, 1 objeto no bucket de ensaio e 0 no cofre', async () => {
      const { pc, im } = await parDeTeste(patient.test);

      await rodarJobs();
      expect(paid(pc)).toEqual(ZERO);
      expect(paid(im)).toEqual(ZERO);
      expect((await eventsOf(pc.id, 'skipped_test')).length).toBe(1);
      expect((await eventsOf(im.id, 'skipped_test')).length).toBe(1);
      expect(await postCallRepo.listCandidateIds(clock)).not.toContain(pc.id);
      expect(await importRepo.listDueIds(clock)).not.toContain(im.id);

      expect((await release(patient.test, pc)).status).toBe(201);
      expect((await release(patient.test, im)).status).toBe(201);
      expect(await postCallRepo.listCandidateIds(clock)).toContain(pc.id);
      expect(await importRepo.listDueIds(clock)).toContain(im.id);

      await rodarJobs();
      expect(paid(pc).meet).toBeGreaterThanOrEqual(1);
      const p = paid(im);
      expect(p.tactiq).toBeGreaterThanOrEqual(1);
      expect(p.vertex).toBeGreaterThanOrEqual(1);
      expect(await objectsIn(REHEARSAL_BUCKET, im)).toBe(1);
      expect(await objectsIn(VAULT_BUCKET, im)).toBe(0);
      expect(rehearsalVault.puts.filter((o) => o.includes(im.id))).toHaveLength(1);
      expect(vault.puts.filter((o) => o.includes(im.id))).toHaveLength(0);
      expect((await eventsOf(im.id, 'summary_saved')).length).toBe(1);
      expect((await eventsOf(pc.id, 'conference_ended')).length).toBe(1);
    });

    it('expirada (relógio + 49 h, sem sleep) → 0 chamadas pagas novas, sai da fila de novo com UM `skipped_test` novo e sem laço', async () => {
      const { pc, im } = await parDeTeste(patient.test);
      await rodarJobs(); // skipped_test (antes da liberação)
      expect((await release(patient.test, pc)).status).toBe(201);
      expect((await release(patient.test, im)).status).toBe(201);

      const depois = new Date(clock.getTime() + 49 * HOUR);
      for (let i = 0; i < 4; i += 1) await rodarJobs(depois);

      expect(paid(pc)).toEqual(ZERO);
      expect(paid(im)).toEqual(ZERO);
      expect(await objectsIn(REHEARSAL_BUCKET, im)).toBe(0);
      expect((await eventsOf(pc.id, 'skipped_test')).length).toBe(2); // 1 antes da liberação + 1 da expiração
      expect((await eventsOf(im.id, 'skipped_test')).length).toBe(2);
      expect(await postCallRepo.listCandidateIds(depois)).not.toContain(pc.id);
      expect(await importRepo.listDueIds(depois)).not.toContain(im.id);
    });

    it('controle da expiração: a MESMA liberação, dentro das 48 h (relógio + 47 h) → o caminho roda', async () => {
      const { im } = await parDeTeste(patient.test);
      expect((await release(patient.test, im)).status).toBe(201);
      await importer.runOnce(new Date(clock.getTime() + 47 * HOUR));
      expect(paid(im).vertex).toBeGreaterThanOrEqual(1);
      expect(await objectsIn(REHEARSAL_BUCKET, im)).toBe(1);
    });
  });

  describe('A3-3: alcance — liberar A não libera B, nem do mesmo paciente', () => {
    it('A liberada roda; B (mesmo paciente) segue com 0 chamadas, em pós-call, importação e mensagem', async () => {
      const A = await parDeTeste(patient.test);
      const B = await parDeTeste(patient.test);
      expect((await release(patient.test, A.pc)).status).toBe(201);
      expect((await release(patient.test, A.im)).status).toBe(201);

      await rodarJobs();
      expect(paid(A.pc).meet).toBeGreaterThanOrEqual(1);
      expect(paid(A.im).vertex).toBeGreaterThanOrEqual(1);
      expect(paid(B.pc)).toEqual(ZERO);
      expect(paid(B.im)).toEqual(ZERO);
      expect(await objectsIn(REHEARSAL_BUCKET, B.im)).toBe(0);
      expect((await eventsOf(B.pc.id, 'skipped_test')).length).toBe(1);
      expect((await eventsOf(B.im.id, 'skipped_test')).length).toBe(1);
      expect(await eventsOf(B.im.id, 'paid_rehearsal_released')).toEqual([]);

      // o WhatsApp também: lembrete de A sai, o de B é `skipped_test` (0 chamadas à Twilio)
      const antes = whatsapp.calls.length;
      expect(await reminders.send30MinReminder(A.pc.id)).toMatchObject({ sent: true });
      expect(whatsapp.calls.length).toBe(antes + 1);
      expect(await reminders.send30MinReminder(B.pc.id)).toMatchObject({ sent: false });
      expect(whatsapp.calls.length).toBe(antes + 1);
    });
  });

  describe('A3-4: roteamento nos 3 sentidos (+ falha fechada)', () => {
    it('ensaio → bucket de ensaio (e nunca o cofre) · real → cofre (e nunca o de ensaio)', async () => {
      const ens = await appt(patient.test, { endedMinAgo: 80 });
      const real = await appt(patient.real, { endedMinAgo: 80 });
      tactiqSees(ens);
      tactiqSees(real);
      expect((await release(patient.test, ens)).status).toBe(201);

      await importer.runOnce(clock);

      expect(await objectsIn(REHEARSAL_BUCKET, ens)).toBe(1);
      expect(await objectsIn(VAULT_BUCKET, ens)).toBe(0);
      expect(await objectsIn(VAULT_BUCKET, real)).toBe(1); // controle positivo: o cofre recebe o REAL
      expect(await objectsIn(REHEARSAL_BUCKET, real)).toBe(0);
      expect(vault.puts.filter((o) => o.includes(ens.id))).toHaveLength(0);
      expect(rehearsalVault.puts.filter((o) => o.includes(real.id))).toHaveLength(0);
      // mesma cifra/“só cria”: o 2º putOnce do MESMO objeto no bucket de ensaio é recusado (412) e não muda nada
      const again = await rehearsalVault.putOnce(rehearsalVault.puts.find((o) => o.includes(ens.id)) as string, Buffer.from('outro'), { sha256: 'x' });
      expect(again).toEqual({ outcome: 'already_exists' });
    });

    it('ensaio com a env AUSENTE ou VAZIA → 0 chamadas pagas, 0 objetos em QUALQUER bucket e o motivo na trilha; com a env de volta, segue', async () => {
      for (const ausente of [undefined, '']) {
        const ens = await appt(patient.test, { endedMinAgo: 80 });
        tactiqSees(ens);
        expect((await release(patient.test, ens)).status).toBe(201);
        setEnv('ADMISSION_REHEARSAL_BUCKET', ausente);

        const out = await importer.importOne(ens.id, clock);
        await importer.importOne(ens.id, clock); // 2ª passada: o motivo entra UMA vez na trilha

        expect(out).toBe('blocked');
        expect(paid(ens)).toEqual(ZERO);
        expect(await objectsIn(VAULT_BUCKET, ens)).toBe(0);
        expect(await objectsIn(REHEARSAL_BUCKET, ens)).toBe(0);
        const blocked = await eventsOf(ens.id, 'import_blocked');
        expect(blocked.map((e) => e.reason)).toEqual(['rehearsal_bucket_missing']);
        expect((await eventsOf(ens.id, 'vault_write_failed'))).toEqual([]);

        setEnv('ADMISSION_REHEARSAL_BUCKET', REHEARSAL_BUCKET);
        expect(await importer.importOne(ens.id, clock)).toBe('done'); // recuperação: o bloqueio não é permanente
        expect(await objectsIn(REHEARSAL_BUCKET, ens)).toBe(1);
        expect(await objectsIn(VAULT_BUCKET, ens)).toBe(0);
      }
    });

    it('bucket de ensaio IGUAL ao cofre → falha fechada do mesmo jeito (ensaio nunca cai no cofre de 5 anos)', async () => {
      const ens = await appt(patient.test, { endedMinAgo: 80 });
      tactiqSees(ens);
      expect((await release(patient.test, ens)).status).toBe(201);
      setEnv('ADMISSION_REHEARSAL_BUCKET', VAULT_BUCKET);

      expect(await importer.importOne(ens.id, clock)).toBe('blocked');
      expect(paid(ens)).toEqual(ZERO);
      expect(await objectsIn(VAULT_BUCKET, ens)).toBe(0);
      expect((await eventsOf(ens.id, 'import_blocked')).map((e) => e.reason)).toEqual(['rehearsal_bucket_missing']);
    });

    it('a env ausente NÃO afeta a reunião REAL (controle: o cofre segue recebendo)', async () => {
      const real = await appt(patient.real, { endedMinAgo: 80 });
      tactiqSees(real);
      setEnv('ADMISSION_REHEARSAL_BUCKET', undefined);
      expect(await importer.importOne(real.id, clock)).toBe('done');
      expect(await objectsIn(VAULT_BUCKET, real)).toBe(1);
    });
  });

  // ── A3-6 ─────────────────────────────────────────────────────────────────────────────────────────
  describe('A3-6: trilha com o ator e `admission.paid_call` com realm=ensaio', () => {
    it('`paid_rehearsal_released` guarda quem liberou e até quando (só ids e carimbo — nada de PII)', async () => {
      const a = await appt(patient.test);
      const res = await release(patient.test, a);
      const ev = await eventsOf(a.id, 'paid_rehearsal_released');
      expect(ev).toHaveLength(1);
      expect(ev[0].outcome).toBe('released');
      expect(ev[0].ref).toEqual({ actorUid: U.master, expiresAt: res.body.data.expiresAt });
      expect(JSON.stringify(ev[0])).not.toContain(PHONE);
      expect(JSON.stringify(ev[0])).not.toContain('Carlota');
      const at = await admin.query(`SELECT at FROM admission_events WHERE appointment_id = $1 AND kind = 'paid_rehearsal_released'`, [a.id]);
      expect(Math.abs(new Date(at.rows[0].at).getTime() - Date.now())).toBeLessThan(60_000); // “quando” está na coluna `at`
    });

    it('Vertex e Twilio de uma reunião LIBERADA saem com realm=ensaio e appointmentId; de uma NÃO liberada, 0 linhas', async () => {
      const lib = await appt(patient.test, { endedMinAgo: 80 });
      const nao = await appt(patient.test, { endedMinAgo: 80 });
      tactiqSees(lib);
      tactiqSees(nao);
      expect((await release(patient.test, lib)).status).toBe(201);
      await importer.runOnce(clock);
      expect(await reminders.send30MinReminder(lib.id)).toMatchObject({ sent: true });
      expect(await reminders.send30MinReminder(nao.id)).toMatchObject({ sent: false });

      expect(paidFor(lib.id).map((l) => `${l.provider}:${l.realm}`).sort()).toEqual(['twilio:ensaio', 'vertex:ensaio']);
      expect(paidFor(nao.id)).toEqual([]);
      const lines = logs.output().split('\n').filter((l) => l.includes(`"message":"${PAID_CALL}"`));
      for (const l of lines) {
        expect(l).not.toContain(PHONE);
        expect(l).not.toContain('Carlota');
        expect(l).not.toContain('TEXTO-SINTETICO');
      }
    });

    it('lembrete com a liberação EXPIRADA → `skipped_test` e 0 chamadas à Twilio (o realm é resolvido na hora do envio)', async () => {
      const a = await appt(patient.test);
      expect((await release(patient.test, a)).status).toBe(201);
      const antes = whatsapp.calls.length;
      clock = new Date(Date.now() + 49 * HOUR);
      expect(await reminders.send30MinReminder(a.id)).toMatchObject({ sent: false });
      expect(whatsapp.calls.length).toBe(antes);
      const msg = await admin.query(`SELECT status FROM admission_messages WHERE appointment_id = $1`, [a.id]);
      expect(msg.rows).toEqual([{ status: 'skipped_test' }]);
      expect(paidFor(a.id)).toEqual([]);
    });
  });

  describe('WhatsApp no ensaio — o que o reenvio faz hoje (medido, sem estender)', () => {
    it('uma mensagem `skipped_test` NÃO é reenviável: a rota de reenvio responde 409 RESEND_NOT_ALLOWED', async () => {
      const a = await appt(patient.test);
      expect(await reminders.send30MinReminder(a.id)).toMatchObject({ sent: false }); // antes da liberação → skipped_test
      expect((await release(patient.test, a)).status).toBe(201);
      const before = whatsapp.calls.length;
      const res = await http('POST', `/api/admin/patients/${patient.test}/admission-appointments/${a.id}/messages/reminder_30min/resend`, U.master);
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ code: 'RESEND_NOT_ALLOWED' });
      expect(whatsapp.calls.length).toBe(before);
    });
  });

  it('fim: nenhum texto sintético da transcrição apareceu em log', () => {
    expect(logs.output()).not.toContain('TEXTO-SINTETICO');
  });
});
