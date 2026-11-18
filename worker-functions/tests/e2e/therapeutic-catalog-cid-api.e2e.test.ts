/**
 * Spec 091 (T219, §9.4, CA-6, CA-12) — cascata por CID-11 e vínculos item↔categoria pela HTTP REAL, banco real,
 * engine de permissão ligado (família admin.patients). Sem mock de dado; só linhas sintéticas semeadas AQUI
 * (release `E2E219-FIX` promovido como corrente e restaurado no fim; stems `ZY9x`; sentinelas `e2e219 …`).
 *
 * `-t cascata` (CA-6): bloco `ok` com objetivos/atividades DA CATEGORIA (a atividade só entra pelo vínculo dela com a
 * categoria, não por pertencer ao objetivo); `no_catalog`; `no_category`; URI desconhecida → 422 sem ecoar a URI; célula dupla.
 * `-t vinculos` (CA-12): add/list/remove de objetivo e de atividade; atividade fora do objetivo → 422;
 * remover a categoria do objetivo devolve `removedActivityLinks`.
 * Só dado de catálogo e de terminologia; nenhum dado de paciente.
 */
import { Pool } from 'pg';
import { travarReleaseCorrente } from './helpers/ptiCatalogoCidSeed';
import { montarAppDeFamilia, tokenMock, grupoComCelulas, limparIamFixtures, garantirCelula, TENANT_E2E, type AppDeFamilia } from './helpers/permissionFamilyHarness';

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

const BASE = '/api/admin/therapeutic-catalogs';
const FIX_RELEASE = 'E2E219-FIX';
const ACTOR_LABEL = 'e2e219 ';
const URI = 'http://e2e219.test/';
const PROBE = 'e2e219probe';
const SERVICE = 'AT';
const U = { total: 'e2e219-total', leitura: 'e2e219-leitura' };
const GRUPOS = { total: 'E2E219 Total', leitura: 'E2E219 Leitura' };

const CAT_OK = 'ZY91'; // stem de 4 caracteres: a categoria da cascata com catálogo
const CAT_VAZIA = 'ZY92'; // stem de 4 caracteres sem nenhum vínculo: `no_catalog`
const CAT_OUTRA = 'ZY94'; // 2ª categoria do objetivo 1: só a atividade 2 se vincula a ela
const CAT_EXT = 'ZY95'; // kind='extension' (4 caracteres): não é categoria
const CAT_SUB = 'ZY96.1'; // stem com 6 caracteres: não é categoria
const CAT_AUSENTE = 'ZY99'; // não existe na terminologia semeada
const CODE_SEM_CATEGORIA = '06'; // código de capítulo (forma válida do IcdCode, sem 4 caracteres): URI resolvida, mas sem categoria → `no_category`

const ENTIDADES: Array<{ n: number; code: string; kind: string; title: string }> = [
  { n: 1, code: CAT_OK, kind: 'stem', title: `${PROBE} categoria com catalogo` },
  { n: 2, code: CAT_VAZIA, kind: 'stem', title: `${PROBE} categoria sem catalogo` },
  { n: 3, code: CODE_SEM_CATEGORIA, kind: 'chapter', title: `${PROBE} capitulo sem categoria` },
  { n: 4, code: CAT_OUTRA, kind: 'stem', title: `${PROBE} categoria outra` },
  { n: 5, code: CAT_EXT, kind: 'extension', title: `${PROBE} extensao` },
  { n: 6, code: CAT_SUB, kind: 'stem', title: `${PROBE} subcodigo` },
];
const uriDe = (n: number): string => `${URI}${n}`;

describe('spec 091 — catálogo por categoria CID-11 pela API (HTTP real, banco real, engine ligado) @integration', () => {
  let pool: Pool;
  let app: AppDeFamilia;
  let releaseAnterior: string | null = null;
  let soltarLockCid: () => Promise<void> = async () => undefined; // T222: `is_current` é global; serializa entre processos jest
  let semServico: string; // service_types sem objetivo ativo: `serviceHasCatalog=false`
  const ids: { o1: string; o2: string; o3: string; oInativo: string; a1: string; a2: string } = {} as never;

  const envAnterior: Record<string, string | undefined> = {};
  const setEnv = (k: string, v: string): void => { envAnterior[k] = process.env[k]; process.env[k] = v; };

  async function chamar(metodo: string, caminho: string, uid: string, body?: unknown): Promise<{ status: number; body: any; texto: string }> {
    const res = await fetch(`${app.url}${caminho}`, {
      method: metodo,
      headers: { Authorization: tokenMock(uid), 'Content-Type': 'application/json' },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const texto = await res.text();
    let json: any = {};
    try { json = JSON.parse(texto); } catch { /* corpo vazio */ }
    return { status: res.status, body: json, texto };
  }
  const count = async (sql: string, params: unknown[] = []): Promise<number> => Number((await pool.query(sql, params)).rows[0].n);

  async function semearCid(): Promise<void> {
    await pool.query(`INSERT INTO terminology.icd_releases (release, entity_count) VALUES ($1, $2) ON CONFLICT (release) DO NOTHING`, [FIX_RELEASE, ENTIDADES.length]);
    for (const e of ENTIDADES) {
      await pool.query(
        `INSERT INTO terminology.icd_entities (icd_uri, release, code, title_es, chapter, kind, is_leaf)
         VALUES ($1, $2, $3, $4, '06', $5, true) ON CONFLICT (icd_uri, release) DO NOTHING`,
        [uriDe(e.n), FIX_RELEASE, e.code, e.title, e.kind],
      );
    }
    releaseAnterior = (await pool.query<{ release: string }>(`SELECT release FROM terminology.icd_releases WHERE is_current LIMIT 1`)).rows[0]?.release ?? null;
    await pool.query(`UPDATE terminology.icd_releases SET is_current = false, promoted_at = NULL, promoted_by = NULL WHERE is_current`);
    await pool.query(`UPDATE terminology.icd_releases SET is_current = true, promoted_at = NOW(), promoted_by = 'e2e219' WHERE release = $1`, [FIX_RELEASE]);
  }
  async function restaurarCid(): Promise<void> {
    await pool.query(`UPDATE terminology.icd_releases SET is_current = false, promoted_at = NULL, promoted_by = NULL WHERE release = $1`, [FIX_RELEASE]);
    if (releaseAnterior) await pool.query(`UPDATE terminology.icd_releases SET is_current = true, promoted_at = NOW(), promoted_by = 'e2e219-restore' WHERE release = $1`, [releaseAnterior]);
    await pool.query(`DELETE FROM terminology.icd_entities WHERE release = $1`, [FIX_RELEASE]);
    await pool.query(`DELETE FROM terminology.icd_releases WHERE release = $1`, [FIX_RELEASE]);
  }

  async function limparCatalogo(): Promise<void> {
    const objetivos = `(SELECT id FROM therapeutic_specific_objectives WHERE label LIKE '${ACTOR_LABEL}%')`;
    await pool.query(`DELETE FROM therapeutic_activity_icd_categories WHERE objective_id IN ${objetivos}`);
    await pool.query(`DELETE FROM therapeutic_objective_icd_categories WHERE objective_id IN ${objetivos}`);
    await pool.query(`DELETE FROM therapeutic_activities WHERE label LIKE '${ACTOR_LABEL}%'`);
    await pool.query(`DELETE FROM therapeutic_specific_objectives WHERE label LIKE '${ACTOR_LABEL}%'`);
  }
  async function limpar(): Promise<void> {
    await pool.query(`DELETE FROM resource_access_log WHERE operator_uid = ANY($1)`, [Object.values(U)]);
    await limparIamFixtures(pool, { uids: Object.values(U), grupos: Object.values(GRUPOS) });
    await limparCatalogo();
  }

  const novoObjetivo = async (label: string, active = true): Promise<string> =>
    (await pool.query<{ id: string }>(
      `INSERT INTO therapeutic_specific_objectives (label, service_code, active, deactivated_at, created_by, updated_by)
       VALUES ($1, $2, $3, CASE WHEN $3 THEN NULL ELSE NOW() END, 'e2e219', 'e2e219') RETURNING id`,
      [ACTOR_LABEL + label, SERVICE, active],
    )).rows[0].id;
  const novaAtividade = async (label: string, objective: string, frequencia: string | null): Promise<string> =>
    (await pool.query<{ id: string }>(
      `INSERT INTO therapeutic_activities (label, objective_id, suggested_frequency, created_by, updated_by) VALUES ($1, $2, $3, 'e2e219', 'e2e219') RETURNING id`,
      [ACTOR_LABEL + label, objective, frequencia],
    )).rows[0].id;
  const vinculoObjetivo = (objective: string, code: string, ordem: number | null) =>
    pool.query(`INSERT INTO therapeutic_objective_icd_categories (objective_id, category_code, sort_order, created_by) VALUES ($1, $2, $3, 'e2e219')`, [objective, code, ordem]);
  const vinculoAtividade = async (activity: string, objective: string, code: string) =>
    pool.query(`INSERT INTO therapeutic_activity_icd_categories (activity_id, objective_id, category_code, created_by) VALUES ($1, $2, $3, 'e2e219')`, [activity, objective, code]);

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    soltarLockCid = await travarReleaseCorrente(pool);
    await limpar();
    await restaurarCid(); // sobra de rodada interrompida: some antes de semear de novo
    await pool.query(
      `INSERT INTO users (firebase_uid, email, display_name, role, status, is_active, tenant_id) VALUES
         ($1, 'e2e219-total@e2e.local', 'Catalogo 219 Total', 'admin', 'ACTIVE', true, $3),
         ($2, 'e2e219-leitura@e2e.local', 'Catalogo 219 Leitura', 'admin', 'ACTIVE', true, $3)`,
      [U.total, U.leitura, TENANT_E2E],
    );
    const celulasTotal: Array<[string, string]> = ['read', 'create', 'update'].flatMap((a): Array<[string, string]> => [
      ['catalog_therapeutic_objectives', a], ['catalog_therapeutic_activities', a],
    ]);
    const celulasLeitura: Array<[string, string]> = [['catalog_therapeutic_objectives', 'read']]; // sem a de atividades
    for (const [resource, action] of celulasTotal) await garantirCelula(pool, { resource, action, category: 'Pacientes' });
    await grupoComCelulas(pool, { nome: GRUPOS.total, uid: U.total, celulas: celulasTotal });
    await grupoComCelulas(pool, { nome: GRUPOS.leitura, uid: U.leitura, celulas: celulasLeitura });
    await semearCid();

    semServico = (await pool.query<{ code: string }>(
      `SELECT st.code FROM service_types st
        WHERE NOT EXISTS (SELECT 1 FROM therapeutic_specific_objectives o WHERE o.active AND o.service_code = st.code) ORDER BY st.code LIMIT 1`,
    )).rows[0].code;

    // Catálogo da cascata: o1 e o2 na categoria OK (o1 também em OUTRA); o3 só em OUTRA; um inativo na OK.
    ids.o1 = await novoObjetivo('obj a');
    ids.o2 = await novoObjetivo('obj b');
    ids.o3 = await novoObjetivo('obj fora');
    ids.oInativo = await novoObjetivo('obj inativo', false);
    await vinculoObjetivo(ids.o1, CAT_OK, null);
    await vinculoObjetivo(ids.o1, CAT_OUTRA, null);
    await vinculoObjetivo(ids.o2, CAT_OK, null);
    await vinculoObjetivo(ids.o3, CAT_OUTRA, null);
    await vinculoObjetivo(ids.oInativo, CAT_OK, null);
    // a1 e a2 são do MESMO objetivo (o1): a1 só na OK, a2 só na OUTRA — a categoria da ATIVIDADE é que decide.
    ids.a1 = await novaAtividade('ativ 1', ids.o1, 'semanal');
    ids.a2 = await novaAtividade('ativ 2', ids.o1, null);
    await vinculoAtividade(ids.a1, ids.o1, CAT_OK);
    await vinculoAtividade(ids.a2, ids.o1, CAT_OUTRA);

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
    try { await restaurarCid(); } finally { await soltarLockCid(); }
    await pool.end();
    for (const [k, v] of Object.entries(envAnterior)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  });

  describe('CA-6 cascata', () => {
    const cascata = (serviceCode: string, diagnosisUris: string[], uid = U.total) =>
      chamar('POST', `${BASE}/cascade`, uid, { serviceCode, diagnosisUris });

    it('cascata: bloco ok traz os objetivos DA categoria e, em cada um, só as atividades vinculadas À categoria', async () => {
      const r = await cascata(SERVICE, [uriDe(1)]);
      expect(r.status).toBe(200);
      expect(r.body.data).toMatchObject({ serviceCode: SERVICE, serviceHasCatalog: true });
      expect(r.body.data.blocks).toHaveLength(1);
      const [bloco] = r.body.data.blocks;
      expect(bloco).toMatchObject({ diagnosisUri: uriDe(1), categoryCode: CAT_OK, status: 'ok' });
      // o1 e o2 (a ordem é a do rótulo: sem sort_order); o3 (outra categoria) e o inativo ficam de fora
      expect(bloco.objectives.map((o: { id: string }) => o.id)).toEqual([ids.o1, ids.o2]);
      expect(bloco.objectives[0]).toEqual({
        id: ids.o1, label: `${ACTOR_LABEL}obj a`, description: null,
        // a2 é do objetivo o1, mas só se vincula à OUTRA categoria: não pode aparecer aqui
        activities: [{ id: ids.a1, label: `${ACTOR_LABEL}ativ 1`, description: null, suggestedFrequency: 'semanal' }],
      });
      expect(bloco.objectives[1].activities).toEqual([]);
    });

    it('cascata: a outra categoria do mesmo objetivo devolve a OUTRA atividade (a seleção vem do vínculo da atividade)', async () => {
      const r = await cascata(SERVICE, [uriDe(4)]);
      expect(r.status).toBe(200);
      const [bloco] = r.body.data.blocks;
      expect(bloco).toMatchObject({ categoryCode: CAT_OUTRA, status: 'ok' });
      expect(bloco.objectives.map((o: { id: string }) => o.id)).toEqual([ids.o1, ids.o3]);
      expect(bloco.objectives[0].activities).toEqual([{ id: ids.a2, label: `${ACTOR_LABEL}ativ 2`, description: null, suggestedFrequency: null }]);
      expect(bloco.objectives[1].activities).toEqual([]);
    });

    it('cascata: no_catalog (categoria sem vínculo) e no_category (código sem 4 caracteres), na ordem das URIs, com URI repetida', async () => {
      const r = await cascata(SERVICE, [uriDe(3), uriDe(2), uriDe(1), uriDe(2)]);
      expect(r.status).toBe(200);
      expect(r.body.data.blocks.map((b: { diagnosisUri: string; categoryCode: string | null; status: string }) => [b.diagnosisUri, b.categoryCode, b.status])).toEqual([
        [uriDe(3), null, 'no_category'],
        [uriDe(2), CAT_VAZIA, 'no_catalog'],
        [uriDe(1), CAT_OK, 'ok'],
        [uriDe(2), CAT_VAZIA, 'no_catalog'],
      ]);
      expect(r.body.data.blocks[0].objectives).toEqual([]);
      expect(r.body.data.blocks[1].objectives).toEqual([]);
    });

    it('cascata: serviço sem catálogo → serviceHasCatalog=false e a categoria que tem catálogo em outro serviço vira no_catalog', async () => {
      const r = await cascata(semServico, [uriDe(1)]);
      expect(r.status).toBe(200);
      expect(r.body.data.serviceHasCatalog).toBe(false);
      expect(r.body.data.blocks).toEqual([{ diagnosisUri: uriDe(1), categoryCode: CAT_OK, status: 'no_catalog', objectives: [] }]);
    });

    it('cascata: URI desconhecida → 422 ptp_diagnosis_unknown sem ecoar a URI, mesmo com URIs boas na lista', async () => {
      const desconhecida = `${URI}nao-existe-219`;
      const r = await cascata(SERVICE, [uriDe(1), desconhecida]);
      expect(r.status).toBe(422);
      expect(r.body).toMatchObject({ success: false, code: 'ptp_diagnosis_unknown' });
      expect(r.texto).not.toContain('nao-existe-219');
      expect(r.texto).not.toContain(URI);
    });

    it('cascata: corpo fora do contrato → 400 (serviceCode minúsculo, 0 URIs, 21 URIs, chave extra)', async () => {
      expect((await cascata('at', [uriDe(1)])).status).toBe(400);
      expect((await cascata(SERVICE, [])).status).toBe(400);
      expect((await cascata(SERVICE, Array.from({ length: 21 }, (_, i) => `${URI}${i}`))).status).toBe(400);
      expect((await chamar('POST', `${BASE}/cascade`, U.total, { serviceCode: SERVICE, diagnosisUris: [uriDe(1)], segmentId: 'x' })).status).toBe(400);
    });

    it('cascata: exige as DUAS células — só objectives:read → 403; as duas → 200', async () => {
      const r = await cascata(SERVICE, [uriDe(1)], U.leitura);
      expect(r.status).toBe(403);
      expect(r.body.data).toBeUndefined();
      expect((await cascata(SERVICE, [uriDe(1)], U.total)).status).toBe(200);
    });
  });

  describe('CA-12 vinculos', () => {
    let objetivo: string;
    let atividade: string;
    let atividade2: string;

    it('vinculos: busca de categoria devolve só stem de 4 caracteres (sem extension, sem subcódigo, sem ausente)', async () => {
      const r = await chamar('GET', `${BASE}/icd-categories?q=${PROBE}`, U.total);
      expect(r.status).toBe(200);
      expect(r.body.data.map((c: { code: string }) => c.code).sort()).toEqual([CAT_OK, CAT_VAZIA, CAT_OUTRA].sort());
      expect(r.body.data.find((c: { code: string }) => c.code === CAT_OK)).toEqual({ code: CAT_OK, title: `${PROBE} categoria com catalogo` });
      expect((await chamar('GET', `${BASE}/icd-categories?q=x`, U.total)).status).toBe(400);
    });

    it('vinculos: objetivo criado pela API com serviceCode (sem segmentId); add → list → duplicado 409 → código inválido 422', async () => {
      const semServico = await chamar('POST', `${BASE}/specific-objectives`, U.total, { label: `${ACTOR_LABEL}vinc obj` });
      expect(semServico.status).toBe(400);
      const comSegmento = await chamar('POST', `${BASE}/specific-objectives`, U.total, { label: `${ACTOR_LABEL}vinc obj`, serviceCode: SERVICE, segmentId: ids.o1 });
      expect(comSegmento.status).toBe(400);
      const criado = await chamar('POST', `${BASE}/specific-objectives`, U.total, { label: `${ACTOR_LABEL}vinc obj`, serviceCode: SERVICE });
      expect(criado.status).toBe(201);
      objetivo = criado.body.data.id;

      const rota = `${BASE}/specific-objectives/${objetivo}/categories`;
      expect((await chamar('GET', rota, U.total)).body.data).toEqual({ total: 0, items: [] });
      const add = await chamar('POST', rota, U.total, { code: CAT_OK });
      expect(add.status).toBe(201);
      expect(add.body.data).toEqual({ code: CAT_OK, title: `${PROBE} categoria com catalogo` });
      expect((await chamar('POST', rota, U.total, { code: CAT_OUTRA })).status).toBe(201);
      const dup = await chamar('POST', rota, U.total, { code: CAT_OK });
      expect(dup.status).toBe(409);
      expect(dup.body.code).toBe('icd_category_already_linked');
      for (const invalido of [CAT_AUSENTE, CAT_EXT, CAT_SUB]) {
        const r = await chamar('POST', rota, U.total, { code: invalido });
        expect(r.status).toBe(422);
        expect(r.body.code).toBe('icd_category_invalid');
      }
      const lista = await chamar('GET', rota, U.total);
      expect(lista.status).toBe(200);
      expect(lista.body.data.total).toBe(2);
      expect(lista.body.data.items).toEqual(expect.arrayContaining([
        { code: CAT_OK, title: `${PROBE} categoria com catalogo`, activityLinks: 0 },
        { code: CAT_OUTRA, title: `${PROBE} categoria outra`, activityLinks: 0 },
      ]));
      expect(await count(`SELECT count(*) AS n FROM therapeutic_objective_icd_categories WHERE objective_id = $1`, [objetivo])).toBe(2);
    });

    it('vinculos: atividade com objectiveId obrigatório; add dentro do objetivo 201 → list; fora do objetivo 422; duplicado 409', async () => {
      expect((await chamar('POST', `${BASE}/activities`, U.total, { label: `${ACTOR_LABEL}vinc ativ` })).status).toBe(400);
      const a1 = await chamar('POST', `${BASE}/activities`, U.total, { label: `${ACTOR_LABEL}vinc ativ 1`, objectiveId: objetivo, suggestedFrequency: '2x por semana' });
      expect(a1.status).toBe(201);
      atividade = a1.body.data.id;
      const a2 = await chamar('POST', `${BASE}/activities`, U.total, { label: `${ACTOR_LABEL}vinc ativ 2`, objectiveId: objetivo });
      expect(a2.status).toBe(201);
      atividade2 = a2.body.data.id;

      const rota = `${BASE}/activities/${atividade}/categories`;
      const add = await chamar('POST', rota, U.total, { code: CAT_OK });
      expect(add.status).toBe(201);
      expect(add.body.data).toEqual({ code: CAT_OK, title: `${PROBE} categoria com catalogo` });
      // CAT_VAZIA existe na terminologia, mas o OBJETIVO não a tem: a atividade não pode.
      const fora = await chamar('POST', rota, U.total, { code: CAT_VAZIA });
      expect(fora.status).toBe(422);
      expect(fora.body.code).toBe('icd_category_not_in_objective');
      expect(await count(`SELECT count(*) AS n FROM therapeutic_activity_icd_categories WHERE activity_id = $1 AND category_code = $2`, [atividade, CAT_VAZIA])).toBe(0);
      // atividade de OUTRO objetivo (o1) recebe uma categoria que este objetivo tem mas o1 não tem: também 422
      const deOutro = await chamar('POST', `${BASE}/activities/${ids.a1}/categories`, U.total, { code: CAT_VAZIA });
      expect(deOutro.status).toBe(422);
      const dup = await chamar('POST', rota, U.total, { code: CAT_OK });
      expect(dup.status).toBe(409);
      expect(dup.body.code).toBe('icd_category_already_linked');
      expect((await chamar('POST', `${BASE}/activities/${atividade2}/categories`, U.total, { code: CAT_OK })).status).toBe(201);

      const lista = await chamar('GET', rota, U.total);
      expect(lista.status).toBe(200);
      expect(lista.body.data).toEqual({ total: 1, items: [{ code: CAT_OK, title: `${PROBE} categoria com catalogo`, activityLinks: 1 }].map(({ code, title }) => ({ code, title })) });
    });

    it('vinculos: remover a categoria do objetivo devolve removedActivityLinks e leva os vínculos das atividades junto', async () => {
      const rotaObj = `${BASE}/specific-objectives/${objetivo}/categories`;
      expect((await chamar('GET', rotaObj, U.total)).body.data.items.find((i: { code: string }) => i.code === CAT_OK).activityLinks).toBe(2);
      const removida = await chamar('DELETE', `${rotaObj}/${CAT_OK}`, U.total);
      expect(removida.status).toBe(200);
      expect(removida.body.data).toEqual({ removedActivityLinks: 2 });
      expect(await count(`SELECT count(*) AS n FROM therapeutic_activity_icd_categories WHERE objective_id = $1 AND category_code = $2`, [objetivo, CAT_OK])).toBe(0);
      expect((await chamar('GET', `${BASE}/activities/${atividade}/categories`, U.total)).body.data).toEqual({ total: 0, items: [] });
      // a outra categoria do objetivo segue; remover de novo é idempotente (0)
      expect((await chamar('GET', rotaObj, U.total)).body.data.items.map((i: { code: string }) => i.code)).toEqual([CAT_OUTRA]);
      const denovo = await chamar('DELETE', `${rotaObj}/${CAT_OK}`, U.total);
      expect(denovo.status).toBe(200);
      expect(denovo.body.data).toEqual({ removedActivityLinks: 0 });
    });

    it('vinculos: remover o vínculo da atividade (DELETE) e remover a categoria do objetivo sem vínculo de atividade → 0', async () => {
      const rotaAtv = `${BASE}/activities/${atividade}/categories`;
      expect((await chamar('POST', rotaAtv, U.total, { code: CAT_OUTRA })).status).toBe(201);
      expect((await chamar('GET', rotaAtv, U.total)).body.data.total).toBe(1);
      const r = await chamar('DELETE', `${rotaAtv}/${CAT_OUTRA}`, U.total);
      expect(r.status).toBe(200);
      expect((await chamar('GET', rotaAtv, U.total)).body.data).toEqual({ total: 0, items: [] });
      const objOutra = await chamar('DELETE', `${BASE}/specific-objectives/${objetivo}/categories/${CAT_OUTRA}`, U.total);
      expect(objOutra.status).toBe(200);
      expect(objOutra.body.data).toEqual({ removedActivityLinks: 0 });
    });

    it('vinculos: as rotas de vínculo exigem a célula do dono — só leitura de objetivos não escreve (403, banco inalterado)', async () => {
      const antes = await count(`SELECT count(*) AS n FROM therapeutic_objective_icd_categories WHERE objective_id = $1`, [objetivo]);
      const r = await chamar('POST', `${BASE}/specific-objectives/${objetivo}/categories`, U.leitura, { code: CAT_OK });
      expect(r.status).toBe(403);
      expect(await count(`SELECT count(*) AS n FROM therapeutic_objective_icd_categories WHERE objective_id = $1`, [objetivo])).toBe(antes);
      expect((await chamar('GET', `${BASE}/specific-objectives/${objetivo}/categories`, U.leitura)).status).toBe(200);
      expect((await chamar('GET', `${BASE}/activities/${atividade}/categories`, U.leitura)).status).toBe(403);
    });
  });
});
