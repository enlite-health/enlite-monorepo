/**
 * admissionCalendarRlsHarness — spec 050 F10 (complemento): as varreduras do job (R-36, R-37) e a compensação da F9 (R-34) com o
 * PAPEL DO RUNTIME, nas rotas HTTP montadas com os middlewares de verdade (`systemContextMiddleware`, `publicContextMiddleware`,
 * staff com claim de país), e não em processo com a conexão do dono.
 *
 * O MESMO conjunto roda em dois arquivos, mudando SÓ quem conecta (padrão do `admissionPaisHarness`): `-runtime` (login membro de
 * `app_runtime` + pool de sistema `app_system`, `COUNTRY_RLS_ENABLED=true`, como a API em stg/prd) e `-dono` (controle).
 * Google dublado; dados sintéticos (@example.test). Nada toca canal real.
 */
import { Pool } from 'pg';
import { DateTime } from 'luxon';
import { montarAppDeFamilia, tokenMock, type AppDeFamilia } from './permissionFamilyHarness';
import { ensureLoginRole, dropLoginRoles, urlFor } from './loginRoles';
import { FakeAdmissionCalendar } from '../../../src/modules/matching/infrastructure/doubles/FakeAdmissionCalendar';
import { FakeMeetConference } from '../../../src/modules/matching/infrastructure/doubles/FakeMeetConference';
import { FakeTactiqMcp, FakeTactiqOAuth } from '../../../src/modules/matching/infrastructure/doubles/FakeTactiq';
import type { CreateEventParams } from '../../../src/modules/matching/infrastructure/AdmissionCalendarService';
import { capturingLogger } from '../../../src/modules/matching/infrastructure/doubles/admissionTestKit';

const DATABASE_URL =
  process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

export type ConexaoCalendario = 'runtime' | 'dono';

const TENANT = '00000000-0000-0000-0000-000000000001';
const SENHA = 'adm050_cal_pw';
const SECRET = 'test-secret-for-e2e-only';
const MEET = 'https://meet.google.com/abc-defg-hij';
const AR_ZONE = 'America/Argentina/Buenos_Aires';

class ProgrammableCalendar extends FakeAdmissionCalendar {
  /** criações que falham (sempre, enquanto true) */
  failCreate = false;
  failDelete = false;
  creates = 0;
  async createEventWithMeet(p: CreateEventParams): Promise<{ eventId: string; meetLink: string }> {
    this.creates += 1;
    if (this.failCreate) throw new Error('google fora');
    return { eventId: p.eventId ?? 'sem-id', meetLink: MEET };
  }
  async deleteEvent(calendarId: string, eventId: string, impersonate?: string): Promise<void> {
    if (this.failDelete) throw new Error('google fora');
    return super.deleteEvent(calendarId, eventId, impersonate);
  }
}

export function definirCenariosCalendarioRls(conexao: ConexaoCalendario, sufixo: string): void {
  const RUNTIME_USER = `adm050cal_rt_${sufixo}`;
  const SYSTEM_USER = `adm050cal_sys_${sufixo}`;
  const STAFF = { uid: `adm050-cal-staff-${sufixo}`, email: `adm050-cal-staff-${sufixo}@e2e.local` };
  const HOST = `ana.cal.${sufixo}@example.test`;
  const CAL_AR = `cal-ar-rls-${sufixo}@example.test`;

  describe(`F10 — varreduras do job e compensação da F9 sob RLS, HTTP real, conexão: ${conexao}`, () => {
    let admin: Pool;
    let app: AppDeFamilia;
    let cal: ProgrammableCalendar;
    const logs = capturingLogger();
    let patientId: string;
    const envAnterior: Record<string, string | undefined> = {};
    let dayOffset = 40 + Math.floor(Math.random() * 200);

    function setEnv(k: string, v: string | undefined): void {
      if (!(k in envAnterior)) envAnterior[k] = process.env[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    const nextSlot = (): string => {
      let d: DateTime;
      do {
        d = DateTime.now().setZone(AR_ZONE).plus({ days: ++dayOffset }).set({ hour: 11, minute: 0, second: 0, millisecond: 0 });
      } while (d.weekday > 5);
      return d.toISO() as string;
    };
    async function post(path: string, headers: Record<string, string>, body?: unknown) {
      const res = await fetch(`${app.url}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, any> };
    }
    const job = () => post('/api/internal/jobs/admission-post-call', { 'X-Internal-Secret': SECRET });
    const panelBook = (slot: string) =>
      post(`/api/admin/patients/${patientId}/admission-appointments`, { Authorization: tokenMock(STAFF.uid, 'admin', 'AR') }, { hostEmail: HOST, slotStartISO: slot });
    const siteBook = (slot: string) => post('/api/public/v1/admission/book', {}, { patientId, slotStartISO: slot, country: 'AR' });

    async function seed(opts: { status: 'booked' | 'cancelled'; eventId?: string; minutesOld?: number }): Promise<string> {
      const slot = nextSlot();
      const r = await admin.query(
        `INSERT INTO admission_appointments (patient_id, country, host_email, slot_start, slot_end, status, calendar_event_id, meet_link, created_at)
         VALUES ($1,'AR',$2,$3::timestamptz,$3::timestamptz + interval '1 hour',$4,$5,$6, now() - make_interval(mins => $7)) RETURNING id`,
        [patientId, HOST, slot, opts.status, opts.eventId ?? null, opts.eventId ? MEET : null, opts.minutesOld ?? 0],
      );
      return r.rows[0].id;
    }
    const trail = async (id: string, kind: string): Promise<number> =>
      Number((await admin.query(`SELECT count(*) FROM admission_events WHERE appointment_id=$1 AND kind=$2`, [id, kind])).rows[0].count);
    const statusOf = async (id: string): Promise<string> => (await admin.query(`SELECT status FROM admission_appointments WHERE id=$1`, [id])).rows[0].status;
    const bySlot = async (slot: string, status: string): Promise<string[]> =>
      (await admin.query(`SELECT id FROM admission_appointments WHERE patient_id=$1 AND slot_start=$2 AND status=$3`, [patientId, slot, status])).rows.map((r) => r.id);

    async function limpar(): Promise<void> {
      await admin.query(`DELETE FROM admission_appointments WHERE host_email = $1`, [HOST]);
      await admin.query(`DELETE FROM patients WHERE clickup_task_id = $1`, [`e2e-050-cal-rls-${sufixo}`]);
      await admin.query('DELETE FROM interview_hosts WHERE email = $1', [HOST]);
      await admin.query('DELETE FROM tactiq_links WHERE lower(host_email) = $1', [HOST]);
      await admin.query('DELETE FROM users WHERE firebase_uid = $1', [STAFF.uid]);
    }

    beforeAll(async () => {
      admin = new Pool({ connectionString: DATABASE_URL });
      await ensureLoginRole(admin, RUNTIME_USER, SENHA, 'app_runtime');
      await ensureLoginRole(admin, SYSTEM_USER, SENHA, 'app_system');
      await limpar();
      setEnv('DATABASE_URL', conexao === 'runtime' ? urlFor(DATABASE_URL, RUNTIME_USER, SENHA) : DATABASE_URL);
      setEnv('DATABASE_SYSTEM_URL', conexao === 'runtime' ? urlFor(DATABASE_URL, SYSTEM_USER, SENHA) : undefined);
      setEnv('COUNTRY_RLS_ENABLED', 'true');
      setEnv('USE_MOCK_AUTH', 'true');
      setEnv('DB_POOL_MAX', '4');
      setEnv('DB_SYSTEM_POOL_MAX', '2');
      setEnv('INTERNAL_TOKEN_SECRET', SECRET);
      setEnv('ADMISSION_HOST_ROSTER_ENABLED', 'true');
      setEnv('ADMISSION_CALENDAR_ID_AR', CAL_AR);

      await admin.query(`INSERT INTO users (firebase_uid, email, role, status, is_active, tenant_id) VALUES ($1,$2,'admin','ACTIVE',true,$3)`, [STAFF.uid, STAFF.email, TENANT]);
      await admin.query(`INSERT INTO interview_hosts (email, display_name, country, active) VALUES ($1,'Ana','AR',true)`, [HOST]);
      await admin.query(`INSERT INTO tactiq_links (host_email, firebase_uid, status) VALUES ($1,$2,'linked')`, [HOST, `tq-${sufixo}`]);
      patientId = (await admin.query(
        `INSERT INTO patients (clickup_task_id, first_name, last_name, country, is_test, has_consent, contact_email_encrypted)
         VALUES ($1,'Carla','Sintetico','AR',false,true,'cipher') RETURNING id`,
        [`e2e-050-cal-rls-${sufixo}`],
      )).rows[0].id;
      cal = new ProgrammableCalendar();

      const [identity, { DatabaseConnection }] = await Promise.all([import('@modules/identity'), import('@shared/database/DatabaseConnection')]);
      const auth = new identity.AuthMiddleware(
        new identity.MultiAuthService({ enableApiKeys: true, enableJwt: false, enableGoogleIdToken: true }, DatabaseConnection.getInstance().getPool()),
        new identity.SimplifiedAuthorizationEngine(),
      );
      app = await montarAppDeFamilia({
        auth,
        montarRotas: async ({ app: express, auth: authMw, permissions }) => {
          const { AdmissionSchedulingService } = await import('../../../src/modules/matching/application/AdmissionSchedulingService');
          const { AdmissionPanelService } = await import('../../../src/modules/matching/application/AdmissionPanelService');
          const { AdmissionPanelController } = await import('../../../src/modules/matching/interfaces/controllers/AdmissionPanelController');
          const { AdmissionSchedulingController } = await import('../../../src/modules/matching/interfaces/controllers/AdmissionSchedulingController');
          const { createAdminAdmissionRoutes } = await import('../../../src/modules/matching/interfaces/routes/adminAdmissionRoutes');
          const { AdmissionEventRepository } = await import('../../../src/modules/matching/infrastructure/AdmissionEventRepository');
          const { interviewHostRepository } = await import('../../../src/modules/matching/infrastructure/InterviewHostRepository');
          const { TactiqLinkService } = await import('../../../src/modules/matching/application/TactiqLinkService');
          const { TactiqLinkRepository } = await import('../../../src/modules/matching/infrastructure/TactiqLinkRepository');
          const { AdmissionPostCallJob } = await import('../../../src/modules/matching/application/AdmissionPostCallJob');
          const { AdmissionCalendarSweeps } = await import('../../../src/modules/matching/application/admissionCalendarSweeps');
          const { AdmissionPostCallRepository } = await import('../../../src/modules/matching/infrastructure/AdmissionPostCallRepository');
          const { AdmissionPostCallInternalController } = await import('../../../src/modules/matching/interfaces/controllers/AdmissionPostCallInternalController');
          const { createAdmissionPostCallInternalRoutes } = await import('../../../src/modules/matching/interfaces/routes/admissionPostCallRoutes');
          const { systemContextMiddleware, publicContextMiddleware } = await import('@shared/database/systemContextMiddleware');
          const { internalAuthMiddleware } = await import('@modules/notification');

          const pool = DatabaseConnection.getInstance().getPool();
          const events = new AdmissionEventRepository(pool);
          const tactiq = new TactiqLinkService({ repo: new TactiqLinkRepository(pool), oauth: new FakeTactiqOAuth(), mcp: new FakeTactiqMcp(), db: pool });
          const encryption = { decrypt: async () => `familia.${sufixo}@example.test` } as never;
          const scheduling = new AdmissionSchedulingService(cal, { onBooked: async () => undefined } as never, encryption, 'enlite@enlite.health', interviewHostRepository, tactiq);
          const panel = new AdmissionPanelService({
            db: pool, calendar: cal, reminderTasks: { cancel: async () => undefined } as never, events, messaging: {} as never,
            hosts: interviewHostRepository, tactiq, impersonateEmail: 'enlite@enlite.health',
          });
          express.use('/api/admin', createAdminAdmissionRoutes(authMw, permissions, new AdmissionPanelController(scheduling, panel)));
          // site público: contexto `public`, sem ator (como no index.ts)
          const site = new AdmissionSchedulingController(scheduling);
          express.post('/api/public/v1/admission/book', publicContextMiddleware('public:/api/public/v1/admission/book'), (req, res) => void site.book(req, res));
          // job de 15 min: contexto `system` + segredo interno (como no index.ts)
          express.use(
            '/api/internal',
            systemContextMiddleware('job:admission-post-call'),
            internalAuthMiddleware,
            createAdmissionPostCallInternalRoutes(
              new AdmissionPostCallInternalController(
                new AdmissionPostCallJob({
                  repo: new AdmissionPostCallRepository(pool), meet: new FakeMeetConference(), events, db: pool, log: logs.log,
                  calendarSweeps: new AdmissionCalendarSweeps({ db: pool, calendar: cal, events, impersonateEmail: 'enlite@enlite.health', log: logs.log }),
                }),
              ),
            ),
          );
        },
      });
    }, 90000);

    beforeEach(() => {
      cal.failCreate = false;
      cal.failDelete = false;
      cal.creates = 0;
      cal.deleted.length = 0;
    });

    afterAll(async () => {
      await app?.fechar();
      const { DatabaseConnection } = await import('@shared/database/DatabaseConnection');
      await DatabaseConnection.getInstance().close();
      await limpar();
      await dropLoginRoles(admin, [RUNTIME_USER, SYSTEM_USER]);
      await admin.end();
      for (const [k, v] of Object.entries(envAnterior)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    });

    it('0. sanidade: a conexão é a que o arquivo declara (current_user) e, no runtime, a RLS está de pé (a conexão do runtime, sem identidade, é recusada pela RLS)', async () => {
      const { DatabaseConnection } = await import('@shared/database/DatabaseConnection');
      const raw = DatabaseConnection.getInstance().getRawPool();
      const who = await raw.query('SELECT current_user AS u');
      expect(who.rows[0].u).toBe(conexao === 'runtime' ? RUNTIME_USER : new URL(DATABASE_URL).username);
      const semContexto = raw.query(`SELECT count(*)::int AS n FROM patients WHERE id = $1`, [patientId]);
      if (conexao === 'runtime') await expect(semContexto).rejects.toThrow(/rls_session_without_identity/);
      else expect((await semContexto).rows[0].n).toBe(1);
    });

    it('A. job (contexto de sistema): cancelamento pendente → o job apaga e grava cancel_calendar_deleted; órfã → calendar_failed + trilha', async () => {
      const pendente = await seed({ status: 'cancelled', eventId: `evt-rls-${sufixo}` });
      await admin.query(`INSERT INTO admission_events (appointment_id, kind, outcome, reason) VALUES ($1,'cancel_calendar_failed','failed','delete_event')`, [pendente]);
      const orfa = await seed({ status: 'booked', minutesOld: 10 });
      const comEvento = await seed({ status: 'booked', eventId: `evt-vivo-${sufixo}`, minutesOld: 10 });

      cal.failDelete = true; // 1ª execução: o Google segue fora — a pendente fica, e a órfã é compensada mesmo assim
      const r1 = await job();
      expect(r1.status).toBe(200);
      expect(r1.body.data.cancelEventPending).toBeGreaterThanOrEqual(1);
      expect(r1.body.data.cancelEventDeleted).toBe(0);
      expect(await trail(pendente, 'cancel_calendar_deleted')).toBe(0);
      expect(await statusOf(orfa)).toBe('calendar_failed');
      expect(await trail(orfa, 'calendar_create_failed')).toBe(1);

      cal.failDelete = false; // 2ª: o Google voltou
      const r2 = await job();
      expect(r2.status).toBe(200);
      expect(r2.body.data.cancelEventDeleted).toBeGreaterThanOrEqual(1);
      expect(cal.deleted.map((d) => d.eventId)).toContain(`evt-rls-${sufixo}`);
      expect(await trail(pendente, 'cancel_calendar_deleted')).toBe(1);
      // controle: a reserva COM evento não foi tocada
      expect(await statusOf(comEvento)).toBe('booked');
      expect(await trail(comEvento, 'calendar_create_failed')).toBe(0);
      expect(await trail(orfa, 'calendar_create_failed')).toBe(1);
    });

    it('B. compensação da F9 no painel (staff com ator): o Google falhando → 502, a linha vira calendar_failed e a trilha é gravada', async () => {
      const slot = nextSlot();
      cal.failCreate = true;
      const r = await panelBook(slot);
      expect(r.status).toBe(502);
      expect(r.body.code).toBe('CALENDAR_CREATE_FAILED');
      expect(await bySlot(slot, 'booked')).toHaveLength(0);
      const falhas = await bySlot(slot, 'calendar_failed');
      expect(falhas).toHaveLength(1);
      expect(await trail(falhas[0], 'calendar_create_failed')).toBe(1);
    });

    it('C. compensação da F9 no site público (contexto public, sem ator): o Google falhando → sem 500, linha calendar_failed e trilha gravada', async () => {
      const slot = nextSlot();
      cal.failCreate = true;
      const r = await siteBook(slot);
      expect(r.status).toBeLessThan(500);
      expect(await bySlot(slot, 'booked')).toHaveLength(0);
      const falhas = await bySlot(slot, 'calendar_failed');
      expect(falhas).toHaveLength(1);
      expect(await trail(falhas[0], 'calendar_create_failed')).toBe(1);
    });

    it('E. detector de mensagem sem status (F7) com o papel do runtime: `sent` há 30 h conta em deliveryNoStatus e nenhum alarme de detector/varredura sai', async () => {
      const appt = await seed({ status: 'cancelled' });
      const msg = (await admin.query(
        `INSERT INTO admission_messages (appointment_id, kind, attempt, status, updated_at) VALUES ($1,'confirmation',0,'sent', now() - interval '30 hours') RETURNING id`,
        [appt],
      )).rows[0].id as string;
      const antes = logs.output().length;
      const r = await job();
      expect(r.status).toBe(200);
      expect(r.body.data.deliveryNoStatus).toBeGreaterThanOrEqual(1);
      const novo = logs.output().slice(antes);
      // controle positivo: o alarme informativo do detector SAIU, com o id da mensagem semeada (o detector enxergou a linha)
      expect(novo).toContain('"message":"admission.delivery.no_status"');
      expect(novo).toContain(msg);
      expect(novo).not.toContain('admission.delivery.detector_failed');
      expect(novo).not.toContain('admission.calendar_sweep.failed');
    });

    it('controle positivo: sem falha, painel e site agendam (a RLS não derruba o caminho feliz)', async () => {
      const a = nextSlot();
      expect((await panelBook(a)).status).toBe(201);
      expect(await bySlot(a, 'booked')).toHaveLength(1);
      const b = nextSlot();
      const site = await siteBook(b);
      expect(site.status).toBeLessThan(300);
      expect(await bySlot(b, 'booked')).toHaveLength(1);
    });
  });
}
