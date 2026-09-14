/**
 * Spec 017 — a API do Projeto Terapêutico com o ENGINE DE PERMISSÃO LIGADO (família admin.patients),
 * HTTP real, banco real. Sem mock de dado.
 *
 * O que se prova (D299; lex C5, C7, C9, C13, C18, C19):
 *   1. numeração: new→1.0, new→2.0, edit(1.0)→1.1, edit(1.0) de novo→1.2 (nunca colide);
 *   2. projeção C7: ator SÓ com `patient_therapeutic_project:read` recebe versões/datas/autor/
 *      catálogos, e NÃO recebe texto clínico nem CID (`redacted.clinical` constante);
 *   3. escrita cumulativa: sem `patient_clinical:write` → 403 nomeando a célula; sem a célula do
 *      projeto → 403 `missing_cell` do middleware; sem nada → 403;
 *   4. anular passa uma vez; anulada não é origem de edição; UPDATE de conteúdo nunca existe;
 *   5. catálogo: criar/renomear/desativar; rótulo duplicado 409; rótulo com dado pessoal 400;
 *      id desativado no snapshot → 422 e NADA gravado;
 *   5b. tipo de patologia DERIVADO do CID-11 (Gabriel 08/09; D163/D164): capítulo por diagnóstico,
 *      distinto e ordenado; `pathologyTypeIds` no corpo → 400; CID que não resolve → 422 e nada
 *      gravado; a rota do catálogo `pathology-types` NÃO existe (404); sem clínica sai `null`;
 *   6. trilha: `read_project:therapeuticProject+clinical` e `export_pdf:…` com `?purpose=export`,
 *      só UUID na linha;
 *   7. o uid do autor NUNCA sai — só `createdByName`; idem quem anulou (`annulledByName`).
 */
import { Pool } from 'pg';
import { montarAppDeFamilia, tokenMock, grupoComCelulas, limparIamFixtures, TENANT_E2E, type AppDeFamilia } from './helpers/permissionFamilyHarness';

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

describe('spec 017 — projeto terapêutico: API sob engine de permissão (HTTP real, banco real)', () => {
  let pool: Pool;
  let app: AppDeFamilia;
  const PATIENT = 'ee417000-0a00-0001-0001-000000000001';
  const OUTRO = 'ee417000-0a00-0001-0002-000000000001';
  let serviceId: string;
  let serviceOutroId: string;
  let objectiveIds: string[];
  let activityIds: string[];

  const U = {
    completa: 'pt017-completa',
    soProjeto: 'pt017-so-projeto',
    semClinica: 'pt017-sem-clinica',
    operacional: 'pt017-operacional',
    catalogo: 'pt017-catalogo',
  };
  const GRUPOS = {
    completa: 'PT017 Completa',
    soProjeto: 'PT017 Só projeto',
    semClinica: 'PT017 Sem clínica',
    operacional: 'PT017 Operacional',
    catalogo: 'PT017 Catálogo',
  };
  const CELULAS: ReadonlyArray<readonly [string, string]> = [
    ['patient_therapeutic_project', 'read'],
    ['patient_therapeutic_project', 'write'],
    // PR-7 (92f766a3, lex C8(b)): `?purpose=export` passa a exigir esta célula ALÉM da leitura.
    ['patient_therapeutic_project', 'export'],
    ['patient_clinical', 'read'],
    ['patient_clinical', 'write'],
    ['patient_services', 'read'],
    ['catalog_therapeutic_objectives', 'read'],
    ['catalog_therapeutic_objectives', 'write'],
    ['catalog_therapeutic_activities', 'read'],
  ];

  /**
   * Release-fixture do CID-11 (o ingestor real não roda aqui; o CI o tem, mas o teste não depende
   * dele): capítulo 06 + um stem nele, capítulo 08 + um stem nele. Promovido como CORRENTE no
   * beforeAll e o release anterior restaurado no afterAll (D2: só um corrente por vez).
   */
  const FIX_RELEASE = 'PT017-FIX';
  const CAP06 = { code: '06', title: 'Trastornos mentales, del comportamiento y del neurodesarrollo' };
  const CAP08 = { code: '08', title: 'Enfermedades del sistema nervioso' };
  const URI_TEA = 'test://ptp017/tea';
  const URI_EPI = 'test://ptp017/epilepsia';
  const URI_SUMIDA = 'test://ptp017/nao-existe';
  let releaseAnterior: string | null = null;
  async function semearCid(): Promise<void> {
    await pool.query(`INSERT INTO terminology.icd_releases (release, entity_count) VALUES ($1, 4) ON CONFLICT (release) DO NOTHING`, [FIX_RELEASE]);
    const linhas: Array<[string, string, string, string, string, boolean]> = [
      ['test://ptp017/cap06', CAP06.code, CAP06.title, CAP06.code, 'chapter', false],
      ['test://ptp017/cap08', CAP08.code, CAP08.title, CAP08.code, 'chapter', false],
      [URI_TEA, '6A02', 'Trastorno del espectro autista', CAP06.code, 'stem', true],
      [URI_EPI, '8A60', 'Epilepsia', CAP08.code, 'stem', true],
    ];
    for (const [uri, code, title, chapter, kind, leaf] of linhas) {
      await pool.query(
        `INSERT INTO terminology.icd_entities (icd_uri, release, code, title_es, title_en, chapter, parent_uri, kind, is_leaf)
         VALUES ($1, $2, $3, $4, NULL, $5, NULL, $6, $7) ON CONFLICT (icd_uri, release) DO NOTHING`,
        [uri, FIX_RELEASE, code, title, chapter, kind, leaf],
      );
    }
    releaseAnterior = (await pool.query<{ release: string }>(`SELECT release FROM terminology.icd_releases WHERE is_current LIMIT 1`)).rows[0]?.release ?? null;
    await pool.query(`UPDATE terminology.icd_releases SET is_current = false, promoted_at = NULL, promoted_by = NULL WHERE is_current`);
    await pool.query(`UPDATE terminology.icd_releases SET is_current = true, promoted_at = NOW(), promoted_by = 'pt017-e2e' WHERE release = $1`, [FIX_RELEASE]);
  }
  async function restaurarCid(): Promise<void> {
    await pool.query(`UPDATE terminology.icd_releases SET is_current = false, promoted_at = NULL, promoted_by = NULL WHERE release = $1`, [FIX_RELEASE]);
    if (releaseAnterior) await pool.query(`UPDATE terminology.icd_releases SET is_current = true, promoted_at = NOW(), promoted_by = 'pt017-e2e-restore' WHERE release = $1`, [releaseAnterior]);
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
    specificObjectiveIds: objectiveIds.slice(0, 2),
    activityIds: activityIds.slice(0, 3),
    startDate: '2026-09-01',
    endDate: '2026-12-31',
    ...over,
  });

  async function limparCelulas(): Promise<void> {
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
    await pool.query(`DELETE FROM patients WHERE id = ANY($1)`, [[PATIENT, OUTRO]]);
    await pool.query(`DELETE FROM therapeutic_specific_objectives WHERE label LIKE 'E2E 017 %'`);
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    await limpar();
    await pool.query(
      `INSERT INTO users (firebase_uid, email, display_name, role, status, is_active, tenant_id) VALUES
         ($1, 'pt017-completa@e2e.local', 'Ana Sintética', 'admin', 'ACTIVE', true, $6),
         ($2, 'pt017-so-projeto@e2e.local', 'Leitora Sintética', 'admin', 'ACTIVE', true, $6),
         ($3, 'pt017-sem-clinica@e2e.local', 'Sem Clínica', 'admin', 'ACTIVE', true, $6),
         ($4, 'pt017-operacional@e2e.local', 'Operacional', 'admin', 'ACTIVE', true, $6),
         ($5, 'pt017-catalogo@e2e.local', 'Catálogo', 'admin', 'ACTIVE', true, $6)`,
      [U.completa, U.soProjeto, U.semClinica, U.operacional, U.catalogo, TENANT_E2E],
    );
    // As células nascem do sync do catálogo no boot real; neste app de família semeia-se o que os grupos usam.
    for (const [resource, action] of CELULAS) {
      await pool.query(
        `INSERT INTO iam.permissions (resource, action, description, category) VALUES ($1, $2, 'e2e 017', 'Pacientes') ON CONFLICT DO NOTHING`,
        [resource, action],
      );
    }
    await pool.query(`INSERT INTO iam.permissions (resource, action, description, category) VALUES ('patient', 'read', 'e2e', 'Pacientes') ON CONFLICT DO NOTHING`);
    await grupoComCelulas(pool, {
      nome: GRUPOS.completa, uid: U.completa,
      celulas: [['patient', 'read'], ['patient_therapeutic_project', 'read'], ['patient_therapeutic_project', 'write'], ['patient_therapeutic_project', 'export'], ['patient_clinical', 'read'], ['patient_clinical', 'write'], ['patient_services', 'read'], ['catalog_therapeutic_objectives', 'read'], ['catalog_therapeutic_activities', 'read']],
    });
    await grupoComCelulas(pool, { nome: GRUPOS.soProjeto, uid: U.soProjeto, celulas: [['patient', 'read'], ['patient_therapeutic_project', 'read']] });
    await grupoComCelulas(pool, { nome: GRUPOS.semClinica, uid: U.semClinica, celulas: [['patient', 'read'], ['patient_therapeutic_project', 'read'], ['patient_therapeutic_project', 'write']] });
    await grupoComCelulas(pool, { nome: GRUPOS.operacional, uid: U.operacional, celulas: [['patient', 'read']] });
    await grupoComCelulas(pool, { nome: GRUPOS.catalogo, uid: U.catalogo, celulas: [['catalog_therapeutic_objectives', 'read'], ['catalog_therapeutic_objectives', 'write']] });

    await pool.query(
      `INSERT INTO patients (id, clickup_task_id, first_name, last_name, country, is_test) VALUES
         ($1, 'e2e-017-a', 'Paciente', 'Sintético', 'AR', true), ($2, 'e2e-017-b', 'Outro', 'Sintético', 'AR', true)`,
      [PATIENT, OUTRO],
    );
    serviceId = (await pool.query<{ id: string }>(
      `INSERT INTO patient_contracted_services (patient_id, service_code, created_by, updated_by) VALUES ($1, 'CAREGIVER', 'e2e', 'e2e') RETURNING id`, [PATIENT],
    )).rows[0].id;
    serviceOutroId = (await pool.query<{ id: string }>(
      `INSERT INTO patient_contracted_services (patient_id, service_code, created_by, updated_by) VALUES ($1, 'CAREGIVER', 'e2e', 'e2e') RETURNING id`, [OUTRO],
    )).rows[0].id;
    objectiveIds = (await pool.query<{ id: string }>(`SELECT id FROM therapeutic_specific_objectives WHERE active ORDER BY sort_order`)).rows.map((r) => r.id);
    activityIds = (await pool.query<{ id: string }>(`SELECT id FROM therapeutic_activities WHERE active ORDER BY sort_order`)).rows.map((r) => r.id);
    await semearCid();

    setEnv('USE_MOCK_AUTH', 'true');
    setEnv('PERMISSION_ENGINE_ENABLED', 'true');
    setEnv('PERMISSION_ENFORCED_ROUTES', 'admin.patients');
    setEnv('PERMISSION_CACHE_TTL_MS', '0');
    setEnv('DATABASE_URL', DATABASE_URL);

    const caseModule = await import('@modules/case');
    app = await montarAppDeFamilia({
      enforcedRoutes: 'admin.patients',
      montarRotas: ({ app: express, auth, permissions }) =>
        express.use('/api/admin', caseModule.createAdminTherapeuticProjectsRoutes(new caseModule.AdminTherapeuticProjectsController(), auth, permissions)),
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
  const created: Record<string, string> = {};

  it('1. new → V.1.0 com autor por NOME (nunca uid), snapshot dos catálogos com texto', async () => {
    const r = await chamar('POST', BASE(), U.completa, { mode: 'new', version: versionBody() });
    expect(r.status).toBe(201);
    expect(r.body.data).toMatchObject({ major: 1, minor: 0, version: 'V.1.0', createdByName: 'Ana Sintética', editedFromVersionId: null, modality: 'IN_PERSON', contractedServiceCode: 'CAREGIVER' });
    // D301.3a: a modalidade fica na linha (417) — e o trigger de imutabilidade a protege como as demais.
    expect((await pool.query(`SELECT modality FROM patient_therapeutic_projects WHERE id = $1`, [r.body.data.id])).rows[0].modality).toBe('IN_PERSON');
    expect(r.body.data).not.toHaveProperty('createdBy');
    expect(r.body.data.specificObjectives).toHaveLength(2);
    expect(r.body.data.specificObjectives[0]).toEqual({ id: objectiveIds[0], label: expect.any(String), segmentId: null, segmentLabel: null });
    expect(r.body.data.clinicalContext).toContain('Síntesis sintética');
    // Tipo de patologia DERIVADO: o capítulo CID-11 do diagnóstico, congelado na linha (nada veio do cliente).
    expect(r.body.data.pathologyTypes).toEqual([{ id: CAP06.code, label: CAP06.title }]);
    expect((await pool.query(`SELECT pathology_types FROM patient_therapeutic_projects WHERE id = $1`, [r.body.data.id])).rows[0].pathology_types).toEqual([{ id: CAP06.code, label: CAP06.title }]);
    created['1.0'] = r.body.data.id;
  });

  it('2. edit(1.0) → V.1.1; edit(1.1) outra vez → V.1.2 (SUP-4: nunca colide); depois de "new" a 1.x fica trancada (409 ptp_not_current — ADR-4/SUP-24, cd7d4037/a085b93b)', async () => {
    // D328/SUP-24: modality é MICRO — trocar presencial↔online é o que `mode:'edit'` aceita mudar
    // (generalObjective é MACRO e daria 422 ptp_macro_locked, ver TherapeuticProject.ts THERAPEUTIC_FIELD_CLASS).
    const v11 = await chamar('POST', BASE(), U.completa, { mode: 'edit', fromVersionId: created['1.0'], version: versionBody({ modality: 'ONLINE' }) });
    expect(v11.status).toBe(201);
    expect(v11.body.data).toMatchObject({ version: 'V.1.1', editedFromVersionId: created['1.0'], modality: 'ONLINE' });
    created['1.1'] = v11.body.data.id;
    // Editar de novo tem de partir da VIGENTE (agora 1.1) — 1.0 não é mais a vigente.
    const v12 = await chamar('POST', BASE(), U.completa, { mode: 'edit', fromVersionId: created['1.1'], version: versionBody({ modality: 'HYBRID' }) });
    expect(v12.status).toBe(201);
    expect(v12.body.data).toMatchObject({ version: 'V.1.2', editedFromVersionId: created['1.1'], modality: 'HYBRID' });
    created['1.2'] = v12.body.data.id;
    // A 1.0 continua intacta no banco — Editar não altera a origem.
    const row = await pool.query(`SELECT general_objective, modality FROM patient_therapeutic_projects WHERE id = $1`, [created['1.0']]);
    expect(row.rows[0].general_objective).toBe('Objetivo general sintético e2e.');
    expect(row.rows[0].modality).toBe('IN_PERSON');
    // ADR-4/SUP-24 (cd7d4037): só a VIGENTE (created_at mais recente entre as não-anuladas, GLOBAL —
    // não por major) pode ser editada. 1.0 já não é vigente (1.1/1.2 vieram depois) → 409, nunca 422.
    const stale = await chamar('POST', BASE(), U.completa, { mode: 'edit', fromVersionId: created['1.0'], version: versionBody() });
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({ code: 'ptp_not_current' });
    // "new" nasce sempre — SUP-25 REJEITADA (D328): não há versão automática, mas o operador
    // pode criar uma major nova a qualquer momento; a partir daí a 1.x também fica trancada.
    const v20 = await chamar('POST', BASE(), U.completa, { mode: 'new', version: versionBody() });
    expect(v20.status).toBe(201);
    expect(v20.body.data).toMatchObject({ version: 'V.2.0' });
    created['2.0'] = v20.body.data.id;
  });

  it('3. lista por data de criação DESC (a mais recente primeiro), 4 versões', async () => {
    const r = await chamar('GET', BASE(), U.completa);
    expect(r.status).toBe(200);
    expect(r.body.data.versions.map((v: { version: string }) => v.version)).toEqual(['V.2.0', 'V.1.2', 'V.1.1', 'V.1.0']);
  });

  it('4. 🔒 C7: só `patient_therapeutic_project:read` → versões sim; texto clínico e CID NÃO (marcador constante)', async () => {
    const r = await chamar('GET', BASE(), U.soProjeto);
    expect(r.status).toBe(200);
    for (const v of r.body.data.versions) {
      // lex A1: sem `patient_services:read` o TIPO do serviço congelado também não sai — marcador constante.
      expect(v).toMatchObject({ clinicalContext: null, generalObjective: null, diagnoses: null, pathologyTypes: null, contractedServiceCode: null, redacted: { clinical: true, services: true } });
      expect(JSON.stringify(v)).not.toContain('CAREGIVER');
      // o capítulo 06 sozinho revela saúde mental (OP-18): não sai sem a célula clínica
      expect(JSON.stringify(v)).not.toContain('Trastornos');
      expect(v.specificObjectives.length).toBeGreaterThan(0);
      expect(v.version).toMatch(/^V\.\d+\.\d+$/);
      expect(v).not.toHaveProperty('createdBy');
    }
    const one = await chamar('GET', `${BASE()}/${created['1.0']}`, U.soProjeto);
    expect(one.body.data).toMatchObject({ redacted: { clinical: true, services: true }, clinicalContext: null, contractedServiceCode: null });
    // O grupo semClinica não tem clínica NEM serviços: os dois marcadores (o caso "só serviços" está no unit).
    const semClinica = await chamar('GET', `${BASE()}/${created['1.0']}`, U.semClinica);
    expect(semClinica.body.data.redacted).toEqual({ clinical: true, services: true });
    // A trilha diz o que serviu (C4) — lida DEPOIS de uma leitura própria, com polling (a trilha é assíncrona).
    await chamar('GET', BASE(), U.completa);
    let ultima = '';
    for (let i = 0; i < 20 && !/services$/.test(ultima); i++) {
      const trilha = await pool.query(`SELECT action FROM resource_access_log WHERE operator_uid = $1 AND resource_id = $2 ORDER BY occurred_at DESC LIMIT 1`, [U.completa, PATIENT]);
      ultima = trilha.rows[0]?.action ?? '';
      if (!/services$/.test(ultima)) await new Promise((r) => setTimeout(r, 100));
    }
    expect(ultima).toBe('read_project:therapeuticProject+clinical+services');
  });

  it('5. 🔒 escrita: sem patient_clinical:write → 403 nomeando a célula; sem a célula do projeto → missing_cell; operacional → 403', async () => {
    const semClinica = await chamar('POST', BASE(), U.semClinica, { mode: 'new', version: versionBody() });
    expect(semClinica.status).toBe(403);
    expect(semClinica.body).toEqual({ success: false, error: 'Forbidden', details: { cell: 'patient_clinical:write' } });
    const soLeitura = await chamar('POST', BASE(), U.soProjeto, { mode: 'new', version: versionBody() });
    expect(soLeitura.status).toBe(403);
    expect(soLeitura.body).toMatchObject({ code: 'missing_cell' });
    const operacional = await chamar('GET', BASE(), U.operacional);
    expect(operacional.status).toBe(403);
    const total = await pool.query(`SELECT count(*)::int AS n FROM patient_therapeutic_projects WHERE patient_id = $1`, [PATIENT]);
    expect(total.rows[0].n).toBe(4);
  });

  it('6. serviço de OUTRO paciente → 422 e nada gravado; corpo com major → 400 (só nomes de campo)', async () => {
    const r = await chamar('POST', BASE(), U.completa, { mode: 'new', version: versionBody({ contractedServiceId: serviceOutroId }) });
    expect(r.status).toBe(422);
    expect(r.body).toMatchObject({ code: 'service_not_of_patient' });
    const bad = await chamar('POST', BASE(), U.completa, { mode: 'new', version: versionBody({ major: 9 }) });
    expect(bad.status).toBe(400);
    expect(JSON.stringify(bad.body)).not.toContain('Síntesis sintética');
    // D301.3a: modalidade obrigatória e fechada — sem ela ou fora do enum, 400.
    const { modality: _m, ...semModalidade } = versionBody();
    expect((await chamar('POST', BASE(), U.completa, { mode: 'new', version: semModalidade })).status).toBe(400);
    expect((await chamar('POST', BASE(), U.completa, { mode: 'new', version: versionBody({ modality: 'presencial' }) })).status).toBe(400);
    const total = await pool.query(`SELECT count(*)::int AS n FROM patient_therapeutic_projects WHERE patient_id = $1`, [PATIENT]);
    expect(total.rows[0].n).toBe(4);
  });

  it('7. anular a 1.1 passa uma vez; anulada não é origem de edição; anular de novo → 404', async () => {
    const a = await chamar('POST', `${BASE()}/${created['1.1']}/annul`, U.completa, { reason: 'erro de digitação' });
    expect(a.status).toBe(200);
    expect(a.body.data).toMatchObject({ version: 'V.1.1', annulReason: 'erro de digitação' });
    expect(a.body.data.annulledAt).toBeTruthy();
    // Quem anulou sai como NOME resolvido; o uid nunca (mesma régua do autor — gate 08/09).
    expect(a.body.data.annulledByName).toBe('Ana Sintética');
    expect(a.body.data).not.toHaveProperty('annulledBy');
    const again = await chamar('POST', `${BASE()}/${created['1.1']}/annul`, U.completa, { reason: 'de novo' });
    expect(again.status).toBe(404);
    const fromAnnulled = await chamar('POST', BASE(), U.completa, { mode: 'edit', fromVersionId: created['1.1'], version: versionBody() });
    expect(fromAnnulled.status).toBe(404);
    expect(fromAnnulled.body).toMatchObject({ code: 'source_version_not_found' });
    const pii = await chamar('POST', `${BASE()}/${created['2.0']}/annul`, U.completa, { reason: 'pedido por juan@example.com' });
    expect(pii.status).toBe(400);
  });

  it('8. catálogo: criar, renomear, desativar; duplicado 409; dado pessoal 400; id desativado no snapshot → 422', async () => {
    const path = '/api/admin/therapeutic-catalogs/specific-objectives';
    const novo = await chamar('POST', path, U.catalogo, { label: 'E2E 017 objetivo novo' });
    expect(novo.status).toBe(201);
    expect(novo.body.data).toMatchObject({ label: 'E2E 017 objetivo novo', active: true });
    const dup = await chamar('POST', path, U.catalogo, { label: '  e2e 017 OBJETIVO novo ' });
    expect(dup.status).toBe(409);
    const pii = await chamar('POST', path, U.catalogo, { label: 'E2E 017 llamar al 11 4463 5919' });
    expect(pii.status).toBe(400);
    const renomeado = await chamar('PATCH', `${path}/${novo.body.data.id}`, U.catalogo, { label: 'E2E 017 objetivo renomeado' });
    expect(renomeado.body.data.label).toBe('E2E 017 objetivo renomeado');
    const off = await chamar('PATCH', `${path}/${novo.body.data.id}`, U.catalogo, { active: false });
    expect(off.body.data).toMatchObject({ active: false });
    expect(off.body.data.deactivatedAt).toBeTruthy();
    // Sem includeInactive a lista não o mostra; com, mostra.
    const lista = await chamar('GET', path, U.catalogo);
    expect(lista.body.data.items.some((i: { id: string }) => i.id === novo.body.data.id)).toBe(false);
    const listaToda = await chamar('GET', `${path}?includeInactive=true`, U.catalogo);
    expect(listaToda.body.data.items.some((i: { id: string }) => i.id === novo.body.data.id)).toBe(true);
    // Snapshot com id desativado → 422 e nada gravado (lex C19).
    const r = await chamar('POST', BASE(), U.completa, { mode: 'new', version: versionBody({ specificObjectiveIds: [novo.body.data.id] }) });
    expect(r.status).toBe(422);
    expect(r.body).toMatchObject({ code: 'catalog_items_unknown', details: { kind: 'specific-objectives', ids: [novo.body.data.id] } });
    // A leitura do catálogo de atividades exige a SUA célula: o grupo do catálogo só tem objetivos.
    const outroCatalogo = await chamar('GET', '/api/admin/therapeutic-catalogs/activities', U.catalogo);
    expect(outroCatalogo.status).toBe(403);
  });

  it('8b. tipo de patologia vem do CID-11: 2 diagnósticos de capítulos distintos → 2 capítulos ordenados; `pathologyTypeIds` → 400; CID sumido → 422 e nada gravado; rota do catálogo → 404', async () => {
    const antes = (await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM patient_therapeutic_projects WHERE patient_id = $1`, [PATIENT])).rows[0].n;
    const dois = await chamar('POST', BASE(), U.completa, { mode: 'new', version: versionBody({ diagnoses: [
      { uri: URI_EPI, title: 'Epilepsia e2e' }, { uri: URI_TEA, title: 'TEA e2e' }, { uri: URI_TEA, title: 'TEA e2e repetido' },
    ] }) });
    expect(dois.status).toBe(201);
    expect(dois.body.data.pathologyTypes).toEqual([{ id: CAP06.code, label: CAP06.title }, { id: CAP08.code, label: CAP08.title }]);
    // O campo antigo é recusado pela borda `.strict()` — o cliente não escolhe o segmento.
    const antigo = await chamar('POST', BASE(), U.completa, { mode: 'new', version: { ...versionBody(), pathologyTypeIds: ['11111111-1111-4111-8111-111111111111'] } });
    expect(antigo.status).toBe(400);
    expect(JSON.stringify(antigo.body)).not.toContain('Síntesis');
    // CID que não resolve no release corrente → 422 tipado, sem a URI no corpo nem linha gravada.
    const sumido = await chamar('POST', BASE(), U.completa, { mode: 'new', version: versionBody({ diagnoses: [{ uri: URI_SUMIDA, title: 'Sumido' }] }) });
    expect(sumido.status).toBe(422);
    expect(sumido.body).toMatchObject({ code: 'ptp_diagnosis_unknown' });
    expect(JSON.stringify(sumido.body)).not.toContain(URI_SUMIDA);
    const depois = (await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM patient_therapeutic_projects WHERE patient_id = $1`, [PATIENT])).rows[0].n;
    expect(depois).toBe(antes + 1);
    // Não existe catálogo de tipo de patologia — a rota sumiu (a célula, o sync do catálogo marca no boot; prova na stage).
    const rota = await chamar('GET', '/api/admin/therapeutic-catalogs/pathology-types', U.completa);
    expect(rota.status).toBe(404);
    // A tabela da 415 ficou DEPRECADA (418): as 8 opções seedadas continuam (versões antigas apontam), TODAS inativas.
    const tabela = await pool.query<{ total: number; ativas: number }>(`SELECT count(*)::int AS total, count(*) FILTER (WHERE active)::int AS ativas FROM pathology_types`);
    expect(tabela.rows[0].total).toBeGreaterThan(0);
    expect(tabela.rows[0].ativas).toBe(0);
  });

  it('9. 🔒 trilha: read_project com os containers servidos; ?purpose=export → export_pdf; só UUID na linha', async () => {
    await chamar('GET', `${BASE()}/${created['1.0']}`, U.soProjeto);
    await chamar('GET', `${BASE()}/${created['1.0']}?purpose=export`, U.completa);
    const limite = Date.now() + 10_000;
    let rows: Array<{ operator_uid: string; action: string; resource_id: string }> = [];
    while (Date.now() < limite) {
      rows = (await pool.query(
        `SELECT operator_uid, action, resource_id FROM resource_access_log WHERE operator_uid = ANY($1) ORDER BY occurred_at`,
        [[U.soProjeto, U.completa]],
      )).rows;
      if (rows.some((r) => r.action.startsWith('export_pdf')) && rows.some((r) => r.operator_uid === U.soProjeto)) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(rows.some((r) => r.operator_uid === U.soProjeto && r.action === 'read_project:therapeuticProject' && r.resource_id === PATIENT)).toBe(true);
    expect(rows.some((r) => r.operator_uid === U.completa && r.action === 'export_pdf:therapeuticProject+clinical+services')).toBe(true);
    expect(JSON.stringify(rows)).not.toContain('Síntesis');
  });
});
