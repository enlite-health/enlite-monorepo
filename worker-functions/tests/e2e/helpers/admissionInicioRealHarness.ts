/**
 * admissionInicioRealHarness — spec 050 F14 (R-7): o INÍCIO REAL da reunião gravado pelo job de 15 min, com o PAPEL DO RUNTIME,
 * nas rotas HTTP montadas com os middlewares de verdade (`systemContextMiddleware` para o job, staff com claim de país para a lista).
 *
 * O MESMO conjunto roda em dois arquivos, mudando SÓ quem conecta (padrão do `admissionCalendarRlsHarness`): `-runtime` (login membro de
 * `app_runtime` + pool de sistema `app_system`, `COUNTRY_RLS_ENABLED=true`, como a API em stg/prd) e `-dono` (controle: bypassa RLS).
 * A Meet API é dublê (`FakeMeetConference`). Dados sintéticos (@example.test). Nada toca canal real.
 *
 * A14-1 conferência aberta → grava o início e segue esperando · A14-2 duas conferências → início = a mais antiga, fim = a mais nova
 * A14-3 `no_show` e fim inalterados (antes do fim marcado o job só LÊ o início) · A14-4 a lista da aba traz os dois horários.
 */
import { Pool } from 'pg';
import { montarAppDeFamilia, tokenMock, type AppDeFamilia } from './permissionFamilyHarness';
import { ensureLoginRole, dropLoginRoles, urlFor } from './loginRoles';
import { FakeAdmissionCalendar } from '../../../src/modules/matching/infrastructure/doubles/FakeAdmissionCalendar';
import { FakeMeetConference } from '../../../src/modules/matching/infrastructure/doubles/FakeMeetConference';
import { FakeTactiqMcp, FakeTactiqOAuth } from '../../../src/modules/matching/infrastructure/doubles/FakeTactiq';
import { capturingLogger } from '../../../src/modules/matching/infrastructure/doubles/admissionTestKit';

const DATABASE_URL =
  process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

export type ConexaoInicio = 'runtime' | 'dono';

const TENANT = '00000000-0000-0000-0000-000000000001';
const SENHA = 'adm050_ini_pw';
const SECRET = 'test-secret-for-e2e-only';
const MIN = 60_000;

export function definirCenariosInicioReal(conexao: ConexaoInicio, sufixo: string): void {
  const RUNTIME_USER = `adm050ini_rt_${sufixo}`;
  const SYSTEM_USER = `adm050ini_sys_${sufixo}`;
  const STAFF = { uid: `adm050-ini-staff-${sufixo}`, email: `adm050-ini-staff-${sufixo}@e2e.local` };
  const HOST = `ana.ini.${sufixo}@example.test`;

  describe(`F14 — início real da reunião sob RLS, HTTP real, conexão: ${conexao}`, () => {
    let admin: Pool;
    let app: AppDeFamilia;
    let fake: FakeMeetConference;
    let patientId = '';
    let seq = 0;
    const logs = capturingLogger();
    const envAnterior: Record<string, string | undefined> = {};
    function setEnv(k: string, v: string | undefined): void {
      if (!(k in envAnterior)) envAnterior[k] = process.env[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }

    const job = async (): Promise<{ status: number; data: Record<string, number> }> => {
      const res = await fetch(`${app.url}/api/internal/jobs/admission-post-call`, { method: 'POST', headers: { 'X-Internal-Secret': SECRET } });
      const body = (await res.json().catch(() => ({}))) as { data?: Record<string, number> };
      return { status: res.status, data: body.data ?? {} };
    };
    const lista = async (): Promise<Array<Record<string, any>>> => {
      const res = await fetch(`${app.url}/api/admin/patients/${patientId}/admission-appointments`, { headers: { Authorization: tokenMock(STAFF.uid, 'admin', 'AR') } });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: Array<Record<string, any>> };
      return body.data;
    };

    /** Reunião relativa a AGORA (o job do HTTP usa o relógio real). `inicioMin`/`fimMin` = minutos a partir de agora (negativo = passado). */
    async function appt(inicioMin: number, fimMin: number): Promise<{ id: string; code: string }> {
      seq += 1;
      const meetCode = `abc-${sufixo}${seq}-xyz`; // um espaço do Meet por reunião (o dublê programa por código)
      const meet = `https://meet.google.com/${meetCode}`;
      const { rows } = await admin.query(
        `INSERT INTO admission_appointments (patient_id, country, host_email, host_display_name, slot_start, slot_end, status, meet_link, admission_code, created_at)
         VALUES ($1,'AR',$2,'Operadora Sintetica', now() + make_interval(mins => $3), now() + make_interval(mins => $4), 'booked', $5,
                 'ADM-' || upper(substr(md5(random()::text), 1, 6)), now() - interval '3 hours') RETURNING id`,
        [patientId, HOST, inicioMin, fimMin, meet],
      );
      return { id: rows[0].id, code: meetCode };
    }
    const row = async (id: string) =>
      (await admin.query(`SELECT status, import_status, conference_started_at, conference_ended_at FROM admission_appointments WHERE id = $1`, [id])).rows[0];
    const kinds = async (id: string, like = 'conference_%'): Promise<string[]> =>
      (await admin.query(`SELECT kind FROM admission_events WHERE appointment_id = $1 AND kind LIKE $2 ORDER BY kind`, [id, like])).rows.map((r) => r.kind);
    const iso = (d: Date | null): string | null => (d ? new Date(d).toISOString() : null);
    const ago = (m: number): Date => new Date(Date.now() - m * MIN);

    async function limpar(): Promise<void> {
      await admin.query(`DELETE FROM admission_appointments WHERE host_email = $1`, [HOST]);
      await admin.query(`DELETE FROM patients WHERE clickup_task_id = $1`, [`e2e-050-ini-${sufixo}`]);
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
      await admin.query(`INSERT INTO users (firebase_uid, email, role, status, is_active, tenant_id) VALUES ($1,$2,'admin','ACTIVE',true,$3)`, [STAFF.uid, STAFF.email, TENANT]);
      patientId = (await admin.query(
        `INSERT INTO patients (clickup_task_id, first_name, last_name, country, is_test, has_consent)
         VALUES ($1,'Carla','Sintetico','AR',false,true) RETURNING id`,
        [`e2e-050-ini-${sufixo}`],
      )).rows[0].id;
      fake = new FakeMeetConference();

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
          const { createAdminAdmissionRoutes } = await import('../../../src/modules/matching/interfaces/routes/adminAdmissionRoutes');
          const { AdmissionEventRepository } = await import('../../../src/modules/matching/infrastructure/AdmissionEventRepository');
          const { interviewHostRepository } = await import('../../../src/modules/matching/infrastructure/InterviewHostRepository');
          const { TactiqLinkService } = await import('../../../src/modules/matching/application/TactiqLinkService');
          const { TactiqLinkRepository } = await import('../../../src/modules/matching/infrastructure/TactiqLinkRepository');
          const { AdmissionPostCallJob } = await import('../../../src/modules/matching/application/AdmissionPostCallJob');
          const { AdmissionPostCallRepository } = await import('../../../src/modules/matching/infrastructure/AdmissionPostCallRepository');
          const { AdmissionPostCallInternalController } = await import('../../../src/modules/matching/interfaces/controllers/AdmissionPostCallInternalController');
          const { createAdmissionPostCallInternalRoutes } = await import('../../../src/modules/matching/interfaces/routes/admissionPostCallRoutes');
          const { systemContextMiddleware } = await import('@shared/database/systemContextMiddleware');
          const { internalAuthMiddleware } = await import('@modules/notification');

          const pool = DatabaseConnection.getInstance().getPool();
          const events = new AdmissionEventRepository(pool);
          const cal = new FakeAdmissionCalendar();
          const tactiq = new TactiqLinkService({ repo: new TactiqLinkRepository(pool), oauth: new FakeTactiqOAuth(), mcp: new FakeTactiqMcp(), db: pool });
          const scheduling = new AdmissionSchedulingService(cal, { onBooked: async () => undefined } as never, { decrypt: async () => 'x@example.test' } as never, 'enlite@enlite.health', interviewHostRepository, tactiq);
          const panel = new AdmissionPanelService({
            db: pool, calendar: cal, reminderTasks: { cancel: async () => undefined } as never, events, messaging: {} as never,
            hosts: interviewHostRepository, tactiq, impersonateEmail: 'enlite@enlite.health',
          });
          express.use('/api/admin', createAdminAdmissionRoutes(authMw, permissions, new AdmissionPanelController(scheduling, panel)));
          express.use(
            '/api/internal',
            systemContextMiddleware('job:admission-post-call'),
            internalAuthMiddleware,
            createAdmissionPostCallInternalRoutes(
              new AdmissionPostCallInternalController(new AdmissionPostCallJob({ repo: new AdmissionPostCallRepository(pool), meet: fake, events, db: pool, log: logs.log })),
            ),
          );
        },
      });
    }, 90000);

    beforeEach(() => fake.reset());

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

    it('0. sanidade: a conexão é a que o arquivo declara e, no runtime, a RLS está de pé (sem identidade a conexão é recusada)', async () => {
      const { DatabaseConnection } = await import('@shared/database/DatabaseConnection');
      const raw = DatabaseConnection.getInstance().getRawPool();
      expect((await raw.query('SELECT current_user AS u')).rows[0].u).toBe(conexao === 'runtime' ? RUNTIME_USER : new URL(DATABASE_URL).username);
      const semContexto = raw.query(`SELECT count(*)::int AS n FROM patients WHERE id = $1`, [patientId]);
      if (conexao === 'runtime') await expect(semContexto).rejects.toThrow(/rls_session_without_identity/);
      else expect((await semContexto).rows[0].n).toBe(1);
    });

    it('A14-1: reunião EM ANDAMENTO (antes do fim marcado) com conferência aberta → grava o início, 1 evento, segue esperando; 2ª execução não repete', async () => {
      const a = await appt(-20, 40); // começou há 20 min, termina em 40
      const inicio = ago(18);
      fake.setRecords(a.code, [{ name: 'conferenceRecords/c1', startTime: inicio, endTime: null }]);

      const r1 = await job();
      expect(r1.status).toBe(200);
      expect(r1.data.waiting).toBeGreaterThanOrEqual(1);
      const depois = await row(a.id);
      expect(iso(depois.conference_started_at)).toBe(inicio.toISOString());
      expect(depois).toMatchObject({ status: 'booked', import_status: null, conference_ended_at: null }); // segue esperando
      expect(await kinds(a.id)).toEqual(['conference_started']);

      await job();
      expect(await kinds(a.id)).toEqual(['conference_started']); // idempotente
      expect(iso((await row(a.id)).conference_started_at)).toBe(inicio.toISOString());
      // log só com ids e contagem
      const linha = logs.output().split('\n').filter((l) => l.includes('"message":"admission.conference_started"')).map((l) => JSON.parse(l) as Record<string, unknown>).find((l) => l.appointmentId === a.id);
      expect(linha).toBeDefined();
      expect(Object.keys(linha as object).filter((k) => !['severity', 'time', 'pid', 'hostname', 'message', 'level', 'timestamp'].includes(k)).sort()).toEqual(['appointmentId', 'parts']);
    });

    it('A14-2: duas conferências → início = a mais ANTIGA, fim = a mais NOVA; a mais antiga aparecendo depois puxa o início para trás sem novo evento', async () => {
      const a = await appt(-120, -60);
      const tardia = { name: 'conferenceRecords/tardia', startTime: ago(100), endTime: ago(65) };
      const antiga = { name: 'conferenceRecords/antiga', startTime: ago(118), endTime: ago(110) };
      fake.setRecords(a.code, [tardia, { ...antiga, endTime: null }]); // uma aberta: a reunião espera
      await job();
      expect(iso((await row(a.id)).conference_started_at)).toBe(antiga.startTime.toISOString());
      expect((await row(a.id)).conference_ended_at).toBeNull();

      fake.setRecords(a.code, [tardia, antiga]); // todas terminadas
      await job();
      const fim = await row(a.id);
      expect(iso(fim.conference_started_at)).toBe(antiga.startTime.toISOString());
      expect(iso(fim.conference_ended_at)).toBe(tardia.endTime.toISOString());
      expect(await kinds(a.id)).toEqual(['conference_ended', 'conference_started']);

      // início mais antigo que o gravado: anda para trás, sem 2º evento (controle do "só o menor vale")
      const b = await appt(-120, -60);
      fake.setRecords(b.code, [{ name: 'conferenceRecords/b1', startTime: ago(90), endTime: null }]);
      await job();
      fake.setRecords(b.code, [{ name: 'conferenceRecords/b1', startTime: ago(90), endTime: null }, { name: 'conferenceRecords/b0', startTime: ago(110), endTime: null }]);
      await job();
      const mais = ago(110).getTime();
      expect(Math.abs(new Date((await row(b.id)).conference_started_at).getTime() - mais)).toBeLessThan(5_000); // o menor (110 min atrás), não o 1º visto (90)
      expect(await kinds(b.id)).toEqual(['conference_started']);
    });

    it('A14-3: antes do fim marcado o job só LÊ o início — sem conferência não vira no_show (nem com mais de 1 h desde o início), sem fim', async () => {
      const longa = await appt(-70, 110); // começou há 70 min (> 1 h), termina em 110: ainda não acabou
      const s = await job();
      expect(s.status).toBe(200);
      expect(await row(longa.id)).toMatchObject({ status: 'booked', import_status: null, conference_started_at: null, conference_ended_at: null });
      expect(await kinds(longa.id, '%')).toEqual([]);
      expect(fake.listCalls).toContain(`spaces/${longa.code}`); // o job OLHOU a reunião (o "nada muda" não é "nem olhou")

      const noFim = await appt(-70, 110);
      fake.setRecords(noFim.code, [{ name: 'conferenceRecords/curta', startTime: ago(65), endTime: ago(50) }]); // todas terminadas, mas o marcado ainda não acabou
      await job();
      expect(await row(noFim.id)).toMatchObject({ import_status: null, conference_ended_at: null });
      expect(Math.abs(new Date((await row(noFim.id)).conference_started_at).getTime() - ago(65).getTime())).toBeLessThan(5_000); // o início é lido; o fim, não
    });

    it('controle: depois do fim marcado o no_show segue como era (lista vazia > 1 h do início) e o fim real é o maior endTime', async () => {
      const semNinguem = await appt(-90, -30);
      const comCall = await appt(-90, -30);
      fake.setRecords(comCall.code, [{ name: 'conferenceRecords/ok', startTime: ago(80), endTime: ago(40) }]);
      await job();
      expect(await row(semNinguem.id)).toMatchObject({ status: 'no_show', import_status: 'no_show', conference_started_at: null });
      expect(await kinds(semNinguem.id, '%')).toEqual(['no_show']);
      const ok = await row(comCall.id);
      expect(ok).toMatchObject({ status: 'booked', import_status: 'pending' });
      expect(Math.abs(new Date(ok.conference_ended_at).getTime() - ago(40).getTime())).toBeLessThan(5_000);
    });

    it('A14-4: a lista da aba (GET do staff, RLS do request) traz os DOIS horários; sem conferência ambos são null', async () => {
      const a = await appt(-120, -60);
      const vazia = await appt(60, 120);
      const inicio = ago(115);
      const fim = ago(65);
      fake.setRecords(a.code, [{ name: 'conferenceRecords/x', startTime: inicio, endTime: fim }]);
      await job();
      const itens = await lista();
      const dela = itens.find((i) => i.id === a.id)!;
      expect(dela.conferenceStartedAt).toBe(inicio.toISOString());
      expect(dela.conferenceEndedAt).toBe(fim.toISOString());
      const dela2 = itens.find((i) => i.id === vazia.id)!;
      expect(dela2.conferenceStartedAt).toBeNull();
      expect(dela2.conferenceEndedAt).toBeNull();
    });
  });
}
