/**
 * Spec 061 — catálogo terapêutico com TÍTULO (150) + DESCRIÇÃO (1000) em objetivos e atividades:
 * a API sob o engine de permissão (família admin.patients), HTTP real, banco real. Sem mock de dado.
 * Molde: `therapeutic-projects-api.e2e.test.ts` (app/pool/token/semente do CID).
 *
 * O que se prova (atividades; objetivos usam o MESMO schema/repositório por `kind`):
 *   1. ida-e-volta: POST com título + descrição → 201; GET lista → a mesma descrição;
 *   2. descrição de 1001 → 400 na API E recusa no BANCO por SQL direto (CHECK `23514`; `''` também);
 *   3. título de 151 → 400 no create, nada gravado;
 *   4. título ANTIGO de 155 (o CHECK do banco ainda é 200): PATCH só com `description` → 200 e o título
 *      segue intacto; PATCH com `label` de 155 → 400 (o teto novo vale para o que o corpo traz);
 *   5. PATCH `description: null` limpa;
 *   6. CONGELAMENTO: a versão do projeto guarda título+descrição; mudar o catálogo depois não reescreve a versão;
 *   7. `segments` + `description` → 400 (o catálogo de segmentos não ganhou descrição);
 *   8. a lista sai em ordem ALFABÉTICA (itens criados em ordem inversa).
 * Sentinelas sintéticas `E2E 061 …` (só letras: sequência de dígitos é recusada pela guarda de PII).
 */
import { Pool } from 'pg';
import { montarAppDeFamilia, tokenMock, grupoComCelulas, limparIamFixtures, garantirCelula, TENANT_E2E, type AppDeFamilia } from './helpers/permissionFamilyHarness';

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

describe('spec 061 — catálogo terapêutico: título + descrição (HTTP real, banco real, engine de permissão ligado)', () => {
  let pool: Pool;
  let app: AppDeFamilia;
  const PATIENT = 'ee461000-0a00-0001-0001-000000000001';
  const U = { catalogo: 'pt061-catalogo', completa: 'pt061-completa' };
  const GRUPOS = { catalogo: 'PT061 Catálogo', completa: 'PT061 Completa' };
  const CATALOGO = '/api/admin/therapeutic-catalogs/activities';
  const PREFIXO = 'E2E 061 ';
  /** `E2E 061 <n> <sufixo>` com exatamente `n` caracteres (preenche com "a"). */
  const comTamanho = (n: number, tag: string): string => (PREFIXO + tag + ' ').padEnd(n, 'a');

  const CELULAS: Array<[string, string]> = [
    ['catalog_therapeutic_activities', 'read'], ['catalog_therapeutic_activities', 'create'], ['catalog_therapeutic_activities', 'update'],
    ['catalog_therapeutic_segments', 'read'], ['catalog_therapeutic_segments', 'create'],
    ['catalog_therapeutic_objectives', 'read'],
  ];
  const CELULAS_PT: Array<[string, string]> = [
    ['patient', 'read'], ['patient_therapeutic_project', 'read'], ['patient_therapeutic_project', 'create'],
    ['patient_clinical', 'read'], ['patient_clinical', 'write'], ['patient_services', 'read'],
    ['catalog_therapeutic_objectives', 'read'], ['catalog_therapeutic_activities', 'read'],
  ];

  // Release-fixture do CID-11 (molde da 017): capítulo 06 + um stem, promovido como CORRENTE e restaurado no fim.
  const FIX_RELEASE = 'PT061-FIX';
  const URI_TEA = 'test://ptp061/tea';
  let releaseAnterior: string | null = null;
  let serviceId: string;
  let objectiveId: string;
  let ptiSegmentId: string;

  async function semearCid(): Promise<void> {
    await pool.query(`INSERT INTO terminology.icd_releases (release, entity_count) VALUES ($1, 2) ON CONFLICT (release) DO NOTHING`, [FIX_RELEASE]);
    const linhas: Array<[string, string, string, string, string, boolean]> = [
      ['test://ptp061/cap06', '06', 'Trastornos mentales, del comportamiento y del neurodesarrollo', '06', 'chapter', false],
      [URI_TEA, '6A02', 'Trastorno del espectro autista', '06', 'stem', true],
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
    await pool.query(`UPDATE terminology.icd_releases SET is_current = true, promoted_at = NOW(), promoted_by = 'pt061-e2e' WHERE release = $1`, [FIX_RELEASE]);
  }
  async function restaurarCid(): Promise<void> {
    await pool.query(`UPDATE terminology.icd_releases SET is_current = false, promoted_at = NULL, promoted_by = NULL WHERE release = $1`, [FIX_RELEASE]);
    if (releaseAnterior) await pool.query(`UPDATE terminology.icd_releases SET is_current = true, promoted_at = NOW(), promoted_by = 'pt061-e2e-restore' WHERE release = $1`, [releaseAnterior]);
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

  async function limpar(): Promise<void> {
    await pool.query(`DELETE FROM resource_access_log WHERE operator_uid = ANY($1)`, [Object.values(U)]);
    await limparIamFixtures(pool, { uids: Object.values(U), grupos: Object.values(GRUPOS) });
    await pool.query(`DELETE FROM patients WHERE id = $1`, [PATIENT]);
    await pool.query(`DELETE FROM therapeutic_activities WHERE label LIKE 'E2E 061 %'`);
    await pool.query(`DELETE FROM therapeutic_segments WHERE label LIKE 'E2E 061 %'`);
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    await limpar();
    await pool.query(
      `INSERT INTO users (firebase_uid, email, display_name, role, status, is_active, tenant_id) VALUES
         ($1, 'pt061-catalogo@e2e.local', 'Catálogo 061', 'admin', 'ACTIVE', true, $3),
         ($2, 'pt061-completa@e2e.local', 'Ana Sintética 061', 'admin', 'ACTIVE', true, $3)`,
      [U.catalogo, U.completa, TENANT_E2E],
    );
    for (const [resource, action] of [...CELULAS, ...CELULAS_PT]) {
      await garantirCelula(pool, { resource, action, category: 'Pacientes' });
    }
    await grupoComCelulas(pool, { nome: GRUPOS.catalogo, uid: U.catalogo, celulas: CELULAS });
    await grupoComCelulas(pool, { nome: GRUPOS.completa, uid: U.completa, celulas: CELULAS_PT });
    await pool.query(
      `INSERT INTO patients (id, clickup_task_id, first_name, last_name, country, is_test) VALUES ($1, 'e2e-061-a', 'Paciente', 'Sintético', 'AR', true)`,
      [PATIENT],
    );
    serviceId = (await pool.query<{ id: string }>(
      `INSERT INTO patient_contracted_services (patient_id, service_code, created_by, updated_by) VALUES ($1, 'CAREGIVER', 'e2e', 'e2e') RETURNING id`, [PATIENT],
    )).rows[0].id;
    objectiveId = (await pool.query<{ id: string }>(`SELECT id FROM therapeutic_specific_objectives WHERE active ORDER BY sort_order LIMIT 1`)).rows[0].id;
    ptiSegmentId = (await pool.query<{ id: string }>(`SELECT id FROM therapeutic_segments WHERE active AND created_by = 'seed:495' ORDER BY sort_order LIMIT 1`)).rows[0].id;
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
    // A versão é imutável (trigger 416): só sai por CASCADE do paciente (`limpar` apaga o paciente).
    await limpar();
    await restaurarCid();
    await pool.end();
    for (const [k, v] of Object.entries(envAnterior)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  });

  const listar = async (): Promise<Array<{ id: string; label: string; description?: string | null }>> =>
    (await chamar('GET', `${CATALOGO}?includeInactive=true`, U.catalogo)).body.data.items;

  it('1. ida-e-volta: POST com título + descrição → 201; a lista devolve a MESMA descrição', async () => {
    const label = `${PREFIXO}ida e volta`;
    const description = 'Descripcion sintetica: actividad de estimulacion ida y vuelta.';
    const r = await chamar('POST', CATALOGO, U.catalogo, { label, description });
    expect(r.status).toBe(201);
    expect(r.body.data).toMatchObject({ label, description, active: true });
    const doBanco = (await pool.query(`SELECT description FROM therapeutic_activities WHERE id = $1`, [r.body.data.id])).rows[0];
    expect(doBanco.description).toBe(description);
    const item = (await listar()).find((i) => i.id === r.body.data.id);
    expect(item).toMatchObject({ label, description });
  });

  it('2. descrição de 1001 → 400 na API; SQL direto com 1001 (e com "") → recusa do banco 23514', async () => {
    const antes = Number((await pool.query(`SELECT count(*) FROM therapeutic_activities WHERE label LIKE 'E2E 061 d1001%'`)).rows[0].count);
    const r = await chamar('POST', CATALOGO, U.catalogo, { label: `${PREFIXO}d1001 api`, description: 'd'.repeat(1001) });
    expect(r.status).toBe(400);
    expect(Number((await pool.query(`SELECT count(*) FROM therapeutic_activities WHERE label LIKE 'E2E 061 d1001%'`)).rows[0].count)).toBe(antes);
    // 1000 passa (controle de que o teto é 1000 e não menos).
    const limite = await chamar('POST', CATALOGO, U.catalogo, { label: `${PREFIXO}d1000 api`, description: 'd'.repeat(1000) });
    expect(limite.status).toBe(201);
    // O banco recusa por conta própria (CHECK da 547), sem passar pela API.
    await expect(
      pool.query(`INSERT INTO therapeutic_activities (label, sort_order, description, created_by, updated_by) VALUES ($1, 99990, repeat('a', 1001), 'e2e', 'e2e')`, [`${PREFIXO}d1001 sql`]),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      pool.query(`INSERT INTO therapeutic_activities (label, sort_order, description, created_by, updated_by) VALUES ($1, 99991, '', 'e2e', 'e2e')`, [`${PREFIXO}d1001 vazia`]),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('3. título de 151 → 400 no create, nada gravado; 150 passa', async () => {
    const r151 = await chamar('POST', CATALOGO, U.catalogo, { label: comTamanho(151, 't151') });
    expect(r151.status).toBe(400);
    expect(Number((await pool.query(`SELECT count(*) FROM therapeutic_activities WHERE label LIKE 'E2E 061 t151%'`)).rows[0].count)).toBe(0);
    const r150 = await chamar('POST', CATALOGO, U.catalogo, { label: comTamanho(150, 't150') });
    expect(r150.status).toBe(201);
  });

  it('4. título ANTIGO de 155: PATCH só com `description` → 200 e o título segue intacto; PATCH com `label` de 155 → 400', async () => {
    const antigo = comTamanho(155, 'antigo');
    expect(antigo).toHaveLength(155);
    // O CHECK do banco ainda é 200: o título antigo entra por SQL (o que a produção já tem).
    const id = (await pool.query<{ id: string }>(
      `INSERT INTO therapeutic_activities (label, sort_order, created_by, updated_by) VALUES ($1, 99992, 'e2e', 'e2e') RETURNING id`, [antigo],
    )).rows[0].id;
    const ok = await chamar('PATCH', `${CATALOGO}/${id}`, U.catalogo, { description: 'Descripcion nueva sobre titulo antiguo.' });
    expect(ok.status).toBe(200);
    expect(ok.body.data.description).toBe('Descripcion nueva sobre titulo antiguo.');
    const item = (await listar()).find((i) => i.id === id);
    expect(item?.label).toBe(antigo);
    expect(item?.label).toHaveLength(155);
    const recusa = await chamar('PATCH', `${CATALOGO}/${id}`, U.catalogo, { label: antigo });
    expect(recusa.status).toBe(400);
    expect((await pool.query(`SELECT label FROM therapeutic_activities WHERE id = $1`, [id])).rows[0].label).toBe(antigo);
  });

  it('5. PATCH `description: null` limpa a descrição', async () => {
    const novo = await chamar('POST', CATALOGO, U.catalogo, { label: `${PREFIXO}limpar`, description: 'Texto que sera limpo.' });
    expect(novo.status).toBe(201);
    const limpo = await chamar('PATCH', `${CATALOGO}/${novo.body.data.id}`, U.catalogo, { description: null });
    expect(limpo.status).toBe(200);
    expect(limpo.body.data.description).toBeNull();
    expect((await pool.query(`SELECT description FROM therapeutic_activities WHERE id = $1`, [novo.body.data.id])).rows[0].description).toBeNull();
    expect((await listar()).find((i) => i.id === novo.body.data.id)?.description).toBeNull();
  });

  it('6. 🔒 congelamento: a versão guarda título + descrição; mudar o catálogo depois NÃO reescreve a versão', async () => {
    const label = `${PREFIXO}congelada`;
    const description = 'Descripcion congelada en la version.';
    const item = await chamar('POST', CATALOGO, U.catalogo, { label, description });
    expect(item.status).toBe(201);
    const base = `/api/admin/patients/${PATIENT}/therapeutic-projects`;
    const criada = await chamar('POST', base, U.completa, {
      mode: 'new',
      version: {
        contractedServiceId: serviceId, modality: 'IN_PERSON', segmentId: ptiSegmentId,
        diagnoses: [{ uri: URI_TEA, code: '6A02', title: 'Diagnóstico sintético e2e 061' }],
        clinicalContext: 'Síntesis sintética e2e 061.', generalObjective: 'Objetivo general sintético e2e 061.',
        specificObjectiveIds: [objectiveId], activityIds: [item.body.data.id],
        startDate: '2026-09-01', endDate: '2026-12-31', contactStatus: {},
      },
    });
    expect(criada.status).toBe(201);
    expect(criada.body.data.activities).toEqual([expect.objectContaining({ id: item.body.data.id, label, description })]);
    const vid = criada.body.data.id as string;

    const muda = await chamar('PATCH', `${CATALOGO}/${item.body.data.id}`, U.catalogo, { label: `${PREFIXO}congelada renomeada`, description: 'Descripcion NUEVA del catalogo.' });
    expect(muda.status).toBe(200);
    expect(muda.body.data).toMatchObject({ label: `${PREFIXO}congelada renomeada`, description: 'Descripcion NUEVA del catalogo.' });

    const lida = await chamar('GET', `${base}/${vid}`, U.completa);
    expect(lida.status).toBe(200);
    expect(lida.body.data.activities).toEqual([expect.objectContaining({ id: item.body.data.id, label, description })]);
    // E no banco, a coluna jsonb da versão tem o texto de antes.
    const linha = (await pool.query(`SELECT activities FROM patient_therapeutic_projects WHERE id = $1`, [vid])).rows[0];
    expect(linha.activities[0]).toMatchObject({ label, description });
  });

  it('7. `segments` + `description` → 400 (o catálogo de segmentos não ganhou descrição) e nada gravado', async () => {
    const r = await chamar('POST', '/api/admin/therapeutic-catalogs/segments', U.catalogo, { label: `${PREFIXO}segmento`, description: 'no aplica' });
    expect(r.status).toBe(400);
    expect(Number((await pool.query(`SELECT count(*) FROM therapeutic_segments WHERE label = $1`, [`${PREFIXO}segmento`])).rows[0].count)).toBe(0);
  });

  it('8. a lista sai em ordem ALFABÉTICA (itens criados em ordem inversa)', async () => {
    for (const letra of ['c', 'b', 'a']) {
      const r = await chamar('POST', CATALOGO, U.catalogo, { label: `${PREFIXO}ord ${letra}` });
      expect(r.status).toBe(201);
    }
    const lista = await chamar('GET', CATALOGO, U.catalogo);
    expect(lista.status).toBe(200);
    const nossos = (lista.body.data.items as Array<{ label: string }>).map((i) => i.label).filter((l) => l.startsWith(`${PREFIXO}ord `));
    expect(nossos).toEqual([`${PREFIXO}ord a`, `${PREFIXO}ord b`, `${PREFIXO}ord c`]);
  });
});
