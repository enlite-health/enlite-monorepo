/**
 * Spec 018 PR-7 — API do Projeto Terapêutico com o D328 aplicado, catálogo de segmentos (US-17) e
 * a permissão da versão antiga, HTTP real, banco real, engine de permissão LIGADO (família
 * admin.patients). Complementa `therapeutic-projects-api.e2e.test.ts` (spec 017) e
 * `patient-therapeutic-project-contacts-db.e2e.test.ts` (429 no banco) — aqui é a CAMADA HTTP dos
 * pontos do bloco C do checklist `lex-pr7.md` e do contrato `therapeutic-project.md`.
 *
 * O que cada teste prova:
 *   1. D328 (contract §Sem versão automática): editar/desativar um contato EXTERNAL referenciado
 *      pela vigente e trocar `affiliateId` (seção `coverage`) pelas rotas da FICHA não criam
 *      versão nenhuma — mesmo `version_id`, mesma contagem em `patient_therapeutic_projects`.
 *   2. `mode:'edit'` de uma versão que deixou de ser vigente → 409 `ptp_not_current`.
 *   3. Editar a vigente trocando só `modality` (MICRO) → sobe a MINOR, sem `ptp_macro_locked`.
 *   4. Contato INATIVO no `contactRefs` → 422 `ptp_contact_inactive` com só `kind`/`id` (nunca
 *      nome/telefone, lex #7 C7).
 *   5. lex-pr7 C8(a): ator com `patient_therapeutic_project:read` sem `patient_family:read` lendo
 *      versão NÃO vigente recebe o contato EXTERNAL redigido (`redacted:true`), nunca nome.
 *   6. lex-pr7 C8(b): `?purpose=export` de versão antiga sem `…:export` → 403; com a célula → 200
 *      e a trilha grava `export_pdf:` (nunca `read_project:`).
 *   7. lex-pr7 C6: GET grava em `resource_access_log` os containers de contato EFETIVAMENTE
 *      servidos, só UUID — nunca nome/telefone do contato na trilha.
 *   8. lex-pr7 C3(b)/D303: `segmentId`/`segmentLabel` do objetivo saem só com `patient_clinical:read`;
 *      sem a célula, o item continua (id/label) mas o segmento vem `null`.
 *   9. Catálogo de segmentos (US-17): rótulo que parece dado pessoal é recusado pelo mesmo zod dos
 *      outros catálogos (`.strict()`/`containsLikelyPersonalData` → 400 — molde já provado em
 *      `therapeutic-projects-api.e2e.test.ts` teste 8 para `specific-objectives`).
 */
import { Pool } from 'pg';
import { AdminPatientDiagnosesController } from '@modules/diagnosis/interfaces/controllers/AdminPatientDiagnosesController';
import { AdminTerminologySearchController } from '@modules/terminology/interfaces/controllers/AdminTerminologySearchController';
import { montarAppDeFamilia, tokenMock, grupoComCelulas, limparIamFixtures, TENANT_E2E, type AppDeFamilia } from './helpers/permissionFamilyHarness';

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

/** Espelha `KMSEncryptionService.encrypt` em testMode (`NODE_ENV=test` → base64, ver KMSEncryptionService.ts:11). */
function cifrar(valor: string): string {
  return Buffer.from(valor, 'utf8').toString('base64');
}

describe('spec 018 PR-7 — projeto terapêutico pós-D328: API sob engine de permissão (HTTP real, banco real)', () => {
  let pool: Pool;
  let app: AppDeFamilia;
  const PATIENT = 'ee018007-0a00-0001-0001-000000000001';
  const OUTRO_PACIENTE = 'ee018007-0a00-0001-0001-000000000099';
  let serviceId: string;
  let objectiveIds: string[];
  let activityIds: string[];
  let externalContactId: string;
  /** Ativo, mas do OUTRO paciente — 23503 (FK 429) tem de virar 404, não 500 (task do Gabriel, 14/09). */
  let externalContactDeOutroPacienteId: string;
  let responsibleDeOutroPacienteId: string;

  const U = {
    completa: 'pt018pr7-completa',
    semFamilia: 'pt018pr7-sem-familia',
    semExport: 'pt018pr7-sem-export',
    semClinica: 'pt018pr7-sem-clinica',
  };
  const GRUPOS = {
    completa: 'PT018PR7 Completa',
    semFamilia: 'PT018PR7 Sem família',
    semExport: 'PT018PR7 Sem export',
    semClinica: 'PT018PR7 Sem clínica',
  };
  const CELULAS: ReadonlyArray<readonly [string, string]> = [
    ['patient_therapeutic_project', 'read'],
    ['patient_therapeutic_project', 'write'],
    ['patient_therapeutic_project', 'export'],
    ['patient_clinical', 'read'],
    ['patient_clinical', 'write'],
    ['patient_services', 'read'],
    ['patient_family', 'read'],
    ['patient_family', 'write'],
    ['patient_coverage', 'read'],
    ['patient_coverage', 'write'],
    ['patient_care_team', 'read'],
    ['catalog_therapeutic_objectives', 'read'],
    ['catalog_therapeutic_objectives', 'write'],
    ['catalog_therapeutic_activities', 'read'],
    ['catalog_therapeutic_segments', 'read'],
    ['catalog_therapeutic_segments', 'write'],
  ];

  // Release-fixture do CID-11 (mesmo molde de `therapeutic-projects-api.e2e.test.ts`).
  const FIX_RELEASE = 'PT018PR7-FIX';
  const CAP06 = { code: '06', title: 'Trastornos mentales, del comportamiento y del neurodesarrollo' };
  const URI_TEA = 'test://ptp018pr7/tea';
  let releaseAnterior: string | null = null;
  async function semearCid(): Promise<void> {
    await pool.query(`INSERT INTO terminology.icd_releases (release, entity_count) VALUES ($1, 2) ON CONFLICT (release) DO NOTHING`, [FIX_RELEASE]);
    await pool.query(
      `INSERT INTO terminology.icd_entities (icd_uri, release, code, title_es, title_en, chapter, parent_uri, kind, is_leaf)
       VALUES ('test://ptp018pr7/cap06', $1, $2, $3, NULL, $2, NULL, 'chapter', false) ON CONFLICT (icd_uri, release) DO NOTHING`,
      [FIX_RELEASE, CAP06.code, CAP06.title],
    );
    await pool.query(
      `INSERT INTO terminology.icd_entities (icd_uri, release, code, title_es, title_en, chapter, parent_uri, kind, is_leaf)
       VALUES ($1, $2, '6A02', 'Trastorno del espectro autista', NULL, $3, NULL, 'stem', true) ON CONFLICT (icd_uri, release) DO NOTHING`,
      [URI_TEA, FIX_RELEASE, CAP06.code],
    );
    releaseAnterior = (await pool.query<{ release: string }>(`SELECT release FROM terminology.icd_releases WHERE is_current LIMIT 1`)).rows[0]?.release ?? null;
    await pool.query(`UPDATE terminology.icd_releases SET is_current = false, promoted_at = NULL, promoted_by = NULL WHERE is_current`);
    await pool.query(`UPDATE terminology.icd_releases SET is_current = true, promoted_at = NOW(), promoted_by = 'pt018pr7-e2e' WHERE release = $1`, [FIX_RELEASE]);
  }
  async function restaurarCid(): Promise<void> {
    await pool.query(`UPDATE terminology.icd_releases SET is_current = false, promoted_at = NULL, promoted_by = NULL WHERE release = $1`, [FIX_RELEASE]);
    if (releaseAnterior) await pool.query(`UPDATE terminology.icd_releases SET is_current = true, promoted_at = NOW(), promoted_by = 'pt018pr7-e2e-restore' WHERE release = $1`, [releaseAnterior]);
    await pool.query(`DELETE FROM terminology.icd_entities WHERE release = $1`, [FIX_RELEASE]);
    await pool.query(`DELETE FROM terminology.icd_releases WHERE release = $1`, [FIX_RELEASE]);
  }

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

  const versionBody = (over: Record<string, unknown> = {}) => ({
    contractedServiceId: serviceId,
    modality: 'IN_PERSON',
    diagnoses: [{ uri: URI_TEA, code: '6A02', title: 'Diagnóstico sintético e2e' }],
    clinicalContext: 'Síntesis sintética e2e — texto de teste sem dado de titular.',
    generalObjective: 'Objetivo general sintético e2e.',
    specificObjectiveIds: objectiveIds.slice(0, 1),
    activityIds: activityIds.slice(0, 1),
    startDate: '2026-09-01',
    endDate: '2026-12-31',
    contactRefs: [],
    careTeamIds: [],
    ...over,
  });

  async function limparCelulas(): Promise<void> {
    // Mesmo padrão do irmão 017 (therapeutic-projects-api.e2e.test.ts): apaga TAMBÉM a linha em
    // `iam.permissions`, não só o vínculo em `group_permissions` — senão a permissão criada aqui
    // sobrevive ao teste e contamina a contagem exata de `permissions-iam-schema.e2e.test.ts`
    // (seed fixo da migration 206, 41 linhas/18 recursos). Nenhum resource/action de CELULAS está
    // no seed da 206 (confirmado por leitura de migrations/206_permissions_iam_foundation.sql:101-150)
    // — o catálogo desses recursos nasce só do sync de rotas (migrations/431, comentário), nunca de
    // migration com DDL; por isso é seguro apagar por resource/action aqui, sem risco de apagar seed.
    for (const [resource, action] of CELULAS) {
      await pool.query(
        `DELETE FROM iam.group_permissions WHERE permission_id IN (SELECT id FROM iam.permissions WHERE resource = $1 AND action = $2)`,
        [resource, action],
      );
      await pool.query(`DELETE FROM iam.permissions WHERE resource = $1 AND action = $2`, [resource, action]);
    }
  }
  async function limpar(): Promise<void> {
    await pool.query(`DELETE FROM resource_access_log WHERE operator_uid = ANY($1)`, [Object.values(U)]);
    await limparIamFixtures(pool, { uids: Object.values(U), grupos: Object.values(GRUPOS) });
    await limparCelulas();
    await pool.query(`DELETE FROM patients WHERE id = $1`, [PATIENT]);
    await pool.query(`DELETE FROM patients WHERE id = $1`, [OUTRO_PACIENTE]);
    await pool.query(`DELETE FROM therapeutic_specific_objectives WHERE label LIKE 'E2E PR7 %'`);
    await pool.query(`DELETE FROM therapeutic_segments WHERE label LIKE 'E2E PR7 %'`);
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    await limpar();
    await pool.query(
      `INSERT INTO users (firebase_uid, email, display_name, role, status, is_active, tenant_id) VALUES
         ($1, 'pt018pr7-completa@e2e.local', 'Completa Sintética', 'admin', 'ACTIVE', true, $5),
         ($2, 'pt018pr7-sem-familia@e2e.local', 'Sem Família', 'admin', 'ACTIVE', true, $5),
         ($3, 'pt018pr7-sem-export@e2e.local', 'Sem Export', 'admin', 'ACTIVE', true, $5),
         ($4, 'pt018pr7-sem-clinica@e2e.local', 'Sem Clínica', 'admin', 'ACTIVE', true, $5)`,
      [U.completa, U.semFamilia, U.semExport, U.semClinica, TENANT_E2E],
    );
    for (const [resource, action] of CELULAS) {
      await pool.query(
        `INSERT INTO iam.permissions (resource, action, description, category) VALUES ($1, $2, 'e2e 018 pr7', 'Pacientes') ON CONFLICT DO NOTHING`,
        [resource, action],
      );
    }
    await pool.query(`INSERT INTO iam.permissions (resource, action, description, category) VALUES ('patient', 'read', 'e2e', 'Pacientes') ON CONFLICT DO NOTHING`);

    await grupoComCelulas(pool, {
      nome: GRUPOS.completa, uid: U.completa,
      celulas: [
        ['patient', 'read'],
        ['patient_therapeutic_project', 'read'], ['patient_therapeutic_project', 'write'], ['patient_therapeutic_project', 'export'],
        ['patient_clinical', 'read'], ['patient_clinical', 'write'],
        ['patient_services', 'read'],
        ['patient_family', 'read'], ['patient_family', 'write'],
        ['patient_coverage', 'read'], ['patient_coverage', 'write'],
        ['patient_care_team', 'read'],
        ['catalog_therapeutic_objectives', 'read'], ['catalog_therapeutic_objectives', 'write'],
        ['catalog_therapeutic_activities', 'read'],
        ['catalog_therapeutic_segments', 'read'], ['catalog_therapeutic_segments', 'write'],
      ],
    });
    // C8(a): lê o projeto e o clínico, mas NÃO vê a origem `family` — o contato EXTERNAL some.
    await grupoComCelulas(pool, {
      nome: GRUPOS.semFamilia, uid: U.semFamilia,
      celulas: [['patient', 'read'], ['patient_therapeutic_project', 'read'], ['patient_clinical', 'read'], ['patient_services', 'read']],
    });
    // C8(b): lê o projeto, mas não tem a célula de EXPORT.
    await grupoComCelulas(pool, {
      nome: GRUPOS.semExport, uid: U.semExport,
      celulas: [['patient', 'read'], ['patient_therapeutic_project', 'read'], ['patient_clinical', 'read'], ['patient_services', 'read']],
    });
    // C3(b): lê o projeto, mas não tem `patient_clinical:read` — o segmento do objetivo tem de sumir.
    await grupoComCelulas(pool, {
      nome: GRUPOS.semClinica, uid: U.semClinica,
      celulas: [['patient', 'read'], ['patient_therapeutic_project', 'read']],
    });

    await pool.query(
      `INSERT INTO patients (id, clickup_task_id, first_name, last_name, country, is_test) VALUES ($1, 'e2e-018pr7-a', 'Paciente', 'Sintético', 'AR', true)`,
      [PATIENT],
    );
    serviceId = (await pool.query<{ id: string }>(
      `INSERT INTO patient_contracted_services (patient_id, service_code, created_by, updated_by) VALUES ($1, 'CAREGIVER', 'e2e', 'e2e') RETURNING id`, [PATIENT],
    )).rows[0].id;
    objectiveIds = (await pool.query<{ id: string }>(`SELECT id FROM therapeutic_specific_objectives WHERE active ORDER BY sort_order`)).rows.map((r) => r.id);
    activityIds = (await pool.query<{ id: string }>(`SELECT id FROM therapeutic_activities WHERE active ORDER BY sort_order`)).rows.map((r) => r.id);
    externalContactId = (await pool.query<{ id: string }>(
      `INSERT INTO patient_external_contacts (patient_id, relation, name, phone_encrypted, created_by)
       VALUES ($1, 'NEIGHBOR', 'Vizinha Sintética PR7', $2, 'e2e-018pr7') RETURNING id`,
      [PATIENT, cifrar('+54 11 0000-0001')],
    )).rows[0].id;

    // OUTRO paciente, com contatos ATIVOS — usados só para provar que uma referência de outro
    // paciente vira 404 (FK 23503 da 429), não 422 `ptp_contact_inactive` (que é só p/ INATIVO).
    await pool.query(
      `INSERT INTO patients (id, clickup_task_id, first_name, last_name, country, is_test) VALUES ($1, 'e2e-018pr7-b', 'Outro', 'Paciente', 'AR', true)`,
      [OUTRO_PACIENTE],
    );
    externalContactDeOutroPacienteId = (await pool.query<{ id: string }>(
      `INSERT INTO patient_external_contacts (patient_id, relation, name, phone_encrypted, created_by)
       VALUES ($1, 'NEIGHBOR', 'Vizinha do Outro Paciente', $2, 'e2e-018pr7') RETURNING id`,
      [OUTRO_PACIENTE, cifrar('+54 11 0000-0002')],
    )).rows[0].id;
    responsibleDeOutroPacienteId = (await pool.query<{ id: string }>(
      `INSERT INTO patient_responsibles (patient_id, first_name, last_name, is_primary, source) VALUES ($1, 'Responsável', 'Do Outro', true, 'e2e') RETURNING id`,
      [OUTRO_PACIENTE],
    )).rows[0].id;
    await semearCid();

    setEnv('USE_MOCK_AUTH', 'true');
    setEnv('PERMISSION_ENGINE_ENABLED', 'true');
    setEnv('PERMISSION_ENFORCED_ROUTES', 'admin.patients');
    setEnv('PERMISSION_CACHE_TTL_MS', '0');
    setEnv('DATABASE_URL', DATABASE_URL);

    const caseModule = await import('@modules/case');
    app = await montarAppDeFamilia({
      enforcedRoutes: 'admin.patients',
      montarRotas: ({ app: express, auth, permissions }) => {
        express.use('/api/admin', caseModule.createAdminTherapeuticProjectsRoutes(new caseModule.AdminTherapeuticProjectsController(), auth, permissions));
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
        );
      },
    });
  }, 30000);

  afterAll(async () => {
    await app?.fechar();
    const { DatabaseConnection } = await import('@shared/database/DatabaseConnection');
    await DatabaseConnection.getInstance().close();
    await limpar();
    await restaurarCid();
    await pool.end();
    for (const [k, v] of Object.entries(envAnterior)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  });

  const BASE = () => `/api/admin/patients/${PATIENT}/therapeutic-projects`;
  const contarVersoes = async (): Promise<number> =>
    (await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM patient_therapeutic_projects WHERE patient_id = $1`, [PATIENT])).rows[0].n;

  let v10: string;

  it('1. D328 (contract §Sem versão automática): editar/desativar contato referenciado e trocar affiliateId NÃO criam versão', async () => {
    const antes = await contarVersoes();
    const criado = await chamar('POST', BASE(), U.completa, { mode: 'new', version: versionBody({ contactRefs: [{ kind: 'EXTERNAL', id: externalContactId }] }) });
    expect(criado.status).toBe(201);
    v10 = criado.body.data.id;
    expect(await contarVersoes()).toBe(antes + 1);

    // (a) editar o contato referenciado pela rota da ficha — sem campo de auto-versão na resposta.
    const editado = await chamar('PATCH', `/api/admin/patients/${PATIENT}/external-contacts/${externalContactId}`, U.completa, { name: 'Vizinha Sintética PR7 (editada)' });
    expect(editado.status).toBe(200);
    expect(editado.body.data).not.toHaveProperty('therapeuticProjectAutoVersion');
    expect(await contarVersoes()).toBe(antes + 1);

    // (b) trocar affiliateId (seção `coverage`) — mesma régua, nenhuma versão nova.
    const cobertura = await chamar('PATCH', `/api/admin/patients/${PATIENT}/coverage`, U.completa, { affiliateId: 'AFILIADO-PR7-E2E' });
    expect(cobertura.status).toBe(200);
    expect(await contarVersoes()).toBe(antes + 1);

    // (c) desativar o contato referenciado — ainda nenhuma versão nova, e a ligação mantém o MESMO id.
    const desativado = await chamar('POST', `/api/admin/patients/${PATIENT}/external-contacts/${externalContactId}/deactivate`, U.completa);
    expect(desativado.status).toBe(200);
    expect(await contarVersoes()).toBe(antes + 1);
    const ligacao = await pool.query<{ version_id: string; external_contact_id: string }>(
      `SELECT version_id, external_contact_id FROM patient_therapeutic_project_contacts WHERE version_id = $1`,
      [v10],
    );
    expect(ligacao.rows[0]).toEqual({ version_id: v10, external_contact_id: externalContactId });
  });

  let v20: string;

  it('2. `mode:edit` com `fromVersionId` que deixou de ser vigente → 409 `ptp_not_current`', async () => {
    // V.1.0 (`v10`) ainda é a única — cria V.2.0 e torna V.1.0 não-vigente.
    const novo = await chamar('POST', BASE(), U.completa, { mode: 'new', version: versionBody() });
    expect(novo.status).toBe(201);
    v20 = novo.body.data.id;

    const editarVelha = await chamar('POST', BASE(), U.completa, { mode: 'edit', fromVersionId: v10, version: versionBody() });
    expect(editarVelha.status).toBe(409);
    expect(editarVelha.body).toMatchObject({ code: 'ptp_not_current' });
  });

  it('3. editar a vigente trocando só `modality` (MICRO) → sobe a MINOR, sem `ptp_macro_locked`', async () => {
    const editado = await chamar('POST', BASE(), U.completa, { mode: 'edit', fromVersionId: v20, version: versionBody({ modality: 'ONLINE' }) });
    expect(editado.status).toBe(201);
    expect(editado.body.data).toMatchObject({ version: 'V.2.1', modality: 'ONLINE', editedFromVersionId: v20 });
    v20 = editado.body.data.id; // a vigente agora é V.2.1
  });

  it('4. contato INATIVO em `contactRefs` → 422 `ptp_contact_inactive` só com `kind`/`id`', async () => {
    // `externalContactId` foi desativado no teste 1(c) — referenciá-lo agora é recusado.
    const r = await chamar('POST', BASE(), U.completa, { mode: 'edit', fromVersionId: v20, version: versionBody({ contactRefs: [{ kind: 'EXTERNAL', id: externalContactId }] }) });
    expect(r.status).toBe(422);
    expect(r.body).toEqual({ success: false, error: 'Selected contact is inactive', code: 'ptp_contact_inactive', details: { kind: 'EXTERNAL', id: externalContactId } });
    expect(JSON.stringify(r.body)).not.toContain('Vizinha');
  });

  it('4b. contato EXTERNAL ATIVO mas de OUTRO paciente → 404 `contact_not_found` (kind/id, nunca nome/telefone), NENHUMA versão criada (FK 429, `ptpc_ext_fk`)', async () => {
    const antes = await contarVersoes();
    const r = await chamar('POST', BASE(), U.completa, { mode: 'edit', fromVersionId: v20, version: versionBody({ contactRefs: [{ kind: 'EXTERNAL', id: externalContactDeOutroPacienteId }] }) });
    expect(r.status).toBe(404);
    expect(r.body).toEqual({ success: false, error: 'Selected contact not found', code: 'contact_not_found', details: { kind: 'EXTERNAL', id: externalContactDeOutroPacienteId } });
    expect(JSON.stringify(r.body)).not.toContain('Vizinha');
    expect(JSON.stringify(r.body)).not.toContain('54 11');
    expect(await contarVersoes()).toBe(antes);
  });

  it('4c. contato RESPONSIBLE ATIVO mas de OUTRO paciente → 404 `contact_not_found` (FK 429, `ptpc_resp_fk`), nenhuma versão criada', async () => {
    const antes = await contarVersoes();
    const r = await chamar('POST', BASE(), U.completa, { mode: 'edit', fromVersionId: v20, version: versionBody({ contactRefs: [{ kind: 'RESPONSIBLE', id: responsibleDeOutroPacienteId }] }) });
    expect(r.status).toBe(404);
    expect(r.body).toEqual({ success: false, error: 'Selected contact not found', code: 'contact_not_found', details: { kind: 'RESPONSIBLE', id: responsibleDeOutroPacienteId } });
    expect(JSON.stringify(r.body)).not.toContain('Responsável');
    expect(await contarVersoes()).toBe(antes);
  });

  it('5. lex-pr7 C8(a): sem `patient_family:read`, versão NÃO vigente (V.1.0) devolve o contato EXTERNAL redigido', async () => {
    const r = await chamar('GET', `${BASE()}/${v10}`, U.semFamilia);
    expect(r.status).toBe(200);
    expect(r.body.data.contacts).toEqual([{ kind: 'EXTERNAL', id: externalContactId, redacted: true }]);
    expect(JSON.stringify(r.body)).not.toContain('Vizinha');

    // Controle: quem TEM `patient_family:read` mas a linha está INATIVA (desde o teste 1c) — nunca
    // resolve nome, mesmo em versão histórica (regra única lex-pr7 condição 5).
    const comFamilia = await chamar('GET', `${BASE()}/${v10}`, U.completa);
    expect(comFamilia.body.data.contacts).toEqual([{ kind: 'EXTERNAL', id: externalContactId, inactive: true }]);
    expect(JSON.stringify(comFamilia.body)).not.toContain('Vizinha');
  });

  it('6. lex-pr7 C8(b): `?purpose=export` de versão antiga sem `…:export` → 403; com a célula → 200 + trilha `export_pdf:`', async () => {
    const semCelula = await chamar('GET', `${BASE()}/${v10}?purpose=export`, U.semExport);
    expect(semCelula.status).toBe(403);

    const comCelula = await chamar('GET', `${BASE()}/${v10}?purpose=export`, U.completa);
    expect(comCelula.status).toBe(200);

    const limite = Date.now() + 10_000;
    let linha: { action: string } | undefined;
    while (Date.now() < limite && !linha) {
      const trilha = await pool.query<{ action: string }>(
        `SELECT action FROM resource_access_log WHERE operator_uid = $1 AND resource_id = $2 AND action LIKE 'export_pdf:%' ORDER BY occurred_at DESC LIMIT 1`,
        [U.completa, PATIENT],
      );
      linha = trilha.rows[0];
      if (!linha) await new Promise((r) => setTimeout(r, 100));
    }
    expect(linha?.action).toMatch(/^export_pdf:/);
    expect(linha?.action).not.toMatch(/^read_project:/);
  });

  it('7. lex-pr7 C6: GET grava os containers de contato SERVIDOS na trilha, só UUID — nunca nome/telefone', async () => {
    // V.2.1 (`v20`) não tem `contactRefs`; usa V.1.0, que referencia o EXTERNAL (agora inativo —
    // `containersServed` só conta contato RESOLVIDO, não meramente referenciado, lex-pr7 C6).
    await chamar('GET', `${BASE()}/${v10}`, U.completa);
    const limite = Date.now() + 10_000;
    let linha: { action: string; resource_id: string } | undefined;
    while (Date.now() < limite && !linha) {
      const trilha = await pool.query<{ action: string; resource_id: string }>(
        `SELECT action, resource_id FROM resource_access_log WHERE operator_uid = $1 AND resource_id = $2 AND action LIKE 'read_project:%' ORDER BY occurred_at DESC LIMIT 1`,
        [U.completa, PATIENT],
      );
      linha = trilha.rows[0];
      if (!linha) await new Promise((r) => setTimeout(r, 100));
    }
    // O contato está INATIVO (teste 1c) — não é "servido" (nome não resolvido), então `family` NÃO
    // entra no `action`, só `therapeuticProject`(+`clinical`+`services`, células que `completa` tem).
    expect(linha?.action).toBe('read_project:therapeuticProject+clinical+services');
    expect(linha?.resource_id).toBe(PATIENT);
    expect(JSON.stringify(linha)).not.toContain('Vizinha');
  });

  let segmentId: string;
  let objetivoComSegmentoId: string;

  it('8. lex-pr7 C3(b)/D303: `segmentId`/`segmentLabel` do objetivo saem só com `patient_clinical:read`', async () => {
    const segCriado = await chamar('POST', '/api/admin/therapeutic-catalogs/segments', U.completa, { label: 'E2E PR7 Segmento Motor' });
    expect(segCriado.status).toBe(201);
    segmentId = segCriado.body.data.id;

    const objCriado = await chamar('POST', '/api/admin/therapeutic-catalogs/specific-objectives', U.completa, { label: 'E2E PR7 Objetivo com segmento', segmentId });
    expect(objCriado.status).toBe(201);
    objetivoComSegmentoId = objCriado.body.data.id;
    expect(objCriado.body.data).toMatchObject({ segmentId });

    const versao = await chamar('POST', BASE(), U.completa, {
      mode: 'new',
      version: versionBody({ specificObjectiveIds: [objetivoComSegmentoId, ...objectiveIds.slice(0, 1)] }),
    });
    expect(versao.status).toBe(201);
    const vid = versao.body.data.id;

    const comClinica = await chamar('GET', `${BASE()}/${vid}`, U.completa);
    const itemComClinica = comClinica.body.data.specificObjectives.find((i: { id: string }) => i.id === objetivoComSegmentoId);
    expect(itemComClinica).toMatchObject({ id: objetivoComSegmentoId, segmentId, segmentLabel: 'E2E PR7 Segmento Motor' });

    const semClinica = await chamar('GET', `${BASE()}/${vid}`, U.semClinica);
    expect(semClinica.body.data.redacted).toMatchObject({ clinical: true });
    const itemSemClinica = semClinica.body.data.specificObjectives.find((i: { id: string }) => i.id === objetivoComSegmentoId);
    // O ITEM continua (id/label) — só o segmento é redigido (lex-pr7 C3(b): não é o objetivo inteiro).
    expect(itemSemClinica).toMatchObject({ id: objetivoComSegmentoId, segmentId: null, segmentLabel: null });
    expect(itemSemClinica.label).toBeTruthy();
  });

  it('9. catálogo de segmentos: rótulo que parece dado pessoal é recusado (mesmo zod dos outros catálogos)', async () => {
    const pii = await chamar('POST', '/api/admin/therapeutic-catalogs/segments', U.completa, { label: 'E2E PR7 llamar al 11 4463 5919' });
    // `containsLikelyPersonalData` é o MESMO `.refine` de `catalogLabel` (therapeuticProjectSchemas.ts:95-101)
    // que já vale para objetivos/atividades desde a spec 017 — falha no zod, não no repositório, e
    // por isso é 400 (`invalidBody`), o mesmo código do teste 8 de `therapeutic-projects-api.e2e.test.ts`
    // para o catálogo irmão (não 422: não existe verificação de PII depois do parse).
    expect(pii.status).toBe(400);
    const total = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM therapeutic_segments WHERE label LIKE 'E2E PR7 llamar%'`);
    expect(total.rows[0].n).toBe(0);
  });

  it('10. conserto 14/09 (achado do gate): GET devolve `contactRefs`/`careTeamIds` CRUS (lista e versão isolada), e editar a vigente reenviando os MESMOS refs lidos do GET mantém o contato na minor nova', async () => {
    // Contato PRÓPRIO deste teste (self-contained — não reaproveita `externalContactId`, que os
    // testes 1/4/5 já deixam INATIVO nesta suíte).
    const contatoAtivo = (await pool.query<{ id: string }>(
      `INSERT INTO patient_external_contacts (patient_id, relation, name, phone_encrypted, created_by)
       VALUES ($1, 'NEIGHBOR', 'Amiga Sintética Teste 10', $2, 'e2e-018pr7') RETURNING id`,
      [PATIENT, cifrar('+54 11 0000-0009')],
    )).rows[0].id;

    const criado = await chamar('POST', BASE(), U.completa, { mode: 'new', version: versionBody({ contactRefs: [{ kind: 'EXTERNAL', id: contatoAtivo }] }) });
    expect(criado.status).toBe(201);
    const vidMajor = criado.body.data.id;

    // GET de uma versão isolada já devolve `contactRefs` cru — não só `contacts` resolvido.
    const lido = await chamar('GET', `${BASE()}/${vidMajor}`, U.completa);
    expect(lido.status).toBe(200);
    expect(lido.body.data.contactRefs).toEqual([{ kind: 'EXTERNAL', id: contatoAtivo }]);
    expect(lido.body.data.careTeamIds).toEqual([]);
    expect(lido.body.data.contacts).toEqual([{ kind: 'EXTERNAL', id: contatoAtivo, name: 'Amiga Sintética Teste 10', phone: '+54 11 0000-0009', relation: 'NEIGHBOR' }]);

    // GET da LISTA: a MESMA versão, dentro de `data.versions`, também carrega `contactRefs`.
    const lista = await chamar('GET', BASE(), U.completa);
    expect(lista.status).toBe(200);
    const naLista = (lista.body.data.versions as Array<{ id: string; contactRefs: unknown; careTeamIds: unknown }>).find((v) => v.id === vidMajor);
    expect(naLista?.contactRefs).toEqual([{ kind: 'EXTERNAL', id: contatoAtivo }]);
    expect(naLista?.careTeamIds).toEqual([]);

    // "Editar" a vigente trocando só a modalidade (MICRO), REENVIANDO `contactRefs`/`careTeamIds`
    // tal como o GET devolveu — é exatamente o que `TherapeuticProjectForm.tsx` (`keptIdsOfKind`)
    // faz agora com um contato ATIVO: o contato segue presente na minor nova.
    const editado = await chamar('POST', BASE(), U.completa, {
      mode: 'edit',
      fromVersionId: vidMajor,
      version: versionBody({ modality: 'ONLINE', contactRefs: lido.body.data.contactRefs, careTeamIds: lido.body.data.careTeamIds }),
    });
    expect(editado.status).toBe(201);
    expect(editado.body.data.editedFromVersionId).toBe(vidMajor);
    const vidMinor = editado.body.data.id;

    const relida = await chamar('GET', `${BASE()}/${vidMinor}`, U.completa);
    expect(relida.body.data.contactRefs).toEqual([{ kind: 'EXTERNAL', id: contatoAtivo }]);
    expect(relida.body.data.contacts).toEqual([{ kind: 'EXTERNAL', id: contatoAtivo, name: 'Amiga Sintética Teste 10', phone: '+54 11 0000-0009', relation: 'NEIGHBOR' }]);

    // A MAJOR original (v1.0 deste teste) continua intocada — imutabilidade da versão de origem.
    const original = await chamar('GET', `${BASE()}/${vidMajor}`, U.completa);
    expect(original.body.data.contactRefs).toEqual([{ kind: 'EXTERNAL', id: contatoAtivo }]);
  });

  it('11. conserto 14/09 (achado do gate): a resposta 201 do POST traz `contactRefs`/`careTeamIds`/`contacts` IGUAIS ao GET da MESMA versão — inclusive redigido sem a célula de origem, e a trilha do POST grava o container SERVIDO', async () => {
    const contatoAtivo = (await pool.query<{ id: string }>(
      `INSERT INTO patient_external_contacts (patient_id, relation, name, phone_encrypted, created_by)
       VALUES ($1, 'NEIGHBOR', 'Vizinha Sintética Teste 11', $2, 'e2e-018pr7') RETURNING id`,
      [PATIENT, cifrar('+54 11 0000-0011')],
    )).rows[0].id;

    const criado = await chamar('POST', BASE(), U.completa, { mode: 'new', version: versionBody({ contactRefs: [{ kind: 'EXTERNAL', id: contatoAtivo }] }) });
    expect(criado.status).toBe(201);
    const vid = criado.body.data.id;

    // O 201 já vem com `contacts` RESOLVIDO (nome/telefone) — nunca cru, nunca `undefined`.
    expect(criado.body.data.contactRefs).toEqual([{ kind: 'EXTERNAL', id: contatoAtivo }]);
    expect(criado.body.data.careTeamIds).toEqual([]);
    expect(criado.body.data.contacts).toEqual([{ kind: 'EXTERNAL', id: contatoAtivo, name: 'Vizinha Sintética Teste 11', phone: '+54 11 0000-0011', relation: 'NEIGHBOR' }]);

    // O GET imediatamente depois, pelo MESMO ator, devolve EXATAMENTE o mesmo bloco — mesma
    // `resolveContacts`, mesma consulta (contract §POST: "nunca uma 2ª query com formato próprio").
    const lido = await chamar('GET', `${BASE()}/${vid}`, U.completa);
    expect(lido.body.data.contactRefs).toEqual(criado.body.data.contactRefs);
    expect(lido.body.data.careTeamIds).toEqual(criado.body.data.careTeamIds);
    expect(lido.body.data.contacts).toEqual(criado.body.data.contacts);

    // Redigido: ator SEM `patient_family:read` recebe `redacted:true` — mesma regra de célula de
    // origem que `resolveContacts` já aplica no GET, agora provada com o GET da mesma versão criada pelo POST.
    const semFamiliaLe = await chamar('GET', `${BASE()}/${vid}`, U.semFamilia);
    expect(semFamiliaLe.body.data.contacts).toEqual([{ kind: 'EXTERNAL', id: contatoAtivo, redacted: true }]);
    expect(JSON.stringify(semFamiliaLe.body)).not.toContain('Vizinha Sintética Teste 11');

    // Trilha do POST (`write_project:`) grava o container `family` SERVIDO — mesmo mecanismo do GET
    // (lex C6/C9, `req.therapeuticContactContainers`), sem formato novo.
    const limite = Date.now() + 10_000;
    let linha: { action: string } | undefined;
    while (Date.now() < limite && !linha) {
      const trilha = await pool.query<{ action: string }>(
        `SELECT action FROM resource_access_log WHERE operator_uid = $1 AND resource_id = $2 AND action LIKE 'write_project:%' ORDER BY occurred_at DESC LIMIT 1`,
        [U.completa, PATIENT],
      );
      linha = trilha.rows[0];
      if (!linha) await new Promise((r) => setTimeout(r, 100));
    }
    expect(linha?.action).toBe('write_project:therapeuticProject+clinical+services+family');
    expect(JSON.stringify(linha)).not.toContain('Vizinha');
  });
});
