/**
 * admissionLiveJobHarness — spec 050, 4º passo, F26 (R-44 a R-46, R-49, R-50, R-55, R-56): o job de 1 minuto na ROTA HTTP real
 * (`POST /api/internal/jobs/admission-live`, com `systemContextMiddleware` e `internalAuthMiddleware` de verdade), com o PAPEL DO RUNTIME.
 *
 * O MESMO conjunto roda em dois arquivos, mudando SÓ quem conecta (`-runtime`: login membro de `app_runtime` + pool de sistema
 * `app_system`, RLS de país ligada, como a stage; `-dono`: controle, bypassa RLS, como a produção). Meet = dublê; o RELÓGIO é um
 * parâmetro (`clock`, minutos depois das 10:00 de um dia fixo), nunca espera real. Dados sintéticos (@example.test). Nada toca canal real.
 *
 * A26-1 início em até 2 min (entra 15 min antes) · A26-2 fim 20 min antes do marcado (a rede só espera) · A26-4 saída e volta antes do
 * resumo · A26-5 resumo `done` só ganha o evento · A26-6 fim cedo demais não arma · A26-8 segredo e só contagens · A26-9 sentinela.
 */
import { Pool } from 'pg';
import { montarAppDeFamilia, type AppDeFamilia } from './permissionFamilyHarness';
import { ensureLoginRole, dropLoginRoles, urlFor } from './loginRoles';
import { LiveFixtures } from './admissionLiveFixtures';
import { FakeMeetConference } from '../../../src/modules/matching/infrastructure/doubles/FakeMeetConference';
import { capturingLogger } from '../../../src/modules/matching/infrastructure/doubles/admissionTestKit';
import { AdmissionImportRepository } from '../../../src/modules/matching/infrastructure/AdmissionImportRepository';

const DATABASE_URL =
  process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

export type ConexaoJob = 'runtime' | 'dono';

const SENHA = 'adm050_job_pw';
const SECRET = 'test-secret-for-e2e-only';
const MIN = 60_000;
/** Dia fixo e distante: o relógio do job é este, não o da máquina. Reunião marcada das 10:00 às 10:45. */
const T0 = new Date('2031-04-14T10:00:00Z');
const at = (min: number): Date => new Date(T0.getTime() + min * MIN);
const SENTINELA = 'Quixotrium';
const TELEFONE = '+5491155550199';

export const CHAVES_DO_RESUMO = [
  'applied', 'candidates', 'ended', 'endedEarly', 'errors', 'noMeetLink', 'reopened', 'reopenedAfterSummary', 'scopeMissing',
  'skippedImporting', 'skippedLocked', 'skippedTest', 'started', 'transient', 'waiting',
];

export function definirCenariosJobVivo(conexao: ConexaoJob, sufixo: string): void {
  const RUNTIME_USER = `adm050jb_rt_${sufixo}`;
  const SYSTEM_USER = `adm050jb_sys_${sufixo}`;

  describe(`F26 — job de 1 minuto sob RLS, HTTP real, conexão: ${conexao}`, () => {
    let admin: Pool;
    let app: AppDeFamilia;
    let fx: LiveFixtures;
    let fake: FakeMeetConference;
    let clock = at(0);
    const logs = capturingLogger();
    const envAnterior: Record<string, string | undefined> = {};
    function setEnv(k: string, v: string | undefined): void {
      if (!(k in envAnterior)) envAnterior[k] = process.env[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }

    const chamar = async (rota: string, min: number, segredo: string | null = SECRET): Promise<{ status: number; data: Record<string, number>; texto: string }> => {
      clock = at(min);
      const res = await fetch(`${app.url}/api/internal/jobs/${rota}`, { method: 'POST', headers: segredo ? { 'X-Internal-Secret': segredo } : {} });
      const texto = await res.text();
      let data: Record<string, number> = {};
      try { data = (JSON.parse(texto) as { data?: Record<string, number> }).data ?? {}; } catch { /* corpo sem JSON */ }
      return { status: res.status, data, texto };
    };
    const vivo = (min: number) => chamar('admission-live', min);
    const rede = (min: number) => chamar('admission-post-call', min);

    /** Reunião (início/fim marcados em minutos de T0) e o código do Meet dela. */
    async function reuniao(inicioMin: number, fimMin: number, extra: Partial<Parameters<LiveFixtures['semear']>[0]> = {}): Promise<{ id: string; code: string }> {
      const id = await fx.semear({ inicioMin, fimMin, ...extra });
      const link = (await admin.query(`SELECT meet_link FROM admission_appointments WHERE id = $1`, [id])).rows[0].meet_link as string;
      return { id, code: link.split('/').pop() as string };
    }
    const conf = (n: string, ini: number, fim: number | null) => ({ name: `conferenceRecords/${n}`, startTime: at(ini), endTime: fim === null ? null : at(fim) });
    const row = async (id: string) =>
      (await admin.query(
        `SELECT import_status, summary_fast_state, summary_fast_reads, conference_started_at, conference_ended_at, conference_start_seen_at, conference_end_seen_at,
                extract(epoch FROM (conference_start_seen_at - conference_started_at))::int AS atraso_inicio_s,
                extract(epoch FROM (conference_end_seen_at - conference_ended_at))::int AS atraso_fim_s
           FROM admission_appointments WHERE id = $1`,
        [id],
      )).rows[0];
    const kinds = async (id: string): Promise<string[]> =>
      (await admin.query(`SELECT kind || coalesce(':' || reason, '') AS k FROM admission_events WHERE appointment_id = $1 ORDER BY kind`, [id])).rows.map((r) => r.k);
    const iso = (d: Date | null): string | null => (d ? new Date(d).toISOString() : null);

    beforeAll(async () => {
      admin = new Pool({ connectionString: DATABASE_URL });
      await ensureLoginRole(admin, RUNTIME_USER, SENHA, 'app_runtime');
      await ensureLoginRole(admin, SYSTEM_USER, SENHA, 'app_system');
      fx = new LiveFixtures(admin, sufixo, T0);
      await fx.iniciar();
      setEnv('DATABASE_URL', conexao === 'runtime' ? urlFor(DATABASE_URL, RUNTIME_USER, SENHA) : DATABASE_URL);
      setEnv('DATABASE_SYSTEM_URL', conexao === 'runtime' ? urlFor(DATABASE_URL, SYSTEM_USER, SENHA) : undefined);
      setEnv('COUNTRY_RLS_ENABLED', 'true');
      setEnv('USE_MOCK_AUTH', 'true');
      setEnv('DB_POOL_MAX', '4');
      setEnv('DB_SYSTEM_POOL_MAX', '2');
      setEnv('INTERNAL_TOKEN_SECRET', SECRET);
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
          const { AdmissionLiveJob } = await import('../../../src/modules/matching/application/AdmissionLiveJob');
          const { AdmissionLiveRepository } = await import('../../../src/modules/matching/infrastructure/AdmissionLiveRepository');
          const { AdmissionLiveInternalController } = await import('../../../src/modules/matching/interfaces/controllers/AdmissionLiveInternalController');
          const { createAdmissionLiveInternalRoutes } = await import('../../../src/modules/matching/interfaces/routes/admissionLiveRoutes');
          const { systemContextMiddleware } = await import('@shared/database/systemContextMiddleware');
          const { internalAuthMiddleware } = await import('@modules/notification');

          const pool = DatabaseConnection.getInstance().getPool();
          const events = new AdmissionEventRepository(pool);
          const postCall = new AdmissionPostCallRepository(pool);
          // A ORDEM e os middlewares são os de `registerAdmissionInternalJobRoutes`: post-call, depois o job de 1 min.
          express.use(
            '/api/internal', systemContextMiddleware('job:admission-post-call'), internalAuthMiddleware,
            createAdmissionPostCallInternalRoutes(new AdmissionPostCallInternalController(new AdmissionPostCallJob({ repo: postCall, meet: fake, events, db: pool, log: logs.log, now: () => clock }))),
          );
          express.use(
            '/api/internal', systemContextMiddleware('job:admission-live'), internalAuthMiddleware,
            createAdmissionLiveInternalRoutes(new AdmissionLiveInternalController(new AdmissionLiveJob({ live: new AdmissionLiveRepository(pool), postCall, meet: fake, events, db: pool, log: logs.log, now: () => clock }))),
          );
        },
      });
    }, 90000);

    beforeEach(() => fake.reset());

    afterAll(async () => {
      await app?.fechar();
      const { DatabaseConnection } = await import('@shared/database/DatabaseConnection');
      await DatabaseConnection.getInstance().close();
      await fx.limpar();
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
      const semContexto = raw.query(`SELECT count(*)::int AS n FROM patients`);
      if (conexao === 'runtime') await expect(semContexto).rejects.toThrow(/rls_session_without_identity/);
      else expect((await semContexto).rows[0].n).toBeGreaterThanOrEqual(0);
    });

    it('A26-8: com o segredo → 200 e SÓ contagens (as chaves são as combinadas); sem segredo e com segredo errado → recusada', async () => {
      const ok = await vivo(0);
      expect(ok.status).toBe(200);
      expect(Object.keys(ok.data).sort()).toEqual(CHAVES_DO_RESUMO);
      expect(Object.values(ok.data).every((v) => typeof v === 'number')).toBe(true);
      expect((await chamar('admission-live', 0, null)).status).toBe(403);
      expect((await chamar('admission-live', 0, 'errado')).status).toBe(403);
      // controle: a rota do job de 15 min recusa do mesmo jeito (a recusa é a do middleware, não um 404)
      expect((await chamar('admission-post-call', 0, null)).status).toBe(403);
    });

    it('A26-1 (R-44): conferência abre 5 min ANTES da hora; a execução 1 min depois grava o início e o "ficou sabendo" com atraso ≤ 2 min', async () => {
      const a = await reuniao(10, 55); // marcada 10:10–10:55; a sala abre às 10:05 (entra na janela 15 min antes)
      fake.setRecords(a.code, [conf('c1', 5, null)]);
      const s = await vivo(6);
      expect(s.status).toBe(200);
      expect(s.data.started).toBeGreaterThanOrEqual(1);
      const r = await row(a.id);
      expect(iso(r.conference_started_at)).toBe(at(5).toISOString());
      expect(iso(r.conference_start_seen_at)).toBe(at(6).toISOString());
      expect(r.atraso_inicio_s).toBeLessThanOrEqual(120);
      expect(await kinds(a.id)).toEqual(['conference_started']);
      await vivo(7); // 2ª execução: não repete
      expect(await kinds(a.id)).toEqual(['conference_started']);
    });

    it('A26-2 (R-45): fim 20 min antes do marcado → fim, "ficou sabendo" e pending gravados e gatilho armado; a rede de 15 min, na MESMA fixture e no mesmo instante, só espera', async () => {
      const a = await reuniao(0, 45);
      const b = await reuniao(0, 45); // controle: igual à primeira
      for (const x of [a, b]) fake.setRecords(x.code, [conf('c1', 1, 25)]);
      const antes = await rede(26); // 10:26, o marcado só acaba às 10:45
      expect(antes.data.waiting).toBeGreaterThanOrEqual(2);
      expect((await row(b.id)).conference_ended_at).toBeNull();
      expect((await row(b.id)).import_status).toBeNull();

      const s = await vivo(26);
      expect(s.data.ended).toBeGreaterThanOrEqual(2);
      for (const x of [a, b]) {
        const r = await row(x.id);
        expect(r).toMatchObject({ import_status: 'pending', summary_fast_state: 'armed', atraso_fim_s: 60 });
        expect(iso(r.conference_ended_at)).toBe(at(25).toISOString());
        expect(iso(r.conference_end_seen_at)).toBe(at(26).toISOString());
        expect(await kinds(x.id)).toEqual(['conference_ended', 'conference_started']);
      }
      await vivo(27);
      expect((await kinds(a.id)).filter((k) => k === 'conference_ended')).toHaveLength(1); // 2ª execução não repete
    });

    it('A26-4 (R-49): saída e volta antes do resumo → fim zerado, gatilho cancelled, 1 evento; fecha de novo → fim regravado e gatilho armed', async () => {
      const a = await reuniao(0, 45);
      fake.setRecords(a.code, [conf('c1', 1, 20)]);
      await vivo(21);
      expect(await row(a.id)).toMatchObject({ import_status: 'pending', summary_fast_state: 'armed' });

      fake.setRecords(a.code, [conf('c1', 1, 20), conf('c2', 22, null)]); // a pessoa voltou
      await vivo(23);
      const aberta = await row(a.id);
      expect(aberta.conference_ended_at).toBeNull();
      expect(aberta.conference_end_seen_at).toBeNull();
      expect(aberta).toMatchObject({ import_status: null, summary_fast_state: 'cancelled' });
      await vivo(24); // idempotente: continua aberta, sem outro evento
      expect((await kinds(a.id)).filter((k) => k === 'conference_reopened:before_summary')).toHaveLength(1);

      fake.setRecords(a.code, [conf('c1', 1, 20), conf('c2', 22, 30)]);
      await vivo(31);
      const fechou = await row(a.id);
      expect(iso(fechou.conference_ended_at)).toBe(at(30).toISOString());
      expect(iso(fechou.conference_end_seen_at)).toBe(at(31).toISOString());
      expect(fechou).toMatchObject({ import_status: 'pending', summary_fast_state: 'armed' });
      expect((await kinds(a.id)).filter((k) => k === 'conference_ended')).toHaveLength(2);
    });

    it('A26-5 (R-50): resumo done + conferência nova → só o evento after_summary (UM), import_status segue done; sem done, a mesma fixture reabre', async () => {
      const feita = await reuniao(0, 45, { conferenceStartedMin: 1, conferenceEndedMin: 30, importStatus: 'done', summaryFastState: 'fired' });
      const sem = await reuniao(0, 45, { conferenceStartedMin: 1, conferenceEndedMin: 30, importStatus: 'pending', summaryFastState: 'armed' }); // controle
      for (const x of [feita, sem]) fake.setRecords(x.code, [conf('c1', 1, 30), conf('c2', 35, null)]);
      const s = await vivo(36);
      expect(s.data.reopenedAfterSummary).toBe(1);
      expect(s.data.reopened).toBe(1);
      const r = await row(feita.id);
      expect(r).toMatchObject({ import_status: 'done', summary_fast_state: 'fired' });
      expect(iso(r.conference_ended_at)).toBe(at(30).toISOString()); // o fim não anda
      expect(await kinds(feita.id)).toEqual(['conference_reopened:after_summary']); // o início já estava gravado: sem 2º conference_started
      await vivo(37);
      await vivo(38);
      expect((await kinds(feita.id)).filter((k) => k === 'conference_reopened:after_summary')).toHaveLength(1);
      expect(await row(sem.id)).toMatchObject({ import_status: null, summary_fast_state: 'cancelled' });
    });

    it('A26-6 (R-56): sala fechada 5 min depois da hora (10 min antes do guarda) → fim gravado SEM armar e fora da fila da importação; reaberta, o fim de verdade arma; fim aos 30 de 45 arma', async () => {
      const a = await reuniao(0, 45);
      const controle = await reuniao(0, 45);
      fake.setRecords(a.code, [conf('c1', -5, 5)]);
      fake.setRecords(controle.code, [conf('c1', 1, 30)]);
      const s = await vivo(6);
      expect(s.data.endedEarly).toBe(1);
      expect(s.data.ended).toBe(1); // o controle (fim aos 30 de 45) arma
      expect(await row(controle.id)).toMatchObject({ import_status: 'pending', summary_fast_state: 'armed' });
      const cedo = await row(a.id);
      expect(iso(cedo.conference_ended_at)).toBe(at(5).toISOString());
      expect(cedo.atraso_fim_s).toBe(60);
      expect(cedo).toMatchObject({ import_status: null, summary_fast_state: null });
      expect(await kinds(a.id)).toEqual(['conference_ended:too_early', 'conference_started']);
      // a fila da importação, 25 min depois do fim cedo, NÃO a vê; ao lado, a reunião pending com fim há 25 min ela vê
      const pendente = await reuniao(0, 45, { conferenceStartedMin: 1, conferenceEndedMin: 5, importStatus: 'pending' });
      const devidas = await new AdmissionImportRepository(admin).listDueIds(at(30), 500);
      expect(devidas).toContain(pendente.id);
      expect(devidas).not.toContain(a.id);

      fake.setRecords(a.code, [conf('c1', -5, 5), conf('c2', 10, null)]); // reaberta na hora
      await vivo(11);
      expect((await row(a.id)).conference_ended_at).toBeNull();
      expect((await row(a.id)).summary_fast_state).toBeNull(); // nada armado para cancelar
      fake.setRecords(a.code, [conf('c1', -5, 5), conf('c2', 10, 40)]);
      await vivo(41);
      const real = await row(a.id);
      expect(iso(real.conference_ended_at)).toBe(at(40).toISOString());
      expect(real).toMatchObject({ import_status: 'pending', summary_fast_state: 'armed' });
    });

    it('A26-9 (R-55): nome, telefone, e-mail, link e texto-sentinela nunca vão para o log, a trilha nem a resposta — nem quando a Meet falha com a sentinela na mensagem', async () => {
      const paciente = await fx.criarPaciente({ isTest: false, primeiroNome: SENTINELA, sobrenome: `${SENTINELA}Sobrenome`, telefone: TELEFONE });
      const ok = await reuniao(0, 45, { pacienteId: paciente });
      const falha = await reuniao(0, 45, { pacienteId: paciente });
      fake.setRecords(ok.code, [conf('c1', 1, 25)]);
      fake.setRecords(falha.code, [conf('c1', 1, 25)]);
      logs.log.info({}, 'marca-inicial');
      const marca = logs.output().length;
      const bom = await vivo(26);
      fake.failWith(new Error(`falha com ${SENTINELA} e ${TELEFONE}`));
      const ruim = await vivo(27);
      expect(ruim.data.errors).toBeGreaterThanOrEqual(1); // controle: o caminho de erro rodou
      const emails = (await admin.query(`SELECT host_email, meet_link FROM admission_appointments WHERE id = ANY($1)`, [[ok.id, falha.id]])).rows;
      const trilha = JSON.stringify((await admin.query(`SELECT kind, outcome, reason, ref FROM admission_events WHERE appointment_id = ANY($1)`, [[ok.id, falha.id]])).rows);
      const saida = logs.output().slice(marca);
      expect(saida).toContain('admission.live.run_done'); // controle: o log existe e foi lido
      expect(trilha).toContain('conference_ended'); // controle: a trilha existe e foi lida
      const proibidos = [SENTINELA, TELEFONE, 'Operadora Sintetica', ...emails.flatMap((e) => [e.host_email, e.meet_link, String(e.meet_link).split('/').pop()])];
      for (const [fonte, texto] of [['log', saida], ['trilha', trilha], ['resposta', bom.texto + ruim.texto]] as const) {
        for (const p of proibidos) expect({ fonte, p, achou: texto.includes(p) }).toEqual({ fonte, p, achou: false });
      }
    });
  });
}
