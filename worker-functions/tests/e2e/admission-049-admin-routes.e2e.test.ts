/**
 * admission-049-admin-routes.e2e.test.ts — spec 049, F3: as rotas ADMIN da aba Admissão contra POSTGRES REAL, HTTP real,
 * com o ENGINE DE PERMISSÃO LIGADO (PermissionMiddleware de produção + tabelas iam.* reais).
 *
 * Só as fronteiras externas são dublês (Google Calendar, Cloud Tasks, Twilio) — injetadas nos MESMOS serviços que o
 * `index.ts` monta. Nada toca canal real. Dados SINTÉTICOS (e-mails @example.test, telefone fictício).
 *
 * Bloco 1 (sempre roda, é o que o CI executa): A3-2 a A3-7 e A3-9 + a varredura de rota (as 3 células estão LITERAIS na rota)
 *   + A4-3 (F4): a TRAVA do vínculo do Tactiq no servidor — responsável missing/broken/wrong_account → 409, linked → 201.
 * Bloco 2 (só com a stack de engine ligado — `E2E_ABAC_STACK=1`, API em container com ADMISSION_EXTERNALS=fake,
 *   PERMISSION_ENGINE_ENABLED, PERMISSION_CATALOG_SYNC_ENABLED): A3-8 (catálogo SINCRONIZADO no boot, `deprecated_at IS NULL`)
 *   e 403 sem a célula / 201 com ela pelo `index.ts` de verdade.
 */
import { Pool } from 'pg';
import { DateTime } from 'luxon';
import {
  TENANT_E2E,
  tokenMock,
  montarAppDeFamilia,
  limparIamFixtures,
  grupoComCelulas,
  type AppDeFamilia,
} from './helpers/permissionFamilyHarness';
import { FakeAdmissionCalendar } from '../../src/modules/matching/infrastructure/doubles/FakeAdmissionCalendar';
import { InMemoryAdmissionReminderTasks } from '../../src/modules/matching/infrastructure/doubles/InMemoryAdmissionReminderTasks';
import { RecordingAdmissionWhatsApp } from '../../src/modules/matching/infrastructure/doubles/RecordingAdmissionWhatsApp';
import { capturingLogger } from '../../src/modules/matching/infrastructure/doubles/admissionTestKit';
import { FakeTactiqMcp, FakeTactiqOAuth } from '../../src/modules/matching/infrastructure/doubles/FakeTactiq';
import { AdmissionMessageRepository } from '../../src/modules/matching/infrastructure/AdmissionMessageRepository';
import { admissionReminderTaskId } from '../../src/modules/matching/infrastructure/RealAdmissionNotifier';
import type { AdmissionMessageKind } from '../../src/modules/matching/application/ports/AdmissionMessagingPorts';

const DATABASE_URL =
  process.env.TEST_DATABASE_URL ||
  process.env.DATABASE_URL ||
  'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';
const API_URL = process.env.API_URL || 'http://localhost:8080';

const PHONE = '+5491100000000';
const FIRST_NAME = 'Carla';
const FAMILY_EMAIL = 'familia.e2e049@example.test';
const ANA = 'ana.e2e049@example.test';
const OCUPADA = 'ocupado.mari.e2e049@example.test';
const CAL_AR = 'cal-ar-e2e049@example.test';
// A4-3: responsáveis do roster em cada estado do vínculo do Tactiq (ANA e OCUPADA estão `linked`).
const SEM_VINCULO = 'sem.vinculo.e2e049@example.test';
const QUEBRADO = 'quebrado.e2e049@example.test';
const OUTRA_CONTA = 'outra.conta.e2e049@example.test';

const U = {
  chefe: 'adm049-chefe', // read + create + update + resend_message
  agendadora: 'adm049-agendadora', // read + create + update (agenda e cancela; sem resend_message)
  leitora: 'adm049-leitora', // read
  semGrupo: 'adm049-sem-grupo', // staff sem célula nenhuma
};
const GRUPOS = { chefe: 'Adm049 Chefe', agendadora: 'Adm049 Agendadora', leitora: 'Adm049 Leitora' };

/** Um repositório de mensagens que deixa o teste ENTRAR NO MEIO da corrida do reenvio (determinístico, sem sleep). */
class RacyMessageRepository extends AdmissionMessageRepository {
  afterListAttempts: (() => Promise<void>) | null = null;
  private barrier: { size: number; arrived: number; open: () => void; gate: Promise<void> } | null = null;

  /** Segura cada `listAttempts` até `size` requisições terem LIDO a tentativa anterior: as duas passam pela checagem e disputam o claim. */
  armBarrier(size: number): void {
    let open!: () => void;
    const gate = new Promise<void>((resolve) => { open = resolve; });
    this.barrier = { size, arrived: 0, open, gate };
  }

  async listAttempts(appointmentId: string, kind: AdmissionMessageKind) {
    const rows = await super.listAttempts(appointmentId, kind);
    const b = this.barrier;
    if (b) {
      b.arrived += 1;
      if (b.arrived >= b.size) b.open();
      await b.gate;
    }
    const hook = this.afterListAttempts;
    this.afterListAttempts = null;
    if (hook) await hook();
    return rows;
  }

  disarmBarrier(): void {
    this.barrier = null;
  }
}

describe('rotas admin da aba Admissão — HTTP real, banco real, engine LIGADO (spec 049, F3)', () => {
  let admin: Pool;
  let app: AppDeFamilia;
  let calendar: FakeAdmissionCalendar;
  let tasks: InMemoryAdmissionReminderTasks;
  let whatsapp: RecordingAdmissionWhatsApp;
  let racyStore: RacyMessageRepository;
  let reminderService: { send30MinReminder: (id: string) => Promise<{ sent: boolean; reason?: string }> };
  let logs: ReturnType<typeof capturingLogger>;
  let loggerSpies: jest.SpyInstance[] = [];
  const loggerCalls: string[] = [];
  const patients: string[] = [];
  let seq = 0;
  let dayOffset = 5 + Math.floor(Math.random() * 300);

  const envAnterior: Record<string, string | undefined> = {};
  function setEnv(k: string, v: string | undefined): void {
    if (!(k in envAnterior)) envAnterior[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }

  async function newPatient(): Promise<string> {
    seq += 1;
    const { rows } = await admin.query(
      `INSERT INTO patients (clickup_task_id, first_name, last_name, country, is_test, phone_whatsapp, has_consent, contact_email_encrypted)
       VALUES ($1, $2, 'Sintetico', 'AR', false, $3, true, 'cipher') RETURNING id`,
      [`e2e-049-adm-${Date.now()}-${seq}`, FIRST_NAME, PHONE],
    );
    patients.push(rows[0].id);
    return rows[0].id;
  }

  /** Um horário futuro e ÚNICO por chamada (a trava é UNIQUE(host_email, slot_start) e o banco sobrevive entre rodadas). */
  function nextSlot(): string {
    dayOffset += 1;
    return DateTime.now().setZone('America/Argentina/Buenos_Aires').plus({ days: dayOffset }).set({ hour: 11, minute: 0, second: 0, millisecond: 0 }).toISO() as string;
  }

  async function http(method: string, path: string, uid: string | null, body?: unknown, target: { url: string } = app) {
    const res = await fetch(`${target.url}${path}`, {
      method,
      headers: { ...(uid ? { Authorization: tokenMock(uid, 'admin', 'AR') } : {}), 'Content-Type': 'application/json' },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, any> };
  }

  const book = (patientId: string, uid = U.agendadora, hostEmail = ANA, slotStartISO = nextSlot()) =>
    http('POST', `/api/admin/patients/${patientId}/admission-appointments`, uid, { hostEmail, slotStartISO });
  const apptRow = async (id: string) => (await admin.query(`SELECT * FROM admission_appointments WHERE id = $1`, [id])).rows[0];
  const msgs = async (id: string) =>
    (await admin.query(`SELECT kind, attempt, status FROM admission_messages WHERE appointment_id = $1 ORDER BY kind, attempt`, [id])).rows;
  const eventKinds = async (id: string) =>
    (await admin.query(`SELECT kind FROM admission_events WHERE appointment_id = $1 ORDER BY at, id`, [id])).rows.map((r) => r.kind as string);
  const countAppts = async (patientId: string) =>
    (await admin.query(`SELECT count(*)::int AS n FROM admission_appointments WHERE patient_id = $1`, [patientId])).rows[0].n as number;

  async function limparIam(): Promise<void> {
    await limparIamFixtures(admin, { uids: Object.values(U), grupos: Object.values(GRUPOS) });
  }

  beforeAll(async () => {
    admin = new Pool({ connectionString: DATABASE_URL });
    await limparIam();
    await admin.query('DELETE FROM interview_hosts WHERE email = ANY($1)', [[ANA, OCUPADA]]);
    await admin.query('DELETE FROM tactiq_links WHERE lower(host_email) = ANY($1)', [[ANA, OCUPADA, SEM_VINCULO, QUEBRADO, OUTRA_CONTA]]);

    setEnv('USE_MOCK_AUTH', 'true');
    setEnv('PERMISSION_ENGINE_ENABLED', 'true');
    setEnv('PERMISSION_ENFORCED_ROUTES', 'admin.patients');
    setEnv('PERMISSION_CACHE_TTL_MS', '0');
    setEnv('DATABASE_URL', DATABASE_URL);
    setEnv('ADMISSION_HOST_ROSTER_ENABLED', 'true');
    setEnv('ADMISSION_CALENDAR_ID_AR', CAL_AR);
    setEnv('TWILIO_TEMPLATE_ADMISSION_CONFIRMATION_ES', 'HX_CONF_ES_E2E');
    setEnv('TWILIO_TEMPLATE_ADMISSION_REMINDER_ES', 'HX_REM_ES_E2E');
    setEnv('TWILIO_STATUS_CALLBACK_URL', undefined);

    await admin.query(
      `INSERT INTO users (firebase_uid, email, role, status, is_active, tenant_id) VALUES
         ($1,'adm049-chefe@e2e.local','admin','ACTIVE',true,$5),
         ($2,'adm049-agendadora@e2e.local','admin','ACTIVE',true,$5),
         ($3,'adm049-leitora@e2e.local','admin','ACTIVE',true,$5),
         ($4,'adm049-sem-grupo@e2e.local','admin','ACTIVE',true,$5)`,
      [U.chefe, U.agendadora, U.leitora, U.semGrupo, TENANT_E2E],
    );
    await grupoComCelulas(admin, { nome: GRUPOS.chefe, uid: U.chefe, celulas: [['patient_admission', 'read'], ['patient_admission', 'create'], ['patient_admission', 'update'], ['patient_admission', 'resend_message']] });
    await grupoComCelulas(admin, { nome: GRUPOS.agendadora, uid: U.agendadora, celulas: [['patient_admission', 'read'], ['patient_admission', 'create'], ['patient_admission', 'update']] });
    await grupoComCelulas(admin, { nome: GRUPOS.leitora, uid: U.leitora, celulas: [['patient_admission', 'read']] });
    await admin.query(
      `INSERT INTO interview_hosts (email, display_name, country, active) VALUES ($1,'Ana','AR',true), ($2,'Mari','AR',true),
         ($3,'Sem','AR',true), ($4,'Quebrado','AR',true), ($5,'Outra','AR',true)`,
      [ANA, OCUPADA, SEM_VINCULO, QUEBRADO, OUTRA_CONTA],
    );
    // Vínculo do Tactiq (F4). O token (tabela à parte, 505) o teste nunca usa.
    await admin.query(
      `INSERT INTO tactiq_links (host_email, firebase_uid, status) VALUES
         ($1,'tq-ana','linked'), ($2,'tq-mari','linked'), ($3,'tq-quebrado','broken'), ($4,'tq-outra','wrong_account')`,
      [ANA, OCUPADA, QUEBRADO, OUTRA_CONTA],
    );

    calendar = new FakeAdmissionCalendar();
    tasks = new InMemoryAdmissionReminderTasks();
    whatsapp = new RecordingAdmissionWhatsApp();
    logs = capturingLogger();

    const { logger } = await import('@shared/logging');
    loggerSpies = (['info', 'warn', 'error', 'debug'] as const).map((lvl) =>
      jest.spyOn(logger as never, lvl as never).mockImplementation(((...a: unknown[]) => { loggerCalls.push(JSON.stringify(a)); }) as never),
    );

    app = await montarAppDeFamilia({
      enforcedRoutes: 'admin.patients',
      montarRotas: async ({ app: express, auth, permissions }) => {
        const { DatabaseConnection } = await import('@shared/database/DatabaseConnection');
        const { AdmissionSchedulingService } = await import('../../src/modules/matching/application/AdmissionSchedulingService');
        const { AdmissionMessagingService } = await import('../../src/modules/matching/application/AdmissionMessagingService');
        const { AdmissionPanelService } = await import('../../src/modules/matching/application/AdmissionPanelService');
        const { AdmissionReminderService } = await import('../../src/modules/matching/application/AdmissionReminderService');
        const { AdmissionPanelController } = await import('../../src/modules/matching/interfaces/controllers/AdmissionPanelController');
        const { createAdminAdmissionRoutes } = await import('../../src/modules/matching/interfaces/routes/adminAdmissionRoutes');
        const { AdmissionEventRepository } = await import('../../src/modules/matching/infrastructure/AdmissionEventRepository');
        const { AdmissionMessageContent } = await import('../../src/modules/matching/infrastructure/AdmissionMessageContent');
        const { RealAdmissionNotifier } = await import('../../src/modules/matching/infrastructure/RealAdmissionNotifier');
        const { interviewHostRepository } = await import('../../src/modules/matching/infrastructure/InterviewHostRepository');

        const pool = DatabaseConnection.getInstance().getPool();
        racyStore = new RacyMessageRepository(pool);
        const events = new AdmissionEventRepository(pool);
        const content = new AdmissionMessageContent(pool);
        const messaging = new AdmissionMessagingService(racyStore, events, whatsapp, content, logs.log);
        const notifier = new RealAdmissionNotifier(messaging, content, tasks, events, pool, () => new Date(), logs.log);
        const encryption = { decrypt: async () => FAMILY_EMAIL } as never;
        const { TactiqLinkService } = await import('../../src/modules/matching/application/TactiqLinkService');
        const { TactiqLinkRepository } = await import('../../src/modules/matching/infrastructure/TactiqLinkRepository');
        // O gate de produção (TactiqLinkService.statesFor sobre o banco real); OAuth/MCP são dublês que nunca são chamados aqui.
        const tactiq = new TactiqLinkService({ repo: new TactiqLinkRepository(pool), oauth: new FakeTactiqOAuth(), mcp: new FakeTactiqMcp(), db: pool });
        const scheduling = new AdmissionSchedulingService(calendar, notifier, encryption, 'enlite@enlite.health', interviewHostRepository, tactiq);
        const panel = new AdmissionPanelService({
          db: pool, calendar, reminderTasks: tasks, events, messaging, hosts: interviewHostRepository, tactiq,
          impersonateEmail: 'enlite@enlite.health', log: logs.log,
        });
        reminderService = new AdmissionReminderService(messaging, content, pool, logs.log);
        express.use('/api/admin', createAdminAdmissionRoutes(auth, permissions, new AdmissionPanelController(scheduling, panel)));
      },
    });
  }, 60000);

  afterAll(async () => {
    loggerSpies.forEach((s) => s.mockRestore());
    await app?.fechar();
    const { DatabaseConnection } = await import('@shared/database/DatabaseConnection');
    await DatabaseConnection.getInstance().close();
    if (patients.length) {
      await admin.query(`DELETE FROM patient_documents WHERE patient_id = ANY($1)`, [patients]);
      await admin.query(`DELETE FROM admission_appointments WHERE patient_id = ANY($1)`, [patients]);
      await admin.query(`DELETE FROM patients WHERE id = ANY($1)`, [patients]);
    }
    await admin.query('DELETE FROM interview_hosts WHERE email = ANY($1)', [[ANA, OCUPADA, SEM_VINCULO, QUEBRADO, OUTRA_CONTA]]);
    await admin.query('DELETE FROM tactiq_links WHERE lower(host_email) = ANY($1)', [[ANA, OCUPADA, SEM_VINCULO, QUEBRADO, OUTRA_CONTA]]);
    await limparIam();
    await admin.end();
    for (const [k, v] of Object.entries(envAnterior)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('0. sanidade: o roster semeado existe e as tabelas da F1 estão lá (o zero das provas abaixo não é banco vazio)', async () => {
    const { rows } = await admin.query(`SELECT count(*)::int AS n FROM interview_hosts WHERE email = ANY($1) AND active`, [[ANA, OCUPADA, SEM_VINCULO, QUEBRADO, OUTRA_CONTA]]);
    expect(rows[0].n).toBe(5);
    const links = await admin.query(`SELECT count(*)::int AS n FROM tactiq_links WHERE lower(host_email) = ANY($1)`, [[ANA, OCUPADA, QUEBRADO, OUTRA_CONTA]]);
    expect(links.rows[0].n).toBe(4);
    const t = await admin.query(`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_name IN ('admission_messages','admission_events')`);
    expect(t.rows[0].n).toBe(2);
  });

  describe('A3-8 (varredura): as 3 células estão LITERAIS na rota — é o que o catálogo enxerga', () => {
    it('scanExpressRouter vê cada rota com a SUA célula (read / create / update / resend_message)', async () => {
      const { scanExpressRouter, declaredCells } = await import('@modules/identity/permissions');
      const routes = scanExpressRouter(app.servidor.listeners('request')[0] as never)
        .filter((r) => r.path.includes('admission'));
      const por = (m: string, suffix: string) =>
        routes.find((r) => r.method === m && r.path.endsWith(suffix))?.cell;
      expect(por('GET', '/patients/:id/admission-appointments')).toMatchObject({ resource: 'patient_admission', action: 'read' });
      expect(por('POST', '/patients/:id/admission-appointments')).toMatchObject({ resource: 'patient_admission', action: 'create' });
      expect(por('GET', '/admission/hosts')).toMatchObject({ resource: 'patient_admission', action: 'create' });
      expect(por('POST', '/:apptId/cancel')).toMatchObject({ resource: 'patient_admission', action: 'update' });
      expect(por('POST', '/messages/:kind/resend')).toMatchObject({ resource: 'patient_admission', action: 'resend_message' });
      expect(por('POST', '/:apptId/paid-rehearsal')).toMatchObject({ resource: 'patient_admission', action: 'release_paid_rehearsal' });
      expect(routes).toHaveLength(6);
      const declared = declaredCells(routes).map((c) => `${c.resource}:${c.action}`).sort();
      expect(declared).toEqual(['patient_admission:create', 'patient_admission:read', 'patient_admission:release_paid_rehearsal', 'patient_admission:resend_message', 'patient_admission:update']);
    });
  });

  describe('A3-7 (ABAC, engine ligado): 403 sem a célula, 2xx com ela', () => {
    it('staff só-leitura: POST → 403 missing_cell e o banco/Google/Twilio ficam INALTERADOS; a leitura passa', async () => {
      const p = await newPatient();
      const created = calendar.created.length;
      const sent = whatsapp.calls.length;
      const res = await book(p, U.leitora);
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ code: 'missing_cell' });
      expect(await countAppts(p)).toBe(0);
      expect(calendar.created.length).toBe(created);
      expect(whatsapp.calls.length).toBe(sent);

      expect((await http('GET', `/api/admin/patients/${p}/admission-appointments`, U.leitora)).status).toBe(200);
      expect((await http('GET', '/api/admin/admission/hosts?country=AR', U.leitora)).status).toBe(403);
    });

    it('staff SEM grupo: tudo 403', async () => {
      const p = await newPatient();
      expect((await http('GET', `/api/admin/patients/${p}/admission-appointments`, U.semGrupo)).status).toBe(403);
      expect((await book(p, U.semGrupo)).status).toBe(403);
      expect((await http('GET', '/api/admin/admission/hosts?country=AR', U.semGrupo)).status).toBe(403);
    });

    it('com patient_admission:create → 201 (controle positivo) e lista de hosts 200', async () => {
      const p = await newPatient();
      const res = await book(p, U.agendadora);
      expect(res.status).toBe(201);
      expect(await countAppts(p)).toBe(1);
      const hosts = await http('GET', '/api/admin/admission/hosts?country=AR', U.agendadora);
      expect(hosts.status).toBe(200);
      expect(hosts.body.data.map((h: { email: string }) => h.email)).toEqual(expect.arrayContaining([ANA, OCUPADA]));
    });

    it('reenviar exige a célula PRÓPRIA: quem agenda (create) mas não tem resend_message leva 403', async () => {
      const p = await newPatient();
      const b = await book(p, U.agendadora);
      const r = await http('POST', `/api/admin/patients/${p}/admission-appointments/${b.body.data.appointmentId}/messages/confirmation/resend`, U.agendadora);
      expect(r.status).toBe(403);
      expect(r.body).toMatchObject({ code: 'missing_cell' });
    });

    it('cancelar exige update: só-leitura leva 403 e a reunião segue booked', async () => {
      const p = await newPatient();
      const b = await book(p, U.agendadora);
      const id = b.body.data.appointmentId as string;
      const r = await http('POST', `/api/admin/patients/${p}/admission-appointments/${id}/cancel`, U.leitora);
      expect(r.status).toBe(403);
      expect((await apptRow(id)).status).toBe('booked');
    });
  });

  describe('agendar pelo painel (A3-2, A3-3, A3-9)', () => {
    it('A3-2: responsável OCUPADO → 409 SLOT_TAKEN, 0 linhas, 0 mensagens, 0 eventos de trilha, 0 envios, 0 evento no Google', async () => {
      const p = await newPatient();
      const created = calendar.created.length;
      const sent = whatsapp.calls.length;
      const res = await book(p, U.agendadora, OCUPADA);
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ code: 'SLOT_TAKEN' });
      expect(await countAppts(p)).toBe(0);
      expect(calendar.created.length).toBe(created);
      expect(whatsapp.calls.length).toBe(sent);
      const m = await admin.query(`SELECT count(*)::int AS n FROM admission_messages m JOIN admission_appointments a ON a.id = m.appointment_id WHERE a.patient_id = $1`, [p]);
      expect(m.rows[0].n).toBe(0);
    });

    it('A3-2: o MESMO responsável e horário 2× → o 2º é 409 (trava do banco), 1 linha só, 1 evento só', async () => {
      const p = await newPatient();
      const slot = nextSlot();
      const created = calendar.created.length;
      expect((await book(p, U.agendadora, ANA, slot)).status).toBe(201);
      const second = await book(await newPatient(), U.agendadora, ANA, slot);
      expect(second.status).toBe(409);
      expect(second.body).toMatchObject({ code: 'SLOT_TAKEN' });
      expect(calendar.created.length).toBe(created + 1);
    });

    it('A3-3: responsável FORA do roster do país → 422, nada criado', async () => {
      const p = await newPatient();
      const created = calendar.created.length;
      const res = await book(p, U.agendadora, 'fora.do.roster@example.test');
      expect(res.status).toBe(422);
      expect(res.body).toMatchObject({ code: 'HOST_NOT_IN_ROSTER' });
      expect(await countAppts(p)).toBe(0);
      expect(calendar.created.length).toBe(created);
    });

    it('horário passado → 422 SLOT_IN_PAST, nada criado; data inválida → 400; campo extra no corpo → 400', async () => {
      const p = await newPatient();
      const past = DateTime.now().minus({ hours: 2 }).toISO() as string;
      const r1 = await book(p, U.agendadora, ANA, past);
      expect(r1.status).toBe(422);
      expect(r1.body).toMatchObject({ code: 'SLOT_IN_PAST' });
      expect((await book(p, U.agendadora, ANA, 'amanhã')).status).toBe(400);
      expect((await http('POST', `/api/admin/patients/${p}/admission-appointments`, U.agendadora, { hostEmail: ANA, slotStartISO: nextSlot(), country: 'BR' })).status).toBe(400);
      expect(await countAppts(p)).toBe(0);
    });

    it('paciente inexistente → 404', async () => {
      const res = await book('99999999-9999-4999-8999-999999999999');
      expect(res.status).toBe(404);
    });

    it('horário daqui a ~1 h passa no painel (a antecedência de 4 h do site não vale); 201 com a reunião, o código e o Meet do dublê', async () => {
      const p = await newPatient();
      const soon = DateTime.now().plus({ hours: 1 }).toISO() as string;
      const res = await book(p, U.agendadora, ANA, soon);
      expect(res.status).toBe(201);
      expect(res.body.data.meetLink).toMatch(/^https:\/\/meet\.google\.com\/fak-e049-/);
      expect(res.body.data.admissionCode).toMatch(/^ADM-[0-9A-Z]{6}$/);
    });

    it('A3-9: o título do evento tem o código, nenhum dado do paciente; a linha grava created_via=panel, created_by_uid e o MESMO código', async () => {
      const p = await newPatient();
      const res = await book(p, U.agendadora);
      expect(res.status).toBe(201);
      const id = res.body.data.appointmentId as string;
      const row = await apptRow(id);
      expect(row).toMatchObject({ created_via: 'panel', created_by_uid: U.agendadora, status: 'booked', host_email: ANA });
      expect(row.admission_code).toBe(res.body.data.admissionCode);
      const ev = calendar.created.find((c) => c.summary.endsWith(row.admission_code))!;
      expect(ev.summary).toMatch(/^Entrevista de admisión — .+ · ADM-[0-9A-Z]{6}$/);
      expect(ev.summary + ev.description).not.toContain(FIRST_NAME);
      expect(ev).toMatchObject({ calendarId: CAL_AR, coHostEmail: ANA, patientEmail: FAMILY_EMAIL });
      expect(row.calendar_event_id).toMatch(/^fake-evt-/);
    });

    it('a confirmação sai pelo MESMO núcleo: 1 envio, linha sent, task NOMEADA agendada, e a lista mostra os selos', async () => {
      const p = await newPatient();
      const sent = whatsapp.calls.length;
      const id = (await book(p)).body.data.appointmentId as string;
      expect(whatsapp.calls.length).toBe(sent + 1);
      expect(await msgs(id)).toEqual([{ kind: 'confirmation', attempt: 0, status: 'sent' }]);
      expect(tasks.tasks.has(admissionReminderTaskId(id))).toBe(true);
      expect((await apptRow(id)).reminder_task_name).toBe(admissionReminderTaskId(id));

      const list = await http('GET', `/api/admin/patients/${p}/admission-appointments`, U.leitora);
      expect(list.status).toBe(200);
      expect(list.body.data).toHaveLength(1);
      expect(list.body.data[0]).toMatchObject({
        id, createdVia: 'panel', status: 'booked', hostEmail: ANA,
        seals: { confirmation: { seal: 'sent', attempt: 0, canResend: false }, reminder: { seal: 'scheduled' }, import: null, document: null },
      });
      expect(list.body.data[0].meetLink).toMatch(/fak-e049/);
      expect(JSON.stringify(list.body)).not.toContain(PHONE);
    });
  });

  describe('A4-3 (trava, spec 049 F4): o PAINEL só agenda com responsável de vínculo Tactiq `linked` — no SERVIDOR', () => {
    it.each([
      ['missing (nunca vinculou)', SEM_VINCULO, 'missing'],
      ['broken (o teste diário derrubou)', QUEBRADO, 'broken'],
      ['wrong_account (a conta não é a dele)', OUTRA_CONTA, 'wrong_account'],
    ])('responsável %s → 409 TACTIQ_LINK_REQUIRED, 0 linhas, 0 evento no Google, 0 envio, 0 task', async (_n, host) => {
      const p = await newPatient();
      const created = calendar.created.length;
      const sent = whatsapp.calls.length;
      const taskCount = tasks.tasks.size;
      const res = await book(p, U.agendadora, host);
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ success: false, code: 'TACTIQ_LINK_REQUIRED' });
      expect(await countAppts(p)).toBe(0);
      expect(calendar.created.length).toBe(created);
      expect(whatsapp.calls.length).toBe(sent);
      expect(tasks.tasks.size).toBe(taskCount);
    });

    it('responsável `linked` → 201 (controle positivo: a mesma chamada passa quando o vínculo está vivo)', async () => {
      const p = await newPatient();
      const res = await book(p, U.agendadora, ANA);
      expect(res.status).toBe(201);
      expect(await countAppts(p)).toBe(1);
    });

    it('a trava segue o BANCO ao vivo: derruba o vínculo da ANA → 409; religa → 201', async () => {
      await admin.query(`UPDATE tactiq_links SET status = 'broken' WHERE lower(host_email) = $1`, [ANA]);
      try {
        const p = await newPatient();
        expect((await book(p, U.agendadora, ANA)).status).toBe(409);
        expect(await countAppts(p)).toBe(0);
      } finally {
        await admin.query(`UPDATE tactiq_links SET status = 'linked' WHERE lower(host_email) = $1`, [ANA]);
      }
      expect((await book(await newPatient(), U.agendadora, ANA)).status).toBe(201);
    });

    it('GET /admission/hosts devolve `linked` e o motivo de cada responsável (a tela mostra desabilitado "Sin Tactiq vinculado")', async () => {
      const res = await http('GET', '/api/admin/admission/hosts?country=AR', U.agendadora);
      expect(res.status).toBe(200);
      const by = Object.fromEntries((res.body.data as Array<{ email: string; linked: boolean; linkState: string }>).map((h) => [h.email, h]));
      expect(by[ANA]).toMatchObject({ linked: true, linkState: 'linked' });
      expect(by[OCUPADA]).toMatchObject({ linked: true, linkState: 'linked' });
      expect(by[SEM_VINCULO]).toMatchObject({ linked: false, linkState: 'missing' });
      expect(by[QUEBRADO]).toMatchObject({ linked: false, linkState: 'broken' });
      expect(by[OUTRA_CONTA]).toMatchObject({ linked: false, linkState: 'wrong_account' });
      expect(JSON.stringify(res.body)).not.toContain('enc:ana');
    });
  });

  describe('A3-4 (anti-duplicata): cancelar', () => {
    it('apaga a task pelo NOME determinístico e o evento; o lembrete que chegar depois → 0 envios e linha cancelled', async () => {
      const p = await newPatient();
      const id = (await book(p)).body.data.appointmentId as string;
      const eventId = (await apptRow(id)).calendar_event_id as string;
      const sentBefore = whatsapp.calls.length;

      const res = await http('POST', `/api/admin/patients/${p}/admission-appointments/${id}/cancel`, U.agendadora);
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ status: 'cancelled', calendarEventDeleted: true, reminderTaskDeleted: true });
      expect(tasks.cancelled).toContain(admissionReminderTaskId(id));
      expect(tasks.tasks.has(admissionReminderTaskId(id))).toBe(false);
      expect(calendar.deleted).toContainEqual({ calendarId: CAL_AR, eventId });

      const row = await apptRow(id);
      expect(row).toMatchObject({ status: 'cancelled', cancelled_by_uid: U.agendadora });
      expect(row.cancelled_at).not.toBeNull();
      expect(await eventKinds(id)).toContain('cancelled');

      // o Cloud Tasks (at-least-once) ainda entrega o lembrete: não pode enviar
      const late = await reminderService.send30MinReminder(id);
      expect(late.sent).toBe(false);
      expect(whatsapp.calls.length).toBe(sentBefore);
      expect((await msgs(id)).filter((m) => m.kind === 'reminder_30min')).toEqual([{ kind: 'reminder_30min', attempt: 0, status: 'cancelled' }]);

      // o selo e a lista refletem o cancelamento; Meet some
      const list = (await http('GET', `/api/admin/patients/${p}/admission-appointments`, U.leitora)).body.data[0];
      expect(list).toMatchObject({ status: 'cancelled', meetLink: null, seals: { reminder: { seal: 'cancelled' } } });
    });

    it('cancelar 2× → o 2º é 409; cancelar reunião de OUTRO paciente → 404 e a reunião fica booked', async () => {
      const p = await newPatient();
      const other = await newPatient();
      const id = (await book(p)).body.data.appointmentId as string;

      const wrong = await http('POST', `/api/admin/patients/${other}/admission-appointments/${id}/cancel`, U.agendadora);
      expect(wrong.status).toBe(404);
      expect((await apptRow(id)).status).toBe('booked');

      expect((await http('POST', `/api/admin/patients/${p}/admission-appointments/${id}/cancel`, U.agendadora)).status).toBe(200);
      const again = await http('POST', `/api/admin/patients/${p}/admission-appointments/${id}/cancel`, U.agendadora);
      expect(again.status).toBe(409);
      expect(again.body).toMatchObject({ code: 'APPOINTMENT_NOT_CANCELLABLE' });
    });

    it('dois cancelamentos SIMULTÂNEOS → um 200 e um 409, e o evento do Google é apagado 1×', async () => {
      const p = await newPatient();
      const id = (await book(p)).body.data.appointmentId as string;
      const eventId = (await apptRow(id)).calendar_event_id as string;
      const path = `/api/admin/patients/${p}/admission-appointments/${id}/cancel`;
      const rs = await Promise.all([http('POST', path, U.agendadora), http('POST', path, U.agendadora)]);
      expect(rs.map((r) => r.status).sort()).toEqual([200, 409]);
      expect(calendar.deleted.filter((d) => d.eventId === eventId)).toHaveLength(1);
    });

    it('o cancelamento libera o horário no Google mas a trava do banco segue: refazer no MESMO horário → 409 (achado §11)', async () => {
      const p = await newPatient();
      const slot = nextSlot();
      const id = (await book(p, U.agendadora, ANA, slot)).body.data.appointmentId as string;
      await http('POST', `/api/admin/patients/${p}/admission-appointments/${id}/cancel`, U.agendadora);
      const again = await book(await newPatient(), U.agendadora, ANA, slot);
      expect(again.status).toBe(409);
    });
  });

  describe('reenviar (A3-5, A3-6)', () => {
    /** Reunião cuja confirmação FALHOU no envio (send_failed), e o canal volta a funcionar. */
    async function apptWithFailedConfirmation(): Promise<{ p: string; id: string; path: string }> {
      const p = await newPatient();
      whatsapp.failWith = 'canal fora';
      const id = (await book(p)).body.data.appointmentId as string;
      whatsapp.failWith = null;
      expect(await msgs(id)).toEqual([{ kind: 'confirmation', attempt: 0, status: 'send_failed' }]);
      return { p, id, path: `/api/admin/patients/${p}/admission-appointments/${id}/messages/confirmation/resend` };
    }

    it('a lista mostra a falha e o botão de reenviar (canResend)', async () => {
      const { p } = await apptWithFailedConfirmation();
      const row = (await http('GET', `/api/admin/patients/${p}/admission-appointments`, U.leitora)).body.data[0];
      expect(row.seals.confirmation).toEqual({ seal: 'failed', attempt: 0, canResend: true });
    });

    it('A3-5: dois POST …/resend SIMULTÂNEOS (HTTP real) → exatamente 1 envio, 1 resposta 200 e 1 resposta 409', async () => {
      const { id, path } = await apptWithFailedConfirmation();
      const sent = whatsapp.calls.length;
      // As duas requisições LEEM a tentativa 0 (falhou) antes de qualquer claim: a disputa é pelo claim, não por sorte de ordem.
      racyStore.armBarrier(2);
      let rs: Awaited<ReturnType<typeof http>>[];
      try {
        rs = await Promise.all([http('POST', path, U.chefe), http('POST', path, U.chefe)]);
      } finally {
        racyStore.disarmBarrier();
      }

      expect(rs.map((r) => r.status).sort()).toEqual([200, 409]);
      expect(rs.find((r) => r.status === 409)!.body).toMatchObject({ code: 'RESEND_IN_PROGRESS' });
      expect(rs.find((r) => r.status === 200)!.body.data).toEqual({ outcome: 'sent' });
      expect(whatsapp.calls.length).toBe(sent + 1);
      expect(await msgs(id)).toEqual([
        { kind: 'confirmation', attempt: 0, status: 'send_failed' },
        { kind: 'confirmation', attempt: 1, status: 'sent' },
      ]);
      const kinds = await eventKinds(id);
      expect(kinds.filter((k) => k === 'resend_sent')).toHaveLength(1);
      const ev = await admin.query(`SELECT ref FROM admission_events WHERE appointment_id = $1 AND kind = 'resend_requested'`, [id]);
      expect(ev.rows[0].ref).toMatchObject({ requestedByUid: U.chefe, attempt: 1 });
    });

    it('A3-5 (perdeu o claim SEM exceção): o outro clique toma a tentativa 1 entre a leitura e o claim → 409 RESEND_IN_PROGRESS e 0 envios', async () => {
      const { id, path } = await apptWithFailedConfirmation();
      const sent = whatsapp.calls.length;
      racyStore.afterListAttempts = async () => {
        await admin.query(`INSERT INTO admission_messages (appointment_id, kind, attempt, status) VALUES ($1,'confirmation',1,'claimed')`, [id]);
      };
      const res = await http('POST', path, U.chefe);
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ code: 'RESEND_IN_PROGRESS' });
      expect(whatsapp.calls.length).toBe(sent);
      expect(await eventKinds(id)).toContain('duplicate_blocked');
    });

    it('A3-6: 3º reenvio → 409 RESEND_LIMIT_REACHED (os 2 primeiros falham de novo e gastam a tentativa, sem ser erro de HTTP)', async () => {
      const { id, path } = await apptWithFailedConfirmation();
      whatsapp.failWith = 'canal fora';
      const r1 = await http('POST', path, U.chefe);
      const r2 = await http('POST', path, U.chefe);
      expect([r1.status, r2.status]).toEqual([200, 200]);
      expect([r1.body.data, r2.body.data]).toEqual([{ outcome: 'send_failed' }, { outcome: 'send_failed' }]);
      const sent = whatsapp.calls.length;
      whatsapp.failWith = null;

      const r3 = await http('POST', path, U.chefe);
      expect(r3.status).toBe(409);
      expect(r3.body).toMatchObject({ code: 'RESEND_LIMIT_REACHED' });
      expect(whatsapp.calls.length).toBe(sent);
      expect((await msgs(id)).map((m) => m.attempt)).toEqual([0, 1, 2]);
    });

    it('A3-6: reenvio de mensagem ENTREGUE → 409 RESEND_NOT_ALLOWED, 0 envios', async () => {
      const p = await newPatient();
      const id = (await book(p)).body.data.appointmentId as string;
      await admin.query(`UPDATE admission_messages SET status = 'delivered' WHERE appointment_id = $1 AND kind = 'confirmation'`, [id]);
      const sent = whatsapp.calls.length;
      const res = await http('POST', `/api/admin/patients/${p}/admission-appointments/${id}/messages/confirmation/resend`, U.chefe);
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ code: 'RESEND_NOT_ALLOWED' });
      expect(whatsapp.calls.length).toBe(sent);
    });

    it('reunião de OUTRO paciente → 404; kind inválido → 400; reunião cancelada → 409', async () => {
      const { p, id } = await apptWithFailedConfirmation();
      const other = await newPatient();
      const base = (pid: string, kind: string) => `/api/admin/patients/${pid}/admission-appointments/${id}/messages/${kind}/resend`;
      expect((await http('POST', base(other, 'confirmation'), U.chefe)).status).toBe(404);
      expect((await http('POST', base(p, 'xpto'), U.chefe)).status).toBe(400);
      await http('POST', `/api/admin/patients/${p}/admission-appointments/${id}/cancel`, U.chefe);
      expect((await http('POST', base(p, 'confirmation'), U.chefe)).status).toBe(409);
    });
  });

  describe('log: nenhuma das rotas novas escreve telefone, nome, e-mail da família nem do responsável', () => {
    it('saída do logger (pino real dos serviços + todas as chamadas ao logger global) não contém PII', () => {
      const out = logs.output() + loggerCalls.join('\n');
      expect(out.length).toBeGreaterThan(0);
      expect(out).toContain('admission.');
      for (const pii of [PHONE, FIRST_NAME, FAMILY_EMAIL, ANA, OCUPADA]) expect(out).not.toContain(pii);
      expect(out).toContain('admission.cancelled');
      expect(out).toContain('admission.confirmation_sent');
    });
  });
});

const describeAbacStack = process.env.E2E_ABAC_STACK === '1' ? describe : describe.skip;

describeAbacStack('stack com engine ligado e catálogo SINCRONIZADO no boot (A3-7 e A3-8 pelo index.ts de verdade)', () => {
  let pool: Pool;
  const uids = { sem: 'adm049-c-sem', com: 'adm049-c-com' };
  const grupos = { sem: 'Adm049 C Sem', com: 'Adm049 C Com' };
  let patientId: string;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    await limparIamFixtures(pool, { uids: Object.values(uids), grupos: Object.values(grupos) });
    await pool.query('DELETE FROM interview_hosts WHERE email = $1', [ANA]);
    await pool.query(
      `INSERT INTO users (firebase_uid, email, role, status, is_active, tenant_id) VALUES
         ($1,'adm049-c-sem@e2e.local','admin','ACTIVE',true,$3), ($2,'adm049-c-com@e2e.local','admin','ACTIVE',true,$3)`,
      [uids.sem, uids.com, TENANT_E2E],
    );
    await grupoComCelulas(pool, { nome: grupos.sem, uid: uids.sem, celulas: [['patient_admission', 'read']] });
    await grupoComCelulas(pool, { nome: grupos.com, uid: uids.com, celulas: [['patient_admission', 'read'], ['patient_admission', 'create'], ['patient_admission', 'update']] });
    await pool.query(`INSERT INTO interview_hosts (email, display_name, country, active) VALUES ($1,'Ana','AR',true)`, [ANA]);
    await pool.query(`DELETE FROM tactiq_links WHERE lower(host_email) = $1`, [ANA]);
    await pool.query(`INSERT INTO tactiq_links (host_email, firebase_uid, status) VALUES ($1,'tq-ana-c','linked')`, [ANA]);
    const { rows } = await pool.query(
      `INSERT INTO patients (clickup_task_id, first_name, last_name, country, is_test) VALUES ($1,'Carla','Sintetico','AR',true) RETURNING id`,
      [`e2e-049-adm-c-${Date.now()}`],
    );
    patientId = rows[0].id;
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM admission_appointments WHERE patient_id = $1`, [patientId]);
    await pool.query(`DELETE FROM patients WHERE id = $1`, [patientId]);
    await pool.query('DELETE FROM interview_hosts WHERE email = $1', [ANA]);
    await pool.query(`DELETE FROM tactiq_links WHERE lower(host_email) = $1`, [ANA]);
    await limparIamFixtures(pool, { uids: Object.values(uids), grupos: Object.values(grupos) });
    await pool.end();
  });

  it('A3-8: as 5 células patient_admission estão no catálogo SINCRONIZADO (descrição do código, não o placeholder da 507) e com deprecated_at IS NULL', async () => {
    const { rows } = await pool.query(
      `SELECT action, description, deprecated_at FROM iam.permissions WHERE resource = 'patient_admission' ORDER BY action`,
    );
    expect(rows.map((r) => r.action)).toEqual(['create', 'read', 'release_paid_rehearsal', 'resend_message', 'update']);
    for (const r of rows) {
      expect(r.deprecated_at).toBeNull();
      expect(r.description).not.toContain('507 placeholder');
    }
  });

  it('A3-7 pelo container: só-leitura → 403 e nada criado; com create → 201 (Meet do dublê fak-e049); engine ligado', async () => {
    const slot = DateTime.now().plus({ days: 400 + Math.floor(Math.random() * 300) }).set({ hour: 10, minute: 0, second: 0, millisecond: 0 }).toISO();
    const call = async (uid: string) => {
      const res = await fetch(`${API_URL}/api/admin/patients/${patientId}/admission-appointments`, {
        method: 'POST',
        headers: { Authorization: tokenMock(uid, 'admin', 'AR'), 'Content-Type': 'application/json' },
        body: JSON.stringify({ hostEmail: ANA, slotStartISO: slot }),
      });
      return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, any> };
    };

    const denied = await call(uids.sem);
    expect(denied.status).toBe(403);
    expect(denied.body).toMatchObject({ code: 'missing_cell' });
    expect((await pool.query(`SELECT count(*)::int AS n FROM admission_appointments WHERE patient_id = $1`, [patientId])).rows[0].n).toBe(0);

    const ok = await call(uids.com);
    expect(ok.status).toBe(201);
    const row = (await pool.query(`SELECT meet_link, created_via, created_by_uid FROM admission_appointments WHERE id = $1`, [ok.body.data.appointmentId])).rows[0];
    expect(row).toMatchObject({ created_via: 'panel', created_by_uid: uids.com });
    expect(row.meet_link).toMatch(/fak-e049-/);
  });
});
