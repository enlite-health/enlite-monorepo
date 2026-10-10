/**
 * admissionPaisHarness — spec 050 F7, R-31: isolamento por país da aba Admissão, provado com o PAPEL DO RUNTIME.
 *
 * O MESMO conjunto de cenários roda em dois arquivos, mudando SÓ quem conecta ao banco:
 *   - `admission-050-pais-runtime.e2e.test.ts` → login membro de `app_runtime` (como a API em stg/prd): staff AR mexendo
 *     em paciente BR leva 404 nos 4 verbos (listar, agendar, cancelar, reenviar); o paciente AR (controle) passa.
 *   - `admission-050-pais-dono.e2e.test.ts` → a conexão do dono do banco (bypassa RLS): os MESMOS pedidos NÃO devolvem 404.
 *     É o controle que prova que o teste mede a regra de RLS (e não um 404 de outra origem: id inventado, rota errada).
 *
 * Um arquivo por conexão porque o `DatabaseConnection` é singleton por processo (jest isola o registro de módulos por arquivo).
 * Dados 100% sintéticos (@example.test); Google, Twilio e Cloud Tasks são dublês. Nada toca canal real.
 */
import { Pool } from 'pg';
import { DateTime } from 'luxon';
import { montarAppDeFamilia, tokenMock, type AppDeFamilia } from './permissionFamilyHarness';
import { ensureLoginRole, dropLoginRoles, urlFor } from './loginRoles';
import { FakeAdmissionCalendar } from '../../../src/modules/matching/infrastructure/doubles/FakeAdmissionCalendar';
import { InMemoryAdmissionReminderTasks } from '../../../src/modules/matching/infrastructure/doubles/InMemoryAdmissionReminderTasks';
import { RecordingAdmissionWhatsApp } from '../../../src/modules/matching/infrastructure/doubles/RecordingAdmissionWhatsApp';
import { capturingLogger } from '../../../src/modules/matching/infrastructure/doubles/admissionTestKit';
import { FakeTactiqMcp, FakeTactiqOAuth } from '../../../src/modules/matching/infrastructure/doubles/FakeTactiq';

const DATABASE_URL =
  process.env.TEST_DATABASE_URL ||
  process.env.DATABASE_URL ||
  'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

export type ConexaoPais = 'runtime' | 'dono';

const TENANT = '00000000-0000-0000-0000-000000000001';
const SENHA = 'adm050_pais_pw';

export function definirCenariosPais(conexao: ConexaoPais, sufixo: string): void {
  const RUNTIME_USER = `adm050pais_rt_${sufixo}`;
  const SYSTEM_USER = `adm050pais_sys_${sufixo}`;
  const STAFF = { uid: `adm050-pais-staff-${sufixo}`, email: `adm050-pais-staff-${sufixo}@e2e.local` };
  const HOST_AR = `ana.ar.${sufixo}@example.test`;
  const HOST_BR = `bia.br.${sufixo}@example.test`;
  const CAL_AR = `cal-ar-${sufixo}@example.test`;
  const CAL_BR = `cal-br-${sufixo}@example.test`;
  const FAMILY_EMAIL = `familia.${sufixo}@example.test`;

  describe(`isolamento por país da aba Admissão — HTTP real, conexão: ${conexao} (spec 050 F7, R-31)`, () => {
    let admin: Pool;
    let app: AppDeFamilia;
    let whatsapp: RecordingAdmissionWhatsApp;
    let calendar: FakeAdmissionCalendar;
    const patients: string[] = [];
    let patientBR: string;
    let patientAR: string;
    let apptBR: string;
    let apptAR: string;
    const envAnterior: Record<string, string | undefined> = {};
    let dayOffset = 20 + Math.floor(Math.random() * 200);

    function setEnv(k: string, v: string | undefined): void {
      if (!(k in envAnterior)) envAnterior[k] = process.env[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }

    const nextSlot = (): string => {
      dayOffset += 1;
      return DateTime.now().setZone('America/Argentina/Buenos_Aires').plus({ days: dayOffset }).set({ hour: 11, minute: 0, second: 0, millisecond: 0 }).toISO() as string;
    };

    /** Staff com claim de país AR — o país da CONTA, que a RLS lê (o paciente BR não é dele). */
    async function http(method: string, path: string, body?: unknown) {
      const res = await fetch(`${app.url}${path}`, {
        method,
        headers: { Authorization: tokenMock(STAFF.uid, 'admin', 'AR'), 'Content-Type': 'application/json' },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, any> };
    }

    async function newPatient(country: 'AR' | 'BR'): Promise<string> {
      const { rows } = await admin.query(
        `INSERT INTO patients (clickup_task_id, first_name, last_name, country, is_test, phone_whatsapp, has_consent, contact_email_encrypted)
         VALUES ($1,'Carla','Sintetico',$2,false,'+5491100000000',true,'cipher') RETURNING id`,
        [`e2e-050-pais-${sufixo}-${country}-${patients.length}`, country],
      );
      patients.push(rows[0].id);
      return rows[0].id;
    }

    /** Reunião futura `booked` com a confirmação em `send_failed` (reenviável). */
    async function newAppt(patientId: string, country: 'AR' | 'BR', host: string, n: number): Promise<string> {
      const start = DateTime.now().plus({ days: 3 + n }).set({ hour: 14, minute: 0, second: 0, millisecond: 0 });
      const { rows } = await admin.query(
        `INSERT INTO admission_appointments (patient_id, country, host_email, host_display_name, slot_start, slot_end, status, meet_link, admission_code, created_via)
         VALUES ($1,$2,$3,'Equipo',$4,$5,'booked','https://meet.google.com/abc-defg-hij',$6,'panel') RETURNING id`,
        [patientId, country, host, start.toJSDate(), start.plus({ minutes: 30 }).toJSDate(), `ADM-${sufixo.toUpperCase().slice(0, 4)}${country}${n}`.slice(0, 10)],
      );
      await admin.query(`INSERT INTO admission_messages (appointment_id, kind, attempt, status) VALUES ($1,'confirmation',0,'send_failed')`, [rows[0].id]);
      return rows[0].id;
    }

    const base = (p: string) => `/api/admin/patients/${p}/admission-appointments`;
    const countAppts = async (p: string) =>
      (await admin.query(`SELECT count(*)::int AS n FROM admission_appointments WHERE patient_id = $1`, [p])).rows[0].n as number;
    const statusOf = async (id: string) => (await admin.query(`SELECT status FROM admission_appointments WHERE id = $1`, [id])).rows[0].status as string;
    const msgCount = async (id: string) =>
      (await admin.query(`SELECT count(*)::int AS n FROM admission_messages WHERE appointment_id = $1`, [id])).rows[0].n as number;

    async function limpar(): Promise<void> {
      if (patients.length) {
        await admin.query(`DELETE FROM admission_appointments WHERE patient_id = ANY($1)`, [patients]);
        await admin.query(`DELETE FROM patients WHERE id = ANY($1)`, [patients]);
      }
      await admin.query('DELETE FROM interview_hosts WHERE email = ANY($1)', [[HOST_AR, HOST_BR]]);
      await admin.query('DELETE FROM tactiq_links WHERE lower(host_email) = ANY($1)', [[HOST_AR, HOST_BR]]);
      await admin.query('DELETE FROM users WHERE firebase_uid = $1', [STAFF.uid]);
    }

    beforeAll(async () => {
      admin = new Pool({ connectionString: DATABASE_URL });
      await ensureLoginRole(admin, RUNTIME_USER, SENHA, 'app_runtime');
      await ensureLoginRole(admin, SYSTEM_USER, SENHA, 'app_system');
      await limpar();

      // Quem conecta é a ÚNICA diferença entre os dois arquivos. O pool de sistema só existe no modo runtime (como em stg/prd).
      setEnv('DATABASE_URL', conexao === 'runtime' ? urlFor(DATABASE_URL, RUNTIME_USER, SENHA) : DATABASE_URL);
      setEnv('DATABASE_SYSTEM_URL', conexao === 'runtime' ? urlFor(DATABASE_URL, SYSTEM_USER, SENHA) : undefined);
      setEnv('COUNTRY_RLS_ENABLED', 'true');
      setEnv('USE_MOCK_AUTH', 'true');
      setEnv('DB_POOL_MAX', '4');
      setEnv('DB_SYSTEM_POOL_MAX', '2');
      setEnv('ADMISSION_HOST_ROSTER_ENABLED', 'true');
      setEnv('ADMISSION_CALENDAR_ID_AR', CAL_AR);
      setEnv('ADMISSION_CALENDAR_ID_BR', CAL_BR);
      setEnv('TWILIO_TEMPLATE_ADMISSION_CONFIRMATION_ES', 'HX_CONF_ES_E2E');
      setEnv('TWILIO_TEMPLATE_ADMISSION_REMINDER_ES', 'HX_REM_ES_E2E');
      setEnv('TWILIO_TEMPLATE_ADMISSION_CONFIRMATION_PT', 'HX_CONF_PT_E2E');
      setEnv('TWILIO_TEMPLATE_ADMISSION_REMINDER_PT', 'HX_REM_PT_E2E');
      setEnv('TWILIO_STATUS_CALLBACK_URL', undefined);

      await admin.query(
        `INSERT INTO users (firebase_uid, email, role, status, is_active, tenant_id) VALUES ($1,$2,'admin','ACTIVE',true,$3)`,
        [STAFF.uid, STAFF.email, TENANT],
      );
      await admin.query(
        `INSERT INTO interview_hosts (email, display_name, country, active) VALUES ($1,'Ana','AR',true), ($2,'Bia','BR',true)`,
        [HOST_AR, HOST_BR],
      );
      await admin.query(
        `INSERT INTO tactiq_links (host_email, firebase_uid, status) VALUES ($1,$3,'linked'), ($2,$4,'linked')`,
        [HOST_AR, HOST_BR, `tq-ar-${sufixo}`, `tq-br-${sufixo}`],
      );
      patientBR = await newPatient('BR');
      patientAR = await newPatient('AR');
      apptBR = await newAppt(patientBR, 'BR', HOST_BR, 1);
      apptAR = await newAppt(patientAR, 'AR', HOST_AR, 2);

      calendar = new FakeAdmissionCalendar();
      whatsapp = new RecordingAdmissionWhatsApp();
      const tasks = new InMemoryAdmissionReminderTasks();
      const logs = capturingLogger();

      const [identity, { DatabaseConnection }] = await Promise.all([import('@modules/identity'), import('@shared/database/DatabaseConnection')]);
      // O AuthMiddleware de PRODUÇÃO (MultiAuthService): é ele que liga o claim `country` ao contexto de banco que a policy lê.
      const auth = new identity.AuthMiddleware(
        new identity.MultiAuthService({ enableApiKeys: true, enableJwt: false, enableGoogleIdToken: true }, DatabaseConnection.getInstance().getPool()),
        new identity.SimplifiedAuthorizationEngine(),
      );

      app = await montarAppDeFamilia({
        auth,
        montarRotas: async ({ app: express, auth: authMw, permissions }) => {
          const { AdmissionSchedulingService } = await import('../../../src/modules/matching/application/AdmissionSchedulingService');
          const { AdmissionMessagingService } = await import('../../../src/modules/matching/application/AdmissionMessagingService');
          const { AdmissionPanelService } = await import('../../../src/modules/matching/application/AdmissionPanelService');
          const { AdmissionPanelController } = await import('../../../src/modules/matching/interfaces/controllers/AdmissionPanelController');
          const { createAdminAdmissionRoutes } = await import('../../../src/modules/matching/interfaces/routes/adminAdmissionRoutes');
          const { AdmissionEventRepository } = await import('../../../src/modules/matching/infrastructure/AdmissionEventRepository');
          const { AdmissionMessageRepository } = await import('../../../src/modules/matching/infrastructure/AdmissionMessageRepository');
          const { AdmissionMessageContent } = await import('../../../src/modules/matching/infrastructure/AdmissionMessageContent');
          const { RealAdmissionNotifier } = await import('../../../src/modules/matching/infrastructure/RealAdmissionNotifier');
          const { interviewHostRepository } = await import('../../../src/modules/matching/infrastructure/InterviewHostRepository');
          const { TactiqLinkService } = await import('../../../src/modules/matching/application/TactiqLinkService');
          const { TactiqLinkRepository } = await import('../../../src/modules/matching/infrastructure/TactiqLinkRepository');

          const pool = DatabaseConnection.getInstance().getPool();
          const events = new AdmissionEventRepository(pool);
          const content = new AdmissionMessageContent(pool);
          const messaging = new AdmissionMessagingService(new AdmissionMessageRepository(pool), events, whatsapp, content, logs.log);
          const notifier = new RealAdmissionNotifier(messaging, content, tasks, events, pool, () => new Date(), logs.log);
          const tactiq = new TactiqLinkService({ repo: new TactiqLinkRepository(pool), oauth: new FakeTactiqOAuth(), mcp: new FakeTactiqMcp(), db: pool });
          const encryption = { decrypt: async () => FAMILY_EMAIL } as never;
          const scheduling = new AdmissionSchedulingService(calendar, notifier, encryption, 'enlite@enlite.health', interviewHostRepository, tactiq);
          const panel = new AdmissionPanelService({
            db: pool, calendar, reminderTasks: tasks, events, messaging, hosts: interviewHostRepository, tactiq,
            impersonateEmail: 'enlite@enlite.health', log: logs.log,
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

    it('0. sanidade: o banco tem os 2 pacientes e as 2 reuniões (o 404 abaixo não é banco vazio) e a conexão é a que o arquivo declara', async () => {
      const { rows } = await admin.query(`SELECT count(*)::int AS n FROM admission_appointments WHERE id = ANY($1)`, [[apptBR, apptAR]]);
      expect(rows[0].n).toBe(2);
      const { DatabaseConnection } = await import('@shared/database/DatabaseConnection');
      const who = await DatabaseConnection.getInstance().getRawPool().query('SELECT current_user AS u');
      expect(who.rows[0].u).toBe(conexao === 'runtime' ? RUNTIME_USER : new URL(DATABASE_URL).username);
    });

    if (conexao === 'runtime') {
      describe('A7-2: papel do runtime — paciente de OUTRO país → 404 nos 4 verbos, sem efeito algum', () => {
        it('listar → 404', async () => {
          expect((await http('GET', base(patientBR))).status).toBe(404);
        });

        it('agendar → 404 e nenhuma reunião, nenhum evento no Google, nenhum envio', async () => {
          const eventsBefore = calendar.created?.length ?? 0;
          const res = await http('POST', base(patientBR), { hostEmail: HOST_BR, slotStartISO: nextSlot() });
          expect(res.status).toBe(404);
          expect(await countAppts(patientBR)).toBe(1); // só a semeada
          expect(calendar.created?.length ?? 0).toBe(eventsBefore);
        });

        it('cancelar → 404 e a reunião segue booked', async () => {
          const res = await http('POST', `${base(patientBR)}/${apptBR}/cancel`);
          expect(res.status).toBe(404);
          expect(await statusOf(apptBR)).toBe('booked');
        });

        it('reenviar → 404, 0 envios e nenhuma tentativa nova', async () => {
          const sent = whatsapp.calls.length;
          const res = await http('POST', `${base(patientBR)}/${apptBR}/messages/confirmation/resend`);
          expect(res.status).toBe(404);
          expect(whatsapp.calls.length).toBe(sent);
          expect(await msgCount(apptBR)).toBe(1);
        });
      });

      describe('A7-2 (controle positivo): o MESMO staff, no PRÓPRIO país, passa nos mesmos verbos', () => {
        it('listar → 200 com a reunião; agendar → 201; reenviar → 200 e 1 envio; cancelar → 200', async () => {
          const list = await http('GET', base(patientAR));
          expect(list.status).toBe(200);
          expect(list.body.data).toHaveLength(1);

          const book = await http('POST', base(patientAR), { hostEmail: HOST_AR, slotStartISO: nextSlot() });
          expect(book.status).toBe(201);

          const sent = whatsapp.calls.length;
          const resend = await http('POST', `${base(patientAR)}/${apptAR}/messages/confirmation/resend`);
          expect(resend.status).toBe(200);
          expect(whatsapp.calls.length).toBe(sent + 1);

          const cancel = await http('POST', `${base(patientAR)}/${apptAR}/cancel`);
          expect(cancel.status).toBe(200);
          expect(await statusOf(apptAR)).toBe('cancelled');
        });
      });
    } else {
      describe('A7-2 (controle): a conexão do DONO não devolve 404 — o teste mede a regra de RLS, não um 404 de outra origem', () => {
        it('listar → 200 com a reunião do paciente BR', async () => {
          const res = await http('GET', base(patientBR));
          expect(res.status).toBe(200);
          expect(res.body.data).toHaveLength(1);
        });

        it('agendar → 201 e a reunião nasce', async () => {
          const res = await http('POST', base(patientBR), { hostEmail: HOST_BR, slotStartISO: nextSlot() });
          expect(res.status).toBe(201);
          expect(await countAppts(patientBR)).toBe(2);
        });

        it('reenviar → 200 e 1 envio', async () => {
          const sent = whatsapp.calls.length;
          const res = await http('POST', `${base(patientBR)}/${apptBR}/messages/confirmation/resend`);
          expect(res.status).toBe(200);
          expect(whatsapp.calls.length).toBe(sent + 1);
        });

        it('cancelar → 200 e a reunião vira cancelled', async () => {
          const res = await http('POST', `${base(patientBR)}/${apptBR}/cancel`);
          expect(res.status).toBe(200);
          expect(await statusOf(apptBR)).toBe('cancelled');
        });
      });
    }
  });
}
