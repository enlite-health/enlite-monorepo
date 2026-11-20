/**
 * Spec 092 (F2, T204, CA-4) — leitura dos informes da guarda no PAINEL, pela borda HTTP, com o ENGINE DE PERMISSÃO LIGADO
 * (PermissionMiddleware de produção + iam.* reais) e a rota REAL (`createAdminDailyReportRoutes`), Postgres real.
 *
 * describe('redação'): usuário A com `daily_report:read` SEM `daily_report_narrative:read` → `narrative: null` + `narrativeRedacted: true`
 * (e o texto-espião NÃO está em nenhum byte da resposta); usuário B COM as duas → o texto vem. Sem `daily_report:read` → 403 (também quem só
 * tem a célula do texto). Dado 100% sintético; narrativa = `NARRATIVA-ESPIA-092`.
 */
import { Pool } from 'pg';
import { v4 as uuidv4 } from 'uuid';
import {
  TENANT_E2E, tokenMock, montarAppDeFamilia, limparIamFixtures, grupoComCelulas, garantirCelulas, removerCelulasCriadas, type AppDeFamilia,
} from './helpers/permissionFamilyHarness';
import { catalogoItens, inserirPti, semearGuarda, limparGuarda, type CatalogoItens, type Guarda } from './helpers/seedDailyReport092';

const DATABASE_URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';
const ESPIA = 'NARRATIVA-ESPIA-092';
const TAG = 'e2e092-adm';
const U = { a: 'dr092-a-sem-texto', b: 'dr092-b-com-texto', c: 'dr092-c-sem-grupo', d: 'dr092-d-so-texto' };
const GRUPOS = { a: 'Dr092 A', b: 'Dr092 B', d: 'Dr092 D' };

describe('redação — informes da guarda no painel (spec 092, CA-4) @integration', () => {
  let admin: Pool;
  let app: AppDeFamilia;
  let g: Guarda;
  let cat: CatalogoItens;
  let reportId: string;
  let celulasCriadas: string[] = [];
  const envAnterior: Record<string, string | undefined> = {};
  const setEnv = (k: string, v: string): void => {
    if (!(k in envAnterior)) envAnterior[k] = process.env[k];
    process.env[k] = v;
  };

  const get = async (uid: string | null, path: string) => {
    const res = await fetch(`${app.url}${path}`, { headers: uid ? { Authorization: tokenMock(uid, 'admin', 'AR') } : {} });
    const text = await res.text();
    return { status: res.status, text, body: JSON.parse(text || '{}') as Record<string, any> };
  };
  const lista = (uid: string | null, patientId = g.patientId, qs = '') => get(uid, `/api/admin/patients/${patientId}/daily-reports${qs}`);

  async function limpar(): Promise<void> {
    await limparIamFixtures(admin, { uids: Object.values(U), grupos: Object.values(GRUPOS) });
    await limparGuarda(admin, TAG);
  }

  beforeAll(async () => {
    admin = new Pool({ connectionString: DATABASE_URL });
    await limpar();
    setEnv('USE_MOCK_AUTH', 'true');
    setEnv('PERMISSION_ENGINE_ENABLED', 'true');
    setEnv('PERMISSION_ENFORCED_ROUTES', 'admin.patients');
    setEnv('PERMISSION_CACHE_TTL_MS', '0');
    setEnv('DATABASE_URL', DATABASE_URL);

    cat = await catalogoItens(admin);
    g = await semearGuarda(admin, TAG);
    const pti = await inserirPti(admin, { patientId: g.patientId, serviceId: g.serviceId, start: '2026-01-01', end: '2027-12-31', objectiveIds: [cat.objSn], activityIds: [cat.actSn] });
    reportId = uuidv4();
    await admin.query(
      `INSERT INTO daily_reports (id, worker_id, slot_id, on_date, pti_version_id, narrative, narrative_source, device_submitted_at, app_version)
       VALUES ($1, $2, $3, $4, $5, $6, 'DICTATED', now(), '1.0.0')`,
      [reportId, g.workerId, g.slotSegId, g.onDate, pti, `${ESPIA} texto do relatório`],
    );
    const objGen = (await admin.query<{ id: string }>(`SELECT id FROM therapeutic_specific_objectives WHERE daily_scale_code = 'GEN' ORDER BY id LIMIT 1`)).rows[0].id;
    await admin.query(
      `INSERT INTO daily_report_answers (report_id, objective_id, activity_id, scale_code, option_code) VALUES ($1, $2, NULL, 'GEN', '1'), ($1, NULL, $3, 'SN', 'si')`,
      [reportId, objGen, cat.actSn],
    );

    celulasCriadas = await garantirCelulas(admin, ['daily_report:read', 'daily_report_narrative:read'], 'Pacientes');
    await admin.query(
      `INSERT INTO users (firebase_uid, email, role, status, is_active, tenant_id) VALUES
         ($1,'dr092-a@e2e.local','admin','ACTIVE',true,$5), ($2,'dr092-b@e2e.local','admin','ACTIVE',true,$5),
         ($3,'dr092-c@e2e.local','admin','ACTIVE',true,$5), ($4,'dr092-d@e2e.local','admin','ACTIVE',true,$5)`,
      [U.a, U.b, U.c, U.d, TENANT_E2E],
    );
    await grupoComCelulas(admin, { nome: GRUPOS.a, uid: U.a, celulas: [['daily_report', 'read']] });
    await grupoComCelulas(admin, { nome: GRUPOS.b, uid: U.b, celulas: [['daily_report', 'read'], ['daily_report_narrative', 'read']] });
    await grupoComCelulas(admin, { nome: GRUPOS.d, uid: U.d, celulas: [['daily_report_narrative', 'read']] });

    app = await montarAppDeFamilia({
      enforcedRoutes: 'admin.patients',
      montarRotas: async ({ app: express, auth, permissions }) => {
        const { createAdminDailyReportRoutes, buildAdminDailyReportController } = await import('../../src/modules/case/interfaces/routes/adminDailyReportRoutes');
        express.use('/api/admin', createAdminDailyReportRoutes(buildAdminDailyReportController(), auth, permissions));
      },
    });
  }, 60000);

  afterAll(async () => {
    await app?.fechar();
    const { DatabaseConnection } = await import('@shared/database/DatabaseConnection');
    await DatabaseConnection.getInstance().close();
    await limpar();
    await removerCelulasCriadas(admin, celulasCriadas);
    await admin.end();
    for (const [k, v] of Object.entries(envAnterior)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('0. sanidade: o informe semeado existe com 2 respostas (o "sem texto" abaixo não é banco vazio)', async () => {
    const r = await admin.query(`SELECT (SELECT count(*) FROM daily_reports WHERE id = $1)::int AS r, (SELECT count(*) FROM daily_report_answers WHERE report_id = $1)::int AS a`, [reportId]);
    expect(r.rows[0]).toEqual({ r: 1, a: 2 });
  });

  describe('redação', () => {
    it('A (daily_report:read, SEM a célula do texto): estrutura e sinal vêm; narrative null + narrativeRedacted true; o espião não está em byte nenhum', async () => {
      const r = await lista(U.a);
      expect(r.status).toBe(200);
      expect(r.body.items).toHaveLength(1);
      const item = r.body.items[0];
      expect(item).toMatchObject({ id: reportId, workerId: g.workerId, onDate: g.onDate, narrative: null, narrativeRedacted: true, answersCount: 2, immediateAlert: true, narrativeSource: 'DICTATED' });
      expect(item.answers.find((a: { scaleCode: string }) => a.scaleCode === 'GEN')).toMatchObject({ optionCode: '1', score: 1, immediateAlert: true });
      expect(item.answers.find((a: { scaleCode: string }) => a.scaleCode === 'SN')).toMatchObject({ optionCode: 'si', score: null, immediateAlert: false });
      expect(r.text).not.toContain(ESPIA);
    });
    it('B (com as duas células): o texto vem e narrativeRedacted é false (controle positivo da redação: o texto EXISTE no banco)', async () => {
      const r = await lista(U.b);
      expect(r.status).toBe(200);
      expect(r.body.items[0]).toMatchObject({ narrative: `${ESPIA} texto do relatório`, narrativeRedacted: false });
    });
    it('sem daily_report:read → 403: staff sem grupo e quem só tem a célula do texto (a do texto não substitui a da estrutura)', async () => {
      expect((await lista(U.c)).status).toBe(403);
      const d = await lista(U.d);
      expect(d.status).toBe(403);
      expect(d.text).not.toContain(ESPIA);
      expect((await lista(null)).status).toBe(401);
    });
  });

  describe('forma da rota', () => {
    it('janela: from/to filtram por data da guarda; fora da janela → lista vazia; query inválida → 400; paciente inexistente → 404', async () => {
      expect((await lista(U.a, g.patientId, `?from=${g.onDate}&to=${g.onDate}`)).body.items).toHaveLength(1);
      expect((await lista(U.a, g.patientId, '?from=2020-01-01&to=2020-01-31')).body.items).toEqual([]);
      expect((await lista(U.a, g.patientId, '?from=ontem')).status).toBe(400);
      expect((await lista(U.a, 'nao-e-uuid')).status).toBe(400);
      expect((await lista(U.a, uuidv4())).status).toBe(404);
    });
    it('trilha de leitura de paciente: A grava read_daily_reports, B grava read_daily_reports:narrative (valor enumerado, sem dado)', async () => {
      const acoes = async (uid: string): Promise<string[]> => {
        for (let i = 0; i < 20; i += 1) {
          const { rows } = await admin.query<{ action: string }>(`SELECT action FROM resource_access_log WHERE operator_uid = $1 AND resource_id = $2`, [uid, g.patientId]);
          if (rows.length > 0) return [...new Set(rows.map((r) => r.action))];
          await new Promise((r) => setTimeout(r, 100));
        }
        return [];
      };
      expect(await acoes(U.a)).toEqual(['read_daily_reports']);
      expect(await acoes(U.b)).toEqual(['read_daily_reports:narrative']);
    });
  });
});
