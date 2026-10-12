/**
 * admissionAndamentoHarness — spec 050 F29 (A29-2): o ANDAMENTO da reunião (`callProgress`) que a lista da aba devolve, pela ROTA REAL
 * (`GET /api/admin/patients/:id/admission-appointments`, middlewares de verdade), com o PAPEL DO RUNTIME e com o DONO (controle).
 * O MESMO conjunto roda em `-runtime` (login membro de `app_runtime`, `COUNTRY_RLS_ENABLED=true`, como a API na stage) e `-dono`.
 * Dados sintéticos (@example.test); instantes FIXOS; nada toca canal real.
 */
import { Pool } from 'pg';
import { montarAppDeFamilia, tokenMock, type AppDeFamilia } from './permissionFamilyHarness';
import { ensureLoginRole, dropLoginRoles, urlFor } from './loginRoles';
import { FakeAdmissionCalendar } from '../../../src/modules/matching/infrastructure/doubles/FakeAdmissionCalendar';
import { FakeTactiqMcp, FakeTactiqOAuth } from '../../../src/modules/matching/infrastructure/doubles/FakeTactiq';

const DATABASE_URL =
  process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

export type ConexaoAndamento = 'runtime' | 'dono';

const TENANT = '00000000-0000-0000-0000-000000000001';
const SENHA = 'adm050_and_pw';

const iso = (h: number, m = 0): string => new Date(Date.UTC(2026, 9, 12, h, m)).toISOString();

export function definirCenariosAndamento(conexao: ConexaoAndamento, sufixo: string): void {
  const RUNTIME_USER = `adm050and_rt_${sufixo}`;
  const SYSTEM_USER = `adm050and_sys_${sufixo}`;
  const STAFF = { uid: `adm050-and-staff-${sufixo}`, email: `adm050-and-staff-${sufixo}@e2e.local` };
  const OUTRO = { uid: `adm050-and-br-${sufixo}`, email: `adm050-and-br-${sufixo}@e2e.local` };
  const HOST = `ana.and.${sufixo}@example.test`;

  describe(`F29 — andamento da reunião na lista da aba, HTTP real, conexão: ${conexao}`, () => {
    let admin: Pool;
    let app: AppDeFamilia;
    let patientId = '';
    let seq = 0;
    const envAnterior: Record<string, string | undefined> = {};
    function setEnv(k: string, v: string | undefined): void {
      if (!(k in envAnterior)) envAnterior[k] = process.env[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }

    const lista = async (uid = STAFF.uid, country = 'AR'): Promise<{ status: number; itens: Array<Record<string, any>> }> => {
      const res = await fetch(`${app.url}/api/admin/patients/${patientId}/admission-appointments`, { headers: { Authorization: tokenMock(uid, 'admin', country) } });
      const body = (await res.json().catch(() => ({}))) as { data?: Array<Record<string, any>> };
      return { status: res.status, itens: body.data ?? [] };
    };

    interface Semente { inicio?: string | null; fim?: string | null; importStatus?: string | null; documento?: string | null; reaberturaDepoisDoResumo?: string | null }
    /** Semeia uma reunião com os fatos do andamento (instantes fixos de 12/10/2026). */
    async function semear(s: Semente): Promise<string> {
      seq += 1;
      const id = (await admin.query(
        `INSERT INTO admission_appointments (patient_id, country, host_email, host_display_name, slot_start, slot_end, status, meet_link, admission_code,
                                             conference_started_at, conference_ended_at, import_status, created_at)
         VALUES ($1,'AR',$2,'Operadora Sintetica', $3::timestamptz + make_interval(days => $4), $3::timestamptz + make_interval(days => $4, mins => 45), 'booked',
                 $5, 'ADM-' || upper(substr(md5(random()::text), 1, 6)), $6::timestamptz, $7::timestamptz, $8, now() - interval '3 days') RETURNING id`,
        [patientId, `ana.and.${sufixo}.${seq}@example.test`, iso(14), seq, `https://meet.google.com/and-${sufixo}${seq}-xyz`, s.inicio ?? null, s.fim ?? null, s.importStatus ?? null],
      )).rows[0].id as string;
      if (s.documento) {
        await admin.query(
          `INSERT INTO patient_documents (patient_id, origin, label_encrypted, file_path_encrypted, original_name_encrypted, content_type, size_bytes, sha256, created_by_uid, source_appointment_id, created_at)
           VALUES ($1,'admission','enc:resumo','enc:p','enc:n','application/pdf',10,'\\x00','e050-and',$2,$3::timestamptz)`,
          [patientId, id, s.documento],
        );
      }
      if (s.reaberturaDepoisDoResumo) {
        await admin.query(
          `INSERT INTO admission_events (appointment_id, kind, outcome, reason, at) VALUES ($1,'conference_reopened','reopened','after_summary',$2::timestamptz)`,
          [id, s.reaberturaDepoisDoResumo],
        );
      }
      return id;
    }

    async function limpar(): Promise<void> {
      await admin.query(`DELETE FROM patient_documents WHERE created_by_uid = 'e050-and' AND patient_id IN (SELECT id FROM patients WHERE clickup_task_id = $1)`, [`e2e-050-and-${sufixo}`]);
      await admin.query(`DELETE FROM admission_appointments WHERE host_email LIKE $1`, [`ana.and.${sufixo}.%@example.test`]);
      await admin.query(`DELETE FROM patients WHERE clickup_task_id = $1`, [`e2e-050-and-${sufixo}`]);
      await admin.query('DELETE FROM users WHERE firebase_uid = ANY($1)', [[STAFF.uid, OUTRO.uid]]);
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
      for (const u of [STAFF, OUTRO]) {
        await admin.query(`INSERT INTO users (firebase_uid, email, role, status, is_active, tenant_id) VALUES ($1,$2,'admin','ACTIVE',true,$3)`, [u.uid, u.email, TENANT]);
      }
      patientId = (await admin.query(
        `INSERT INTO patients (clickup_task_id, first_name, last_name, country, is_test, has_consent) VALUES ($1,'Carla','Sintetico','AR',false,true) RETURNING id`,
        [`e2e-050-and-${sufixo}`],
      )).rows[0].id;

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
        },
      });
    }, 90000);

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

    it('0. sanidade: a conexão é a que o arquivo declara', async () => {
      const { DatabaseConnection } = await import('@shared/database/DatabaseConnection');
      const raw = DatabaseConnection.getInstance().getRawPool();
      expect((await raw.query('SELECT current_user AS u')).rows[0].u).toBe(conexao === 'runtime' ? RUNTIME_USER : new URL(DATABASE_URL).username);
    });

    it('A29-2: os 5 estados semeados chegam certos pela rota (estado + hora do dono da regra), e o vazio chega como none', async () => {
      const emCurso = await semear({ inicio: iso(14, 2) });
      const terminou = await semear({ inicio: iso(14, 2), fim: iso(14, 40), importStatus: null }); // fim cedo/silêncio: sem armar
      const preparando = await semear({ inicio: iso(14, 2), fim: iso(14, 40), importStatus: 'pending' });
      const pronto = await semear({ inicio: iso(14, 2), fim: iso(14, 40), importStatus: 'done', documento: iso(14, 47) });
      const reaberta = await semear({ inicio: iso(14, 2), fim: iso(14, 40), importStatus: 'done', documento: iso(14, 47), reaberturaDepoisDoResumo: iso(15, 3) });
      const vazia = await semear({});

      const { status, itens } = await lista();
      expect(status).toBe(200);
      const de = (id: string) => itens.find((i) => i.id === id)!.callProgress;
      expect(de(emCurso)).toEqual({ state: 'in_progress', at: iso(14, 2) });
      expect(de(terminou)).toEqual({ state: 'ended', at: iso(14, 40) });
      expect(de(preparando)).toEqual({ state: 'summary_preparing', at: iso(14, 40) });
      expect(de(pronto)).toEqual({ state: 'summary_ready', at: iso(14, 47) }); // a hora é a do DOCUMENTO, não a do fim
      expect(de(reaberta)).toEqual({ state: 'reopened_after_summary', at: iso(15, 3) });
      expect(de(vazia)).toEqual({ state: 'none', at: null });
      // só acréscimo: os campos que já existiam seguem com o mesmo nome e a mesma forma
      const ja = itens.find((i) => i.id === pronto)!;
      expect(ja.conferenceStartedAt).toBe(iso(14, 2));
      expect(ja.conferenceEndedAt).toBe(iso(14, 40));
      expect(ja.seals.document).toEqual({ id: expect.any(String) });
      expect(ja.seals.import).toBe('done');
    });

    if (conexao === 'runtime') {
      it('A29-2: staff de OUTRO país não vê a reunião (404), e o mesmo staff do país certo vê (controle)', async () => {
        await semear({ inicio: iso(14, 2) });
        const outro = await lista(OUTRO.uid, 'BR');
        expect(outro.status).toBe(404);
        expect(outro.itens).toEqual([]);
        const certo = await lista(STAFF.uid, 'AR');
        expect(certo.status).toBe(200);
        expect(certo.itens.length).toBeGreaterThanOrEqual(1);
      });
    }
  });
}
