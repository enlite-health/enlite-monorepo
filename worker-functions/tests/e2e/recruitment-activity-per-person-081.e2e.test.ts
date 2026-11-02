/**
 * recruitment-activity-per-person-081.e2e.test.ts — spec 081, T064b (gate do PR #787): a rota
 * `GET /api/admin/recruitment/activity-per-person` contra POSTGRES REAL e HTTP real, com o ENGINE DE PERMISSÃO LIGADO para a
 * família `admin.recruitment`. Molde: `pedidos-ia-078.e2e.test.ts` (app em processo pelo harness, usuários/grupos por SQL).
 *
 * Prova (o route test unitário usa fakes e `tests/repo` não roda no CI; este roda no job `backend-e2e`):
 *   - Acesso Master (tem `recruitment_activity_per_person:read` pela migration 555) -> 200 com as linhas de SÓ `staff:<uid>`;
 *     números exatos por pessoa/semana; Luz, sistema e `staff:<e-mail>` (fallback) FORA; nenhum `@` no JSON;
 *   - ação de 6 semanas atrás fica fora da janela padrão (4) e entra com `weeks=12`; `weeks=0` -> 400;
 *   - grupo SEM a célula -> 403; sem credencial -> 401.
 * Dados SINTÉTICOS por SQL (uids/e-mails com marca da rodada), todos os instantes fixados em UM `now()` lido do banco; a limpeza
 * apaga pelo worker (as trilhas caem em CASCADE), pelo job_posting e pelas fixtures de `iam.*`.
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

const DATABASE_URL =
  process.env.TEST_DATABASE_URL ||
  process.env.DATABASE_URL ||
  'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

const MASTER_ID = 'a0000000-0000-0000-0000-000000000001';
const BA = 'America/Argentina/Buenos_Aires';
const RUN = Date.now().toString(36);
// `worker_profile_changes_audit.changed_by` é varchar(40): "staff:" + uid precisa caber.
const A = `ra81-a-${RUN}`;
const B = `ra81-b-${RUN}`;
const U = {
  master: `ra81-master-${RUN}`, // Acesso Master -> tem a célula
  semCelula: `ra81-sem-${RUN}`, // grupo com outra célula
};
const GRUPO_SEM = `Ra81 Sem Celula ${RUN}`;
const EMAIL_DOMAIN = `@ra81-${RUN}.test`;

describe('atividade do funil por recrutadora — HTTP real, banco real, engine LIGADO (spec 081, T064b)', () => {
  let admin: Pool;
  let app: AppDeFamilia;
  let semana = ''; // segunda (BA) da semana de `t`
  let semanaAntiga = ''; // segunda (BA) de 6 semanas antes
  let jobId = '';
  const workers: string[] = [];
  const envAnterior: Record<string, string | undefined> = {};
  const setEnv = (k: string, v: string): void => {
    if (!(k in envAnterior)) envAnterior[k] = process.env[k];
    process.env[k] = v;
  };

  async function get(path: string, uid: string | null) {
    const res = await fetch(`${app.url}${path}`, { headers: uid ? { Authorization: tokenMock(uid, 'admin', 'AR') } : {} });
    const texto = await res.text();
    return { status: res.status, texto, body: (JSON.parse(texto || '{}') as Record<string, any>) };
  }

  async function novoWorker(sufixo: string): Promise<string> {
    // status REGISTERED: o trigger enforce_worker_registered_for_application exige para criar candidatura.
    const r = await admin.query(
      `INSERT INTO workers (auth_uid, email, country, timezone, status) VALUES ($1, $2, 'AR', 'America/Argentina/Buenos_Aires', 'REGISTERED') RETURNING id`,
      [`ra81-w-${sufixo}-${RUN}`, `w-${sufixo}${EMAIL_DOMAIN}`],
    );
    workers.push(r.rows[0].id as string);
    return r.rows[0].id as string;
  }
  async function novaCandidatura(workerId: string): Promise<string> {
    const r = await admin.query(
      `INSERT INTO worker_job_applications (worker_id, job_posting_id, application_funnel_stage, source) VALUES ($1, $2, 'INVITED', 'talentum') RETURNING id`,
      [workerId, jobId],
    );
    return r.rows[0].id as string;
  }
  const mover = (appId: string, por: string | null, t: Date | string) =>
    admin.query(
      `INSERT INTO worker_job_application_stage_history (application_id, field_name, old_value, new_value, changed_by, change_source, created_at)
       VALUES ($1, 'application_funnel_stage', 'INVITED', 'PRE_SCREENING', $2, 'e2e-ra81', $3)`,
      [appId, por, t],
    );
  const mudarStatus = (workerId: string, por: string | null, t: Date | string) =>
    admin.query(
      `INSERT INTO worker_status_history (worker_id, field_name, old_value, new_value, changed_by, change_source, created_at)
       VALUES ($1, 'status', 'REGISTERED', 'ACTIVE', $2, 'e2e-ra81', $3)`,
      [workerId, por, t],
    );
  const editarPerfil = (workerId: string, por: string, t: Date | string) =>
    admin.query(
      `INSERT INTO worker_profile_changes_audit (worker_id, field_name, changed_by, source, created_at) VALUES ($1, 'first_name', $2, 'admin_panel', $3)`,
      [workerId, por, t],
    );

  async function limpar(): Promise<void> {
    await admin.query(`DELETE FROM workers WHERE email LIKE $1`, [`%${EMAIL_DOMAIN}`]); // candidaturas e trilhas caem em CASCADE
    await admin.query(`DELETE FROM job_postings WHERE title = $1`, [`Ra81 ${RUN}`]);
    await limparIamFixtures(admin, { uids: Object.values(U), grupos: [GRUPO_SEM] });
  }

  beforeAll(async () => {
    admin = new Pool({ connectionString: DATABASE_URL });
    await limpar();

    setEnv('USE_MOCK_AUTH', 'true');
    setEnv('PERMISSION_ENGINE_ENABLED', 'true');
    setEnv('PERMISSION_CATALOG_SYNC_ENABLED', 'true');
    setEnv('PERMISSION_ENFORCED_ROUTES', 'admin.recruitment');
    setEnv('PERMISSION_CACHE_TTL_MS', '0');
    setEnv('DATABASE_URL', DATABASE_URL);

    await admin.query(
      `INSERT INTO users (firebase_uid, email, role, status, is_active, tenant_id) VALUES ($1,$3,'admin','ACTIVE',true,$5), ($2,$4,'admin','ACTIVE',true,$5)`,
      [U.master, U.semCelula, `${U.master}@e2e.local`, `${U.semCelula}@e2e.local`, TENANT_E2E],
    );
    await admin.query(`INSERT INTO iam.user_groups (user_id, group_id, tenant_id) VALUES ($1, $2, $3)`, [U.master, MASTER_ID, TENANT_E2E]);
    await grupoComCelulas(admin, { nome: GRUPO_SEM, uid: U.semCelula, celulas: [['dashboard', 'read']] });

    // Um único "agora" vindo do banco: todas as linhas da semana corrente usam este instante (nenhuma cruza a virada da semana).
    const t = (await admin.query(`SELECT now() AS t`)).rows[0].t as Date;
    const antigo = (await admin.query(`SELECT $1::timestamptz - interval '6 weeks' AS t`, [t])).rows[0].t as Date;
    const seg = (d: Date) =>
      admin.query(`SELECT to_char(date_trunc('week', $1::timestamptz AT TIME ZONE '${BA}'), 'YYYY-MM-DD') AS s`, [d]).then((r) => r.rows[0].s as string);
    semana = await seg(t);
    semanaAntiga = await seg(antigo);

    const jp = await admin.query(`INSERT INTO job_postings (title, description, country, status) VALUES ($1, 'Ra81 vaga sintetica', 'AR', 'ACTIVE') RETURNING id`, [`Ra81 ${RUN}`]);
    jobId = jp.rows[0].id as string;

    const w1 = await novoWorker('1');
    const w2 = await novoWorker('2');
    const a1 = await novaCandidatura(w1);
    const a2 = await novaCandidatura(w2);

    // staff A, semana corrente: 2 movimentos de funil (w1, w2), 1 mudança de status (w1), 1 edição de perfil (w1) -> total 4, 2 prestadores.
    await mover(a1, `staff:${A}`, t);
    await mover(a2, `staff:${A}`, t);
    await mudarStatus(w1, `staff:${A}`, t);
    await editarPerfil(w1, `staff:${A}`, t);
    // staff B, semana corrente: 1 movimento (w1) -> total 1, 1 prestador.
    await mover(a1, `staff:${B}`, t);
    // staff A, 6 semanas atrás: 1 mudança de status (w2) — FORA da janela padrão (4), DENTRO de weeks=12.
    await mudarStatus(w2, `staff:${A}`, antigo);
    // NÃO-staff, mesma semana: têm de ficar FORA (Luz, sistema, sem autor, e-mail como fallback do staffActor).
    await mover(a1, 'luz', t);
    await mover(a2, null, t);
    await mudarStatus(w1, 'system', t);
    await mudarStatus(w2, `staff:fulano${EMAIL_DOMAIN}`, t);
    await editarPerfil(w2, 'luz', t);

    app = await montarAppDeFamilia({
      enforcedRoutes: 'admin.recruitment',
      montarRotas: async ({ app: express, auth, permissions }) => {
        const { createRecruitmentRoutes } = await import('../../src/modules/matching/interfaces/routes/recruitmentRoutes');
        express.use('/api', createRecruitmentRoutes(auth, permissions));
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

  it('a célula existe no catálogo do banco e o Acesso Master a tem (migration 555); o grupo de controle não', async () => {
    const r = await admin.query(
      `SELECT gp.group_id FROM iam.group_permissions gp JOIN iam.permissions p ON p.id = gp.permission_id
        WHERE p.resource = 'recruitment_activity_per_person' AND p.action = 'read' AND p.deprecated_at IS NULL`,
    );
    expect(r.rows.map((x) => x.group_id)).toContain(MASTER_ID);
    const sem = await admin.query(
      `SELECT 1 FROM iam.user_groups ug JOIN iam.group_permissions gp ON gp.group_id = ug.group_id JOIN iam.permissions p ON p.id = gp.permission_id
        WHERE ug.user_id = $1 AND p.resource = 'recruitment_activity_per_person'`,
      [U.semCelula],
    );
    expect(sem.rowCount).toBe(0);
  });

  it('Acesso Master -> 200: só as linhas de staff:<uid>, números exatos por pessoa e semana, Luz/sistema/e-mail fora, nenhum "@" no JSON', async () => {
    const r = await get('/api/admin/recruitment/activity-per-person', U.master);
    expect(r.status).toBe(200);
    expect(r.body.success).toBe(true);
    expect(r.body.weeks).toBe(4);

    const rows = r.body.rows as Array<Record<string, any>>;
    const minhas = rows.filter((x) => x.staffUid === A || x.staffUid === B);
    expect(minhas).toEqual([
      { staffUid: A, weekStart: semana, funnelMoves: 2, statusChanges: 1, profileEdits: 1, totalActions: 4, workers: 2 },
      { staffUid: B, weekStart: semana, funnelMoves: 1, statusChanges: 0, profileEdits: 0, totalActions: 1, workers: 1 },
    ]);
    // A ação de 6 semanas atrás (A, w2) não entrou na janela padrão.
    expect(rows.some((x) => x.weekStart === semanaAntiga && x.staffUid === A)).toBe(false);

    // Só atores staff: nenhuma linha (de ninguém) com Luz, sistema, e-mail ou identidade crua; só chaves de contagem.
    for (const x of rows) {
      expect(x.staffUid).not.toMatch(/[@:]/);
      expect(['luz', 'system', 'sistema', '']).not.toContain(x.staffUid);
      expect(Object.keys(x).sort()).toEqual(['funnelMoves', 'profileEdits', 'staffUid', 'statusChanges', 'totalActions', 'weekStart', 'workers']);
    }
    expect(r.texto).not.toContain('@');
    expect(r.texto).not.toContain('staff:');
  });

  it('weeks=12 traz a ação de 6 semanas atrás de A como uma linha à parte; weeks=0 -> 400', async () => {
    const r = await get('/api/admin/recruitment/activity-per-person?weeks=12', U.master);
    expect(r.status).toBe(200);
    expect(r.body.weeks).toBe(12);
    const deA = (r.body.rows as Array<Record<string, any>>).filter((x) => x.staffUid === A);
    expect(deA).toEqual([
      { staffUid: A, weekStart: semana, funnelMoves: 2, statusChanges: 1, profileEdits: 1, totalActions: 4, workers: 2 },
      { staffUid: A, weekStart: semanaAntiga, funnelMoves: 0, statusChanges: 1, profileEdits: 0, totalActions: 1, workers: 1 },
    ]);
    expect((await get('/api/admin/recruitment/activity-per-person?weeks=0', U.master)).status).toBe(400);
  });

  it('staff de grupo SEM a célula -> 403 (e o corpo não traz linha alguma); sem credencial -> 401', async () => {
    const sem = await get('/api/admin/recruitment/activity-per-person', U.semCelula);
    expect(sem.status).toBe(403);
    expect(sem.body.rows).toBeUndefined();
    expect(sem.texto).not.toContain(A);
    const anon = await get('/api/admin/recruitment/activity-per-person', null);
    expect(anon.status).toBe(401);
    expect(anon.body.rows).toBeUndefined();
  });
});
