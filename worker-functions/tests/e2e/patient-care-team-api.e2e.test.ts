/**
 * 427/PR-5 — equipe tratante por LINHA, sob o engine de permissão (HTTP real, banco real, KMS
 * passthrough do modo de teste). Molde: `patient-coverage-emergency-contacts.e2e.test.ts` (417).
 * O que se prova, condição por condição do `lex` (12/09 CONDICIONADO):
 *   C2  sem `patient_care_team:read`: `professionals: null` (nunca `[]`) e nem telefone/e-mail em
 *       claro aparecem na resposta (proxy de "0 KMS" no nível HTTP — o spy de chamada mora no
 *       unit `PatientDetailQueryHelper.test.ts`, sabotado e restaurado nesta mesma execução);
 *   C3  escrita exige `patient_care_team:write` — recruiter (sem a célula) recebe 403
 *       `missing_cell`; admin (com a célula) recebe 201/200;
 *   C5  `specialty` fora do enum → 400 (zod) ANTES de chegar no banco;
 *   C8  desativar é `active=false`, NUNCA DELETE (`n_tup_del` seria > 0 se fosse);
 *   C9  `created_by` = uid do ator autenticado.
 */
import { Pool } from 'pg';
import { AdminPatientDiagnosesController } from '@modules/diagnosis/interfaces/controllers/AdminPatientDiagnosesController';
import { AdminTerminologySearchController } from '@modules/terminology/interfaces/controllers/AdminTerminologySearchController';
import { montarAppDeFamilia, tokenMock, grupoComCelulas, limparIamFixtures, garantirCelula, TENANT_E2E, type AppDeFamilia } from './helpers/permissionFamilyHarness';

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

describe('427/PR-5 — equipe tratante por LINHA: API sob engine (HTTP real, banco real)', () => {
  let pool: Pool;
  let app: AppDeFamilia;
  const PATIENT = 'ee427000-0c00-0001-0001-000000000001';
  const OUTRO_PACIENTE = 'ee427000-0c00-0001-0001-000000000099';
  const U = { admin: 'pct-admin', recruiter: 'pct-recruiter', soLeitura: 'pct-so-leitura' };
  const GRUPOS = { admin: 'PCT Admin', recruiter: 'PCT Recruiter', soLeitura: 'PCT Só leitura' };
  // PR-8b (A3, ADR-2/SUP-30): a rota não declara mais `patient_care_team:write` —
  // POST /professionals exige `create`, PATCH/deactivate exigem `update`
  // (`adminPatientsRoutes.ts:344,347,350`). As duas já nascem seedadas pela migration 435
  // (recurso splitado) — não são mais "próprias" deste arquivo.
  const CELULAS: ReadonlyArray<readonly [string, string]> = [
    ['patient', 'read'], ['patient_care_team', 'read'], ['patient_care_team', 'create'], ['patient_care_team', 'update'],
  ];
  const envAnterior: Record<string, string | undefined> = {};
  const setEnv = (k: string, v: string): void => { envAnterior[k] = process.env[k]; process.env[k] = v; };

  async function chamar(metodo: string, caminho: string, uid: string, body?: unknown): Promise<{ status: number; body: any }> {
    const res = await fetch(`${app.url}${caminho}`, {
      method: metodo,
      headers: { Authorization: tokenMock(uid), 'Content-Type': 'application/json' },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  }

  const TELEFONE = '+54 11 5555-0427';
  const EMAIL = 'dra.sintetica@e2e.local';

  // PR-8b (A3, achado A2): `patient_care_team:create`/`update` são células do CATÁLOGO
  // compartilhado (seedadas pela migration 435) — apagar `iam.permissions` no cleanup derrubava
  // outras suítes que dependem delas. `limparIamFixtures` já apaga só o que este arquivo é DONO
  // (grupos/usuários/`group_permissions`), nunca o catálogo.
  async function limpar(): Promise<void> {
    await pool.query(`DELETE FROM resource_access_log WHERE operator_uid = ANY($1)`, [Object.values(U)]);
    await limparIamFixtures(pool, { uids: Object.values(U), grupos: Object.values(GRUPOS) });
    await pool.query(`DELETE FROM patient_professionals WHERE patient_id = ANY($1)`, [[PATIENT, OUTRO_PACIENTE]]);
    await pool.query(`DELETE FROM patients WHERE id = ANY($1)`, [[PATIENT, OUTRO_PACIENTE]]);
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    await limpar();
    await pool.query(
      `INSERT INTO users (firebase_uid, email, display_name, role, status, is_active, tenant_id) VALUES
         ($1, 'pct-admin@e2e.local', 'Admin', 'admin', 'ACTIVE', true, $4),
         ($2, 'pct-recruiter@e2e.local', 'Recruiter', 'admin', 'ACTIVE', true, $4),
         ($3, 'pct-so-leitura@e2e.local', 'Só leitura', 'admin', 'ACTIVE', true, $4)`,
      [U.admin, U.recruiter, U.soLeitura, TENANT_E2E],
    );
    for (const [resource, action] of CELULAS) {
      await garantirCelula(pool, { resource, action, category: 'Pacientes' });
    }
    // admin: leitura + as DUAS ações de escrita (create do POST, update do PATCH/deactivate).
    await grupoComCelulas(pool, { nome: GRUPOS.admin, uid: U.admin, celulas: [['patient', 'read'], ['patient_care_team', 'read'], ['patient_care_team', 'create'], ['patient_care_team', 'update']] });
    // recruiter: só o operacional — NÃO tem patient_care_team:write (o caso nomeado pelo coordenador).
    await grupoComCelulas(pool, { nome: GRUPOS.recruiter, uid: U.recruiter, celulas: [['patient', 'read']] });
    // só leitura: lê a equipe, não escreve.
    await grupoComCelulas(pool, { nome: GRUPOS.soLeitura, uid: U.soLeitura, celulas: [['patient', 'read'], ['patient_care_team', 'read']] });
    await pool.query(
      `INSERT INTO patients (id, clickup_task_id, first_name, last_name, country, is_test) VALUES
         ($1, 'e2e-427-a', 'Paciente', 'Sintético', 'AR', true),
         ($2, 'e2e-427-b', 'Outro', 'Paciente', 'AR', true)`,
      [PATIENT, OUTRO_PACIENTE],
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

  const ROWS = () => `/api/admin/patients/${PATIENT}/professionals`;
  const ROW = (id: string) => `/api/admin/patients/${PATIENT}/professionals/${id}`;
  const DEACTIVATE = (id: string) => `/api/admin/patients/${PATIENT}/professionals/${id}/deactivate`;
  const DETAIL = () => `/api/admin/patients/${PATIENT}`;
  const linhaNoBanco = async (id: string) => (await pool.query<{ id: string; name: string; phone_encrypted: string | null; specialty: string | null; created_by: string; active: boolean; source: string }>(
    `SELECT id, name, phone_encrypted, specialty, created_by, active, source FROM patient_professionals WHERE id = $1`, [id],
  )).rows[0];

  let idCriado = '';

  it('1. C3 — recruiter (sem patient_care_team:write) recebe 403 missing_cell; nada é criado', async () => {
    const r = await chamar('POST', ROWS(), U.recruiter, { name: 'Dr. Recusado', phone: TELEFONE, specialty: 'PHYSICIAN' });
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('missing_cell');
    const rows = (await pool.query(`SELECT id FROM patient_professionals WHERE patient_id = $1`, [PATIENT])).rows;
    expect(rows).toHaveLength(0);
  });

  it('2. C3/C9 — admin (com a célula) recebe 201; created_by = uid do ator; source = admin_manual; telefone CIFRADO', async () => {
    const r = await chamar('POST', ROWS(), U.admin, { name: 'Dra. Sintética', phone: TELEFONE, email: EMAIL, specialty: 'PHYSICIAN' });
    expect(r.status).toBe(201);
    idCriado = r.body.data.id;
    const row = await linhaNoBanco(idCriado);
    expect(row.created_by).toBe(U.admin);
    expect(row.source).toBe('admin_manual');
    expect(row.specialty).toBe('PHYSICIAN');
    expect(row.phone_encrypted).not.toBe(TELEFONE);
    expect(row.phone_encrypted).not.toContain('5555-0427');
  });

  it('3. C5 — specialty fora do enum → 400 (zod), nada muda no banco', async () => {
    const r = await chamar('POST', ROWS(), U.admin, { name: 'Dr. Ruim', specialty: 'ALIENIGENA' });
    expect(r.status).toBe(400);
    const rows = (await pool.query(`SELECT id FROM patient_professionals WHERE patient_id = $1`, [PATIENT])).rows;
    expect(rows).toHaveLength(1); // só o do teste 2
  });

  it('4. C2 — sem patient_care_team:read: `professionals: null` (nunca []); telefone/e-mail/nome NUNCA aparecem na resposta', async () => {
    const semCelula = await chamar('GET', DETAIL(), U.recruiter);
    expect(semCelula.status).toBe(200);
    expect(semCelula.body.data.professionals).toBeNull();
    expect(semCelula.body.data.redacted).toHaveProperty('careTeam', true);
    const corpo = JSON.stringify(semCelula.body);
    expect(corpo).not.toContain('Sintética');
    expect(corpo).not.toContain(TELEFONE);
    expect(corpo).not.toContain(EMAIL);

    const comCelula = await chamar('GET', DETAIL(), U.soLeitura);
    expect(comCelula.status).toBe(200);
    expect(comCelula.body.data.professionals.map((p: any) => [p.name, p.phone, p.specialty])).toEqual([
      ['Dra. Sintética', TELEFONE, 'PHYSICIAN'],
    ]);
  });

  it('5. C3 escrita — só-leitura (patient_care_team:read, sem write) recebe 403 ao editar/desativar', async () => {
    const editar = await chamar('PATCH', ROW(idCriado), U.soLeitura, { name: 'Tentativa' });
    expect(editar.status).toBe(403);
    const desativar = await chamar('POST', DEACTIVATE(idCriado), U.soLeitura);
    expect(desativar.status).toBe(403);
  });

  it('6. C8 — desativar é active=false, NUNCA DELETE; some da ficha, continua no banco; id de outro paciente = 404', async () => {
    const antes = await linhaNoBanco(idCriado);
    expect(antes.active).toBe(true);

    const r = await chamar('POST', DEACTIVATE(idCriado), U.admin);
    expect(r.status).toBe(200);
    expect(r.body.data).toEqual({ id: idCriado, active: false });

    const depois = await linhaNoBanco(idCriado);
    expect(depois).toBeDefined(); // NUNCA DELETE — a linha continua existindo
    expect(depois.active).toBe(false);

    const detail = await chamar('GET', DETAIL(), U.admin);
    expect(detail.body.data.professionals).toEqual([]); // sumiu da FICHA (active-only)

    expect((await chamar('POST', DEACTIVATE(idCriado), U.admin)).status).toBe(409); // já inativo
    const outroPaciente = await chamar('PATCH', `/api/admin/patients/${OUTRO_PACIENTE}/professionals/${idCriado}`, U.admin, { name: 'x' });
    expect(outroPaciente.status).toBe(404);
  });
});
