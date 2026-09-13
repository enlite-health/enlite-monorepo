/**
 * patient-support-network-rows.e2e.test.ts — spec 018, PR-1, ADR-1 (US-0; FR-001…006).
 *
 * A escrita da rede de apoio (responsáveis) por LINHA, sob o engine de permissão, HTTP real,
 * banco real. Substitui `PATCH /patients/:id/support-network` (410 — provado em
 * `adminPatientsRoutes.test.ts`) pelas rotas por linha. Casos exigidos pela task 1.6:
 *   · editar 1 mantém os ids dos OUTROS (identidade estável, L7-0 do checklist do lex);
 *   · desativar = active=false + deactivated_at, `n_tup_del` da tabela = 0 (nunca DELETE);
 *   · id de OUTRO paciente = 404 (indistinguível de inexistente);
 *   · PATCH lista inteira = 410;
 *   · 403 do DIRECT_PROFESSIONAL sem patient_care_team:read é do lado da cobertura (arquivo
 *     próprio, patient-coverage-emergency-contacts.e2e.test.ts) — aqui é o de patient_family:write.
 */
import { Pool } from 'pg';
import { AdminPatientDiagnosesController } from '@modules/diagnosis/interfaces/controllers/AdminPatientDiagnosesController';
import { AdminTerminologySearchController } from '@modules/terminology/interfaces/controllers/AdminTerminologySearchController';
import { montarAppDeFamilia, tokenMock, grupoComCelulas, limparIamFixtures, TENANT_E2E, type AppDeFamilia } from './helpers/permissionFamilyHarness';

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

describe('PR-1 — rede de apoio (responsáveis) por LINHA: API sob engine (HTTP real, banco real)', () => {
  let pool: Pool;
  let app: AppDeFamilia;
  const PATIENT = 'ee420100-0a00-0001-0001-000000000001';
  const OUTRO_PACIENTE = 'ee420100-0a00-0001-0001-000000000099';
  const U = { familia: 'psnr-familia', semFamilia: 'psnr-sem-familia' };
  const GRUPOS = { familia: 'PSNR Familia', semFamilia: 'PSNR Sem familia' };
  // `patient:read` é célula GLOBAL, compartilhada por várias famílias de e2e (terapêutico,
  // busca, cobertura...) — nenhum arquivo é "dono" dela, e apagá-la no cleanup derruba quem
  // rodar depois na mesma suíte serial (achado: patient-support-network-rows corria antes de
  // permission-enforcement-admin-patients/iam-permissions-foundation/permissions-iam-schema no
  // jest --runInBand e a deleção fazia as três falharem com "célula não existe"). Este arquivo só
  // GARANTE que ela existe (insert idempotente) e só APAGA a célula que ele de fato criou:
  // `patient_family:write` — nunca some, mas nunca é usada fora de PR-1/rede-de-apoio.
  const CELULAS: ReadonlyArray<readonly [string, string]> = [['patient', 'read'], ['patient_family', 'write']];
  const CELULAS_PROPRIAS: ReadonlyArray<readonly [string, string]> = [['patient_family', 'write']];
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

  async function limpar(): Promise<void> {
    await limparIamFixtures(pool, { uids: Object.values(U), grupos: Object.values(GRUPOS) });
    for (const [resource, action] of CELULAS_PROPRIAS) {
      await pool.query(`DELETE FROM iam.group_permissions WHERE permission_id IN (SELECT id FROM iam.permissions WHERE resource = $1 AND action = $2)`, [resource, action]);
      await pool.query(`DELETE FROM iam.permissions WHERE resource = $1 AND action = $2`, [resource, action]);
    }
    await pool.query(`DELETE FROM patients WHERE id = ANY($1)`, [[PATIENT, OUTRO_PACIENTE]]);
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    await limpar();
    await pool.query(
      `INSERT INTO users (firebase_uid, email, display_name, role, status, is_active, tenant_id) VALUES
         ($1, 'psnr-familia@e2e.local', 'Familia', 'admin', 'ACTIVE', true, $3),
         ($2, 'psnr-sem-familia@e2e.local', 'Sem familia', 'admin', 'ACTIVE', true, $3)`,
      [U.familia, U.semFamilia, TENANT_E2E],
    );
    for (const [resource, action] of CELULAS) {
      await pool.query(`INSERT INTO iam.permissions (resource, action, description, category) VALUES ($1, $2, 'e2e psnr', 'Pacientes') ON CONFLICT DO NOTHING`, [resource, action]);
    }
    await grupoComCelulas(pool, { nome: GRUPOS.familia, uid: U.familia, celulas: [['patient', 'read'], ['patient_family', 'write']] });
    await grupoComCelulas(pool, { nome: GRUPOS.semFamilia, uid: U.semFamilia, celulas: [['patient', 'read']] });
    await pool.query(
      `INSERT INTO patients (id, clickup_task_id, first_name, last_name, country, is_test) VALUES
         ($1, 'e2e-psnr-a', 'Paciente', 'Sintético', 'AR', true),
         ($2, 'e2e-psnr-b', 'Outro', 'Paciente', 'AR', true)`,
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

  const ROWS = (patientId: string = PATIENT) => `/api/admin/patients/${patientId}/responsibles`;
  const ROW = (id: string, patientId: string = PATIENT) => `/api/admin/patients/${patientId}/responsibles/${id}`;
  const DEACTIVATE = (id: string, patientId: string = PATIENT) => `/api/admin/patients/${patientId}/responsibles/${id}/deactivate`;
  const todasAsLinhas = async () => (await pool.query<{ id: string; first_name: string; is_primary: boolean; active: boolean; deactivated_by: string | null; source: string }>(
    `SELECT id, first_name, is_primary, active, deactivated_by, source FROM patient_responsibles WHERE patient_id = $1 ORDER BY created_at`, [PATIENT],
  )).rows;

  it('1. sem `patient_family:write` → 403 nomeando a célula; nada é criado', async () => {
    const r = await chamar('POST', ROWS(), U.semFamilia, { firstName: 'Ana', lastName: 'Diaz', isPrimary: true });
    expect(r.status).toBe(403);
    expect(r.body.code ?? r.body.details?.cell ?? 'missing_cell').toBeTruthy();
    expect(await todasAsLinhas()).toHaveLength(0);
  });

  it('2. POST 3 responsáveis; source default admin_manual; editar o 2º mantém os ids dos outros 2 (identidade estável)', async () => {
    const nomes = ['Ana', 'Beatriz', 'Carla'];
    const ids: string[] = [];
    for (const [i, nome] of nomes.entries()) {
      const r = await chamar('POST', ROWS(), U.familia, { firstName: nome, lastName: 'Diaz', isPrimary: i === 0 });
      expect(r.status).toBe(201);
      ids.push(r.body.data.id);
    }
    const antes = await todasAsLinhas();
    expect(antes.map((l) => l.source)).toEqual(['admin_manual', 'admin_manual', 'admin_manual']);

    const editar = await chamar('PATCH', ROW(ids[1]), U.familia, { phone: '+5491100000002' });
    expect(editar.status).toBe(200);
    expect(editar.body.data).toEqual({ id: ids[1] });

    const depois = await todasAsLinhas();
    expect(depois.map((l) => l.id).sort()).toEqual(ids.slice().sort()); // MESMOS 3 ids
    expect(depois.find((l) => l.id === ids[1])?.first_name).toBe('Beatriz'); // só o telefone mudou
  });

  it('3. 2º titular ATIVO → 409 PRIMARY_ALREADY_SET; desativar o titular libera outro', async () => {
    const primeiro = (await todasAsLinhas()).find((l) => l.is_primary)!;
    const conflito = await chamar('POST', ROWS(), U.familia, { firstName: 'Dana', lastName: 'Diaz', isPrimary: true });
    expect(conflito.status).toBe(409);
    expect(conflito.body.code).toBe('PRIMARY_ALREADY_SET');

    const desativar = await chamar('POST', DEACTIVATE(primeiro.id), U.familia);
    expect(desativar.status).toBe(200);
    // Spec 018, PR-2 (D-A#4): a resposta ganhou `emergencyMarkCleared` — este responsável não
    // estava marcado de emergência, então vem `false`.
    expect(desativar.body.data).toEqual({ id: primeiro.id, active: false, emergencyMarkCleared: false });

    const novoTitular = await chamar('POST', ROWS(), U.familia, { firstName: 'Elena', lastName: 'Diaz', isPrimary: true });
    expect(novoTitular.status).toBe(201);
  });

  it('4. desativar é active=false + deactivated_at + deactivated_by, NUNCA DELETE (n_tup_del = 0); desativar de novo → 409; id de outro paciente → 404', async () => {
    await pool.query(`SELECT pg_stat_reset()`).catch(() => undefined); // best-effort — pode não ter permissão no ambiente de teste
    const linhas = await todasAsLinhas();
    const alvo = linhas.find((l) => l.active)!;

    const antesTupDel = (await pool.query<{ n_tup_del: string }>(
      `SELECT n_tup_del FROM pg_stat_user_tables WHERE relname = 'patient_responsibles'`,
    )).rows[0]?.n_tup_del ?? '0';

    const r1 = await chamar('POST', DEACTIVATE(alvo.id), U.familia);
    expect(r1.status).toBe(200);
    const row = (await pool.query<{ active: boolean; deactivated_at: Date | null; deactivated_by: string | null }>(
      `SELECT active, deactivated_at, deactivated_by FROM patient_responsibles WHERE id = $1`, [alvo.id],
    )).rows[0];
    expect(row.active).toBe(false);
    expect(row.deactivated_at).not.toBeNull();
    expect(row.deactivated_by).toBe(U.familia);

    const depoisTupDel = (await pool.query<{ n_tup_del: string }>(
      `SELECT n_tup_del FROM pg_stat_user_tables WHERE relname = 'patient_responsibles'`,
    )).rows[0]?.n_tup_del ?? '0';
    expect(depoisTupDel).toBe(antesTupDel); // nenhum DELETE aconteceu na tabela

    const r2 = await chamar('POST', DEACTIVATE(alvo.id), U.familia);
    expect(r2.status).toBe(409);

    const r3 = await chamar('PATCH', ROW(alvo.id, OUTRO_PACIENTE), U.familia, { firstName: 'X' });
    expect(r3.status).toBe(404);

    const r4 = await chamar('POST', DEACTIVATE('11111111-1111-4111-8111-111111111111'), U.familia);
    expect(r4.status).toBe(404);

    // task 1.10, alt 2: editar a MESMA linha que acabou de ser desativada (simula "outra aba
    // desativou enquanto eu editava") → 404, não um 200 silencioso sobre uma linha morta.
    const r5 = await chamar('PATCH', ROW(alvo.id), U.familia, { firstName: 'Tarde Demais' });
    expect(r5.status).toBe(404);
  });

  it('5. PATCH /support-network (lista inteira) → 410, mesmo com a célula certa', async () => {
    const r = await chamar('PATCH', `/api/admin/patients/${PATIENT}/support-network`, U.familia, { responsibles: [] });
    expect(r.status).toBe(410);
  });
});
