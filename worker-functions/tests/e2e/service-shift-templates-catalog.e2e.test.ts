/**
 * Spec 074 (guardias predefinidas) — API do catálogo (migration 550) sob o ENGINE DE PERMISSÃO
 * LIGADO (família admin.patients), HTTP real, banco real. Sem mock de dado. Molde:
 * `service-exit-reasons-catalog.e2e.test.ts`.
 *
 * O que se prova:
 *   A1. POST cria guardia e GET devolve os itens (e `items: []` → 400, prova HTTP do zod);
 *   A2. PATCH com itens sobrepostos → 422 e os itens antigos ficam intactos (relidos do banco);
 *   A3. `options` não traz guardia desativada e funciona para quem só tem `patient_services:read`;
 *   A4. sem a célula, o POST responde 403 e nenhuma linha nova existe no banco.
 */
import { Pool } from 'pg';
import { montarAppDeFamilia, tokenMock, grupoComCelulas, limparIamFixtures, garantirCelula, TENANT_E2E, type AppDeFamilia } from './helpers/permissionFamilyHarness';

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

const BASE = '/api/admin/therapeutic-catalogs/service-shift-templates';
const PREFIXO = 'QA 074 API ';

describe('spec 074 — catálogo de guardias predefinidas (550): API sob engine de permissão', () => {
  let pool: Pool;
  let app: AppDeFamilia;
  let donaDeServicosRead = false;

  const U = { admin: 'sst550-admin', leitor: 'sst550-leitor', outraCelula: 'sst550-outra' };
  const GRUPOS = { admin: 'SST550 Admin do catálogo', leitor: 'SST550 Só serviços', outraCelula: 'SST550 Só atividades' };
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
    // Itens antes das guardias (FK RESTRICT).
    await pool.query(
      `DELETE FROM service_shift_template_items WHERE template_id IN (SELECT id FROM service_shift_templates WHERE label LIKE $1)`,
      [`${PREFIXO}%`],
    );
    await pool.query(`DELETE FROM service_shift_templates WHERE label LIKE $1`, [`${PREFIXO}%`]);
    await pool.query(`DELETE FROM therapeutic_activities WHERE label LIKE $1`, [`${PREFIXO}%`]);
    if (donaDeServicosRead) {
      await pool.query(`DELETE FROM iam.permissions WHERE resource = 'patient_services' AND action = 'read'`);
      donaDeServicosRead = false;
    }
  }

  const itensDoBanco = async (id: string) => (await pool.query<{ s: string; d: number }>(
    `SELECT to_char(start_time, 'HH24:MI') AS s, duration_minutes AS d
       FROM service_shift_template_items WHERE template_id = $1 ORDER BY start_time`, [id])).rows;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    await limpar();
    await pool.query(
      `INSERT INTO users (firebase_uid, email, display_name, role, status, is_active, tenant_id) VALUES
         ($1, 'sst550-admin@e2e.local', 'Admin Guardias', 'admin', 'ACTIVE', true, $3),
         ($2, 'sst550-leitor@e2e.local', 'Leitor Serviços', 'admin', 'ACTIVE', true, $3),
         ($4, 'sst550-outra@e2e.local', 'Outra célula', 'admin', 'ACTIVE', true, $3)`,
      [U.admin, U.leitor, TENANT_E2E, U.outraCelula],
    );
    // As 3 células de `catalog_service_shift_templates` NÃO são garantidas aqui de propósito:
    // `grupoComCelulas` FALHA ALTO se a 550 não as semeou — é a prova.
    donaDeServicosRead = (await garantirCelula(pool, { resource: 'patient_services', action: 'read', category: 'Pacientes' })).criada;
    await grupoComCelulas(pool, {
      nome: GRUPOS.admin, uid: U.admin,
      celulas: [
        ['catalog_service_shift_templates', 'read'], ['catalog_service_shift_templates', 'create'], ['catalog_service_shift_templates', 'update'],
        ['patient_services', 'read'],
      ],
    });
    await grupoComCelulas(pool, { nome: GRUPOS.leitor, uid: U.leitor, celulas: [['patient_services', 'read']] });
    // Caso 403: TEM a célula de OUTRO catálogo e NÃO a das guardias.
    await grupoComCelulas(pool, { nome: GRUPOS.outraCelula, uid: U.outraCelula, celulas: [['catalog_therapeutic_activities', 'create']] });

    setEnv('USE_MOCK_AUTH', 'true');
    setEnv('PERMISSION_ENGINE_ENABLED', 'true');
    setEnv('PERMISSION_ENFORCED_ROUTES', 'admin.patients');
    setEnv('PERMISSION_CACHE_TTL_MS', '0');
    setEnv('DATABASE_URL', DATABASE_URL);

    const caseModule = await import('@modules/case');
    app = await montarAppDeFamilia({
      enforcedRoutes: 'admin.patients',
      montarRotas: ({ app: express, auth, permissions }) =>
        express.use('/api/admin', caseModule.createAdminTherapeuticProjectsRoutes(new caseModule.AdminTherapeuticProjectsController(), auth, permissions, new caseModule.AdminServiceShiftTemplatesController())),
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

  it('A1 POST cria guardia e GET devolve os itens', async () => {
    const vazio = await chamar('POST', BASE, U.admin, { label: `${PREFIXO}vazia`, items: [] });
    expect(vazio.status).toBe(400);

    const novo = await chamar('POST', BASE, U.admin, {
      label: `${PREFIXO}manhã e noite`,
      items: [{ startTime: '20:00', durationMinutes: 720 }, { startTime: '08:00', durationMinutes: 720 }],
    });
    expect(novo.status).toBe(201);
    expect(novo.body.data.code).toBe(novo.body.data.id);

    const lista = await chamar('GET', BASE, U.admin);
    expect(lista.status).toBe(200);
    const achada = lista.body.data.items.find((g: { id: string }) => g.id === novo.body.data.id);
    expect(achada.items).toEqual([{ startTime: '08:00', durationMinutes: 720 }, { startTime: '20:00', durationMinutes: 720 }]);
  });

  it('A2 PATCH com itens sobrepostos responde 422 e os itens antigos ficam intactos (relidos do banco)', async () => {
    const g = await chamar('POST', BASE, U.admin, {
      label: `${PREFIXO}sobreposição`,
      items: [{ startTime: '08:00', durationMinutes: 360 }, { startTime: '14:00', durationMinutes: 360 }],
    });
    expect(g.status).toBe(201);
    const r = await chamar('PATCH', `${BASE}/${g.body.data.id}`, U.admin, {
      items: [{ startTime: '08:00', durationMinutes: 600 }, { startTime: '14:00', durationMinutes: 360 }],
    });
    expect(r.status).toBe(422);
    expect(r.body.code).toBe('SHIFT_TEMPLATE_ITEMS_OVERLAP');
    expect(await itensDoBanco(g.body.data.id)).toEqual([{ s: '08:00', d: 360 }, { s: '14:00', d: 360 }]);
  });

  it('A3 options não traz guardia desativada e traz para quem só tem patient_services:read', async () => {
    const ativa = await chamar('POST', BASE, U.admin, { label: `${PREFIXO}ativa`, items: [{ startTime: '08:00', durationMinutes: 480 }] });
    const inativa = await chamar('POST', BASE, U.admin, { label: `${PREFIXO}inativa`, items: [{ startTime: '08:00', durationMinutes: 480 }] });
    expect(ativa.status).toBe(201);
    expect(inativa.status).toBe(201);
    const off = await chamar('PATCH', `${BASE}/${inativa.body.data.id}`, U.admin, { active: false });
    expect(off.body.data.active).toBe(false);

    const opcoes = await chamar('GET', `${BASE}/options`, U.leitor);
    expect(opcoes.status).toBe(200);
    const ids: string[] = opcoes.body.data.items.map((i: { id: string }) => i.id);
    expect(ids).toContain(ativa.body.data.id);
    expect(ids).not.toContain(inativa.body.data.id);
    expect(opcoes.body.data.items.find((i: { id: string }) => i.id === ativa.body.data.id).items).toEqual([{ startTime: '08:00', durationMinutes: 480 }]);
  });

  it('A4 sem a célula o POST responde 403 e nenhuma linha nova existe no banco', async () => {
    // Controle positivo: a célula que este usuário tem VALE — cria em /activities.
    const controle = await chamar('POST', '/api/admin/therapeutic-catalogs/activities', U.outraCelula, { label: `${PREFIXO}Controle atividade` });
    expect(controle.status).toBe(201);

    const r = await chamar('POST', BASE, U.outraCelula, { label: `${PREFIXO}sem permissão`, items: [{ startTime: '08:00', durationMinutes: 60 }] });
    expect(r.status).toBe(403);
    const db = await pool.query(`SELECT 1 FROM service_shift_templates WHERE label = $1`, [`${PREFIXO}sem permissão`]);
    expect(db.rowCount).toBe(0);
    // A lista de administração também exige a célula própria.
    expect((await chamar('GET', BASE, U.leitor)).status).toBe(403);
  });
});
