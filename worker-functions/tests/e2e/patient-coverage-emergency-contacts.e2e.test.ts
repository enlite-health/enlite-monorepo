/**
 * 417 / D301.3b — contatos de emergência da COBERTURA MÉDICA, sob o engine de permissão (HTTP real,
 * banco real, KMS passthrough do modo de teste). O que se prova, condição por condição do `lex` (08/09):
 *   C1  o telefone NUNCA está em claro no banco (`phone_encrypted` ≠ o número mandado);
 *   C3  o profissional direto só sai com `patient_coverage:read` E `patient_care_team:read`;
 *   C4  sem `patient_coverage:read` o campo sai `null` e `redacted.coverage = true`;
 *   C6  `created_by` = uid do ator do PATCH;
 *   C7  o país é FORÇADO do paciente também no UPDATE direto;
 *   gate 08/09: quem não vê o profissional direto não o apaga (preservado) nem o cadastra (403); quem não lê não escreve (403);
 *   zod kind fechado (400), lista inteira substituída (`[]` apaga), e escrita exige `patient_coverage:write` (403).
 */
import { Pool } from 'pg';
import { AdminPatientDiagnosesController } from '@modules/diagnosis/interfaces/controllers/AdminPatientDiagnosesController';
import { AdminTerminologySearchController } from '@modules/terminology/interfaces/controllers/AdminTerminologySearchController';
import { montarAppDeFamilia, tokenMock, grupoComCelulas, limparIamFixtures, TENANT_E2E, type AppDeFamilia } from './helpers/permissionFamilyHarness';

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

describe('417 — contatos de emergência da cobertura: API sob engine (HTTP real, banco real)', () => {
  let pool: Pool;
  let app: AppDeFamilia;
  const PATIENT = 'ee417000-0c00-0001-0001-000000000001';
  const U = { completa: 'pcec-completa', soCobertura: 'pcec-so-cobertura', semCobertura: 'pcec-sem-cobertura' };
  const GRUPOS = { completa: 'PCEC Completa', soCobertura: 'PCEC Só cobertura', semCobertura: 'PCEC Sem cobertura' };
  const CELULAS: ReadonlyArray<readonly [string, string]> = [
    ['patient', 'read'], ['patient_coverage', 'read'], ['patient_coverage', 'write'], ['patient_care_team', 'read'],
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

  const TELEFONE_PROFISSIONAL = '+54 11 5555-0417';
  const CONTATOS = [
    { kind: 'AMBULANCE', name: 'Ambulancia sintética', phone: '0800-417-0001' },
    { kind: 'DIRECT_PROFESSIONAL', name: 'Dra. Sintética', phone: TELEFONE_PROFISSIONAL },
    { kind: 'EMERGENCY_CENTER', name: 'Central sintética', phone: '107' },
  ];

  async function limpar(): Promise<void> {
    await pool.query(`DELETE FROM resource_access_log WHERE operator_uid = ANY($1)`, [Object.values(U)]);
    await limparIamFixtures(pool, { uids: Object.values(U), grupos: Object.values(GRUPOS) });
    for (const [resource, action] of CELULAS) {
      await pool.query(`DELETE FROM iam.group_permissions WHERE permission_id IN (SELECT id FROM iam.permissions WHERE resource = $1 AND action = $2)`, [resource, action]);
      await pool.query(`DELETE FROM iam.permissions WHERE resource = $1 AND action = $2`, [resource, action]);
    }
    await pool.query(`DELETE FROM patients WHERE id = $1`, [PATIENT]);
    await limparIamFixtures(pool, { uids: ['pcec-write-only'], grupos: ['PCEC Write-only'] });
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    await limpar();
    await pool.query(
      `INSERT INTO users (firebase_uid, email, display_name, role, status, is_active, tenant_id) VALUES
         ($1, 'pcec-completa@e2e.local', 'Completa', 'admin', 'ACTIVE', true, $4),
         ($2, 'pcec-so-cobertura@e2e.local', 'Só cobertura', 'admin', 'ACTIVE', true, $4),
         ($3, 'pcec-sem-cobertura@e2e.local', 'Sem cobertura', 'admin', 'ACTIVE', true, $4)`,
      [U.completa, U.soCobertura, U.semCobertura, TENANT_E2E],
    );
    for (const [resource, action] of CELULAS) {
      await pool.query(`INSERT INTO iam.permissions (resource, action, description, category) VALUES ($1, $2, 'e2e 417', 'Pacientes') ON CONFLICT DO NOTHING`, [resource, action]);
    }
    await grupoComCelulas(pool, { nome: GRUPOS.completa, uid: U.completa, celulas: [['patient', 'read'], ['patient_coverage', 'read'], ['patient_coverage', 'write'], ['patient_care_team', 'read']] });
    await grupoComCelulas(pool, { nome: GRUPOS.soCobertura, uid: U.soCobertura, celulas: [['patient', 'read'], ['patient_coverage', 'read'], ['patient_coverage', 'write']] });
    await grupoComCelulas(pool, { nome: GRUPOS.semCobertura, uid: U.semCobertura, celulas: [['patient', 'read'], ['patient_care_team', 'read']] });
    await pool.query(
      `INSERT INTO patients (id, clickup_task_id, first_name, last_name, country, is_test) VALUES ($1, 'e2e-417-a', 'Paciente', 'Sintético', 'AR', true)`,
      [PATIENT],
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

  const COVERAGE = () => `/api/admin/patients/${PATIENT}/coverage`;
  const DETAIL = () => `/api/admin/patients/${PATIENT}`;
  const linhas = async () => (await pool.query<{ kind: string; name: string; phone_encrypted: string; created_by: string; country: string; sort_order: number }>(
    `SELECT kind, name, phone_encrypted, created_by, country, sort_order FROM patient_coverage_emergency_contacts WHERE patient_id = $1 ORDER BY sort_order`, [PATIENT],
  )).rows;

  it('1. PATCH coverage com 3 contatos → 200; no banco: 3 linhas na ordem da tela, 🔒 telefone CIFRADO (C1), created_by = uid (C6), país do paciente', async () => {
    const r = await chamar('PATCH', COVERAGE(), U.completa, { emergencyContacts: CONTATOS });
    expect(r.status).toBe(200);
    const rows = await linhas();
    expect(rows.map((x) => [x.kind, x.name, x.sort_order])).toEqual([
      ['AMBULANCE', 'Ambulancia sintética', 0], ['DIRECT_PROFESSIONAL', 'Dra. Sintética', 1], ['EMERGENCY_CENTER', 'Central sintética', 2],
    ]);
    for (const x of rows) {
      expect(x.phone_encrypted).not.toBe('');
      expect(x.phone_encrypted).not.toContain('5555-0417');
      expect(x.phone_encrypted).not.toContain('0800-417');
      expect(x.created_by).toBe(U.completa);
      expect(x.country).toBe('AR');
    }
    // A coluna inteira, em bloco: o número não aparece em lugar nenhum do texto do banco.
    const dump = (await pool.query(`SELECT string_agg(phone_encrypted, '|') AS s FROM patient_coverage_emergency_contacts WHERE patient_id = $1`, [PATIENT])).rows[0].s as string;
    expect(dump).not.toContain(TELEFONE_PROFISSIONAL);
  });

  it('2. 🔒 leitura por célula: completa vê os 3 com telefone; SÓ cobertura NÃO vê o profissional direto (C3); SEM cobertura vê null + redacted (C4)', async () => {
    const completa = await chamar('GET', DETAIL(), U.completa);
    expect(completa.status).toBe(200);
    expect(completa.body.data.coverageEmergencyContacts.map((c: any) => [c.kind, c.name, c.phone])).toEqual([
      ['AMBULANCE', 'Ambulancia sintética', '0800-417-0001'],
      ['DIRECT_PROFESSIONAL', 'Dra. Sintética', TELEFONE_PROFISSIONAL],
      ['EMERGENCY_CENTER', 'Central sintética', '107'],
    ]);
    expect(completa.body.data.redacted ?? {}).not.toHaveProperty('coverage');

    const soCobertura = await chamar('GET', DETAIL(), U.soCobertura);
    expect(soCobertura.status).toBe(200);
    expect(soCobertura.body.data.coverageEmergencyContacts.map((c: any) => c.kind)).toEqual(['AMBULANCE', 'EMERGENCY_CENTER']);
    expect(soCobertura.body.data.coverageDirectProfessionalRedacted).toBe(true); // a lista NÃO é completa — e o corpo diz
    expect(completa.body.data.coverageDirectProfessionalRedacted).toBe(false);
    expect(JSON.stringify(soCobertura.body)).not.toContain(TELEFONE_PROFISSIONAL);
    expect(JSON.stringify(soCobertura.body)).not.toContain('Dra. Sintética');

    const semCobertura = await chamar('GET', DETAIL(), U.semCobertura);
    expect(semCobertura.status).toBe(200);
    expect(semCobertura.body.data.coverageEmergencyContacts).toBeNull();
    expect(semCobertura.body.data.coverageDirectProfessionalRedacted).toBeNull();
    expect(semCobertura.body.data.redacted).toHaveProperty('coverage', true);
    expect(JSON.stringify(semCobertura.body)).not.toContain('Ambulancia sintética');
  });

  it('3. escrita: sem `patient_coverage:write` → 403 e o banco não muda; kind fora do enum → 400; chave a mais → 400', async () => {
    const proibido = await chamar('PATCH', COVERAGE(), U.semCobertura, { emergencyContacts: [] });
    expect(proibido.status).toBe(403);
    expect((await linhas())).toHaveLength(3);
    const kindRuim = await chamar('PATCH', COVERAGE(), U.completa, { emergencyContacts: [{ kind: 'FAMILY', name: 'x', phone: '1' }] });
    expect(kindRuim.status).toBe(400);
    const chaveAMais = await chamar('PATCH', COVERAGE(), U.completa, { emergencyContacts: [{ kind: 'AMBULANCE', name: 'x', phone: '1', email: 'a@b.co' }] });
    expect(chaveAMais.status).toBe(400);
    expect((await linhas())).toHaveLength(3);
  });

  it('4. C7 — UPDATE direto tentando trocar o país é sobrescrito pelo país do paciente', async () => {
    await pool.query(`UPDATE patient_coverage_emergency_contacts SET country = 'BR' WHERE patient_id = $1`, [PATIENT]);
    const paises = (await pool.query<{ country: string }>(`SELECT DISTINCT country FROM patient_coverage_emergency_contacts WHERE patient_id = $1`, [PATIENT])).rows.map((r) => r.country);
    expect(paises).toEqual(['AR']);
  });

  it('5. 🔒 gate 08/09 — SÓ cobertura substitui a lista mas o profissional direto que ele não vê é PRESERVADO; mandar um DIRECT_PROFESSIONAL sem equipe → 403; sem `patient_coverage:read` → 403', async () => {
    // Antes: AMBULANCE, DIRECT_PROFESSIONAL, EMERGENCY_CENTER. O ator só-cobertura vê 2 e manda 1.
    expect((await chamar('PATCH', COVERAGE(), U.soCobertura, { emergencyContacts: [CONTATOS[2]] })).status).toBe(200);
    expect((await linhas()).map((x) => x.kind).sort()).toEqual(['DIRECT_PROFESSIONAL', 'EMERGENCY_CENTER']);
    // Ele tenta cadastrar um profissional direto: recusado nomeando a célula da equipe; nada muda.
    const semEquipe = await chamar('PATCH', COVERAGE(), U.soCobertura, { emergencyContacts: [CONTATOS[1]] });
    expect(semEquipe.status).toBe(403);
    expect(semEquipe.body.details).toEqual({ field: 'emergencyContacts', cell: 'patient_care_team:read' });
    expect((await linhas()).map((x) => x.kind).sort()).toEqual(['DIRECT_PROFESSIONAL', 'EMERGENCY_CENTER']);
    // Quem escreve sem ler a cobertura: recusado nomeando a célula de leitura.
    await pool.query(`INSERT INTO users (firebase_uid, email, display_name, role, status, is_active, tenant_id) VALUES ('pcec-write-only', 'pcec-write-only@e2e.local', 'Write only', 'admin', 'ACTIVE', true, $1) ON CONFLICT DO NOTHING`, [TENANT_E2E]);
    await grupoComCelulas(pool, { nome: 'PCEC Write-only', uid: 'pcec-write-only', celulas: [['patient', 'read'], ['patient_coverage', 'write']] });
    const semLeitura = await chamar('PATCH', COVERAGE(), 'pcec-write-only', { emergencyContacts: [] });
    expect(semLeitura.status).toBe(403);
    expect(semLeitura.body.details).toEqual({ field: 'emergencyContacts', cell: 'patient_coverage:read' });
    expect((await linhas())).toHaveLength(2);
    await limparIamFixtures(pool, { uids: ['pcec-write-only'], grupos: ['PCEC Write-only'] });
  });

  it('6. a lista é substituída INTEIRA por quem vê tudo: PATCH com [] deixa 0; chave ausente não toca', async () => {
    expect((await chamar('PATCH', COVERAGE(), U.completa, { affiliateId: 'AF-417' })).status).toBe(200);
    expect((await linhas())).toHaveLength(2);
    expect((await chamar('PATCH', COVERAGE(), U.completa, { emergencyContacts: [] })).status).toBe(200);
    expect(await linhas()).toHaveLength(0);
    const detail = await chamar('GET', DETAIL(), U.completa);
    expect(detail.body.data.coverageEmergencyContacts).toEqual([]);
    expect(detail.body.data.coverageEmergencyContactsUnavailable).toBe(false);
  });
});
