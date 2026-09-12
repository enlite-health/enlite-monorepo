/**
 * lex 08/09 (item 1 da LISTA da spec 017) — a busca da lista de pacientes é um ORÁCULO sem a célula:
 * `search` casa nome/documento/responsável (container identidade/família) e os filtros clínicos casam
 * atributos de saúde (container clínico). Mesma classe do oráculo do mapa (#322): quem não pode LER o
 * dado não pode FILTRAR por ele. Prova sob o engine (HTTP real, banco real):
 *   - só `patient:read`: lista sem filtro → 200; `search=` → 403 nomeando `patient_identity:read`;
 *     `clinical_specialty=`/`dependency_level=` → 403 nomeando `patient_clinical:read`; e o banco confirma
 *     que a linha existe (o 403 não é "não achou");
 *   - com as células: os mesmos filtros → 200 e o paciente aparece.
 */
import { Pool } from 'pg';
import { AdminPatientDiagnosesController } from '@modules/diagnosis/interfaces/controllers/AdminPatientDiagnosesController';
import { AdminTerminologySearchController } from '@modules/terminology/interfaces/controllers/AdminTerminologySearchController';
import { montarAppDeFamilia, tokenMock, grupoComCelulas, limparIamFixtures, TENANT_E2E, type AppDeFamilia } from './helpers/permissionFamilyHarness';

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

describe('lista de pacientes — busca e filtros clínicos sob o engine (oráculo por célula)', () => {
  let pool: Pool;
  let app: AppDeFamilia;
  const PATIENT = 'ee0917aa-0a00-0001-0001-000000000001';
  const NOME = 'Oraculo';
  const U = { operacional: 'plso-operacional', completa: 'plso-completa', semFamilia: 'plso-sem-familia' };
  const GRUPOS = { operacional: 'PLSO Operacional', completa: 'PLSO Completa', semFamilia: 'PLSO Sem família' };
  const CELULAS: ReadonlyArray<readonly [string, string]> = [['patient', 'read'], ['patient_identity', 'read'], ['patient_clinical', 'read'], ['patient_family', 'read']];
  const RESPONSAVEL = 'Responsaveloraculo';
  const envAnterior: Record<string, string | undefined> = {};
  const setEnv = (k: string, v: string): void => { envAnterior[k] = process.env[k]; process.env[k] = v; };

  async function chamar(caminho: string, uid: string): Promise<{ status: number; body: any }> {
    const res = await fetch(`${app.url}${caminho}`, { headers: { Authorization: tokenMock(uid) } });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  }

  async function limpar(): Promise<void> {
    await pool.query(`DELETE FROM resource_access_log WHERE operator_uid = ANY($1)`, [Object.values(U)]);
    await limparIamFixtures(pool, { uids: Object.values(U), grupos: Object.values(GRUPOS) });
    for (const [resource, action] of CELULAS) {
      await pool.query(`DELETE FROM iam.group_permissions WHERE permission_id IN (SELECT id FROM iam.permissions WHERE resource = $1 AND action = $2)`, [resource, action]);
      await pool.query(`DELETE FROM iam.permissions WHERE resource = $1 AND action = $2`, [resource, action]);
    }
    await pool.query(`DELETE FROM patients WHERE id = $1`, [PATIENT]);
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    await limpar();
    await pool.query(
      `INSERT INTO users (firebase_uid, email, display_name, role, status, is_active, tenant_id) VALUES
         ($1, 'plso-operacional@e2e.local', 'Operacional', 'admin', 'ACTIVE', true, $4),
         ($2, 'plso-completa@e2e.local', 'Completa', 'admin', 'ACTIVE', true, $4),
         ($3, 'plso-sem-familia@e2e.local', 'Sem família', 'admin', 'ACTIVE', true, $4)`,
      [U.operacional, U.completa, U.semFamilia, TENANT_E2E],
    );
    for (const [resource, action] of CELULAS) {
      await pool.query(`INSERT INTO iam.permissions (resource, action, description, category) VALUES ($1, $2, 'e2e oraculo', 'Pacientes') ON CONFLICT DO NOTHING`, [resource, action]);
    }
    await grupoComCelulas(pool, { nome: GRUPOS.operacional, uid: U.operacional, celulas: [['patient', 'read']] });
    await grupoComCelulas(pool, { nome: GRUPOS.completa, uid: U.completa, celulas: [['patient', 'read'], ['patient_identity', 'read'], ['patient_clinical', 'read'], ['patient_family', 'read']] });
    await grupoComCelulas(pool, { nome: GRUPOS.semFamilia, uid: U.semFamilia, celulas: [['patient', 'read'], ['patient_identity', 'read']] });
    await pool.query(
      `INSERT INTO patients (id, clickup_task_id, first_name, last_name, country, is_test, clinical_specialty, dependency_level)
       VALUES ($1, 'e2e-oraculo', $2, 'Sintético', 'AR', true, 'NEUROLOGICAL', 'MILD')`,
      [PATIENT, NOME],
    );
    await pool.query(
      `INSERT INTO patient_responsibles (patient_id, first_name, last_name, is_primary, display_order, source) VALUES ($1, $2, 'Sintético', true, 1, 'admin_manual')`,
      [PATIENT, RESPONSAVEL],
    );

    setEnv('USE_MOCK_AUTH', 'true');
    setEnv('PERMISSION_ENGINE_ENABLED', 'true');
    setEnv('PERMISSION_ENFORCED_ROUTES', 'admin.patients');
    setEnv('PERMISSION_CACHE_TTL_MS', '0');
    setEnv('DATABASE_URL', DATABASE_URL);

    const caseModule = await import('@modules/case');
    app = await montarAppDeFamilia({
      enforcedRoutes: 'admin.patients',
      montarRotas: ({ app: express, auth, permissions }) =>
        express.use(
          '/api/admin',
          caseModule.createAdminPatientsRoutes(
            new caseModule.AdminPatientsController(),
            auth,
            permissions,
            new caseModule.AdminPatientChatIdsController(),
            new caseModule.AdminPatientChatRolesController(),
            new caseModule.AdminPatientsMapController(),
            new caseModule.AdminPatientAddressesController(),
            new caseModule.AdminInsuranceProvidersController(),
            new caseModule.AdminPatientContractedServicesController(),
            new AdminPatientDiagnosesController(),
            new AdminTerminologySearchController(),
          ),
        ),
    });
  }, 30000);

  afterAll(async () => {
    await app?.fechar();
    const { DatabaseConnection } = await import('@shared/database/DatabaseConnection');
    await DatabaseConnection.getInstance().close();
    await limpar();
    await pool.end();
    for (const [k, v] of Object.entries(envAnterior)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  });

  it('só operacional: a lista sem filtro abre (200) e o paciente está lá — sem nome', async () => {
    const r = await chamar('/api/admin/patients?limit=200', U.operacional);
    expect(r.status).toBe(200);
    const linha = (r.body.data as Array<{ id: string }>).find((p) => p.id === PATIENT);
    expect(linha).toBeDefined();
    expect(JSON.stringify(linha)).not.toContain(NOME);
  });

  it('🔒 só operacional: `search` pelo nome → 403 nomeando `patient_identity:read` (o paciente EXISTE — o 403 não é "não achou")', async () => {
    const r = await chamar(`/api/admin/patients?search=${NOME}`, U.operacional);
    expect(r.status).toBe(403);
    expect(r.body.details).toEqual({ field: 'search', cell: 'patient_identity:read' });
    expect((await pool.query(`SELECT count(*)::int AS n FROM patients WHERE id = $1 AND first_name = $2`, [PATIENT, NOME])).rows[0].n).toBe(1);
  });

  it('🔒 só operacional: filtro clínico → 403 nomeando `patient_clinical:read`', async () => {
    const esp = await chamar('/api/admin/patients?clinical_specialty=NEUROLOGICAL', U.operacional);
    expect(esp.status).toBe(403);
    expect(esp.body.details).toEqual({ field: 'clinical_specialty', cell: 'patient_clinical:read' });
    const dep = await chamar('/api/admin/patients?dependency_level=MILD', U.operacional);
    expect(dep.status).toBe(403);
    expect(dep.body.details).toEqual({ field: 'dependency_level', cell: 'patient_clinical:read' });
  });

  it('com identidade e clínica: os mesmos filtros → 200 e o paciente aparece pelo nome', async () => {
    const r = await chamar(`/api/admin/patients?search=${NOME}&clinical_specialty=NEUROLOGICAL&dependency_level=MILD`, U.completa);
    expect(r.status).toBe(200);
    expect((r.body.data as Array<{ id: string }>).some((p) => p.id === PATIENT)).toBe(true);
  });

  it('🔒 busca pelo nome do RESPONSÁVEL: com identidade mas SEM família não acha (o ramo desliga); com família acha', async () => {
    const sem = await chamar(`/api/admin/patients?search=${RESPONSAVEL}`, U.semFamilia);
    expect(sem.status).toBe(200);
    expect((sem.body.data as Array<{ id: string }>).some((p) => p.id === PATIENT)).toBe(false);
    const com = await chamar(`/api/admin/patients?search=${RESPONSAVEL}`, U.completa);
    expect(com.status).toBe(200);
    expect((com.body.data as Array<{ id: string }>).some((p) => p.id === PATIENT)).toBe(true);
  });

  // Achado do gate `revisao-pr` (spec 018, PR-1, FR-004): a migration 420 trocou DELETE por
  // `active=false` em `patient_responsibles` — sem filtrar `active` aqui, um familiar REMOVIDO
  // pelo painel continuava achando o paciente pela busca, indefinidamente.
  it('🔒 busca pelo nome de um responsável DESATIVADO (removido pelo painel, nunca DELETE) NÃO acha o paciente', async () => {
    const REMOVIDO = 'RespRemovidoOraculo';
    await pool.query(
      `INSERT INTO patient_responsibles (patient_id, first_name, last_name, is_primary, display_order, source, active, deactivated_at, deactivated_by)
       VALUES ($1, $2, 'Sintético', false, 2, 'admin_manual', false, NOW(), 'e2e')`,
      [PATIENT, REMOVIDO],
    );
    const r = await chamar(`/api/admin/patients?search=${REMOVIDO}`, U.completa);
    expect(r.status).toBe(200);
    expect((r.body.data as Array<{ id: string }>).some((p) => p.id === PATIENT)).toBe(false);
    // controle: o titular ATIVO continua achável — a régua é `active`, não "responsável nenhum".
    const controle = await chamar(`/api/admin/patients?search=${RESPONSAVEL}`, U.completa);
    expect((controle.body.data as Array<{ id: string }>).some((p) => p.id === PATIENT)).toBe(true);
  });
});
