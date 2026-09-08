import { Pool } from 'pg';
import { AdminPatientDiagnosesController } from '@modules/diagnosis/interfaces/controllers/AdminPatientDiagnosesController';
import { AdminTerminologySearchController } from '@modules/terminology/interfaces/controllers/AdminTerminologySearchController';
import { montarAppDeFamilia, type AppDeFamilia } from './helpers/permissionFamilyHarness';

/**
 * AS ROTAS DE PACIENTE SOB A RLS DE PAÍS — HTTP REAL, BANCO REAL (abac-pais-fase1).
 *
 * `country-context-app.test.ts` provou o MECANISMO (contexto no ALS, GUCs no client) e
 * `dual-pool-routing.test.ts` provou o ROTEAMENTO (duas identidades num processo só).
 * Nenhum dos dois passa por uma rota: os dois chamam `pool.query` na mão, com o contexto
 * declarado pelo próprio teste. Este arquivo fecha a lacuna que sobrou — as três mudanças
 * de rota da change (guard de país no `?country=`/body, 404 indistinguível no detalhe,
 * trilha de leitura no `resource_access_log`) só existem NA CADEIA DE MIDDLEWARE, e a
 * cadeia é justamente o que nenhum teste anterior exercita.
 *
 * Por isso aqui sobe um Express IN-PROCESS com a montagem REAL do `src/index.ts`
 * (`correlationMiddleware` → `dbSessionMiddleware` → `mockAuthMiddleware` →
 * `createAdminPatientsRoutes` com controller/repos de produção) numa porta efêmera, e as
 * provas saem de `fetch` de verdade + asserção no BANCO — nunca no retorno da função.
 *
 * ⚠️ `jest.mock` é PROIBIDO neste arquivo por decisão de escopo: um mock aqui apagaria
 * exatamente a camada sob teste. O que o teste substitui é só a IDENTIDADE DA CONEXÃO
 * (usuários de login membros de `app_runtime`/`app_system`, o que a virada da task 4.x
 * faz em stg/prd) — e essa substituição é o objeto do teste, não um atalho.
 *
 * ⚠️ As envs de banco são escritas ANTES do primeiro `DatabaseConnection.getInstance()`,
 * por isso todo o `src/` entra por `await import()` dentro do `beforeAll`. Import estático
 * no topo criaria o singleton com a connection de `enlite_admin` (superuser, bypassa RLS)
 * e o teste passaria sem testar nada.
 */

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

describe('rotas de paciente sob a RLS de país (HTTP real, banco real)', () => {
  let adminPool: Pool;
  let app: AppDeFamilia;
  let baseUrl: string;

  const RUNTIME_USER = 'abac_routes_runtime';
  const SYSTEM_USER = 'abac_routes_system';
  const PASSWORD = 'abac_routes_e2e_pw';

  const TENANT = '00000000-0000-0000-0000-000000000001';
  const STAFF_AR = { uid: 'abac-routes-staff-ar', email: 'abac-routes-ar@enlite.health', role: 'recruiter', country: 'AR' };

  const IDS = {
    patientAR: 'ee270000-0e00-0001-0001-000000000001',
    patientBR: 'ee270000-0e00-0001-0002-000000000001',
  };
  /** Pacientes criados PELA ROTA — id desconhecido até o POST responder. */
  const criadosPelaRota: string[] = [];

  /** Envs do processo que o teste sobrescreve; restauradas no afterAll. */
  const envAnterior: Record<string, string | undefined> = {};

  const urlFor = (user: string): string => {
    const url = new URL(DATABASE_URL);
    url.username = user;
    url.password = PASSWORD;
    return url.toString();
  };

  /** Token do `mockAuthMiddleware`: `mock_<base64(JSON)>` — `country` espelha o claim. */
  const tokenFor = (user: Record<string, unknown>): string =>
    `mock_${Buffer.from(JSON.stringify(user)).toString('base64')}`;

  /** Corpo da resposta da API. `res.json()` devolve `unknown` — o shape é sempre este. */
  interface ApiBody {
    success?: boolean;
    error?: string;
    detail?: string;
    data?: { id?: string };
  }
  const bodyOf = async (res: Response): Promise<ApiBody> => (await res.json()) as ApiBody;

  const asStaffAR = async (path: string, init: RequestInit = {}): Promise<Response> =>
    fetch(`${baseUrl}${path}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokenFor(STAFF_AR)}`,
        ...(init.headers ?? {}),
      },
    });

  const trailRows = async (): Promise<
    Array<{ operator_uid: string; resource_id: string; origin: string; action: string; resource_type: string }>
  > => {
    // Lido como `enlite_admin`: a 270 REVOGA SELECT de app_runtime/app_system na mãe e em
    // cada partição (a trilha é append-only e ilegível para o runtime, lex C2). Ler pela
    // conexão do app aqui daria zero linhas e o teste passaria por engano.
    const res = await adminPool.query(
      `SELECT operator_uid, resource_id, origin, action, resource_type
         FROM resource_access_log
        WHERE operator_uid = $1
        ORDER BY occurred_at`,
      [STAFF_AR.uid],
    );
    return res.rows;
  };

  /**
   * A trilha é gravada DEPOIS do `finish` da resposta (fail-safe, task 3.4): quando o
   * `fetch` resolve, a linha ainda não existe. Espera ativa em vez de sleep fixo.
   */
  const waitForTrail = async (esperadas: number, timeoutMs = 10_000): Promise<Awaited<ReturnType<typeof trailRows>>> => {
    const limite = Date.now() + timeoutMs;
    let rows = await trailRows();
    while (rows.length < esperadas && Date.now() < limite) {
      await new Promise((r) => setTimeout(r, 100));
      rows = await trailRows();
    }
    return rows;
  };

  async function cleanupDados(): Promise<void> {
    await adminPool.query(`DELETE FROM resource_access_log WHERE operator_uid = $1`, [STAFF_AR.uid]);
    const semeados = [IDS.patientAR, IDS.patientBR, ...criadosPelaRota];
    await adminPool.query(`DELETE FROM patient_status_history WHERE patient_id = ANY($1)`, [semeados]);
    await adminPool.query(`DELETE FROM patients WHERE id = ANY($1)`, [semeados]);
    await adminPool.query(`DELETE FROM users WHERE firebase_uid = $1`, [STAFF_AR.uid]);
  }

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: DATABASE_URL });

    // 1. Usuários de LOGIN por identidade — o que o terraform cria em stg/prd (task 2.2).
    //    Cada um membro de UMA role de grupo só: é essa separação que a policy da 271
    //    checa com `pg_has_role(current_user, 'app_system', 'MEMBER')`.
    for (const [user, group] of [
      [RUNTIME_USER, 'app_runtime'],
      [SYSTEM_USER, 'app_system'],
    ]) {
      await adminPool.query(`DO $$
        BEGIN
          IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${user}') THEN
            CREATE ROLE ${user} LOGIN PASSWORD '${PASSWORD}';
          END IF;
        END $$;`);
      await adminPool.query(`GRANT ${group} TO ${user}`);
    }

    await cleanupDados();

    // 2. Semente como superuser (bypassa RLS) — o teste precisa das DUAS linhas
    //    existindo de verdade para que o 404 do paciente BR prove isolamento, e não
    //    ausência de dado.
    await adminPool.query(
      `INSERT INTO patients (id, clickup_task_id, first_name, last_name, country) VALUES
         ($1, 'abac-routes-e2e-ar', 'Paciente', 'Argentino', 'AR'),
         ($2, 'abac-routes-e2e-br', 'Paciente', 'Brasileiro', 'BR')`,
      [IDS.patientAR, IDS.patientBR],
    );
    // Staff EXISTE e está ativo: sem esta linha, o 403 do teste (b) seria ambíguo
    // (usuário inexistente também não tem grant). Com ela, o 403 é sobre jurisdição.
    await adminPool.query(
      `INSERT INTO users (firebase_uid, email, role, is_active, tenant_id) VALUES ($1, $2, 'recruiter', true, $3)`,
      [STAFF_AR.uid, STAFF_AR.email, TENANT],
    );

    // 3. Envs ANTES do primeiro getInstance() (ver cabeçalho). `maxWorkers: 1` faz todos
    //    os arquivos da suíte dividirem o MESMO processo — por isso o afterAll restaura.
    for (const key of [
      'DATABASE_URL',
      'DATABASE_SYSTEM_URL',
      'COUNTRY_RLS_ENABLED',
      'USE_MOCK_AUTH',
      'DB_POOL_MAX',
      'DB_SYSTEM_POOL_MAX',
    ]) {
      envAnterior[key] = process.env[key];
    }
    process.env.DATABASE_URL = urlFor(RUNTIME_USER);
    process.env.DATABASE_SYSTEM_URL = urlFor(SYSTEM_USER);
    process.env.COUNTRY_RLS_ENABLED = 'true';
    process.env.USE_MOCK_AUTH = 'true';
    process.env.DB_POOL_MAX = '4';
    process.env.DB_SYSTEM_POOL_MAX = '2';

    // 4. Só agora o `src/` entra.
    const [identity, caseModule, { DatabaseConnection }] = await Promise.all([
      import('@modules/identity'),
      import('@modules/case'),
      import('@shared/database/DatabaseConnection'),
    ]);

    // Wiring mínimo do `src/index.ts` — serviços REAIS, não stubs. Com USE_MOCK_AUTH o
    // `requireStaff()` resolve pelo `req.user` do mockAuth, mas a instância é a de
    // produção: é ela que chama `rememberActorInAls` → `setDbContext`, o elo que liga o
    // claim de país da request ao GUC lido pela policy. Por isso o `AuthMiddleware` é
    // construído AQUI e passado ao harness, em vez de usar o dublê padrão dele.
    const authService = new identity.MultiAuthService(
      { enableApiKeys: true, enableJwt: false, enableGoogleIdToken: true },
      DatabaseConnection.getInstance().getPool(),
    );
    const authMiddleware = new identity.AuthMiddleware(
      authService,
      new identity.SimplifiedAuthorizationEngine(),
    );

    // A família `admin.patients` passou a declarar célula (task 3.5). Este teste é
    // sobre RLS de país, não sobre permissão: sem `PERMISSION_ENGINE_ENABLED` o guard
    // é inerte (deixa passar) e o recorte medido aqui continua sendo o do país. O
    // `PermissionMiddleware` entra só porque a fábrica de rotas agora o exige — quem o
    // constrói, com os mesmos pools de sempre, é o harness compartilhado.
    app = await montarAppDeFamilia({
      auth: authMiddleware,
      montarRotas: ({ app: express, auth, permissions }) =>
        express.use(
          '/api/admin',
          caseModule.createAdminPatientsRoutes(
            new caseModule.AdminPatientsController(),
            auth,
            permissions,
            new caseModule.AdminPatientChatIdsController(),
            new caseModule.AdminPatientChatRolesController(),
            // Os 6 controllers que o main trouxe (specs 011-016, mapa) — a fábrica não tem default de propósito.
            new caseModule.AdminPatientsMapController(),
            new caseModule.AdminPatientAddressesController(),
            new caseModule.AdminInsuranceProvidersController(),
            new caseModule.AdminPatientContractedServicesController(),
            new AdminPatientDiagnosesController(),
            new AdminTerminologySearchController(),
          ),
        ) &&
        // Spec 017 (lex C3): o projeto terapêutico segue o paciente sob a RLS de país.
        express.use(
          '/api/admin',
          caseModule.createAdminTherapeuticProjectsRoutes(new caseModule.AdminTherapeuticProjectsController(), auth, permissions),
        ),
    });
    baseUrl = app.url;
  });

  afterAll(async () => {
    await app?.fechar();

    for (const [key, value] of Object.entries(envAnterior)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }

    if (adminPool) {
      await cleanupDados();
      await adminPool.query(`DROP ROLE IF EXISTS ${RUNTIME_USER}`);
      await adminPool.query(`DROP ROLE IF EXISTS ${SYSTEM_USER}`);
      await adminPool.end();
    }
  });

  // ── (a) POST /patients — o país é declarado, nunca inferido ────────────────────────
  describe('(a) POST /api/admin/patients', () => {
    it('sem `country` recusa com 400 e mensagem explícita', async () => {
      const res = await asStaffAR('/api/admin/patients', {
        method: 'POST',
        body: JSON.stringify({ firstName: 'Sem', lastName: 'Pais', phoneWhatsapp: '+5491100000901' }),
      });

      expect(res.status).toBe(400);
      const body = await bodyOf(res);
      expect(body.success).toBe(false);
      // A mensagem precisa NOMEAR o campo: um 400 genérico manda o operador adivinhar.
      expect(JSON.stringify(body)).toMatch(/country/i);

      // E nada foi gravado — 400 de validação não pode deixar rastro.
      const criado = await adminPool.query(
        `SELECT id FROM patients WHERE first_name = 'Sem' AND last_name = 'Pais'`,
      );
      expect(criado.rowCount).toBe(0);
    });

    it('com `country: AR` cria e a LINHA no banco nasce com o país declarado', async () => {
      const res = await asStaffAR('/api/admin/patients', {
        method: 'POST',
        body: JSON.stringify({
          firstName: 'Criado',
          lastName: 'PelaRota',
          phoneWhatsapp: '+5491100000902',
          country: 'AR',
        }),
      });

      const body = await bodyOf(res);
      expect(res.status).toBe(201);
      expect(body.success).toBe(true);

      const id = body.data?.id as string;
      criadosPelaRota.push(id);

      // A prova é a linha, não o corpo da resposta.
      const linha = await adminPool.query<{ country: string; first_name: string }>(
        `SELECT country, first_name FROM patients WHERE id = $1`,
        [id],
      );
      expect(linha.rowCount).toBe(1);
      expect(linha.rows[0].country).toBe('AR');
      expect(linha.rows[0].first_name).toBe('Criado');
    });

    it('staff AR pedindo `country: BR` no body é recusado pelo guard, sem gravar', async () => {
      const res = await asStaffAR('/api/admin/patients', {
        method: 'POST',
        body: JSON.stringify({
          firstName: 'Cross',
          lastName: 'Pais',
          phoneWhatsapp: '+5491100000903',
          country: 'BR',
        }),
      });

      expect(res.status).toBe(403);
      const body = await bodyOf(res);
      expect(body.error).toBe('Country scope required');
      // O guard EXPLICA em vez de devolver erro cru de RLS (task 3.5).
      expect(body.detail).toMatch(/AR/);
      expect(body.detail).toMatch(/BR/);

      const criado = await adminPool.query(
        `SELECT id FROM patients WHERE first_name = 'Cross' AND last_name = 'Pais'`,
      );
      expect(criado.rowCount).toBe(0);
    });
  });

  // ── (b) GET /patients/stats?country= — guard de UX sobre a RLS ─────────────────────
  describe('(b) GET /api/admin/patients/stats', () => {
    it('staff AR pedindo ?country=BR leva 403 com a mensagem do guard', async () => {
      const res = await asStaffAR('/api/admin/patients/stats?country=BR');

      expect(res.status).toBe(403);
      const body = await bodyOf(res);
      expect(body.success).toBe(false);
      expect(body.error).toBe('Country scope required');
      expect(body.detail).toContain('AR');
      expect(body.detail).toContain('BR');
    });

    it('staff AR pedindo ?country=AR passa (200)', async () => {
      const res = await asStaffAR('/api/admin/patients/stats?country=AR');

      expect(res.status).toBe(200);
      const body = await bodyOf(res);
      expect(body.success).toBe(true);
    });
  });

  // ── (c)/(d) GET /patients/:id — 200 com trilha, 404 sem trilha ─────────────────────
  describe('(c/d) GET /api/admin/patients/:id', () => {
    it('(c) paciente do PRÓPRIO país volta 200 e deixa UMA linha na trilha, origin=same_country', async () => {
      expect(await trailRows()).toHaveLength(0);

      const res = await asStaffAR(`/api/admin/patients/${IDS.patientAR}`);
      expect(res.status).toBe(200);
      const body = await bodyOf(res);
      expect(body.data?.id).toBe(IDS.patientAR);

      const rows = await waitForTrail(1);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        operator_uid: STAFF_AR.uid,
        resource_type: 'patient',
        resource_id: IDS.patientAR,
        // D286: o `action` carrega os containers servidos. Aqui o engine está DESLIGADO
        // (`cells = null`, D113) → a ficha inteira → todos os 9 containers, na ordem canônica.
        action: 'read_detail:identity+clinical+careTeam+family+chat+coverage+address+services+therapeuticProject',
        origin: 'same_country',
      });
    });

    it('(d) paciente de OUTRO país volta 404 e NÃO deixa linha nova na trilha', async () => {
      const antes = await trailRows();

      const res = await asStaffAR(`/api/admin/patients/${IDS.patientBR}`);
      // 404, não 403: dizer "existe mas não é seu" confirmaria a existência da pessoa
      // (spec country-isolation).
      expect(res.status).toBe(404);

      // A trilha grava no `finish`; esperar a janela em que a linha APARECERIA antes de
      // afirmar que ela não veio — senão o teste passaria por ser rápido demais.
      await new Promise((r) => setTimeout(r, 1500));
      const depois = await trailRows();
      expect(depois).toHaveLength(antes.length);
      expect(depois.some((r) => r.resource_id === IDS.patientBR)).toBe(false);

      // E o paciente BR EXISTE mesmo — o 404 veio do isolamento, não de id inválido.
      const existe = await adminPool.query(`SELECT country FROM patients WHERE id = $1`, [IDS.patientBR]);
      expect(existe.rows[0]?.country).toBe('BR');
    });
  });
  // ── (e) POST/PATCH /patients/:id/contracted-services sob RLS — a transação leva o país ──
  // Achado da stage (07/09/2026): o `create` do repositório abria `pool.connect()` cru, sem
  // `app.user_country`, e a policy da 411 recusava com 500 `rls_session_without_identity`
  // (D299 item 5). O conserto é `withActorContext` (D95). Só o ambiente COM RLS ligada
  // reproduz — o unit mocka o pool e passa nos dois estados.
  describe('(e) POST/PATCH /api/admin/patients/:id/contracted-services', () => {
    let servicoId: string | undefined;

    it('staff AR cria serviço no SEU paciente → 201, e a LINHA nasce com o país do paciente', async () => {
      const res = await asStaffAR(`/api/admin/patients/${IDS.patientAR}/contracted-services`, {
        method: 'POST',
        body: JSON.stringify({ serviceCode: 'CAREGIVER', weeklyHours: 10 }),
      });
      const body = (await res.json()) as { success?: boolean; data?: { id?: string } };
      expect({ status: res.status, success: body.success }).toEqual({ status: 201, success: true });
      servicoId = body.data?.id;
      expect(servicoId).toBeTruthy();

      const row = await adminPool.query(
        `SELECT country, created_by FROM patient_contracted_services WHERE id = $1`,
        [servicoId],
      );
      expect(row.rows[0]).toEqual({ country: 'AR', created_by: STAFF_AR.uid });
    });

    it('PATCH no mesmo serviço → 200, mesma transação com país', async () => {
      const res = await asStaffAR(`/api/admin/patients/${IDS.patientAR}/contracted-services/${servicoId}`, {
        method: 'PATCH',
        body: JSON.stringify({ weeklyHours: 12 }),
      });
      expect(res.status).toBe(200);
      const row = await adminPool.query(`SELECT weekly_hours FROM patient_contracted_services WHERE id = $1`, [servicoId]);
      expect(Number(row.rows[0]?.weekly_hours)).toBe(12);
    });

    it('staff AR no paciente BR → recusado e NADA gravado (a policy follow_patient da 413 barra o INSERT)', async () => {
      const res = await asStaffAR(`/api/admin/patients/${IDS.patientBR}/contracted-services`, {
        method: 'POST',
        body: JSON.stringify({ serviceCode: 'CAREGIVER' }),
      });
      // Hoje sai 500 ("new row violates row-level security policy"): o isolamento vale, mas o
      // status é o genérico — LISTA (D299): devolver 404 como o GET /patients/:id faz.
      expect(res.status).toBeGreaterThanOrEqual(400);
      const count = await adminPool.query(
        `SELECT count(*)::int AS n FROM patient_contracted_services WHERE patient_id = $1`,
        [IDS.patientBR],
      );
      expect(count.rows[0].n).toBe(0);
    });
  });

  // ── (f) projeto terapêutico sob RLS (spec 017, lex C3) ──────────────────────────────────
  describe('(f) /patients/:id/therapeutic-projects', () => {
    it('staff AR lista o SEU paciente (200, vazio) e o paciente BR devolve ZERO versões — nunca 500', async () => {
      // Semeia uma versão no paciente BR como superuser: a prova é que o AR NÃO a vê.
      const svc = await adminPool.query<{ id: string }>(
        `INSERT INTO patient_contracted_services (patient_id, service_code, created_by, updated_by) VALUES ($1, 'CAREGIVER', 'e2e', 'e2e') RETURNING id`,
        [IDS.patientBR],
      );
      const obj = await adminPool.query<{ id: string; label: string }>(`SELECT id, label FROM therapeutic_specific_objectives WHERE active LIMIT 1`);
      const act = await adminPool.query<{ id: string; label: string }>(`SELECT id, label FROM therapeutic_activities WHERE active LIMIT 1`);
      const pat = await adminPool.query<{ id: string; label: string }>(`SELECT id, label FROM pathology_types WHERE active LIMIT 1`);
      await adminPool.query(
        `INSERT INTO patient_therapeutic_projects
           (patient_id, major, minor, contracted_service_id, diagnoses, clinical_context, general_objective,
            specific_objectives, activities, pathology_types, start_date, end_date, created_by)
         VALUES ($1, 1, 0, $2, '[{"uri":"u","code":"c","title":"t"}]', 'ctx BR', 'obj BR', $3, $4, $5, '2026-09-01', '2026-12-31', 'e2e')`,
        [IDS.patientBR, svc.rows[0].id, JSON.stringify(obj.rows), JSON.stringify(act.rows), JSON.stringify(pat.rows)],
      );
      const ar = await asStaffAR(`/api/admin/patients/${IDS.patientAR}/therapeutic-projects`);
      expect(ar.status).toBe(200);
      expect(((await ar.json()) as { data: { versions: unknown[] } }).data.versions).toEqual([]);
      const br = await asStaffAR(`/api/admin/patients/${IDS.patientBR}/therapeutic-projects`);
      expect(br.status).toBe(200);
      expect(((await br.json()) as { data: { versions: unknown[] } }).data.versions).toEqual([]);
      // Existe MESMO — como superuser há 1 linha.
      const real = await adminPool.query<{ n: number }>(`SELECT count(*)::int AS n FROM patient_therapeutic_projects WHERE patient_id = $1`, [IDS.patientBR]);
      expect(real.rows[0].n).toBe(1);
    });
  });
});
