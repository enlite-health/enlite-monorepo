/**
 * Spec 017 — a API do Projeto Terapêutico com o ENGINE DE PERMISSÃO LIGADO (família admin.patients),
 * HTTP real, banco real. Sem mock de dado.
 *
 * O que se prova (D299; lex C5, C7, C9, C13, C18, C19):
 *   1. numeração: new→1.0, new→2.0, edit(1.0)→1.1, edit(1.0) de novo→1.2 (nunca colide);
 *   2. projeção C7: ator SÓ com `patient_therapeutic_project:read` recebe versões/datas/autor/
 *      catálogos, e NÃO recebe texto clínico nem CID (`redacted.clinical` constante);
 *   3. escrita cumulativa: sem `patient_clinical:create` (mode new; `:update` no edit) → 403 nomeando a célula; sem a célula do
 *      projeto → 403 `missing_cell` do middleware; sem nada → 403;
 *   4. anular passa uma vez; anulada não é origem de edição; UPDATE de conteúdo nunca existe;
 *   5. catálogo: criar/renomear/desativar (objetivo por SERVIÇO, 091); rótulo duplicado 409; rótulo com dado pessoal 400;
 *      objetivo desativado no bloco → 422 `ptp_plan_objective_invalid` e NADA gravado;
 *   5b. tipo de patologia DERIVADO do CID-11 (Gabriel 08/09; D163/D164): capítulo por diagnóstico,
 *      distinto e ordenado; `pathologyTypeIds` no corpo → 400; CID que não resolve → 422 e nada
 *      gravado; a rota do catálogo `pathology-types` NÃO existe (404); sem clínica sai `null`;
 *   6. trilha: `read_project:therapeuticProject+clinical` e `export_pdf:…` com `?purpose=export`,
 *      só UUID na linha;
 *   7. o uid do autor NUNCA sai — só `createdByName`; idem quem anulou (`annulledByName`);
 *   8. spec 091 (CA-7/CA-8/CA-9): versão por diagnóstico (`diagnosisPlans`), MACRO imutável, versão no formato antigo
 *      legível e editável. O catálogo e o CID-11 vêm de `helpers/ptiCatalogoCidSeed.ts` (linhas sintéticas do teste).
 */
import { Pool } from 'pg';
import { montarAppDeFamilia, tokenMock, grupoComCelulas, limparIamFixtures, garantirCelula, TENANT_E2E, type AppDeFamilia } from './helpers/permissionFamilyHarness';
import { semearCatalogoCid, semearVersaoPlana, limparCatalogoPorPrefixo, bloco, planoTea, SERVICO_CID, CAP06, CAP08, type CatalogoCid, type VersaoPlanaSemeada } from './helpers/ptiCatalogoCidSeed';

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

describe('spec 017 — projeto terapêutico: API sob engine de permissão (HTTP real, banco real)', () => {
  let pool: Pool;
  let app: AppDeFamilia;
  const PATIENT = 'ee417000-0a00-0001-0001-000000000001';
  const OUTRO = 'ee417000-0a00-0001-0002-000000000001';
  const ANTIGO = 'ee417000-0a00-0001-0003-000000000001';
  const PREFIXO = 'E2E 017 ';
  let serviceId: string;
  let serviceOutroId: string;
  let cat: CatalogoCid;

  const U = {
    completa: 'pt017-completa',
    soProjeto: 'pt017-so-projeto',
    semClinica: 'pt017-sem-clinica',
    operacional: 'pt017-operacional',
    catalogo: 'pt017-catalogo',
    dividida: 'pt017-dividida',
  };
  const GRUPOS = {
    completa: 'PT017 Completa',
    soProjeto: 'PT017 Só projeto',
    semClinica: 'PT017 Sem clínica',
    operacional: 'PT017 Operacional',
    catalogo: 'PT017 Catálogo',
    dividida: 'PT017 Clínica dividida',
  };
  // PR-8b (rodada A3, ADR-2/SUP-30): as rotas de `patient_therapeutic_project` e
  // `catalog_therapeutic_objectives` não declaram mais `write` — viraram `create`/`update`
  // (fixture `tests/fixtures/pr8b-rotas-create-update.ts`). A checagem clínica é literal no controller
  // (`missingTherapeuticClinicalWriteCell`, `src/modules/case/application/therapeuticProjectAccess.ts`):
  // `new` exige `patient_clinical:create`, `edit` exige `patient_clinical:update`, e o `write` legado
  // (Acesso Master) segue aceito. `patient_clinical` é SPLIT — o painel de grupos grava create+update, nunca `write`.
  const CELULAS: ReadonlyArray<readonly [string, string]> = [
    ['patient_therapeutic_project', 'read'],
    ['patient_therapeutic_project', 'create'],
    ['patient_therapeutic_project', 'update'],
    // PR-7 (92f766a3, lex C8(b)): `?purpose=export` passa a exigir esta célula ALÉM da leitura.
    ['patient_therapeutic_project', 'export'],
    ['patient_clinical', 'read'],
    ['patient_clinical', 'write'],
    ['patient_clinical', 'create'],
    ['patient_clinical', 'update'],
    ['patient_services', 'read'],
    ['catalog_therapeutic_objectives', 'read'],
    ['catalog_therapeutic_objectives', 'create'],
    ['catalog_therapeutic_objectives', 'update'],
    ['catalog_therapeutic_activities', 'read'],
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

  /** Corpo da versão POR DIAGNÓSTICO (091): o mesmo do `new` e do `edit` de origem por diagnóstico. */
  const versionBody = (over: Record<string, unknown> = {}) => ({
    contractedServiceId: serviceId,
    modality: 'IN_PERSON',
    diagnoses: [{ uri: cat.uris.tea, code: '6A02', title: 'Diagnóstico sintético e2e' }],
    clinicalContext: 'Síntesis sintética e2e — texto de teste sem dado de titular.',
    generalObjective: 'Objetivo general sintético e2e.',
    diagnosisPlans: planoTea(cat),
    startDate: '2026-09-01',
    endDate: '2026-12-31',
    contactStatus: {},
    ...over,
  });
  const newVersionBody = versionBody;

  // PR-8b (A3, achado da rodada A2): as células de CELULAS são do CATÁLOGO compartilhado —
  // `create`/`update` nascem seedadas de forma permanente pela migration 435 para os 23 recursos
  // splitados, e as demais (`read`/`export`, `patient_clinical:*`) já existiam antes deste teste
  // rodar pela primeira vez. Apagar `iam.permissions` no cleanup derrubava QUALQUER outra suíte
  // que dependesse da mesma célula (o achado nomeado desta rodada). `limparIamFixtures` já apaga
  // só o que este arquivo É DONO: os grupos/usuários/`group_permissions` dele — nunca o catálogo.
  async function limpar(): Promise<void> {
    await pool.query(`DELETE FROM resource_access_log WHERE operator_uid = ANY($1)`, [Object.values(U)]);
    await limparIamFixtures(pool, { uids: Object.values(U), grupos: Object.values(GRUPOS) });
    await pool.query(`DELETE FROM patients WHERE id = ANY($1)`, [[PATIENT, OUTRO, ANTIGO]]);
    await limparCatalogoPorPrefixo(pool, PREFIXO);
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
         ($5, 'pt017-catalogo@e2e.local', 'Catálogo', 'admin', 'ACTIVE', true, $6),
         ($7, 'pt017-dividida@e2e.local', 'Clínica dividida', 'admin', 'ACTIVE', true, $6)`,
      [U.completa, U.soProjeto, U.semClinica, U.operacional, U.catalogo, TENANT_E2E, U.dividida],
    );
    // Garante que as células existem no catálogo (a maioria já nasce da migration 435 ou de boot
    // anterior; `garantirCelula` é idempotente — helper compartilhado, nunca duplica o INSERT).
    for (const [resource, action] of CELULAS) {
      await garantirCelula(pool, { resource, action, category: 'Pacientes' });
    }
    await garantirCelula(pool, { resource: 'patient', action: 'read', category: 'Pacientes' });
    await grupoComCelulas(pool, {
      nome: GRUPOS.completa, uid: U.completa,
      celulas: [['patient', 'read'], ['patient_therapeutic_project', 'read'], ['patient_therapeutic_project', 'create'], ['patient_therapeutic_project', 'update'], ['patient_therapeutic_project', 'export'], ['patient_clinical', 'read'], ['patient_clinical', 'write'], ['patient_services', 'read'], ['catalog_therapeutic_objectives', 'read'], ['catalog_therapeutic_activities', 'read']],
    });
    await grupoComCelulas(pool, { nome: GRUPOS.soProjeto, uid: U.soProjeto, celulas: [['patient', 'read'], ['patient_therapeutic_project', 'read']] });
    await grupoComCelulas(pool, { nome: GRUPOS.semClinica, uid: U.semClinica, celulas: [['patient', 'read'], ['patient_therapeutic_project', 'read'], ['patient_therapeutic_project', 'create'], ['patient_therapeutic_project', 'update']] });
    // O que o painel de grupos de fato grava (`expandWriteCells`): clínico create+update, NUNCA write.
    await grupoComCelulas(pool, {
      nome: GRUPOS.dividida, uid: U.dividida,
      celulas: [['patient', 'read'], ['patient_therapeutic_project', 'read'], ['patient_therapeutic_project', 'create'], ['patient_therapeutic_project', 'update'], ['patient_clinical', 'create'], ['patient_clinical', 'update']],
    });
    await grupoComCelulas(pool, { nome: GRUPOS.operacional, uid: U.operacional, celulas: [['patient', 'read']] });
    await grupoComCelulas(pool, { nome: GRUPOS.catalogo, uid: U.catalogo, celulas: [['catalog_therapeutic_objectives', 'read'], ['catalog_therapeutic_objectives', 'create'], ['catalog_therapeutic_objectives', 'update']] });

    await pool.query(
      `INSERT INTO patients (id, clickup_task_id, first_name, last_name, country, is_test) VALUES
         ($1, 'e2e-017-a', 'Paciente', 'Sintético', 'AR', true), ($2, 'e2e-017-b', 'Outro', 'Sintético', 'AR', true)`,
      [PATIENT, OUTRO],
    );
    serviceId = (await pool.query<{ id: string }>(
      `INSERT INTO patient_contracted_services (patient_id, service_code, created_by, updated_by) VALUES ($1, '${SERVICO_CID}', 'e2e', 'e2e') RETURNING id`, [PATIENT],
    )).rows[0].id;
    serviceOutroId = (await pool.query<{ id: string }>(
      `INSERT INTO patient_contracted_services (patient_id, service_code, created_by, updated_by) VALUES ($1, '${SERVICO_CID}', 'e2e', 'e2e') RETURNING id`, [OUTRO],
    )).rows[0].id;
    cat = await semearCatalogoCid(pool, { tag: 'PT017', sufixo: '17', prefixo: `${PREFIXO}cid ` });

    setEnv('USE_MOCK_AUTH', 'true');
    setEnv('PERMISSION_ENGINE_ENABLED', 'true');
    setEnv('PERMISSION_ENFORCED_ROUTES', 'admin.patients');
    setEnv('PERMISSION_CACHE_TTL_MS', '0');
    setEnv('DATABASE_URL', DATABASE_URL);

    const caseModule = await import('@modules/case');
    app = await montarAppDeFamilia({
      enforcedRoutes: 'admin.patients',
      montarRotas: ({ app: express, auth, permissions }) =>
        express.use('/api/admin', caseModule.createAdminTherapeuticProjectsRoutes(caseModule.buildAdminTherapeuticProjectsController(), auth, permissions)),
    });
  }, 30000);

  afterAll(async () => {
    await app?.fechar();
    const { DatabaseConnection } = await import('@shared/database/DatabaseConnection');
    await DatabaseConnection.getInstance().close();
    await limpar();
    await cat?.limpar();
    await cat?.restaurar();
    await pool.end();
    for (const [k, v] of Object.entries(envAnterior)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  });

  const BASE = () => `/api/admin/patients/${PATIENT}/therapeutic-projects`;
  const created: Record<string, string> = {};

  it('1. new → V.1.0 com autor por NOME (nunca uid), blocos por diagnóstico com o texto do catálogo', async () => {
    const r = await chamar('POST', BASE(), U.completa, { mode: 'new', version: newVersionBody() });
    expect(r.status).toBe(201);
    expect(r.body.data).toMatchObject({ major: 1, minor: 0, version: 'V.1.0', createdByName: 'Ana Sintética', editedFromVersionId: null, modality: 'IN_PERSON', contractedServiceCode: SERVICO_CID });
    // D301.3a: a modalidade fica na linha (417) — e o trigger de imutabilidade a protege como as demais.
    expect((await pool.query(`SELECT modality FROM patient_therapeutic_projects WHERE id = $1`, [r.body.data.id])).rows[0].modality).toBe('IN_PERSON');
    expect(r.body.data).not.toHaveProperty('createdBy');
    // 091 (DD-8): a lista plana é DERIVADA dos blocos; `segmentId` não existe mais no item.
    expect(r.body.data.objectivesLayout).toBe('byDiagnosis');
    expect(r.body.data.specificObjectives).toEqual([{ id: cat.objetivos.a, label: cat.rotulos.objetivoA }]);
    expect(r.body.data.activities).toEqual([{ id: cat.atividades.a, label: cat.rotulos.atividadeA, suggestedFrequency: 'semanal' }]);
    expect(r.body.data.diagnosisPlans).toEqual([{
      diagnosisUri: cat.uris.tea, categoryCode: cat.categorias.tea,
      objectives: [{ id: cat.objetivos.a, label: cat.rotulos.objetivoA, description: null }],
      activities: [{ id: cat.atividades.a, label: cat.rotulos.atividadeA, description: null, suggestedFrequency: 'semanal' }],
    }]);
    expect((await pool.query(`SELECT specific_objectives, activities, segment FROM patient_therapeutic_projects WHERE id = $1`, [r.body.data.id])).rows[0]).toEqual({ specific_objectives: [], activities: [], segment: null });
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
    const v20 = await chamar('POST', BASE(), U.completa, { mode: 'new', version: newVersionBody() });
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
      expect(JSON.stringify(v)).not.toContain(`"${SERVICO_CID}"`);
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

  it('5. 🔒 escrita: sem patient_clinical:create → 403 nomeando a célula; sem a célula do projeto → missing_cell; operacional → 403', async () => {
    const semClinica = await chamar('POST', BASE(), U.semClinica, { mode: 'new', version: newVersionBody() });
    expect(semClinica.status).toBe(403);
    expect(semClinica.body).toEqual({ success: false, error: 'Forbidden', details: { cell: 'patient_clinical:create' } });
    const soLeitura = await chamar('POST', BASE(), U.soProjeto, { mode: 'new', version: newVersionBody() });
    expect(soLeitura.status).toBe(403);
    expect(soLeitura.body).toMatchObject({ code: 'missing_cell' });
    const operacional = await chamar('GET', BASE(), U.operacional);
    expect(operacional.status).toBe(403);
    const total = await pool.query(`SELECT count(*)::int AS n FROM patient_therapeutic_projects WHERE patient_id = $1`, [PATIENT]);
    expect(total.rows[0].n).toBe(4);
  });

  it('6. serviço de OUTRO paciente → 422 e nada gravado; corpo com major → 400 (só nomes de campo)', async () => {
    const r = await chamar('POST', BASE(), U.completa, { mode: 'new', version: newVersionBody({ contractedServiceId: serviceOutroId }) });
    expect(r.status).toBe(422);
    expect(r.body).toMatchObject({ code: 'service_not_of_patient' });
    const bad = await chamar('POST', BASE(), U.completa, { mode: 'new', version: newVersionBody({ major: 9 }) });
    expect(bad.status).toBe(400);
    expect(JSON.stringify(bad.body)).not.toContain('Síntesis sintética');
    // D301.3a: modalidade obrigatória e fechada — sem ela ou fora do enum, 400.
    const { modality: _m, ...semModalidade } = newVersionBody();
    expect((await chamar('POST', BASE(), U.completa, { mode: 'new', version: semModalidade })).status).toBe(400);
    expect((await chamar('POST', BASE(), U.completa, { mode: 'new', version: newVersionBody({ modality: 'presencial' }) })).status).toBe(400);
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

  it('8. catálogo: criar (com serviço), renomear, desativar; duplicado 409; dado pessoal 400; objetivo desativado no bloco → 422 e nada gravado', async () => {
    const path = '/api/admin/therapeutic-catalogs/specific-objectives';
    const novo = await chamar('POST', path, U.catalogo, { label: 'E2E 017 objetivo novo', serviceCode: SERVICO_CID });
    expect(novo.status).toBe(201);
    expect(novo.body.data).toMatchObject({ label: 'E2E 017 objetivo novo', active: true, serviceCode: SERVICO_CID });
    const dup = await chamar('POST', path, U.catalogo, { label: '  e2e 017 OBJETIVO novo ', serviceCode: SERVICO_CID });
    expect(dup.status).toBe(409);
    const pii = await chamar('POST', path, U.catalogo, { label: 'E2E 017 llamar al 11 4463 5919', serviceCode: SERVICO_CID });
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
    // Objetivo desativado marcado num bloco → 422 nomeado, só índice e ids, e nada gravado (lex C19).
    const antes = (await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM patient_therapeutic_projects WHERE patient_id = $1`, [PATIENT])).rows[0].n;
    const r = await chamar('POST', BASE(), U.completa, { mode: 'new', version: newVersionBody({ diagnosisPlans: [bloco(cat.uris.tea, [cat.objetivos.inativo], [cat.atividades.a])] }) });
    expect(r.status).toBe(422);
    expect(r.body).toMatchObject({ code: 'ptp_plan_objective_invalid', details: { diagnosisIndex: 0, ids: [cat.objetivos.inativo] } });
    expect((await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM patient_therapeutic_projects WHERE patient_id = $1`, [PATIENT])).rows[0].n).toBe(antes);
    // A leitura do catálogo de atividades exige a SUA célula: o grupo do catálogo só tem objetivos.
    const outroCatalogo = await chamar('GET', '/api/admin/therapeutic-catalogs/activities', U.catalogo);
    expect(outroCatalogo.status).toBe(403);
  });

  it('8b. tipo de patologia vem do CID-11: 2 diagnósticos de capítulos distintos → 2 capítulos ordenados; `pathologyTypeIds` → 400; CID sumido → 422 e nada gravado; rota do catálogo → 404', async () => {
    const antes = (await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM patient_therapeutic_projects WHERE patient_id = $1`, [PATIENT])).rows[0].n;
    const dois = await chamar('POST', BASE(), U.completa, { mode: 'new', version: newVersionBody({ diagnoses: [
      { uri: cat.uris.epi, title: 'Epilepsia e2e' }, { uri: cat.uris.tea, title: 'TEA e2e' },
    ], diagnosisPlans: [bloco(cat.uris.epi, [cat.objetivos.epi], [cat.atividades.epi]), ...planoTea(cat)] }) });
    expect(dois.status).toBe(201);
    expect(dois.body.data.pathologyTypes).toEqual([{ id: CAP06.code, label: CAP06.title }, { id: CAP08.code, label: CAP08.title }]);
    // 091: o mesmo diagnóstico duas vezes → 400 (o conjunto de URIs dos blocos = o dos diagnósticos, sem repetição).
    const repetido = await chamar('POST', BASE(), U.completa, { mode: 'new', version: newVersionBody({ diagnoses: [{ uri: cat.uris.tea, title: 'TEA' }, { uri: cat.uris.tea, title: 'TEA repetido' }] }) });
    expect(repetido.status).toBe(400);
    // O campo antigo é recusado pela borda `.strict()` — o cliente não escolhe o segmento.
    const antigo = await chamar('POST', BASE(), U.completa, { mode: 'new', version: { ...newVersionBody(), pathologyTypeIds: ['11111111-1111-4111-8111-111111111111'] } });
    expect(antigo.status).toBe(400);
    expect(JSON.stringify(antigo.body)).not.toContain('Síntesis');
    // CID que não resolve no release corrente → 422 tipado, sem a URI no corpo nem linha gravada.
    const sumido = await chamar('POST', BASE(), U.completa, { mode: 'new', version: newVersionBody({ diagnoses: [{ uri: cat.uris.sumida, title: 'Sumido' }], diagnosisPlans: [bloco(cat.uris.sumida, [], [])] }) });
    expect(sumido.status).toBe(422);
    expect(sumido.body).toMatchObject({ code: 'ptp_diagnosis_unknown' });
    expect(JSON.stringify(sumido.body)).not.toContain(cat.uris.sumida);
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

  describe('091 — versão por diagnóstico (CA-7, CA-8, CA-9)', () => {
    const contar = async (patient = PATIENT): Promise<number> =>
      (await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM patient_therapeutic_projects WHERE patient_id = $1`, [patient])).rows[0].n;
    const novaVigente = async (over: Record<string, unknown> = {}) => {
      const r = await chamar('POST', BASE(), U.completa, { mode: 'new', version: newVersionBody(over) });
      expect(r.status).toBe(201);
      return r.body.data as { id: string; diagnosisPlans: unknown };
    };

    it('091 CA-7 a: new com 2 blocos → 201; diagnosis_plans gravado com N blocos, listas planas `[]`, segment NULL; a lista plana da leitura é DERIVADA', async () => {
      const r = await chamar('POST', BASE(), U.completa, { mode: 'new', version: newVersionBody({
        diagnoses: [{ uri: cat.uris.tea, title: 'TEA e2e' }, { uri: cat.uris.epi, title: 'Epilepsia e2e' }],
        diagnosisPlans: [...planoTea(cat), bloco(cat.uris.epi, [cat.objetivos.epi], [cat.atividades.epi])],
      }) });
      expect(r.status).toBe(201);
      const linha = (await pool.query(`SELECT diagnosis_plans, specific_objectives, activities, segment FROM patient_therapeutic_projects WHERE id = $1`, [r.body.data.id])).rows[0];
      expect(linha.diagnosis_plans).toHaveLength(2);
      expect(linha.diagnosis_plans.map((b: { diagnosisUri: string; categoryCode: string }) => [b.diagnosisUri, b.categoryCode])).toEqual([[cat.uris.tea, cat.categorias.tea], [cat.uris.epi, cat.categorias.epi]]);
      expect([linha.specific_objectives, linha.activities, linha.segment]).toEqual([[], [], null]);
      const lido = await chamar('GET', `${BASE()}/${r.body.data.id}`, U.completa);
      expect(lido.body.data.objectivesLayout).toBe('byDiagnosis');
      expect(lido.body.data.specificObjectives.map((o: { id: string }) => o.id)).toEqual([cat.objetivos.a, cat.objetivos.epi]);
      expect(lido.body.data.activities.map((a: { id: string }) => a.id)).toEqual([cat.atividades.a, cat.atividades.epi]);
    });

    it('091 CA-7 a2: bloco SEM catálogo (categoria sem vínculo) e bloco SEM categoria (capítulo) entram vazios, com `categoryCode` congelado/nulo', async () => {
      const r = await chamar('POST', BASE(), U.completa, { mode: 'new', version: newVersionBody({
        diagnoses: [{ uri: cat.uris.vazio, title: 'Sem catalogo' }, { uri: cat.uris.semCategoria, title: 'Capitulo' }],
        diagnosisPlans: [bloco(cat.uris.vazio, [], []), bloco(cat.uris.semCategoria, [], [])],
      }) });
      expect(r.status).toBe(201);
      expect(r.body.data.diagnosisPlans).toEqual([
        { diagnosisUri: cat.uris.vazio, categoryCode: cat.categorias.vazio, objectives: [], activities: [] },
        { diagnosisUri: cat.uris.semCategoria, categoryCode: null, objectives: [], activities: [] },
      ]);
    });

    it('091 CA-7 b: 422 NOMEADO (índice + ids, nunca a URI) para objetivo de outra categoria/serviço/inativo, atividade de objetivo não marcado, bloco incompleto e bloco sem catálogo com ids; nada gravado', async () => {
      const outroBloco = bloco(cat.uris.epi, [cat.objetivos.epi], [cat.atividades.epi]);
      const dois = (primeiro: ReturnType<typeof bloco>, segundo = outroBloco) => ({
        diagnoses: [{ uri: primeiro.diagnosisUri, title: 'Primeiro' }, { uri: segundo.diagnosisUri, title: 'Segundo' }],
        diagnosisPlans: [primeiro, segundo],
      });
      const casos: Array<[string, Record<string, unknown>, string, Record<string, unknown>]> = [
        ['objetivo de OUTRA categoria', newVersionBody({ diagnosisPlans: [bloco(cat.uris.tea, [cat.objetivos.epi], [cat.atividades.a])] }), 'ptp_plan_objective_invalid', { diagnosisIndex: 0, ids: [cat.objetivos.epi] }],
        ['objetivo de OUTRO serviço', newVersionBody({ diagnosisPlans: [bloco(cat.uris.tea, [cat.objetivos.outroServico], [cat.atividades.a])] }), 'ptp_plan_objective_invalid', { diagnosisIndex: 0, ids: [cat.objetivos.outroServico] }],
        ['objetivo INATIVO, no 2º bloco (índice 1)', newVersionBody(dois(planoTea(cat)[0], bloco(cat.uris.epi, [cat.objetivos.inativo], [cat.atividades.epi]))), 'ptp_plan_objective_invalid', { diagnosisIndex: 1, ids: [cat.objetivos.inativo] }],
        ['atividade de objetivo NÃO marcado', newVersionBody({ diagnosisPlans: [bloco(cat.uris.tea, [cat.objetivos.a], [cat.atividades.b])] }), 'ptp_plan_activity_invalid', { diagnosisIndex: 0, ids: [cat.atividades.b] }],
        ['bloco com catálogo, sem objetivo', newVersionBody({ diagnosisPlans: [bloco(cat.uris.tea, [], [])] }), 'ptp_plan_block_incomplete', { diagnosisIndex: 0 }],
        ['bloco com catálogo, objetivo sem atividade', newVersionBody({ diagnosisPlans: [bloco(cat.uris.tea, [cat.objetivos.a], [])] }), 'ptp_plan_block_incomplete', { diagnosisIndex: 0 }],
        ['bloco SEM catálogo com ids', newVersionBody({ diagnoses: [{ uri: cat.uris.vazio, title: 'Vazio' }], diagnosisPlans: [bloco(cat.uris.vazio, [cat.objetivos.a], [cat.atividades.a])] }), 'ptp_plan_block_without_catalog', { diagnosisIndex: 0 }],
      ];
      const antes = await contar();
      for (const [nome, version, code, details] of casos) {
        const r = await chamar('POST', BASE(), U.completa, { mode: 'new', version });
        expect([nome, r.status, r.body.code, r.body.details]).toEqual([nome, 422, code, details]);
        expect(JSON.stringify(r.body)).not.toContain('test://');
      }
      const comSegmento = await chamar('POST', BASE(), U.completa, { mode: 'new', version: { ...newVersionBody(), segmentId: '11111111-1111-4111-8111-111111111111' } });
      expect(comSegmento.status).toBe(400);
      expect(await contar()).toBe(antes);
    });

    it('091 macro: edit que muda a marcação de um bloco → 422 `ptp_macro_locked` (fields `diagnosisPlans`); reordenar ids e trocar só a modalidade passam', async () => {
      const origem = await novaVigente();
      const antes = await contar();
      const muda = await chamar('POST', BASE(), U.completa, { mode: 'edit', fromVersionId: origem.id, version: versionBody({
        diagnosisPlans: [bloco(cat.uris.tea, [cat.objetivos.a, cat.objetivos.b], [cat.atividades.a, cat.atividades.b])],
      }) });
      expect(muda.status).toBe(422);
      expect(muda.body).toMatchObject({ code: 'ptp_macro_locked', details: { fields: ['diagnosisPlans'] } });
      expect(await contar()).toBe(antes);
      const micro = await chamar('POST', BASE(), U.completa, { mode: 'edit', fromVersionId: origem.id, version: versionBody({ modality: 'ONLINE' }) });
      expect(micro.status).toBe(201);
      expect(micro.body.data.diagnosisPlans).toEqual(origem.diagnosisPlans);
      expect(micro.body.data.editedFromVersionId).toBe(origem.id);
      // formato diferente do da origem (corpo plano sobre origem por diagnóstico) → 422 próprio, sem gravar
      const { diagnosisPlans: _p, ...semBlocos } = versionBody();
      const plano = await chamar('POST', BASE(), U.completa, { mode: 'edit', fromVersionId: micro.body.data.id, version: { ...semBlocos, specificObjectiveIds: [cat.objetivos.a], activityIds: [cat.atividades.a] } });
      expect(plano.status).toBe(422);
      expect(plano.body).toMatchObject({ code: 'ptp_format_mismatch' });
      expect(await contar()).toBe(antes + 1);
    });

    describe('formato-antigo (CA-9): versão plana semeada por SQL', () => {
      let antigo: VersaoPlanaSemeada;
      let servicoAntigo: string;
      // O diagnóstico antigo resolve na terminologia (a edição deriva o capítulo CID-11 dele): usa o stem semeado.
      let DIAG_ANTIGO: Array<{ uri: string; code: string; title: string }>;

      beforeAll(async () => {
        DIAG_ANTIGO = [{ uri: cat.uris.tea, code: '6A02', title: 'Diagnostico antigo sintetico' }];
        await pool.query(`INSERT INTO patients (id, clickup_task_id, first_name, last_name, country, is_test) VALUES ($1, 'e2e-017-c', 'Antigo', 'Sintético', 'AR', true)`, [ANTIGO]);
        servicoAntigo = (await pool.query<{ id: string }>(
          `INSERT INTO patient_contracted_services (patient_id, service_code, created_by, updated_by) VALUES ($1, $2, 'e2e', 'e2e') RETURNING id`, [ANTIGO, SERVICO_CID],
        )).rows[0].id;
        antigo = await semearVersaoPlana(pool, { patientId: ANTIGO, serviceId: servicoAntigo, diagnoses: DIAG_ANTIGO, prefixo: PREFIXO, autor: U.completa });
      });

      const corpoPlano = (over: Record<string, unknown> = {}) => {
        const { diagnosisPlans: _p, ...base } = versionBody({
          contractedServiceId: servicoAntigo, diagnoses: DIAG_ANTIGO,
          clinicalContext: 'Sintese sintetica e2e antiga.',
        });
        return { ...base, specificObjectiveIds: [antigo.objetivo.id], activityIds: [antigo.atividade.id], ...over };
      };
      const BASE_ANTIGO = () => `/api/admin/patients/${ANTIGO}/therapeutic-projects`;

      it('formato-antigo a: GET devolve `objectivesLayout:\'flat\'`, as listas gravadas e o `segment`; sem a célula clínica o segmento some e a lista fica', async () => {
        const r = await chamar('GET', `${BASE_ANTIGO()}/${antigo.versionId}`, U.completa);
        expect(r.status).toBe(200);
        expect(r.body.data).toMatchObject({ objectivesLayout: 'flat', diagnosisPlans: null, segment: antigo.segment });
        expect(r.body.data.specificObjectives).toEqual([antigo.objetivo]);
        expect(r.body.data.activities).toEqual([antigo.atividade]);
        const sem = await chamar('GET', `${BASE_ANTIGO()}/${antigo.versionId}`, U.soProjeto);
        expect(sem.body.data.segment).toBeNull();
        expect(sem.body.data.specificObjectives.map((o: { id: string }) => o.id)).toEqual([antigo.objetivo.id]);
      });

      it('formato-antigo b: edit (minor) → 201 com o snapshot COPIADO, mesmo com o catálogo antigo INATIVO; não relê o catálogo', async () => {
        // controle da medição: o catálogo antigo está inativo (e sem dono) — reler o catálogo daria 422
        const ativos = await pool.query(`SELECT 1 FROM therapeutic_specific_objectives WHERE id = $1 AND active UNION ALL SELECT 1 FROM therapeutic_activities WHERE id = $2 AND active`, [antigo.objetivo.id, antigo.atividade.id]);
        expect(ativos.rowCount).toBe(0);
        const r = await chamar('POST', BASE_ANTIGO(), U.completa, { mode: 'edit', fromVersionId: antigo.versionId, version: corpoPlano({ modality: 'ONLINE' }) });
        expect(r.status).toBe(201);
        expect(r.body.data).toMatchObject({ version: 'V.1.1', objectivesLayout: 'flat', diagnosisPlans: null, segment: antigo.segment, modality: 'ONLINE' });
        expect(r.body.data.specificObjectives).toEqual([antigo.objetivo]);
        expect(r.body.data.activities).toEqual([antigo.atividade]);
        const linha = (await pool.query(`SELECT specific_objectives, activities, segment, diagnosis_plans FROM patient_therapeutic_projects WHERE id = $1`, [r.body.data.id])).rows[0];
        expect(linha).toEqual({ specific_objectives: [antigo.objetivo], activities: [antigo.atividade], segment: antigo.segment, diagnosis_plans: null });
      });

      it('formato-antigo c: corpo por diagnóstico sobre origem plana → 422 `ptp_format_mismatch`; ids planos diferentes → 422 `ptp_macro_locked`; nada gravado', async () => {
        const vigente = (await pool.query<{ id: string }>(`SELECT id FROM patient_therapeutic_projects WHERE patient_id = $1 ORDER BY created_at DESC LIMIT 1`, [ANTIGO])).rows[0].id;
        const antes = await contar(ANTIGO);
        const { specificObjectiveIds: _o, activityIds: _a, ...semPlano } = corpoPlano();
        const blocos = await chamar('POST', BASE_ANTIGO(), U.completa, { mode: 'edit', fromVersionId: vigente, version: { ...semPlano, diagnosisPlans: [bloco(DIAG_ANTIGO[0].uri, [], [])] } });
        expect(blocos.status).toBe(422);
        expect(blocos.body).toMatchObject({ code: 'ptp_format_mismatch' });
        const outros = await chamar('POST', BASE_ANTIGO(), U.completa, { mode: 'edit', fromVersionId: vigente, version: corpoPlano({ specificObjectiveIds: [cat.objetivos.a], activityIds: [cat.atividades.a] }) });
        expect(outros.status).toBe(422);
        expect(outros.body.code).toBe('ptp_macro_locked');
        expect(await contar(ANTIGO)).toBe(antes);
      });
    });
  });

  it('grupo com clinical create+update (SEM write — o que o painel grava) cria o projeto: new → 201', async () => {
    const r = await chamar('POST', BASE(), U.dividida, { mode: 'new', version: newVersionBody() });
    expect(r.status).toBe(201);
    expect(r.body.success).toBe(true);
  });
});
