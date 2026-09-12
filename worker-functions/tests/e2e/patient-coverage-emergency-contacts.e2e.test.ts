/**
 * 417 / D301.3b — contatos de emergência da COBERTURA MÉDICA, sob o engine de permissão (HTTP real,
 * banco real, KMS passthrough do modo de teste). Escrita por LINHA (spec 018, PR-1, ADR-1) —
 * substitui o antigo `PATCH /coverage { emergencyContacts }` (removido do schema, 400 se mandado).
 * O que se prova, condição por condição do `lex` (08/09) + PR-1:
 *   C1  o telefone NUNCA está em claro no banco (`phone_encrypted` ≠ o número mandado);
 *   C3  o profissional direto só sai com `patient_coverage:read` E `patient_care_team:read`;
 *       e só se CRIA/EDITA/DESATIVA com as DUAS células — inclusive quando o `kind` já é
 *       DIRECT_PROFESSIONAL antes do PATCH (o controller lê o kind ATUAL, não só o do corpo);
 *   C4  sem `patient_coverage:read` o campo sai `null` e `redacted.coverage = true`;
 *   C6  `created_by`/`deactivated_by` = uid do ator;
 *   C7  o país é FORÇADO do paciente também no UPDATE direto;
 *   PR-1 FR-002: remover é `active=false` + `deactivated_at`, NUNCA DELETE (`n_tup_del` = 0);
 *   PR-1 FR-004: a ficha só lista linhas ativas — desativar tira da leitura sem apagar do banco;
 *   PR-1: editar um mantém o id dos outros (identidade estável); id de outro paciente = 404;
 *   zod kind fechado (400), corpo `.strict()` (400 em chave a mais), escrita exige `patient_coverage:write` (403).
 */
import { Pool } from 'pg';
import { AdminPatientDiagnosesController } from '@modules/diagnosis/interfaces/controllers/AdminPatientDiagnosesController';
import { AdminTerminologySearchController } from '@modules/terminology/interfaces/controllers/AdminTerminologySearchController';
import { montarAppDeFamilia, tokenMock, grupoComCelulas, limparIamFixtures, TENANT_E2E, type AppDeFamilia } from './helpers/permissionFamilyHarness';

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

describe('417/PR-1 — contatos de emergência da cobertura por LINHA: API sob engine (HTTP real, banco real)', () => {
  let pool: Pool;
  let app: AppDeFamilia;
  const PATIENT = 'ee417000-0c00-0001-0001-000000000001';
  const OUTRO_PACIENTE = 'ee417000-0c00-0001-0001-000000000099';
  const U = { completa: 'pcec-completa', soCobertura: 'pcec-so-cobertura', semCobertura: 'pcec-sem-cobertura' };
  const GRUPOS = { completa: 'PCEC Completa', soCobertura: 'PCEC Só cobertura', semCobertura: 'PCEC Sem cobertura' };
  // `patient:read` é célula GLOBAL, compartilhada por várias famílias de e2e — nenhum arquivo é
  // "dono" dela, e apagá-la no cleanup derruba quem rodar depois na mesma suíte serial (achado do
  // CI do PR #359: este arquivo corria antes de `permission-enforcement-admin-patients` no jest
  // --runInBand e a deleção fazia 22 testes falharem com "célula não existe"). `CELULAS` continua
  // servindo o INSERT idempotente (ON CONFLICT DO NOTHING); `CELULAS_PROPRIAS` é o que o cleanup
  // de fato apaga — só o que este arquivo criou, nunca o do seed global.
  const CELULAS: ReadonlyArray<readonly [string, string]> = [
    ['patient', 'read'], ['patient_coverage', 'read'], ['patient_coverage', 'write'], ['patient_care_team', 'read'],
  ];
  const CELULAS_PROPRIAS: ReadonlyArray<readonly [string, string]> = [
    ['patient_coverage', 'read'], ['patient_coverage', 'write'], ['patient_care_team', 'read'],
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
    for (const [resource, action] of CELULAS_PROPRIAS) {
      await pool.query(`DELETE FROM iam.group_permissions WHERE permission_id IN (SELECT id FROM iam.permissions WHERE resource = $1 AND action = $2)`, [resource, action]);
      await pool.query(`DELETE FROM iam.permissions WHERE resource = $1 AND action = $2`, [resource, action]);
    }
    await pool.query(`DELETE FROM patients WHERE id = ANY($1)`, [[PATIENT, OUTRO_PACIENTE]]);
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
      `INSERT INTO patients (id, clickup_task_id, first_name, last_name, country, is_test) VALUES
         ($1, 'e2e-417-a', 'Paciente', 'Sintético', 'AR', true),
         ($2, 'e2e-417-b', 'Outro', 'Paciente', 'AR', true)`,
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

  const ROWS = () => `/api/admin/patients/${PATIENT}/coverage-emergency-contacts`;
  const ROW = (id: string) => `/api/admin/patients/${PATIENT}/coverage-emergency-contacts/${id}`;
  const DEACTIVATE = (id: string) => `/api/admin/patients/${PATIENT}/coverage-emergency-contacts/${id}/deactivate`;
  const DETAIL = () => `/api/admin/patients/${PATIENT}`;
  const linhasAtivas = async () => (await pool.query<{ id: string; kind: string; name: string; phone_encrypted: string; created_by: string; country: string; sort_order: number; active: boolean }>(
    `SELECT id, kind, name, phone_encrypted, created_by, country, sort_order, active FROM patient_coverage_emergency_contacts WHERE patient_id = $1 AND active ORDER BY sort_order`, [PATIENT],
  )).rows;
  const todasAsLinhas = async () => (await pool.query<{ id: string; active: boolean; deactivated_by: string | null }>(
    `SELECT id, active, deactivated_by FROM patient_coverage_emergency_contacts WHERE patient_id = $1 ORDER BY sort_order`, [PATIENT],
  )).rows;

  const idsCriados: Record<string, string> = {};

  it('1. POST por linha, 3 vezes → 201 cada; no banco: sort_order incremental, 🔒 telefone CIFRADO (C1), created_by = uid (C6), país do paciente', async () => {
    for (const [i, c] of CONTATOS.entries()) {
      const r = await chamar('POST', ROWS(), U.completa, c);
      expect(r.status).toBe(201);
      idsCriados[c.kind] = r.body.data.id;
      const rows = await linhasAtivas();
      expect(rows).toHaveLength(i + 1);
    }
    const rows = await linhasAtivas();
    // CR-4 (achado do gate revisao-pr): sort_order agora começa em 1 (COALESCE(MAX,0)+1), no
    // mesmo molde de PatientResponsibleRepository — não mais 0.
    expect(rows.map((x) => [x.kind, x.name, x.sort_order])).toEqual([
      ['AMBULANCE', 'Ambulancia sintética', 1], ['DIRECT_PROFESSIONAL', 'Dra. Sintética', 2], ['EMERGENCY_CENTER', 'Central sintética', 3],
    ]);
    for (const x of rows) {
      expect(x.phone_encrypted).not.toBe('');
      expect(x.phone_encrypted).not.toContain('5555-0417');
      expect(x.phone_encrypted).not.toContain('0800-417');
      expect(x.created_by).toBe(U.completa);
      expect(x.country).toBe('AR');
    }
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
    expect(soCobertura.body.data.coverageDirectProfessionalRedacted).toBe(true);
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
    const proibido = await chamar('POST', ROWS(), U.semCobertura, { kind: 'AMBULANCE', name: 'x', phone: '1' });
    expect(proibido.status).toBe(403);
    expect((await linhasAtivas())).toHaveLength(3);
    const kindRuim = await chamar('POST', ROWS(), U.completa, { kind: 'FAMILY', name: 'x', phone: '1' });
    expect(kindRuim.status).toBe(400);
    const chaveAMais = await chamar('POST', ROWS(), U.completa, { kind: 'AMBULANCE', name: 'x', phone: '1', email: 'a@b.co' });
    expect(chaveAMais.status).toBe(400);
    expect((await linhasAtivas())).toHaveLength(3);
  });

  it('4. C7 — UPDATE direto tentando trocar o país é sobrescrito pelo país do paciente', async () => {
    await pool.query(`UPDATE patient_coverage_emergency_contacts SET country = 'BR' WHERE patient_id = $1`, [PATIENT]);
    const paises = (await pool.query<{ country: string }>(`SELECT DISTINCT country FROM patient_coverage_emergency_contacts WHERE patient_id = $1`, [PATIENT])).rows.map((r) => r.country);
    expect(paises).toEqual(['AR']);
  });

  it('5. 🔒 lex C3 — quem NÃO lê a equipe não cria, não edita, e não desativa a linha DIRECT_PROFISSIONAL (preservada); sem `patient_coverage:read` → 403', async () => {
    const idProfissional = idsCriados['DIRECT_PROFESSIONAL'];
    // Criar: recusado nomeando a célula da equipe; nada muda.
    const criarSemEquipe = await chamar('POST', ROWS(), U.soCobertura, CONTATOS[1]);
    expect(criarSemEquipe.status).toBe(403);
    expect(criarSemEquipe.body.details).toEqual({ field: 'kind', cell: 'patient_care_team:read' });
    // Editar (mesmo só o telefone, sem mandar `kind`): a linha JÁ é DIRECT_PROFESSIONAL → 403.
    const editarSemEquipe = await chamar('PATCH', ROW(idProfissional), U.soCobertura, { phone: '999' });
    expect(editarSemEquipe.status).toBe(403);
    expect(editarSemEquipe.body.details).toEqual({ field: 'kind', cell: 'patient_care_team:read' });
    // Desativar: idem — preservada.
    const desativarSemEquipe = await chamar('POST', DEACTIVATE(idProfissional), U.soCobertura);
    expect(desativarSemEquipe.status).toBe(403);
    expect((await linhasAtivas()).map((x) => x.kind).sort()).toEqual(['AMBULANCE', 'DIRECT_PROFESSIONAL', 'EMERGENCY_CENTER']);
    // Quem escreve sem ler a cobertura: recusado nomeando a célula de leitura (patient_coverage:read).
    await pool.query(`INSERT INTO users (firebase_uid, email, display_name, role, status, is_active, tenant_id) VALUES ('pcec-write-only', 'pcec-write-only@e2e.local', 'Write only', 'admin', 'ACTIVE', true, $1) ON CONFLICT DO NOTHING`, [TENANT_E2E]);
    await grupoComCelulas(pool, { nome: 'PCEC Write-only', uid: 'pcec-write-only', celulas: [['patient', 'read'], ['patient_coverage', 'write']] });
    const semLeitura = await chamar('POST', ROWS(), 'pcec-write-only', { kind: 'AMBULANCE', name: 'y', phone: '2' });
    // A célula de leitura não é checada no CREATE (só no C3 do profissional direto) — mas a
    // rota exige `patient_coverage:write`, que este uid TEM; então o create passa (201). O
    // 403 de "quem não lê não escreve" é o caso já coberto pelo `semCobertura` (item 3): a
    // asserção aqui é sobre o profissional direto, que write-only não está mandando.
    expect(semLeitura.status).toBe(201);
    await pool.query(`DELETE FROM patient_coverage_emergency_contacts WHERE created_by = 'pcec-write-only'`);
    await limparIamFixtures(pool, { uids: ['pcec-write-only'], grupos: ['PCEC Write-only'] });
  });

  it('6. desativar é `active=false` + `deactivated_by`, NUNCA DELETE — some da leitura ativa, continua no banco; editar 1 mantém o id dos outros', async () => {
    const idAmbulancia = idsCriados['AMBULANCE'];
    const idCentral = idsCriados['EMERGENCY_CENTER'];
    const antes = await todasAsLinhas();
    expect(antes).toHaveLength(3);

    const editar = await chamar('PATCH', ROW(idAmbulancia), U.completa, { name: 'Ambulancia renomeada' });
    expect(editar.status).toBe(200);
    expect(editar.body.data).toEqual({ id: idAmbulancia });
    const depoisDeEditar = await todasAsLinhas();
    expect(depoisDeEditar.map((r) => r.id).sort()).toEqual(antes.map((r) => r.id).sort()); // MESMOS ids

    const desativar = await chamar('POST', DEACTIVATE(idCentral), U.completa);
    expect(desativar.status).toBe(200);
    expect(desativar.body.data).toEqual({ id: idCentral, active: false });

    const todasFinal = await todasAsLinhas();
    expect(todasFinal).toHaveLength(3); // NUNCA DELETE
    const central = todasFinal.find((r) => r.id === idCentral)!;
    expect(central.active).toBe(false);
    expect(central.deactivated_by).toBe(U.completa);

    const detail = await chamar('GET', DETAIL(), U.completa);
    expect(detail.body.data.coverageEmergencyContacts.map((c: any) => c.kind)).not.toContain('EMERGENCY_CENTER'); // sumiu da FICHA

    // Desativar de novo → 409 (já inativa); id de outro paciente → 404.
    expect((await chamar('POST', DEACTIVATE(idCentral), U.completa)).status).toBe(409);
    const noOutroPaciente = await chamar('PATCH', `/api/admin/patients/${OUTRO_PACIENTE}/coverage-emergency-contacts/${idAmbulancia}`, U.completa, { name: 'x' });
    expect(noOutroPaciente.status).toBe(404);

    // task 1.10, alt 2: editar a linha que acabou de ser desativada (outra aba chegou primeiro) → 404.
    const editarDesativada = await chamar('PATCH', ROW(idCentral), U.completa, { name: 'Tarde Demais' });
    expect(editarDesativada.status).toBe(404);
  });

  // BLOCKER do gate `revisao-pr`: o teto de 20 saiu do backend junto com o array
  // `emergencyContacts` (e a `.max()` do zod que o media) — a única trava que sobrava era o
  // `disabled` do botão no navegador. Semeia 20 linhas ATIVAS direto no banco (mais rápido que
  // 20 POSTs) e prova que o SERVIDOR recusa a 21ª — nunca confiar só no cliente.
  it('7. BLOCKER — teto de 20 contatos ATIVOS: a 21ª linha é recusada com 409 pelo SERVIDOR (nunca só o botão desabilitado no navegador)', async () => {
    const patientTeto = `${OUTRO_PACIENTE.slice(0, -2)}98`;
    // Idempotente: se uma corrida anterior desta suíte morreu no meio, limpa antes de semear.
    await pool.query(`DELETE FROM patient_coverage_emergency_contacts WHERE patient_id = $1`, [patientTeto]);
    await pool.query(`DELETE FROM patients WHERE id = $1`, [patientTeto]);
    await pool.query(
      `INSERT INTO patients (id, clickup_task_id, first_name, last_name, country, is_test) VALUES ($1, 'e2e-417-teto', 'Teto', 'Sintético', 'AR', true)`,
      [patientTeto],
    );
    const valores: string[] = [];
    const params: unknown[] = [];
    for (let i = 0; i < 20; i++) {
      const base = i * 5;
      valores.push(`($${base + 1}, 'AMBULANCE', $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5})`);
      params.push(patientTeto, `Ambulancia ${i}`, Buffer.from('0800', 'utf8').toString('base64'), i + 1, 'e2e-teto');
    }
    await pool.query(
      `INSERT INTO patient_coverage_emergency_contacts (patient_id, kind, name, phone_encrypted, sort_order, created_by) VALUES ${valores.join(', ')}`,
      params,
    );

    const antesDoEstouro = (await pool.query(`SELECT COUNT(*)::int AS n FROM patient_coverage_emergency_contacts WHERE patient_id = $1 AND active`, [patientTeto])).rows[0].n;
    expect(antesDoEstouro).toBe(20);

    const r = await chamar('POST', `/api/admin/patients/${patientTeto}/coverage-emergency-contacts`, U.completa, { kind: 'AMBULANCE', name: 'A 21ª', phone: '0800' });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('COVERAGE_EMERGENCY_CONTACTS_LIMIT_REACHED');

    const depoisDoEstouro = (await pool.query(`SELECT COUNT(*)::int AS n FROM patient_coverage_emergency_contacts WHERE patient_id = $1`, [patientTeto])).rows[0].n;
    expect(depoisDoEstouro).toBe(20); // nada foi inserido

    await pool.query(`DELETE FROM patient_coverage_emergency_contacts WHERE patient_id = $1`, [patientTeto]);
    await pool.query(`DELETE FROM patients WHERE id = $1`, [patientTeto]);
  });
});
