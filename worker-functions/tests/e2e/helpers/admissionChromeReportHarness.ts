/**
 * admissionChromeReportHarness — spec 050 F15 (R-1, R-2, R-3, R-5, R-6): o job diário do relatório do Chrome, com o PAPEL DO RUNTIME,
 * na rota HTTP montada com os middlewares de verdade (`systemContextMiddleware` + segredo interno). A porta do Google é DUBLÊ
 * (`FakeChromeReport`); nada toca o Google. Dados sintéticos (@example.test).
 *
 * O MESMO conjunto roda em dois arquivos, mudando SÓ quem conecta (molde `admissionInicioRealHarness`): `-runtime` (login membro de
 * `app_runtime` + pool de sistema `app_system`, `COUNTRY_RLS_ENABLED=true`) e `-dono` (controle: bypassa RLS).
 *
 * A15-1 os 4 estados pela porta dublada · A15-2 relatório velho e lista vazia NÃO viram "ausente" · A15-3 transição nos dois sentidos,
 * 1 evento + 1 aviso por transição · A15-4 `instalada` não libera ninguém · A15-5 política ausente → log de alarme · A15-x o adaptador
 * real (default de produção) não chama o Google e não toca o estado.
 */
import { Pool } from 'pg';
import { montarAppDeFamilia, type AppDeFamilia } from './permissionFamilyHarness';
import { ensureLoginRole, dropLoginRoles, urlFor } from './loginRoles';
import { FakeChromeReport } from '../../../src/modules/matching/infrastructure/doubles/FakeChromeReport';
import { TACTIQ_EXTENSION_ID, type ChromeReportPort } from '../../../src/modules/matching/application/ports/ChromeReportPort';
import { capturingLogger } from '../../../src/modules/matching/infrastructure/doubles/admissionTestKit';

const DATABASE_URL =
  process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

export type ConexaoChrome = 'runtime' | 'dono';

const TENANT = '00000000-0000-0000-0000-000000000001';
const SENHA = 'adm050_chr_pw';
const SECRET = 'test-secret-for-e2e-only';
const HORA = 3_600_000;

type Estado = 'instalada' | 'desativada' | 'ausente';

export function definirCenariosRelatorioChrome(conexao: ConexaoChrome, sufixo: string): void {
  const RUNTIME_USER = `adm050chr_rt_${sufixo}`;
  const SYSTEM_USER = `adm050chr_sys_${sufixo}`;
  const RUN = `${sufixo}${Date.now().toString(36)}`;

  describe(`F15 — relatório do Chrome sob RLS, HTTP real, conexão: ${conexao}`, () => {
    let admin: Pool;
    let app: AppDeFamilia;
    let porta: ChromeReportPort;
    const fake = new FakeChromeReport();
    const logs = capturingLogger();
    const hostEmails: string[] = [];
    const hostUids: string[] = [];
    const inicio = new Date();
    let seq = 0;
    const envAnterior: Record<string, string | undefined> = {};
    function setEnv(k: string, v: string | undefined): void {
      if (!(k in envAnterior)) envAnterior[k] = process.env[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }

    const job = async (): Promise<{ status: number; data: Record<string, any> }> => {
      const res = await fetch(`${app.url}/api/internal/jobs/admission-chrome-report`, { method: 'POST', headers: { 'X-Internal-Secret': SECRET } });
      const body = (await res.json().catch(() => ({}))) as { data?: Record<string, any> };
      return { status: res.status, data: body.data ?? {} };
    };

    /** Operadora do roster; com `user` (padrão) tem usuário ativo e por isso recebe o sino. */
    async function newHost(opts: { user?: boolean } = {}): Promise<{ email: string; uid: string }> {
      seq += 1;
      const email = `chr${seq}.${RUN}@example.test`;
      const uid = `chr050-${seq}-${RUN}`;
      await admin.query(`INSERT INTO interview_hosts (email, display_name, country, active) VALUES ($1,'Operadora Sintetica','AR',true)`, [email]);
      hostEmails.push(email);
      if (opts.user !== false) {
        await admin.query(`INSERT INTO users (firebase_uid, email, role, status, is_active, tenant_id) VALUES ($1,$2,'admin','ACTIVE',true,$3)`, [uid, email, TENANT]);
        hostUids.push(uid);
      }
      return { email, uid };
    }

    /** Programa o dublê para a operadora no estado pedido, com o relatório de `idadeH` horas atrás. */
    function programar(email: string, estado: Estado | 'sem_perfil', idadeH = 2): Date | null {
      if (estado === 'sem_perfil') return null;
      const reportAt = new Date(Date.now() - idadeH * HORA);
      const extensions = estado === 'ausente' ? [] : [{ extensionId: TACTIQ_EXTENSION_ID, isDisabled: estado === 'desativada' }];
      fake.setProfile(email, { lastStatusReportTime: reportAt, extensions });
      if (estado !== 'ausente') {
        instalados.push(email);
        fake.setInstalled(instalados);
      }
      return reportAt;
    }
    let instalados: string[] = [];

    const linha = async (email: string) =>
      (await admin.query(`SELECT state, report_at, conclusive_state, state_changed_at FROM admission_chrome_reports WHERE lower(host_email) = lower($1)`, [email])).rows[0];
    const eventos = async (email: string) =>
      (await admin.query(`SELECT kind, outcome, ref FROM admission_events WHERE lower(host_email) = lower($1) AND kind LIKE 'tactiq\\_extension.%' ORDER BY at, id`, [email])).rows as Array<{ kind: string; outcome: string; ref: { reportAt: string | null } }>;
    const sino = async (uid: string) =>
      (await admin.query(
        `SELECT e.type_code, e.actor_uid, e.payload, e.patient_id FROM notifications n JOIN notification_events e ON e.id = n.event_id WHERE n.recipient_uid = $1 ORDER BY n.created_at, e.id`,
        [uid],
      )).rows as Array<{ type_code: string; actor_uid: string; payload: { state: string }; patient_id: string | null }>;
    const contaLinhas = async (emails: string[]): Promise<number> =>
      (await admin.query(`SELECT count(*)::int AS n FROM admission_chrome_reports WHERE lower(host_email) = ANY($1)`, [emails.map((e) => e.toLowerCase())])).rows[0].n;

    beforeAll(async () => {
      admin = new Pool({ connectionString: DATABASE_URL });
      await ensureLoginRole(admin, RUNTIME_USER, SENHA, 'app_runtime');
      await ensureLoginRole(admin, SYSTEM_USER, SENHA, 'app_system');
      setEnv('DATABASE_URL', conexao === 'runtime' ? urlFor(DATABASE_URL, RUNTIME_USER, SENHA) : DATABASE_URL);
      setEnv('DATABASE_SYSTEM_URL', conexao === 'runtime' ? urlFor(DATABASE_URL, SYSTEM_USER, SENHA) : undefined);
      setEnv('COUNTRY_RLS_ENABLED', 'true');
      setEnv('USE_MOCK_AUTH', 'true');
      setEnv('DB_POOL_MAX', '4');
      setEnv('DB_SYSTEM_POOL_MAX', '2');
      setEnv('INTERNAL_TOKEN_SECRET', SECRET);
      porta = fake;

      const [identity, { DatabaseConnection }] = await Promise.all([import('@modules/identity'), import('@shared/database/DatabaseConnection')]);
      const auth = new identity.AuthMiddleware(
        new identity.MultiAuthService({ enableApiKeys: true, enableJwt: false, enableGoogleIdToken: true }, DatabaseConnection.getInstance().getPool()),
        new identity.SimplifiedAuthorizationEngine(),
      );
      app = await montarAppDeFamilia({
        auth,
        montarRotas: async ({ app: express }) => {
          const { ChromeReportJob } = await import('../../../src/modules/matching/application/ChromeReportJob');
          const { ChromeReportRepository } = await import('../../../src/modules/matching/infrastructure/ChromeReportRepository');
          const { ChromeReportInternalController } = await import('../../../src/modules/matching/interfaces/controllers/ChromeReportInternalController');
          const { createChromeReportInternalRoutes } = await import('../../../src/modules/matching/interfaces/routes/chromeReportRoutes');
          const { systemContextMiddleware } = await import('@shared/database/systemContextMiddleware');
          const { internalAuthMiddleware } = await import('@modules/notification');
          const pool = DatabaseConnection.getInstance().getPool();
          // a porta é trocada por teste (dublê ↔ adaptador real do default de produção) sem remontar a app
          const delegada: ChromeReportPort = {
            findInstalledEmails: (a) => porta.findInstalledEmails(a),
            getProfile: (e) => porta.getProfile(e),
            countInstalledProfiles: (a) => porta.countInstalledProfiles(a),
            resolveForcedInstall: (a) => porta.resolveForcedInstall(a),
          };
          express.use(
            '/api/internal',
            systemContextMiddleware('job:admission-chrome-report'),
            internalAuthMiddleware,
            createChromeReportInternalRoutes(
              new ChromeReportInternalController(new ChromeReportJob({ repo: new ChromeReportRepository(pool), chrome: delegada, db: pool, log: logs.log })),
            ),
          );
        },
      });
    }, 90000);

    beforeEach(() => {
      fake.reset();
      instalados = [];
      porta = fake;
    });

    afterAll(async () => {
      await app?.fechar();
      const { DatabaseConnection } = await import('@shared/database/DatabaseConnection');
      await DatabaseConnection.getInstance().close();
      await admin.query(`DELETE FROM notifications WHERE recipient_uid = ANY($1)`, [hostUids]);
      await admin.query(`DELETE FROM notification_events e WHERE e.type_code = 'ADMISSION_TACTIQ_EXTENSION_CHANGED' AND NOT EXISTS (SELECT 1 FROM notifications n WHERE n.event_id = e.id)`);
      // o job varre o roster inteiro do banco: as linhas das operadoras alheias criadas durante este arquivo também saem
      await admin.query(`DELETE FROM admission_chrome_reports WHERE created_at >= $1`, [inicio]);
      await admin.query('DELETE FROM interview_hosts WHERE email = ANY($1)', [hostEmails]);
      await admin.query('DELETE FROM users WHERE firebase_uid = ANY($1)', [hostUids]);
      await dropLoginRoles(admin, [RUNTIME_USER, SYSTEM_USER]);
      await admin.end();
      for (const [k, v] of Object.entries(envAnterior)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    });

    it('0. sanidade: a conexão é a que o arquivo declara; o runtime lê o estado mas NÃO o escreve (só o sistema)', async () => {
      const { DatabaseConnection } = await import('@shared/database/DatabaseConnection');
      const raw = DatabaseConnection.getInstance().getRawPool();
      expect((await raw.query('SELECT current_user AS u')).rows[0].u).toBe(conexao === 'runtime' ? RUNTIME_USER : new URL(DATABASE_URL).username);
      const priv = async (p: string) =>
        (await raw.query(`SELECT has_table_privilege(current_user, 'admission_chrome_reports', $1) AS ok`, [p])).rows[0].ok as boolean;
      if (conexao === 'runtime') {
        expect(await priv('SELECT')).toBe(true); // o runtime lê (a trava da F16 vai ler)
        expect(await priv('INSERT')).toBe(false);
        expect(await priv('UPDATE')).toBe(false);
        // controle: o papel de sistema (o que o job usa) escreve
        const { rows } = await admin.query(`SELECT has_table_privilege($1, 'admission_chrome_reports', 'INSERT') AS ok`, [SYSTEM_USER]);
        expect(rows[0].ok).toBe(true);
        await expect(raw.query(`INSERT INTO admission_chrome_reports (host_email, state) VALUES ('nao.entra@example.test', 'ausente')`)).rejects.toThrow(/permission denied/);
        expect((await admin.query(`SELECT count(*)::int AS n FROM admission_chrome_reports WHERE host_email = 'nao.entra@example.test'`)).rows[0].n).toBe(0);
      } else {
        expect(await priv('INSERT')).toBe(true); // controle: o dono escreve
      }
    });

    it('A15-1: os 4 estados pela porta dublada, cada um com o relatorio_de do Google; contagem do resumo bate', async () => {
      const [i, d, a, s] = [await newHost(), await newHost(), await newHost(), await newHost()];
      const ri = programar(i.email, 'instalada')!;
      const rd = programar(d.email, 'desativada', 5)!;
      const ra = programar(a.email, 'ausente', 7)!;
      programar(s.email, 'sem_perfil');
      const r = await job();
      expect(r.status).toBe(200);
      expect(r.data).toMatchObject({ status: 'ok', policy: 'applied' });
      expect(r.data.instalada).toBeGreaterThanOrEqual(1);
      expect(r.data.desativada).toBeGreaterThanOrEqual(1);
      expect(r.data.ausente).toBeGreaterThanOrEqual(1);
      expect(r.data.sem_relatorio).toBeGreaterThanOrEqual(1);
      const iso = (v: Date | null) => (v ? new Date(v).toISOString() : null);
      expect(await linha(i.email)).toMatchObject({ state: 'instalada', conclusive_state: 'instalada' });
      expect(iso((await linha(i.email)).report_at)).toBe(ri.toISOString());
      expect(await linha(d.email)).toMatchObject({ state: 'desativada', conclusive_state: 'desativada' });
      expect(iso((await linha(d.email)).report_at)).toBe(rd.toISOString());
      expect(await linha(a.email)).toMatchObject({ state: 'ausente', conclusive_state: 'ausente' });
      expect(iso((await linha(a.email)).report_at)).toBe(ra.toISOString());
      expect(await linha(s.email)).toMatchObject({ state: 'sem_relatorio', report_at: null, conclusive_state: null });
      expect(fake.calls).toEqual(expect.arrayContaining(['findInstalledEmails', 'countInstalledProfiles', 'getProfile', 'resolveForcedInstall']));
    });

    it('A15-2: relatório com mais de 48 h é sem_relatorio (não "ausente", não "instalada"): sem evento, sem aviso; a 47 h ainda vale (controle)', async () => {
      const velhoAusente = await newHost();
      const velhoInstalada = await newHost();
      const fresco = await newHost();
      const r1 = programar(velhoAusente.email, 'ausente', 49)!;
      programar(velhoInstalada.email, 'instalada', 49);
      programar(fresco.email, 'ausente', 47);
      await job();
      expect(await linha(velhoAusente.email)).toMatchObject({ state: 'sem_relatorio', conclusive_state: null });
      expect(new Date((await linha(velhoAusente.email)).report_at).toISOString()).toBe(r1.toISOString()); // o relatorio_de fica visível
      expect(await linha(velhoInstalada.email)).toMatchObject({ state: 'sem_relatorio', conclusive_state: null });
      for (const h of [velhoAusente, velhoInstalada]) {
        expect(await eventos(h.email)).toEqual([]);
        expect(await sino(h.uid)).toEqual([]);
      }
      expect(await linha(fresco.email)).toMatchObject({ state: 'ausente' }); // controle: 47 h ainda é relatório
      expect((await eventos(fresco.email)).map((e) => e.kind)).toEqual(['tactiq_extension.missing']);
    });

    it('A15-2: lista VAZIA com countInstalledApps > 0 falha ALTO (500), não grava estado nenhum e não vira "ninguém tem"; controle: o mesmo cenário com lista cheia grava', async () => {
      const h = await newHost();
      programar(h.email, 'ausente');
      fake.setInstalled([]);
      fake.profileCount = 3;
      const antes = await contaLinhas([h.email]);
      const r = await job();
      expect(r.status).toBe(500);
      expect(await contaLinhas([h.email])).toBe(antes);
      expect(await linha(h.email)).toBeUndefined();
      expect(await eventos(h.email)).toEqual([]);
      expect(logs.output()).toContain('admission.chrome_report.empty_list');
      // controle positivo: lista com gente + o mesmo controle → o job conclui e grava
      const outra = await newHost();
      programar(outra.email, 'instalada');
      fake.profileCount = 1;
      expect((await job()).status).toBe(200);
      expect(await linha(h.email)).toMatchObject({ state: 'ausente' });
    });

    it('A15-3: transição nos dois sentidos — 1 evento + 1 aviso por transição; repetir o mesmo estado não repete; sem_relatorio no meio não conta', async () => {
      const h = await newHost();
      const rodar = async (e: Estado | 'sem_perfil' | 'velho') => {
        fake.reset();
        instalados = [];
        if (e === 'velho') programar(h.email, 'instalada', 60);
        else programar(h.email, e);
        expect((await job()).status).toBe(200);
      };
      const kinds = async () => (await eventos(h.email)).map((x) => x.kind);
      const avisos = async () => (await sino(h.uid)).map((n) => n.payload.state);

      await rodar('instalada'); // (nada → instalada)
      expect(await kinds()).toEqual(['tactiq_extension.installed']);
      expect(await avisos()).toEqual(['installed']);
      await rodar('instalada'); // repetir: nada novo
      expect(await kinds()).toEqual(['tactiq_extension.installed']);
      expect(await avisos()).toEqual(['installed']);
      await rodar('desativada'); // instalada → desativada
      expect(await kinds()).toEqual(['tactiq_extension.installed', 'tactiq_extension.disabled']);
      await rodar('ausente'); // desativada → ausente
      expect(await kinds()).toEqual(['tactiq_extension.installed', 'tactiq_extension.disabled', 'tactiq_extension.missing']);
      await rodar('velho'); // relatório velho: sem_relatorio no meio — NÃO é transição, o último estado conclusivo fica
      expect(await linha(h.email)).toMatchObject({ state: 'sem_relatorio', conclusive_state: 'ausente' });
      expect(await kinds()).toHaveLength(3);
      await rodar('instalada'); // ausente → instalada (sentido contrário), 2ª vez que instala
      expect(await kinds()).toEqual([
        'tactiq_extension.installed', 'tactiq_extension.disabled', 'tactiq_extension.missing', 'tactiq_extension.installed',
      ]);
      expect(await avisos()).toEqual(['installed', 'disabled', 'missing', 'installed']); // exatamente 1 aviso por transição
      const n = await sino(h.uid);
      expect(n.every((x) => x.type_code === 'ADMISSION_TACTIQ_EXTENSION_CHANGED' && x.actor_uid === 'system:admission' && x.patient_id === null)).toBe(true);
      expect(n.every((x) => Object.keys(x.payload).join() === 'state')).toBe(true); // payload fechado: só o estado
      // a data do relatório vai no evento
      const ultimo = (await eventos(h.email)).at(-1)!;
      expect(Number.isNaN(Date.parse(ultimo.ref.reportAt ?? ''))).toBe(false);
    });

    it('A15-3: duas execuções SIMULTÂNEAS na mesma transição → 1 evento e 1 aviso (o lock por operadora serializa)', async () => {
      const h = await newHost();
      programar(h.email, 'ausente');
      const [a, b] = await Promise.all([job(), job()]);
      expect([a.status, b.status]).toEqual([200, 200]);
      expect((await eventos(h.email)).map((e) => e.kind)).toEqual(['tactiq_extension.missing']);
      expect((await sino(h.uid)).map((n) => n.payload.state)).toEqual(['missing']);
    });

    it('A15-3: operadora SEM usuário ativo — o evento da trilha existe, não há sino (e nada quebra)', async () => {
      const h = await newHost({ user: false });
      programar(h.email, 'desativada');
      expect((await job()).status).toBe(200);
      expect((await eventos(h.email)).map((e) => e.kind)).toEqual(['tactiq_extension.disabled']);
      expect((await admin.query(`SELECT count(*)::int AS n FROM users WHERE lower(email) = lower($1)`, [h.email])).rows[0].n).toBe(0);
    });

    it('A15-4: `instalada` NÃO libera ninguém — o vínculo, a aptidão e as agendas ficam como estavam; o job só escreve o próprio estado', async () => {
      const { TactiqLinkRepository } = await import('../../../src/modules/matching/infrastructure/TactiqLinkRepository');
      const { isHostApt } = await import('../../../src/modules/matching/application/admissionHostEligibility');
      const h = await newHost();
      const comVinculoQuebrado = await newHost();
      await admin.query(
        `INSERT INTO tactiq_links (host_email, firebase_uid, status, status_changed_at) VALUES ($1,$2,'broken', now() - interval '1 day')`,
        [comVinculoQuebrado.email, comVinculoQuebrado.uid],
      );
      programar(h.email, 'instalada');
      programar(comVinculoQuebrado.email, 'instalada');
      const agendasAntes = (await admin.query(`SELECT count(*)::int AS n FROM admission_appointments`)).rows[0].n;
      const linksAntes = (await admin.query(`SELECT count(*)::int AS n FROM tactiq_links`)).rows[0].n;
      await job();
      expect(await linha(h.email)).toMatchObject({ state: 'instalada' });
      // o mesmo estado que o painel consulta: sem vínculo continua `missing`; vínculo quebrado continua `broken` — nenhum vira apta
      const { DatabaseConnection } = await import('@shared/database/DatabaseConnection');
      const repo = new TactiqLinkRepository(DatabaseConnection.getInstance().getPool());
      const estados = await repo.statusesByEmail([h.email, comVinculoQuebrado.email]);
      expect(estados.get(h.email.toLowerCase())).toBeUndefined(); // sem linha = `missing` para o `TactiqLinkGate`
      expect(estados.get(comVinculoQuebrado.email.toLowerCase())).toBe('broken');
      expect(isHostApt(estados.get(h.email.toLowerCase()))).toBe(false);
      expect(isHostApt(estados.get(comVinculoQuebrado.email.toLowerCase()))).toBe(false);
      expect((await admin.query(`SELECT count(*)::int AS n FROM tactiq_links`)).rows[0].n).toBe(linksAntes);
      expect((await admin.query(`SELECT count(*)::int AS n FROM admission_appointments`)).rows[0].n).toBe(agendasAntes);
      // controle: o que o job NÃO faz — um vínculo `linked` também fica como está quando o relatório diz `ausente` (a trava dura é a F16)
      const ok = await newHost();
      await admin.query(`INSERT INTO tactiq_links (host_email, firebase_uid, status) VALUES ($1,$2,'linked')`, [ok.email, ok.uid]);
      programar(ok.email, 'ausente');
      await job();
      expect((await repo.statusesByEmail([ok.email])).get(ok.email.toLowerCase())).toBe('linked');
      expect(isHostApt('linked')).toBe(true); // o controle de que `isHostApt` aceita quando o VÍNCULO diz linked
    });

    it('A15-5: política ausente → log de alarme (e o resumo diz); aplicada → sem alarme (controle)', async () => {
      const h = await newHost();
      programar(h.email, 'instalada');
      fake.policy = 'absent';
      const r = await job();
      expect(r.status).toBe(200);
      expect(r.data.policy).toBe('absent');
      expect(logs.output()).toContain('admission.chrome_report.policy_missing');
      const antes = (logs.output().match(/admission\.chrome_report\.policy_missing/g) ?? []).length;
      fake.policy = 'applied';
      await job();
      expect((logs.output().match(/admission\.chrome_report\.policy_missing/g) ?? []).length).toBe(antes);
    });

    it('R-6: `admission.chrome_report.run_done` sai a cada rodada que termina e só com contagens (nenhuma chave de e-mail/nome/id)', async () => {
      const h = await newHost();
      programar(h.email, 'instalada');
      const antes = (logs.output().match(/"message":"admission\.chrome_report\.run_done"/g) ?? []).length;
      expect((await job()).status).toBe(200);
      const linhas = logs.output().split('\n').filter((l) => l.includes('"message":"admission.chrome_report.run_done"')).map((l) => JSON.parse(l) as Record<string, unknown>);
      expect(linhas.length).toBe(antes + 1);
      const chaves = Object.keys(linhas.at(-1)!).filter((k) => !['level', 'time', 'pid', 'hostname', 'message', 'severity', 'timestamp'].includes(k)).sort();
      expect(chaves).toEqual(['ausente', 'desativada', 'instalada', 'notified', 'policy', 'rosterHosts', 'sem_relatorio', 'status', 'transitions']);
    });

    it('A15-x: o adaptador REAL (default de produção) via HTTP → 200 "unavailable", sem run_done novo, nenhuma linha/evento/aviso gravado; 0 chamadas ao dublê', async () => {
      const { GoogleChromeManagementClient } = await import('../../../src/modules/matching/infrastructure/GoogleChromeManagementClient');
      const h = await newHost();
      programar(h.email, 'ausente');
      porta = new GoogleChromeManagementClient({ NODE_ENV: 'production' });
      const fetchSpy = jest.spyOn(globalThis, 'fetch');
      const runDone = () => (logs.output().match(/admission\.chrome_report\.run_done/g) ?? []).length;
      const antes = runDone();
      const chamadasAntes = fake.calls.length;
      // o spy conta só chamadas DEPOIS dele; o próprio `job()` usa fetch para falar com a API local — conta-se o que sai para fora do localhost
      const r = await job();
      const externas = fetchSpy.mock.calls.filter(([u]) => !String(u).startsWith(app.url));
      fetchSpy.mockRestore();
      expect(r.status).toBe(200);
      expect(r.data).toMatchObject({ status: 'unavailable', rosterHosts: 0 });
      expect(externas).toHaveLength(0);
      expect(fake.calls.length).toBe(chamadasAntes);
      expect(runDone()).toBe(antes);
      expect(await linha(h.email)).toBeUndefined();
      expect(await eventos(h.email)).toEqual([]);
      expect(await sino(h.uid)).toEqual([]);
      // controle positivo: com o dublê "disponível" o MESMO cenário grava (≥ 1 chamada ao dublê)
      porta = fake;
      expect((await job()).data.status).toBe('ok');
      expect(fake.calls.length).toBeGreaterThan(chamadasAntes);
      expect(await linha(h.email)).toMatchObject({ state: 'ausente' });
    });

    it('privacidade: nenhum e-mail de operadora aparece em log; o evento da trilha e o sino só levam estado e instante', async () => {
      const saida = logs.output();
      expect(saida.length).toBeGreaterThan(0);
      for (const e of hostEmails) expect(saida).not.toContain(e);
      expect(saida).not.toContain('@example.test');
      const { rows } = await admin.query(`SELECT ref FROM admission_events WHERE kind LIKE 'tactiq\\_extension.%' AND lower(host_email) = ANY($1)`, [hostEmails.map((e) => e.toLowerCase())]);
      expect(rows.length).toBeGreaterThan(0);
      for (const r of rows) expect(Object.keys(r.ref)).toEqual(['reportAt']);
    });
  });
}
