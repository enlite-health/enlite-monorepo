/**
 * adminStaffDirectoryPatientAccess.e2e.test.ts — R3-1 (change 022-ux-mencao-e-notificacao,
 * Rodada 3, pedido do Gabriel 22/09). HTTP real, Postgres real, engine ABAC ligado.
 *
 * `?patientId=` filtra a lista do `@` para SÓ quem PODE, de fato, abrir a conversa DAQUELE
 * paciente — usando o MESMO mecanismo de decisão do servidor
 * (`iam.effective_permissions`, a fonte que `PermissionService.resolve` consulta, a mesma que
 * `PermissionClientActorAccessChecker` usa via `client.can`): célula `patient_conversation:read`.
 * O recorte por PAÍS (`iam.effective_countries`) é CONDICIONAL a `COUNTRY_RLS_ENABLED` (gate 🔴
 * do revisao-pr, 22/09) — este `describe` roda com a flag `true` (país É um eixo real de
 * decisão aqui, testável), exceto no caso 4b, que prova o valor de prd (`false`, medido 22/09):
 * sem a flag, o repositório não filtra por país — só por célula, igual a como
 * `PermissionMiddleware`/`PermissionClientActorAccessChecker` decidem o acesso REAL à conversa
 * hoje. Nunca uma regra paralela.
 *
 * Casos cobertos:
 *  1. Ator SEM `patient_conversation:read` — não aparece, mesmo tendo `staff_directory:read`.
 *  2. Ator COM a célula mas com escopo de país FORA do país do paciente (COUNTRY_RLS_ENABLED=true)
 *     — não aparece.
 *  3. Ator COM a célula e COM o país do paciente no escopo (COUNTRY_RLS_ENABLED=true) — aparece
 *     (controle positivo).
 *  4a. Ator COM a célula mas SEM NENHUM escopo de país (grupo sem `group_country_scopes`),
 *      COUNTRY_RLS_ENABLED=true — não aparece (D113: grupo sem escopo é `[]`, nunca "libera
 *      geral").
 *  4b. MESMO ator do 4a, mas COUNTRY_RLS_ENABLED=false (valor medido em prd, 22/09) — APARECE: a
 *      rota real da conversa não filtra por país hoje, então o `@` também não pode (gate 🔴).
 *  5. O requester nunca aparece na própria lista, mesmo quando ele mesmo qualificaria.
 *  6. `patientId` de paciente INEXISTENTE — lista vazia (fail-closed).
 *  7. SEM `patientId` — comportamento atual (lista geral, ninguém filtrado por conversa).
 *  8. Família `admin.patients` FORA do rollout (engine ligado, mas fora de
 *     `PERMISSION_ENFORCED_ROUTES`) — `patientId` é ignorado, lista igual à de sem filtro.
 *
 * Nenhuma PII real — uid/e-mail/nome sintéticos (`e022r3-*`, `@e2e.local`); paciente sintético
 * (`is_test = true`).
 *
 * Como rodar:
 *   DATABASE_URL=postgresql://enlite_admin:enlite_password@localhost:5442/enlite_e2e_022 \
 *     npx jest --config jest.config.e2e.js tests/e2e/staffDirectory/adminStaffDirectoryPatientAccess.e2e.test.ts
 */
import { Pool } from 'pg';
import {
  montarAppDeFamilia,
  tokenMock,
  grupoComCelulas,
  limparIamFixtures,
  garantirCelula,
  TENANT_E2E,
  type AppDeFamilia,
} from '../helpers/permissionFamilyHarness';

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5442/enlite_e2e_022';

describe('Diretório de staff × patientId (R3-1, spec 022) — HTTP real, Postgres real, engine ABAC ligado', () => {
  let pool: Pool;

  const PAIS_PACIENTE = 'AR';
  const PAIS_FORA = 'BR';
  const PATIENT_ID = 'e467a000-c4a7-0003-0003-000000000001';
  const PATIENT_INEXISTENTE = 'e467a000-c4a7-0003-0003-000000009999';

  const U = {
    requester: 'e022r3-staffdir-requester',
    comCelulaEPais: 'e022r3-staffdir-com-celula-e-pais',
    comCelulaSemPais: 'e022r3-staffdir-com-celula-sem-pais',
    comCelulaPaisErrado: 'e022r3-staffdir-com-celula-pais-errado',
    semCelula: 'e022r3-staffdir-sem-celula',
  };

  const GRUPO_REQUESTER = 'E022R3 StaffDir Requester (staff_directory + conversa AR)';
  const GRUPO_COM_PAIS = 'E022R3 StaffDir ComCelula ComPais (AR)';
  const GRUPO_SEM_PAIS = 'E022R3 StaffDir ComCelula SemPais';
  const GRUPO_PAIS_ERRADO = 'E022R3 StaffDir ComCelula PaisErrado (BR)';
  const GRUPO_SEM_CELULA = 'E022R3 StaffDir SemCelula (só staff_directory)';

  const CEL_STAFF_DIR: [string, string] = ['staff_directory', 'read'];
  const CEL_CONVERSA: [string, string] = ['patient_conversation', 'read'];
  const celulasCriadas: Array<[string, string]> = [];

  const envAnterior: Record<string, string | undefined> = {};
  const setEnv = (k: string, v: string): void => {
    envAnterior[k] = process.env[k];
    process.env[k] = v;
  };

  async function limpar(): Promise<void> {
    await limparIamFixtures(pool, {
      uids: Object.values(U),
      grupos: [GRUPO_REQUESTER, GRUPO_COM_PAIS, GRUPO_SEM_PAIS, GRUPO_PAIS_ERRADO, GRUPO_SEM_CELULA],
    });
    await pool.query(`DELETE FROM patients WHERE id = $1`, [PATIENT_ID]);
  }

  async function limparCelulasCriadas(): Promise<void> {
    for (const [resource, action] of celulasCriadas) {
      await pool.query(
        `DELETE FROM iam.group_permissions WHERE permission_id IN (SELECT id FROM iam.permissions WHERE resource = $1 AND action = $2)`,
        [resource, action],
      );
      await pool.query(`DELETE FROM iam.permissions WHERE resource = $1 AND action = $2`, [resource, action]);
    }
  }

  /** `grupoComCelulas` não cobre escopo de país — inserção direta em `iam.group_country_scopes`,
   *  mesma tabela que `iam.effective_countries` (mig 276) consulta. */
  async function concederPaisAoGrupo(nomeGrupo: string, country: string): Promise<void> {
    await pool.query(
      `INSERT INTO iam.group_country_scopes (group_id, country, granted_by, reason)
       SELECT id, $2, 'e2e-r3-setup', 'e2e — R3-1'
       FROM iam.permission_groups WHERE name = $1`,
      [nomeGrupo, country],
    );
  }

  async function chamar(caminho: string, uid: string): Promise<{ status: number; body: any }> {
    const res = await fetch(`${app.url}${caminho}`, {
      headers: { Authorization: tokenMock(uid, 'admin', PAIS_PACIENTE) },
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  }

  let app: AppDeFamilia;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    await limpar();

    await pool.query(
      `INSERT INTO users (firebase_uid, email, display_name, role, status, tenant_id) VALUES
         ($1, 'e022r3-requester@e2e.local', 'R3 Requester', 'admin', 'ACTIVE', $6),
         ($2, 'e022r3-com-pais@e2e.local', 'R3 ComCelula ComPais', 'admin', 'ACTIVE', $6),
         ($3, 'e022r3-sem-pais@e2e.local', 'R3 ComCelula SemPais', 'admin', 'ACTIVE', $6),
         ($4, 'e022r3-pais-errado@e2e.local', 'R3 ComCelula PaisErrado', 'admin', 'ACTIVE', $6),
         ($5, 'e022r3-sem-celula@e2e.local', 'R3 SemCelula', 'admin', 'ACTIVE', $6)`,
      [U.requester, U.comCelulaEPais, U.comCelulaSemPais, U.comCelulaPaisErrado, U.semCelula, TENANT_E2E],
    );

    await pool.query(
      `INSERT INTO patients (id, clickup_task_id, first_name, last_name, country, is_test) VALUES
         ($1, 'e2e-022r3-staffdir-patient', 'Paciente', 'R3', $2, true)`,
      [PATIENT_ID, PAIS_PACIENTE],
    );

    for (const [resource, action] of [CEL_STAFF_DIR, CEL_CONVERSA]) {
      const { criada } = await garantirCelula(pool, { resource, action, category: 'Usuários' });
      if (criada) celulasCriadas.push([resource, action]);
    }

    // Requester: staff_directory:read (pra poder chamar a rota) + patient_conversation:read com
    // país AR — de propósito, PARA PROVAR que mesmo qualificando ele NUNCA aparece na própria
    // lista (caso 5).
    await grupoComCelulas(pool, {
      nome: GRUPO_REQUESTER,
      uid: U.requester,
      celulas: [CEL_STAFF_DIR, CEL_CONVERSA],
    });
    await concederPaisAoGrupo(GRUPO_REQUESTER, PAIS_PACIENTE);

    // comCelulaEPais: célula + país AR — DEVE aparecer (controle positivo).
    await grupoComCelulas(pool, { nome: GRUPO_COM_PAIS, uid: U.comCelulaEPais, celulas: [CEL_CONVERSA] });
    await concederPaisAoGrupo(GRUPO_COM_PAIS, PAIS_PACIENTE);

    // comCelulaSemPais: tem a célula, MAS o grupo não tem NENHUM escopo de país — `effective_countries`
    // = [] (D113: ausência é `[]`, nunca "libera geral") — NÃO deve aparecer.
    await grupoComCelulas(pool, { nome: GRUPO_SEM_PAIS, uid: U.comCelulaSemPais, celulas: [CEL_CONVERSA] });

    // comCelulaPaisErrado: tem a célula, país BR (o paciente é AR) — NÃO deve aparecer.
    await grupoComCelulas(pool, { nome: GRUPO_PAIS_ERRADO, uid: U.comCelulaPaisErrado, celulas: [CEL_CONVERSA] });
    await concederPaisAoGrupo(GRUPO_PAIS_ERRADO, PAIS_FORA);

    // semCelula: só staff_directory:read, SEM patient_conversation:read — NÃO deve aparecer.
    await grupoComCelulas(pool, { nome: GRUPO_SEM_CELULA, uid: U.semCelula, celulas: [CEL_STAFF_DIR] });

    setEnv('USE_MOCK_AUTH', 'true');
    setEnv('PERMISSION_ENGINE_ENABLED', 'true');
    setEnv('PERMISSION_ENFORCED_ROUTES', 'admin.patients;admin.users');
    setEnv('PERMISSION_CACHE_TTL_MS', '0');
    setEnv('DATABASE_URL', DATABASE_URL);
    // Gate 🔴 do revisao-pr (22/09): o recorte de país só entra com esta flag ligada — este
    // describe testa o eixo de país, então liga por default; o caso 4b desliga TEMPORARIAMENTE
    // (só o request dele) pra provar o valor real de prd.
    setEnv('COUNTRY_RLS_ENABLED', 'true');

    const { createAdminStaffDirectoryRoutes } = await import(
      '../../../src/modules/identity/interfaces/routes/adminStaffDirectoryRoutes'
    );
    app = await montarAppDeFamilia({
      enforcedRoutes: 'admin.patients;admin.users',
      montarRotas: ({ app: express, auth, permissions }) =>
        express.use('/api/admin', createAdminStaffDirectoryRoutes(auth, permissions)),
    });
  }, 30000);

  afterAll(async () => {
    // NÃO fecha `DatabaseConnection` aqui — é um singleton COMPARTILHADO com o 2º `describe`
    // deste arquivo (família admin.patients fora do rollout); fechar cedo demais derruba o pool
    // do outro bloco ("Cannot use a pool after calling end on the pool"). Quem fecha é o ÚLTIMO
    // describe do arquivo.
    await app?.fechar();
    await limpar();
    await limparCelulasCriadas();
    await pool.end();
    for (const [k, v] of Object.entries(envAnterior)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('1. ator SEM patient_conversation:read — não aparece, mesmo com staff_directory:read', async () => {
    const res = await chamar(`/api/admin/staff-directory?patientId=${PATIENT_ID}`, U.requester);
    expect(res.status).toBe(200);
    const uids = res.body.data.map((e: { uid: string }) => e.uid);
    expect(uids).not.toContain(U.semCelula);
  });

  it('2. ator COM a célula mas com escopo de país FORA do país do paciente — não aparece', async () => {
    const res = await chamar(`/api/admin/staff-directory?patientId=${PATIENT_ID}`, U.requester);
    expect(res.status).toBe(200);
    const uids = res.body.data.map((e: { uid: string }) => e.uid);
    expect(uids).not.toContain(U.comCelulaPaisErrado);
  });

  it('3. ator COM a célula e COM o país do paciente no escopo — APARECE (controle positivo)', async () => {
    const res = await chamar(`/api/admin/staff-directory?patientId=${PATIENT_ID}`, U.requester);
    expect(res.status).toBe(200);
    const uids = res.body.data.map((e: { uid: string }) => e.uid);
    expect(uids).toContain(U.comCelulaEPais);
  });

  it('4a. ator COM a célula mas SEM nenhum escopo de país, COUNTRY_RLS_ENABLED=true — não aparece (D113: [] nunca libera geral)', async () => {
    const res = await chamar(`/api/admin/staff-directory?patientId=${PATIENT_ID}`, U.requester);
    expect(res.status).toBe(200);
    const uids = res.body.data.map((e: { uid: string }) => e.uid);
    expect(uids).not.toContain(U.comCelulaSemPais);
  });

  // Gate 🔴 do revisao-pr (22/09): sem COUNTRY_RLS_ENABLED (valor medido em prd), a rota REAL da
  // conversa (PermissionMiddleware/PermissionClientActorAccessChecker) não filtra por país — só
  // por célula. O `@` tem de refletir o MESMO acesso: quem tem a célula mas nenhum escopo de
  // país cadastrado já PODE abrir a conversa de verdade hoje, então precisa aparecer aqui
  // também. Desliga a flag só para este request (não para o describe inteiro — os outros casos
  // deste bloco testam o eixo de país com a flag ligada).
  it('4b. MESMO ator do 4a, mas COUNTRY_RLS_ENABLED=false (valor de prd, medido 22/09) — APARECE', async () => {
    const anterior = process.env.COUNTRY_RLS_ENABLED;
    process.env.COUNTRY_RLS_ENABLED = 'false';
    try {
      const res = await chamar(`/api/admin/staff-directory?patientId=${PATIENT_ID}`, U.requester);
      expect(res.status).toBe(200);
      const uids = res.body.data.map((e: { uid: string }) => e.uid);
      expect(uids).toContain(U.comCelulaSemPais);
    } finally {
      if (anterior === undefined) delete process.env.COUNTRY_RLS_ENABLED;
      else process.env.COUNTRY_RLS_ENABLED = anterior;
    }
  });

  it('5. o requester NUNCA aparece na própria lista, mesmo qualificando (célula + país corretos)', async () => {
    const res = await chamar(`/api/admin/staff-directory?patientId=${PATIENT_ID}`, U.requester);
    expect(res.status).toBe(200);
    const uids = res.body.data.map((e: { uid: string }) => e.uid);
    expect(uids).not.toContain(U.requester);
  });

  it('6. patientId de paciente INEXISTENTE — lista vazia (fail-closed)', async () => {
    const res = await chamar(`/api/admin/staff-directory?patientId=${PATIENT_INEXISTENTE}`, U.requester);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });

  it('7. SEM patientId — comportamento atual (lista geral, ninguém filtrado por conversa)', async () => {
    const res = await chamar('/api/admin/staff-directory', U.requester);
    expect(res.status).toBe(200);
    const uids = res.body.data.map((e: { uid: string }) => e.uid);
    // Sem patientId, TODOS os staff ativos (menos o requester) aparecem — inclusive quem não tem
    // patient_conversation:read nenhuma (semCelula), prova que o filtro por conversa é só ligado
    // quando patientId vem.
    expect(uids).toContain(U.semCelula);
    expect(uids).toContain(U.comCelulaSemPais);
    expect(uids).toContain(U.comCelulaPaisErrado);
    expect(uids).toContain(U.comCelulaEPais);
  });

  it('8. patientId inválido (não-UUID) — 400, nunca 500', async () => {
    const res = await chamar('/api/admin/staff-directory?patientId=nao-e-uuid', U.requester);
    expect(res.status).toBe(400);
  });
});

describe('Diretório de staff × patientId — família admin.patients FORA do rollout (engine ligado, spec 022 R3-1)', () => {
  let pool: Pool;
  let app: AppDeFamilia;

  const PAIS_PACIENTE = 'AR';
  const PATIENT_ID = 'e467a000-c4a7-0003-0003-000000000002';

  const U = { requester: 'e022r3-off-requester', comCelula: 'e022r3-off-com-celula' };
  const GRUPO_REQUESTER = 'E022R3-OFF Requester (staff_directory)';
  const GRUPO_COM_CELULA = 'E022R3-OFF ComCelula (patient_conversation, país AR)';
  const CEL_STAFF_DIR: [string, string] = ['staff_directory', 'read'];
  const CEL_CONVERSA: [string, string] = ['patient_conversation', 'read'];
  const celulasCriadas: Array<[string, string]> = [];

  const envAnterior: Record<string, string | undefined> = {};
  const setEnv = (k: string, v: string): void => {
    envAnterior[k] = process.env[k];
    process.env[k] = v;
  };

  async function limpar(): Promise<void> {
    await limparIamFixtures(pool, { uids: Object.values(U), grupos: [GRUPO_REQUESTER, GRUPO_COM_CELULA] });
    await pool.query(`DELETE FROM patients WHERE id = $1`, [PATIENT_ID]);
  }

  async function limparCelulasCriadas(): Promise<void> {
    for (const [resource, action] of celulasCriadas) {
      await pool.query(
        `DELETE FROM iam.group_permissions WHERE permission_id IN (SELECT id FROM iam.permissions WHERE resource = $1 AND action = $2)`,
        [resource, action],
      );
      await pool.query(`DELETE FROM iam.permissions WHERE resource = $1 AND action = $2`, [resource, action]);
    }
  }

  async function chamar(caminho: string, uid: string): Promise<{ status: number; body: any }> {
    const res = await fetch(`${app.url}${caminho}`, {
      headers: { Authorization: tokenMock(uid, 'admin', PAIS_PACIENTE) },
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    await limpar();

    await pool.query(
      `INSERT INTO users (firebase_uid, email, display_name, role, status, tenant_id) VALUES
         ($1, 'e022r3-off-requester@e2e.local', 'R3-OFF Requester', 'admin', 'ACTIVE', $3),
         ($2, 'e022r3-off-com-celula@e2e.local', 'R3-OFF SemPatientCell', 'admin', 'ACTIVE', $3)`,
      [U.requester, U.comCelula, TENANT_E2E],
    );

    await pool.query(
      `INSERT INTO patients (id, clickup_task_id, first_name, last_name, country, is_test) VALUES
         ($1, 'e2e-022r3-off-patient', 'Paciente', 'R3Off', $2, true)`,
      [PATIENT_ID, PAIS_PACIENTE],
    );

    for (const [resource, action] of [CEL_STAFF_DIR, CEL_CONVERSA]) {
      const { criada } = await garantirCelula(pool, { resource, action, category: 'Usuários' });
      if (criada) celulasCriadas.push([resource, action]);
    }

    await grupoComCelulas(pool, { nome: GRUPO_REQUESTER, uid: U.requester, celulas: [CEL_STAFF_DIR] });
    // comCelula NÃO tem patient_conversation:read nenhuma — só serve pra provar que, com a
    // família admin.patients FORA do rollout, ele aparece MESMO ASSIM (patientId é ignorado).
    await grupoComCelulas(pool, { nome: GRUPO_COM_CELULA, uid: U.comCelula, celulas: [] });

    setEnv('USE_MOCK_AUTH', 'true');
    setEnv('PERMISSION_ENGINE_ENABLED', 'true');
    // admin.patients FICA FORA da lista — só admin.users está enforced (staff_directory:read
    // continua exigida; o que muda é a checagem de acesso à CONVERSA, que R3-1 gateia por
    // `isPermissionFamilyEnforced(ADMIN_PATIENTS_FAMILY, ...)`).
    setEnv('PERMISSION_ENFORCED_ROUTES', 'admin.users');
    setEnv('PERMISSION_CACHE_TTL_MS', '0');
    setEnv('DATABASE_URL', DATABASE_URL);

    const { createAdminStaffDirectoryRoutes } = await import(
      '../../../src/modules/identity/interfaces/routes/adminStaffDirectoryRoutes'
    );
    app = await montarAppDeFamilia({
      enforcedRoutes: 'admin.users',
      montarRotas: ({ app: express, auth, permissions }) =>
        express.use('/api/admin', createAdminStaffDirectoryRoutes(auth, permissions)),
    });
  }, 30000);

  afterAll(async () => {
    await app?.fechar();
    const { DatabaseConnection } = await import('@shared/database/DatabaseConnection');
    await DatabaseConnection.getInstance().close();
    await limpar();
    await limparCelulasCriadas();
    await pool.end();
    for (const [k, v] of Object.entries(envAnterior)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('admin.patients fora do rollout: patientId é IGNORADO — lista igual à de sem filtro (não filtra ninguém indevidamente)', async () => {
    const res = await chamar(`/api/admin/staff-directory?patientId=${PATIENT_ID}`, U.requester);
    expect(res.status).toBe(200);
    const uids = res.body.data.map((e: { uid: string }) => e.uid);
    // comCelula não tem NENHUMA célula de conversa — se o filtro estivesse ativo, sumiria. Com a
    // família fora do rollout, ele aparece (mesma lista de "sem patientId").
    expect(uids).toContain(U.comCelula);
  });
});
