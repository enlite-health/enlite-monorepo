/**
 * interview-host-055-entrevistadores.e2e.test.ts — spec 055 (tela Entrevistadores): a API contra POSTGRES REAL, HTTP real, com o
 * ENGINE DE PERMISSÃO LIGADO, SEM MOCK de repositório/serviço — só o Google (dublê, nunca chamado nestas rotas) e o OAuth/MCP do
 * Tactiq (dublês nunca chamados; o estado do vínculo é lido do banco). Dados SINTÉTICOS (@example.test); nenhum e-mail/nome em asserção
 * de log.
 *
 * Monta as TRÊS rotas que a mudança toca: a tela (`admin.users`), o roster do drawer do enquadre (`admin.vacancies`) e o do modal da
 * admissão (`admin.patients`).
 *
 * O que cada caso mata (sabotagem → vermelho):
 *   1 tirar o filtro de fluxo do repositório (Encuadre-only aparece na admissão)
 *   2 aceitar uid inexistente / de prestador / de usuário desativado (R1)
 *   3 tirar o JOIN em users das leituras de agendamento (usuário desativado e linha SEM usuário continuam aparecendo)
 *   4 ler `country` em vez de `countries` (pessoa AR+BR some no BR)
 *   5 desligar os dois fluxos sem inativar / reativar criando linha nova
 *   6 abrir a rota sem a célula (403 sem `interview_host:update`)
 */
import { Pool } from 'pg';
import {
  TENANT_E2E,
  tokenMock,
  montarAppDeFamilia,
  limparIamFixtures,
  grupoComCelulas,
  type AppDeFamilia,
} from './helpers/permissionFamilyHarness';
import { FakeAdmissionCalendar } from '../../src/modules/matching/infrastructure/doubles/FakeAdmissionCalendar';
import { FakeTactiqMcp, FakeTactiqOAuth } from '../../src/modules/matching/infrastructure/doubles/FakeTactiq';
import { insertInterviewHost, deleteInterviewHosts } from './helpers/interviewHostFixture';

const DATABASE_URL =
  process.env.TEST_DATABASE_URL ||
  process.env.DATABASE_URL ||
  'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const email = (n: string): string => `${n}.e2e055.${RUN}@example.test`;
const FLOR = { uid: `e2e055-flor-${RUN}`, email: email('flor') };
const MAYRA = { uid: `e2e055-mayra-${RUN}`, email: email('mayra') };
const OFF = { uid: `e2e055-off-${RUN}`, email: email('off') };
const WORKER = { uid: `e2e055-worker-${RUN}`, email: email('worker') };
const SEM_USUARIO = email('semusuario');
const CHEFE = `e2e055-chefe-${RUN}`;
const LEITOR = `e2e055-leitor-${RUN}`;
const SEM_GRUPO = `e2e055-semgrupo-${RUN}`;
const GRUPO_CHEFE = `E055 Chefe ${RUN}`;
const GRUPO_LEITOR = `E055 Leitor ${RUN}`;

describe('tela Entrevistadores — HTTP real, banco real, engine LIGADO (spec 055)', () => {
  let admin: Pool;
  let app: AppDeFamilia;
  let vacancyId: string;
  let patientId: string;
  const envAnterior: Record<string, string | undefined> = {};
  const setEnv = (k: string, v: string | undefined): void => {
    if (!(k in envAnterior)) envAnterior[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  };

  async function http(method: string, path: string, body?: unknown, uid = CHEFE) {
    const res = await fetch(`${app.url}${path}`, {
      method,
      headers: { Authorization: tokenMock(uid, 'admin', 'AR'), 'Content-Type': 'application/json' },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, any> };
  }
  const post = (userUid: string, over: Record<string, unknown> = {}) =>
    http('POST', '/api/admin/interview-hosts', { userUid, countries: ['AR'], doesEnquadre: true, doesAdmission: true, ...over });
  const admissionEmails = async (country: 'AR' | 'BR'): Promise<string[]> => {
    const r = await http('GET', `/api/admin/admission/hosts?country=${country}`);
    expect(r.status).toBe(200);
    return (r.body.data as Array<{ email: string }>).map((h) => h.email);
  };
  const enquadreHostNames = async (): Promise<string[]> => {
    const r = await http('GET', `/api/admin/vacancies/${vacancyId}/enquadre-events/hosts`);
    expect(r.status).toBe(200);
    return (r.body.data as Array<{ id: string; name: string }>).map((h) => h.id);
  };
  const hostRow = async (userEmail: string) =>
    (await admin.query(`SELECT * FROM interview_hosts WHERE email = $1`, [userEmail])).rows[0];
  const listed = async () => {
    const r = await http('GET', '/api/admin/interview-hosts');
    expect(r.status).toBe(200);
    return r.body.data as Array<Record<string, any>>;
  };

  async function limpar(): Promise<void> {
    await deleteInterviewHosts(admin, [FLOR.email, MAYRA.email, OFF.email, SEM_USUARIO]);
    await admin.query(`DELETE FROM job_postings WHERE title = $1`, [`ENT055 e2e ${RUN}`]);
    await admin.query(`DELETE FROM patients WHERE clickup_task_id = $1`, [`e2e-055-${RUN}`]);
    await limparIamFixtures(admin, { uids: [CHEFE, LEITOR, SEM_GRUPO, FLOR.uid, MAYRA.uid, OFF.uid, WORKER.uid], grupos: [GRUPO_CHEFE, GRUPO_LEITOR] });
  }

  beforeAll(async () => {
    admin = new Pool({ connectionString: DATABASE_URL });
    await limpar();

    setEnv('USE_MOCK_AUTH', 'true');
    setEnv('PERMISSION_ENGINE_ENABLED', 'true');
    setEnv('PERMISSION_ENFORCED_ROUTES', 'admin.users,admin.patients,admin.vacancies');
    setEnv('PERMISSION_CACHE_TTL_MS', '0');
    setEnv('DATABASE_URL', DATABASE_URL);
    setEnv('ADMISSION_HOST_ROSTER_ENABLED', 'true');

    const staff = (uid: string, mail: string) =>
      admin.query(`INSERT INTO users (firebase_uid, email, display_name, role, status, is_active, tenant_id) VALUES ($1,$2,$3,'admin','ACTIVE',true,$4)`, [uid, mail, `Nome ${uid.split('-')[1]}`, TENANT_E2E]);
    await staff(CHEFE, `chefe.e2e055.${RUN}@e2e.local`);
    await staff(LEITOR, `leitor.e2e055.${RUN}@e2e.local`);
    await staff(SEM_GRUPO, `semgrupo.e2e055.${RUN}@e2e.local`);
    await staff(FLOR.uid, FLOR.email);
    await staff(MAYRA.uid, MAYRA.email);
    await staff(OFF.uid, OFF.email);
    await admin.query(`INSERT INTO users (firebase_uid, email, display_name, role, status, is_active, tenant_id) VALUES ($1,$2,'Nome worker','worker','ACTIVE',true,$3)`, [WORKER.uid, WORKER.email, TENANT_E2E]);
    await admin.query(`UPDATE users SET is_active = false WHERE firebase_uid = $1`, [OFF.uid]);

    await grupoComCelulas(admin, { nome: GRUPO_CHEFE, uid: CHEFE, celulas: [['interview_host', 'read'], ['interview_host', 'update'], ['patient_admission', 'create'], ['enquadre_event', 'create']] });
    await grupoComCelulas(admin, { nome: GRUPO_LEITOR, uid: LEITOR, celulas: [['interview_host', 'read']] });

    const pat = await admin.query(`INSERT INTO patients (clickup_task_id, first_name, last_name, country, is_test) VALUES ($1,'Ficticia','Sobrenomeunico','AR',true) RETURNING id`, [`e2e-055-${RUN}`]);
    patientId = pat.rows[0].id;
    const vac = await admin.query(
      `INSERT INTO job_postings (title, patient_id, status, is_draft, country, is_test, case_number) VALUES ($1,$2,'SEARCHING',false,'AR',true,$3) RETURNING id`,
      [`ENT055 e2e ${RUN}`, patientId, 800000 + Math.floor(Math.random() * 90000)],
    );
    vacancyId = vac.rows[0].id;

    app = await montarAppDeFamilia({
      enforcedRoutes: 'admin.users,admin.patients,admin.vacancies',
      montarRotas: async ({ app: express, auth, permissions }) => {
        const { DatabaseConnection } = await import('@shared/database/DatabaseConnection');
        const { interviewHostRepository } = await import('../../src/modules/matching/infrastructure/InterviewHostRepository');
        const { TactiqLinkService } = await import('../../src/modules/matching/application/TactiqLinkService');
        const { TactiqLinkRepository } = await import('../../src/modules/matching/infrastructure/TactiqLinkRepository');
        const { InterviewHostService } = await import('../../src/modules/matching/application/InterviewHostService');
        const { InterviewHostController } = await import('../../src/modules/matching/interfaces/controllers/InterviewHostController');
        const { createAdminInterviewHostRoutes } = await import('../../src/modules/matching/interfaces/routes/adminInterviewHostRoutes');
        const { AdmissionPanelService } = await import('../../src/modules/matching/application/AdmissionPanelService');
        const { AdmissionPanelController } = await import('../../src/modules/matching/interfaces/controllers/AdmissionPanelController');
        const { createAdminAdmissionRoutes } = await import('../../src/modules/matching/interfaces/routes/adminAdmissionRoutes');
        const { EnquadreEventService } = await import('../../src/modules/matching/application/EnquadreEventService');
        const { EnquadreEventMutations } = await import('../../src/modules/matching/application/EnquadreEventMutations');
        const { EnquadreEventController } = await import('../../src/modules/matching/interfaces/controllers/EnquadreEventController');
        const { createAdminEnquadreEventRoutes } = await import('../../src/modules/matching/interfaces/routes/adminEnquadreEventRoutes');

        const pool = DatabaseConnection.getInstance().getPool();
        // O gate de produção (TactiqLinkService.statesFor sobre o banco real); OAuth/MCP são dublês que nunca são chamados aqui.
        const tactiq = new TactiqLinkService({ repo: new TactiqLinkRepository(pool), oauth: new FakeTactiqOAuth(), mcp: new FakeTactiqMcp(), db: pool });
        const calendar = new FakeAdmissionCalendar();

        express.use('/api/admin', createAdminInterviewHostRoutes(auth, permissions, new InterviewHostController(new InterviewHostService({ db: pool, repo: interviewHostRepository, tactiq }))));
        const panel = new AdmissionPanelService({
          db: pool, calendar, reminderTasks: {} as never, events: {} as never, messaging: {} as never, hosts: interviewHostRepository, tactiq,
          impersonateEmail: 'enlite@enlite.health',
        });
        express.use('/api/admin', createAdminAdmissionRoutes(auth, permissions, new AdmissionPanelController({} as never, panel)));
        const service = new EnquadreEventService({
          db: pool, calendar, hosts: interviewHostRepository, tactiq, decryptor: { decrypt: async () => 'x' }, env: process.env,
          impersonateEmail: 'enlite@enlite.health', calendarRetryDelaysMs: [],
        });
        const mutations = new EnquadreEventMutations({
          db: pool, calendar, env: process.env, impersonateEmail: 'enlite@enlite.health',
          readEvent: (v, e, viewer) => service.getEvent(v, e, viewer), pubsub: { publish: async () => 'msg' } as never,
        });
        express.use('/api/admin', createAdminEnquadreEventRoutes(auth, permissions, new EnquadreEventController(service, mutations)));
      },
    });
  }, 60000);

  afterAll(async () => {
    await app?.fechar();
    const { DatabaseConnection } = await import('@shared/database/DatabaseConnection');
    await DatabaseConnection.getInstance().close();
    await limpar();
    await admin.end();
    for (const [k, v] of Object.entries(envAnterior)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('0. sanidade: as 2 células existem no catálogo e a migration 523 criou as colunas (o zero das provas não é banco antigo)', async () => {
    const cells = await admin.query(`SELECT action FROM iam.permissions WHERE resource = 'interview_host' AND deprecated_at IS NULL ORDER BY action`);
    expect(cells.rows.map((r) => r.action)).toEqual(['read', 'update']);
    const cols = await admin.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'interview_hosts' AND column_name = ANY($1) ORDER BY column_name`,
      [['user_uid', 'does_enquadre', 'does_admission', 'countries', 'updated_at', 'updated_by']],
    );
    expect(cols.rows).toHaveLength(6);
    expect((await admissionEmails('AR')).includes(FLOR.email)).toBe(false);
  });

  describe('R3 — cada fluxo lê só quem tem o seu interruptor ligado', () => {
    it('POST válido (AR, só Encuadre) → 201; aparece no roster do enquadre e NÃO no da admissão', async () => {
      const res = await post(FLOR.uid, { doesAdmission: false });
      expect(res.status).toBe(201);
      const id = res.body.data.id as string;
      expect(await enquadreHostNames()).toContain(id);
      expect(await admissionEmails('AR')).not.toContain(FLOR.email);
      const row = await hostRow(FLOR.email);
      expect(row).toMatchObject({ user_uid: FLOR.uid, does_enquadre: true, does_admission: false, active: true, country: 'AR', countries: ['AR'], updated_by: CHEFE });
    });

    it('religar Admisión pelo PATCH → passa a aparecer nos dois', async () => {
      const id = (await hostRow(FLOR.email)).id as string;
      expect((await http('PATCH', `/api/admin/interview-hosts/${id}`, { doesAdmission: true })).status).toBe(200);
      expect(await admissionEmails('AR')).toContain(FLOR.email);
      expect(await enquadreHostNames()).toContain(id);
    });

    it('só Admisión → aparece na admissão e NÃO no enquadre (o espelho do primeiro caso)', async () => {
      const id = (await hostRow(FLOR.email)).id as string;
      expect((await http('PATCH', `/api/admin/interview-hosts/${id}`, { doesEnquadre: false })).status).toBe(200);
      expect(await admissionEmails('AR')).toContain(FLOR.email);
      expect(await enquadreHostNames()).not.toContain(id);
    });
  });

  describe('R1 — só usuário staff ativo', () => {
    it('uid inexistente, uid de prestador e uid de usuário DESATIVADO → 400 sem criar linha', async () => {
      for (const uid of [`nao-existe-${RUN}`, WORKER.uid, OFF.uid]) {
        const res = await post(uid);
        expect(res.status).toBe(400);
        expect(res.body).toMatchObject({ code: 'INTERVIEW_HOST_USER_NOT_ELIGIBLE' });
      }
      expect((await admin.query(`SELECT count(*)::int AS n FROM interview_hosts WHERE email = ANY($1)`, [[WORKER.email, OFF.email]])).rows[0].n).toBe(0);
    });

    it('a busca de candidatos devolve só staff ativo: nem prestador, nem desativado, nem quem já está na lista', async () => {
      const res = await http('GET', `/api/admin/interview-hosts/candidates?q=${encodeURIComponent(`.e2e055.${RUN}`)}`);
      expect(res.status).toBe(200);
      const found = (res.body.data as Array<{ uid: string }>).map((c) => c.uid);
      expect(found).toContain(MAYRA.uid);
      expect(found).not.toContain(WORKER.uid);
      expect(found).not.toContain(OFF.uid);
      expect(found).not.toContain(FLOR.uid); // já ativa na lista
    });

    it('POST de quem já está ATIVA → 409 (editar é PATCH)', async () => {
      const res = await post(FLOR.uid);
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ code: 'INTERVIEW_HOST_ALREADY_ACTIVE' });
    });
  });

  describe('R2 — usuário desativado sai dos dois fluxos sozinho', () => {
    it('desativar o usuário some do GET .../enquadre-events/hosts e do GET /admission/hosts; reativar volta; a tela marca "usuário inativo"', async () => {
      await post(MAYRA.uid);
      const id = (await hostRow(MAYRA.email)).id as string;
      expect(await enquadreHostNames()).toContain(id);
      expect(await admissionEmails('AR')).toContain(MAYRA.email);

      await admin.query(`UPDATE users SET is_active = false WHERE firebase_uid = $1`, [MAYRA.uid]);
      expect(await enquadreHostNames()).not.toContain(id);
      expect(await admissionEmails('AR')).not.toContain(MAYRA.email);
      const row = (await listed()).find((h) => h.id === id);
      expect(row).toMatchObject({ userInactive: true, userMissing: false });
      // R1 também no editar: religar/mudar a linha de usuário desativado é recusado
      expect((await http('PATCH', `/api/admin/interview-hosts/${id}`, { countries: ['AR', 'BR'] })).status).toBe(400);

      await admin.query(`UPDATE users SET is_active = true WHERE firebase_uid = $1`, [MAYRA.uid]);
      expect(await enquadreHostNames()).toContain(id);
      expect(await admissionEmails('AR')).toContain(MAYRA.email);
    });

    it('linha SEM usuário (user_uid NULL, como a Ana Joulie): fora do roster dos dois fluxos, MAS aparece na tela com userMissing; só dá para Quitar', async () => {
      const semUsuario = await insertInterviewHost(admin, { email: SEM_USUARIO, displayName: 'Sem Usuario', withUser: false });
      expect(await enquadreHostNames()).not.toContain(semUsuario.id);
      expect(await admissionEmails('AR')).not.toContain(SEM_USUARIO);
      const row = (await listed()).find((h) => h.id === semUsuario.id);
      expect(row).toMatchObject({ userMissing: true, userUid: null });
      expect((await http('PATCH', `/api/admin/interview-hosts/${semUsuario.id}`, { countries: ['BR'] })).status).toBe(400);
      expect((await http('PATCH', `/api/admin/interview-hosts/${semUsuario.id}`, { doesEnquadre: false, doesAdmission: false })).status).toBe(200);
      expect((await hostRow(SEM_USUARIO)).active).toBe(false);
    });
  });

  describe('R4 — uma pessoa pode atender os dois países', () => {
    it('AR+BR aparece na lista de admissão dos DOIS países; tirar o BR a tira do BR', async () => {
      const id = (await hostRow(MAYRA.email)).id as string;
      expect((await http('PATCH', `/api/admin/interview-hosts/${id}`, { countries: ['AR', 'BR'] })).status).toBe(200);
      expect(await admissionEmails('AR')).toContain(MAYRA.email);
      expect(await admissionEmails('BR')).toContain(MAYRA.email);
      expect((await hostRow(MAYRA.email)).countries).toEqual(['AR', 'BR']);
      expect((await http('PATCH', `/api/admin/interview-hosts/${id}`, { countries: ['AR'] })).status).toBe(200);
      expect(await admissionEmails('BR')).not.toContain(MAYRA.email);
    });

    it('país fora de AR/BR ou lista vazia → 400', async () => {
      const id = (await hostRow(MAYRA.email)).id as string;
      expect((await http('PATCH', `/api/admin/interview-hosts/${id}`, { countries: [] })).status).toBe(400);
      expect((await http('PATCH', `/api/admin/interview-hosts/${id}`, { countries: ['CL'] })).status).toBe(400);
    });
  });

  describe('Quitar e reativar', () => {
    it('os dois fluxos desligados inativam (a linha NÃO é apagada) e saem das duas listas; POST da mesma pessoa reativa a MESMA linha', async () => {
      const id = (await hostRow(MAYRA.email)).id as string;
      expect((await http('PATCH', `/api/admin/interview-hosts/${id}`, { doesEnquadre: false, doesAdmission: false })).status).toBe(200);
      expect(await hostRow(MAYRA.email)).toMatchObject({ id, active: false });
      expect(await enquadreHostNames()).not.toContain(id);
      expect(await admissionEmails('AR')).not.toContain(MAYRA.email);
      expect((await listed()).some((h) => h.id === id)).toBe(false); // quitada some da tela

      const again = await post(MAYRA.uid, { countries: ['AR'], doesEnquadre: true, doesAdmission: false });
      expect(again.status).toBe(201);
      expect(again.body.data.id).toBe(id);
      expect((await admin.query(`SELECT count(*)::int AS n FROM interview_hosts WHERE email = $1`, [MAYRA.email])).rows[0].n).toBe(1);
      expect(await hostRow(MAYRA.email)).toMatchObject({ active: true, does_enquadre: true, does_admission: false });
    });
  });

  describe('permissão — células próprias', () => {
    it('sem grupo: tudo 403; só `read`: lista 200, mas candidatos, POST e PATCH levam 403', async () => {
      expect((await http('GET', '/api/admin/interview-hosts', undefined, SEM_GRUPO)).status).toBe(403);
      expect((await http('GET', '/api/admin/interview-hosts', undefined, LEITOR)).status).toBe(200);
      expect((await http('GET', '/api/admin/interview-hosts/candidates?q=abc', undefined, LEITOR)).status).toBe(403);
      expect((await http('POST', '/api/admin/interview-hosts', { userUid: MAYRA.uid, countries: ['AR'], doesEnquadre: true, doesAdmission: true }, LEITOR)).status).toBe(403);
      const id = (await hostRow(MAYRA.email)).id as string;
      expect((await http('PATCH', `/api/admin/interview-hosts/${id}`, { doesEnquadre: false }, LEITOR)).status).toBe(403);
      expect((await hostRow(MAYRA.email)).does_enquadre).toBe(true); // nada mudou
    });
  });
});
