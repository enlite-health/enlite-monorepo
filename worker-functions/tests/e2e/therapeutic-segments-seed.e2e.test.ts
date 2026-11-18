import { readFileSync } from 'fs';
import { join } from 'path';
import { Pool } from 'pg';
import { montarAppDeFamilia, tokenMock, grupoComCelulas, limparIamFixtures, garantirCelula, TENANT_E2E, type AppDeFamilia } from './helpers/permissionFamilyHarness';

/**
 * Spec 091 (DF-1, CA-11) — o segmento terapêutico SAIU DE VEZ; este arquivo nasceu na spec 030 (seed 495).
 *
 * Antes: provava 13 linhas ativas semeadas pela migration 495. Agora prova o oposto, contra banco REAL:
 *   1. `therapeutic_segments` tem 0 linha ativa (a 586 desativou, nunca apagou: as 13 do seed 495 seguem lá,
 *      inativas, `updated_by = 'migration:586'`) — a tabela fica para o `SegmentLabelsReader` do resumo de admissão;
 *   2. `GET|POST|PATCH /api/admin/therapeutic-catalogs/segments` → 404, MESMO com o usuário tendo as células
 *      `catalog_therapeutic_segments:*` no banco (grant no banco não revive a rota) e com o controle vivo
 *      (`specific-objectives` → 200 com o mesmo token: o 404 não é app quebrado).
 *
 * Não reaplica o `.sql` do 495: depois da 586 ele INSERIRIA 13 linhas ativas (o ON CONFLICT só olha rótulo ativo).
 */

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';
const FIXTURE_FILE = join(__dirname, '..', 'fixtures', 'segmentos-ana-care.txt');

const fixtureLabels = (): string[] => readFileSync(FIXTURE_FILE, 'utf8').split('\n').filter((l) => l.length > 0);

describe('091 — segmento terapêutico fora de vez: 0 ativos no banco e a rota /segments dá 404 (banco real) @integration', () => {
  let pool: Pool;
  let app: AppDeFamilia;
  const UID = 'pt091-seg-catalogo';
  const GRUPO = 'PT091 Segmento fora';
  const CATALOGO = '/api/admin/therapeutic-catalogs';
  const CELULAS: Array<[string, string]> = [
    ['catalog_therapeutic_objectives', 'read'],
    ['catalog_therapeutic_segments', 'read'], ['catalog_therapeutic_segments', 'create'], ['catalog_therapeutic_segments', 'update'],
  ];
  const envAnterior: Record<string, string | undefined> = {};
  const setEnv = (k: string, v: string): void => { envAnterior[k] = process.env[k]; process.env[k] = v; };

  const chamar = async (metodo: string, caminho: string, body?: unknown): Promise<number> =>
    (await fetch(`${app.url}${caminho}`, {
      method: metodo,
      headers: { Authorization: tokenMock(UID), 'Content-Type': 'application/json' },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })).status;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL, max: 2 });
    await limparIamFixtures(pool, { uids: [UID], grupos: [GRUPO] });
    await pool.query(
      `INSERT INTO users (firebase_uid, email, display_name, role, status, is_active, tenant_id)
       VALUES ($1, 'pt091-seg@e2e.local', 'Segmento 091', 'admin', 'ACTIVE', true, $2)`,
      [UID, TENANT_E2E],
    );
    for (const [resource, action] of CELULAS) await garantirCelula(pool, { resource, action, category: 'Pacientes' });
    await grupoComCelulas(pool, { nome: GRUPO, uid: UID, celulas: CELULAS });

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
    await limparIamFixtures(pool, { uids: [UID], grupos: [GRUPO] });
    await pool.end();
    for (const [k, v] of Object.entries(envAnterior)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  });

  it('(1) `therapeutic_segments` tem 0 linha ativa; as 13 do seed 495 seguem lá, todas inativas pela 586', async () => {
    expect(fixtureLabels()).toHaveLength(13);
    const { rows } = await pool.query<{ ativos: number; seed: number; seed_inativos: number }>(
      `SELECT count(*) FILTER (WHERE active)::int AS ativos,
              count(*) FILTER (WHERE created_by = 'seed:495')::int AS seed,
              count(*) FILTER (WHERE created_by = 'seed:495' AND NOT active AND updated_by = 'migration:586')::int AS seed_inativos
         FROM therapeutic_segments`,
    );
    expect(rows[0]).toEqual({ ativos: 0, seed: 13, seed_inativos: 13 });
  });

  it('(2) "Personalizado" não aparece no .sql do seed nem no banco', async () => {
    expect(readFileSync(join(__dirname, '..', '..', 'migrations', '495_seed_therapeutic_segments.sql'), 'utf8')).not.toMatch(/personalizado/i);
    const { rows } = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM therapeutic_segments WHERE label ILIKE '%personalizado%'`);
    expect(rows[0].n).toBe(0);
  });

  it('(3) GET, POST e PATCH em …/segments → 404 mesmo com as células de segmento no grupo; o controle vivo (specific-objectives) → 200', async () => {
    expect(await chamar('GET', `${CATALOGO}/specific-objectives`)).toBe(200);
    expect(await chamar('GET', `${CATALOGO}/segments`)).toBe(404);
    expect(await chamar('POST', `${CATALOGO}/segments`, { label: 'E2E 091 segmento' })).toBe(404);
    expect(await chamar('PATCH', `${CATALOGO}/segments/00000000-0000-0000-0000-000000000000`, { label: 'E2E 091 segmento' })).toBe(404);
    expect((await pool.query(`SELECT count(*)::int AS n FROM therapeutic_segments WHERE label = 'E2E 091 segmento'`)).rows[0].n).toBe(0);
  });
});
