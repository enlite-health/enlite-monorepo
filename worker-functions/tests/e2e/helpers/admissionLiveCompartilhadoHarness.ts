/**
 * admissionLiveCompartilhadoHarness — spec 050, 4º passo, F25 (R-48, R-54): o que o job de 15 min grava agora (o "ficou sabendo" do
 * início e do fim) e a fila da rede para o fim cedo demais (R-56), com o PAPEL DO RUNTIME, na rota HTTP real do job.
 *
 * O MESMO conjunto roda em dois arquivos, mudando SÓ quem conecta (`-runtime`: login membro de `app_runtime` + pool de sistema
 * `app_system`, RLS de país ligada, como a stage; `-dono`: controle, bypassa RLS, como a produção). Meet = dublê. O RELÓGIO do job é
 * um parâmetro (`clock`), nunca espera real. Dados sintéticos (@example.test). Nada toca canal real.
 *
 * A25-2 "ficou sabendo" do início (COALESCE) e do fim · A25-3 fila da rede: fim cedo sem `pending` volta; fim com `pending` não volta.
 */
import { Pool } from 'pg';
import { montarAppDeFamilia, type AppDeFamilia } from './permissionFamilyHarness';
import { ensureLoginRole, dropLoginRoles, urlFor } from './loginRoles';
import { FakeMeetConference } from '../../../src/modules/matching/infrastructure/doubles/FakeMeetConference';
import { capturingLogger } from '../../../src/modules/matching/infrastructure/doubles/admissionTestKit';

const DATABASE_URL =
  process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

export type ConexaoLive = 'runtime' | 'dono';

const SENHA = 'adm050_live_pw';
const SECRET = 'test-secret-for-e2e-only';
const MIN = 60_000;
/** Dia fixo e distante: o relógio do job é este, não o da máquina. Reunião das 10:00 às 10:45. */
const T0 = Date.parse('2031-03-10T10:00:00Z');
const at = (min: number): Date => new Date(T0 + min * MIN);

export function definirCenariosLiveCompartilhado(conexao: ConexaoLive, sufixo: string): void {
  const RUNTIME_USER = `adm050lv_rt_${sufixo}`;
  const SYSTEM_USER = `adm050lv_sys_${sufixo}`;
  const HOST = (n: number): string => `ana.live.${sufixo}.${n}@example.test`; // um responsável por reunião (índice único host × horário)

  describe(`F25 — observação compartilhada sob RLS, HTTP real, conexão: ${conexao}`, () => {
    let admin: Pool;
    let app: AppDeFamilia;
    let fake: FakeMeetConference;
    let patientId = '';
    let seq = 0;
    let clock = at(0);
    const logs = capturingLogger();
    const envAnterior: Record<string, string | undefined> = {};
    function setEnv(k: string, v: string | undefined): void {
      if (!(k in envAnterior)) envAnterior[k] = process.env[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }

    /** Roda o job de 15 min na rota HTTP com o relógio em `min` (minutos depois das 10:00 do dia fixo). */
    const job = async (min: number): Promise<{ status: number; data: Record<string, number> }> => {
      clock = at(min);
      const res = await fetch(`${app.url}/api/internal/jobs/admission-post-call`, { method: 'POST', headers: { 'X-Internal-Secret': SECRET } });
      const body = (await res.json().catch(() => ({}))) as { data?: Record<string, number> };
      return { status: res.status, data: body.data ?? {} };
    };

    /** Reunião das 10:00 às 10:45. `fim`: já traz o fim gravado (min) e o `import_status` dado. */
    async function appt(fim?: { endedMin: number; importStatus: string | null }): Promise<{ id: string; code: string }> {
      seq += 1;
      const code = `lve-${sufixo}${seq}-xyz`;
      const { rows } = await admin.query(
        `INSERT INTO admission_appointments (patient_id, country, host_email, host_display_name, slot_start, slot_end, status, meet_link, admission_code,
                                             created_at, conference_ended_at, import_status)
         VALUES ($1,'AR',$2,'Operadora Sintetica',$3,$4,'booked',$5,'ADM-' || upper(substr(md5(random()::text), 1, 6)), $6, $7, $8) RETURNING id`,
        [patientId, HOST(seq), at(0), at(45), `https://meet.google.com/${code}`, at(-300), fim ? at(fim.endedMin) : null, fim ? fim.importStatus : null],
      );
      return { id: rows[0].id, code };
    }
    const row = async (id: string) =>
      (await admin.query(
        `SELECT import_status, conference_started_at, conference_ended_at, conference_start_seen_at, conference_end_seen_at,
                extract(epoch FROM (conference_end_seen_at - conference_ended_at))::int AS atraso_fim_s
           FROM admission_appointments WHERE id = $1`,
        [id],
      )).rows[0];
    const kinds = async (id: string): Promise<string[]> =>
      (await admin.query(`SELECT kind FROM admission_events WHERE appointment_id = $1 ORDER BY kind`, [id])).rows.map((r) => r.kind);
    const iso = (d: Date | null): string | null => (d ? new Date(d).toISOString() : null);

    async function limpar(): Promise<void> {
      await admin.query(`DELETE FROM admission_appointments WHERE host_email LIKE $1`, [`ana.live.${sufixo}.%@example.test`]);
      await admin.query(`DELETE FROM patients WHERE clickup_task_id = $1`, [`e2e-050-live-${sufixo}`]);
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
      patientId = (await admin.query(
        `INSERT INTO patients (clickup_task_id, first_name, last_name, country, is_test, has_consent)
         VALUES ($1,'Carla','Sintetico','AR',false,true) RETURNING id`,
        [`e2e-050-live-${sufixo}`],
      )).rows[0].id;
      fake = new FakeMeetConference();

      const [identity, { DatabaseConnection }] = await Promise.all([import('@modules/identity'), import('@shared/database/DatabaseConnection')]);
      const auth = new identity.AuthMiddleware(
        new identity.MultiAuthService({ enableApiKeys: true, enableJwt: false, enableGoogleIdToken: true }, DatabaseConnection.getInstance().getPool()),
        new identity.SimplifiedAuthorizationEngine(),
      );
      app = await montarAppDeFamilia({
        auth,
        montarRotas: async ({ app: express }) => {
          const { AdmissionEventRepository } = await import('../../../src/modules/matching/infrastructure/AdmissionEventRepository');
          const { AdmissionPostCallJob } = await import('../../../src/modules/matching/application/AdmissionPostCallJob');
          const { AdmissionPostCallRepository } = await import('../../../src/modules/matching/infrastructure/AdmissionPostCallRepository');
          const { AdmissionPostCallInternalController } = await import('../../../src/modules/matching/interfaces/controllers/AdmissionPostCallInternalController');
          const { createAdmissionPostCallInternalRoutes } = await import('../../../src/modules/matching/interfaces/routes/admissionPostCallRoutes');
          const { systemContextMiddleware } = await import('@shared/database/systemContextMiddleware');
          const { internalAuthMiddleware } = await import('@modules/notification');

          const pool = DatabaseConnection.getInstance().getPool();
          express.use(
            '/api/internal',
            systemContextMiddleware('job:admission-post-call'),
            internalAuthMiddleware,
            createAdmissionPostCallInternalRoutes(
              new AdmissionPostCallInternalController(
                new AdmissionPostCallJob({ repo: new AdmissionPostCallRepository(pool), meet: fake, events: new AdmissionEventRepository(pool), db: pool, log: logs.log, now: () => clock }),
              ),
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

    it('0. sanidade: a conexão é a que o arquivo declara e, no runtime, a RLS está de pé', async () => {
      const { DatabaseConnection } = await import('@shared/database/DatabaseConnection');
      const raw = DatabaseConnection.getInstance().getRawPool();
      expect((await raw.query('SELECT current_user AS u')).rows[0].u).toBe(conexao === 'runtime' ? RUNTIME_USER : new URL(DATABASE_URL).username);
      const semContexto = raw.query(`SELECT count(*)::int AS n FROM patients WHERE id = $1`, [patientId]);
      if (conexao === 'runtime') await expect(semContexto).rejects.toThrow(/rls_session_without_identity/);
      else expect((await semContexto).rows[0].n).toBe(1);
    });

    it('A25-2 início: "ficou sabendo" = relógio do job; a 2ª gravação (início mais antigo) anda o início mas NÃO o "ficou sabendo"', async () => {
      const a = await appt();
      fake.setRecords(a.code, [{ name: 'conferenceRecords/c1', startTime: at(1), endTime: null }]);
      expect((await job(5)).status).toBe(200);
      const r1 = await row(a.id);
      expect(iso(r1.conference_started_at)).toBe(at(1).toISOString());
      expect(iso(r1.conference_start_seen_at)).toBe(at(5).toISOString()); // sabido às 10:05; o atraso (seen − real) = 4 min
      expect(await kinds(a.id)).toEqual(['conference_started']);

      fake.setRecords(a.code, [
        { name: 'conferenceRecords/c1', startTime: at(1), endTime: null },
        { name: 'conferenceRecords/c0', startTime: at(-2), endTime: null },
      ]);
      await job(9);
      const r2 = await row(a.id);
      expect(iso(r2.conference_started_at)).toBe(at(-2).toISOString()); // o início andou para trás
      expect(iso(r2.conference_start_seen_at)).toBe(at(5).toISOString()); // o primeiro instante vale para sempre
      expect(await kinds(a.id)).toEqual(['conference_started']);
    });

    it('A25-2 fim: depois do fim marcado, "ficou sabendo" do fim = relógio do job e o atraso sai de uma consulta; sem conferência, nada', async () => {
      const a = await appt();
      const vazia = await appt();
      fake.setRecords(a.code, [{ name: 'conferenceRecords/c1', startTime: at(1), endTime: at(44) }]);
      await job(50);
      const r = await row(a.id);
      expect(r).toMatchObject({ import_status: 'pending', atraso_fim_s: 6 * 60 });
      expect(iso(r.conference_ended_at)).toBe(at(44).toISOString());
      expect(iso(r.conference_end_seen_at)).toBe(at(50).toISOString());
      expect(await kinds(a.id)).toEqual(['conference_ended', 'conference_started']);
      // controle: reunião sem conferência não ganha "ficou sabendo" de nada
      const v = await row(vazia.id);
      expect(v.conference_start_seen_at).toBeNull();
      expect(v.conference_end_seen_at).toBeNull();
    });

    it('A25-3 fila da rede: fim cedo SEM pending volta à fila e a rede decide o fim depois do fim marcado; com pending NÃO volta', async () => {
      const cedo = await appt({ endedMin: 20, importStatus: null }); // fim das 10:20 gravado pelo job de 1 min, não armado
      const decidida = await appt({ endedMin: 44, importStatus: 'pending' }); // controle: fim e pending
      fake.setRecords(cedo.code, [{ name: 'conferenceRecords/c1', startTime: at(1), endTime: at(44) }]);
      fake.setRecords(decidida.code, [{ name: 'conferenceRecords/d1', startTime: at(1), endTime: at(44) }]);

      await job(30); // antes do fim marcado: a rede OLHA a reunião (volta à fila) mas só espera
      expect(fake.listCalls).toContain(`spaces/${cedo.code}`);
      expect(fake.listCalls).not.toContain(`spaces/${decidida.code}`);
      expect(await kinds(cedo.id)).toEqual(['conference_started']);
      expect(iso((await row(cedo.id)).conference_ended_at)).toBe(at(20).toISOString()); // o fim cedo segue como estava
      expect((await row(cedo.id)).import_status).toBeNull();

      await job(50); // depois do fim marcado: grava o fim e pending, 1 evento
      const r = await row(cedo.id);
      expect(r.import_status).toBe('pending');
      expect(iso(r.conference_ended_at)).toBe(at(44).toISOString());
      expect(iso(r.conference_end_seen_at)).toBe(at(50).toISOString());
      expect((await kinds(cedo.id)).filter((k) => k === 'conference_ended')).toHaveLength(1);

      await job(51); // agora tem pending: sai da fila
      expect((await kinds(cedo.id)).filter((k) => k === 'conference_ended')).toHaveLength(1);
      // controle: a que já tinha fim e pending nunca voltou
      expect(await kinds(decidida.id)).toEqual([]);
      expect((await row(decidida.id)).conference_end_seen_at).toBeNull();
    });
  });
}
