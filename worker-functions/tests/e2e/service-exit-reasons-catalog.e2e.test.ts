/**
 * Change itinerario-trocas-motivos-e-figma, Fase 1 — catálogo de motivos de saída do serviço
 * (migration 492) sob o ENGINE DE PERMISSÃO LIGADO (família admin.patients), HTTP real, banco real.
 * Sem mock de dado. Molde: `therapeutic-projects-api.e2e.test.ts`.
 *
 * O que se prova:
 *   1. a carga inicial tem os 4 códigos com os rótulos que a tela já mostrava (F8);
 *   2. item criado pelo admin recebe `code = id::text` (trigger);
 *   3. `UPDATE … SET code` é recusado pelo trigger (o código é o que as marcas referenciam);
 *   4. rótulo duplicado entre ativos → 409 `catalog_label_taken`;
 *   5. `options` devolve só ativos, na ordem `sort_order, lower(label)` — e quem só tem
 *      `patient_services:read` consegue ler;
 *   6. sem a célula `catalog_service_exit_reasons:create` → 403 no POST (e nada criado);
 *   7. a migration aplicada 2× não dá erro (idempotente).
 */
import fs from 'fs';
import path from 'path';
import { Pool } from 'pg';
import { montarAppDeFamilia, tokenMock, grupoComCelulas, limparIamFixtures, TENANT_E2E, type AppDeFamilia } from './helpers/permissionFamilyHarness';

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

const BASE = '/api/admin/therapeutic-catalogs/service-exit-reasons';
const PREFIXO = 'E2E 492 ';

const CARGA_INICIAL: ReadonlyArray<readonly [string, string]> = [
  ['PERFIL_INADEQUADO_AO_SERVICO', 'Perfil no adecuado al servicio'],
  ['INDISPONIBILIDADE_DE_HORARIO', 'Sin disponibilidad horaria'],
  ['DESISTENCIA_DO_PRESTADOR', 'El prestador desistió'],
  ['OTHER', 'Otro'],
];

describe('change itinerario-trocas — catálogo de motivos de saída (492): API sob engine de permissão', () => {
  let pool: Pool;
  let app: AppDeFamilia;

  const U = { admin: 'ser492-admin', leitor: 'ser492-leitor' };
  const GRUPOS = { admin: 'SER492 Admin do catálogo', leitor: 'SER492 Só serviços' };
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
    await pool.query(`DELETE FROM service_exit_reasons WHERE label LIKE $1`, [`${PREFIXO}%`]);
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    await limpar();
    await pool.query(
      `INSERT INTO users (firebase_uid, email, display_name, role, status, is_active, tenant_id) VALUES
         ($1, 'ser492-admin@e2e.local', 'Admin Catálogo', 'admin', 'ACTIVE', true, $3),
         ($2, 'ser492-leitor@e2e.local', 'Leitor Serviços', 'admin', 'ACTIVE', true, $3)`,
      [U.admin, U.leitor, TENANT_E2E],
    );
    // `grupoComCelulas` FALHA ALTO se a célula não existe em iam.permissions: é a prova de que a
    // 492 semeou as 3 células (não há `garantirCelula` aqui de propósito).
    await grupoComCelulas(pool, {
      nome: GRUPOS.admin, uid: U.admin,
      celulas: [
        ['catalog_service_exit_reasons', 'read'], ['catalog_service_exit_reasons', 'create'], ['catalog_service_exit_reasons', 'update'],
        ['patient_services', 'read'],
      ],
    });
    await grupoComCelulas(pool, { nome: GRUPOS.leitor, uid: U.leitor, celulas: [['patient_services', 'read']] });

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
    await pool.end();
    for (const [k, v] of Object.entries(envAnterior)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  });

  it('1. a carga inicial tem os 4 códigos com os rótulos de hoje (banco e API concordam)', async () => {
    const db = await pool.query<{ code: string; label: string }>(
      `SELECT code, label FROM service_exit_reasons WHERE code = ANY($1)`, [CARGA_INICIAL.map(([c]) => c)],
    );
    const porCodigo = new Map(db.rows.map((r) => [r.code, r.label]));
    for (const [code, label] of CARGA_INICIAL) expect(porCodigo.get(code)).toBe(label);
    expect(db.rows).toHaveLength(4);

    const lista = await chamar('GET', BASE, U.admin);
    expect(lista.status).toBe(200);
    const viaApi = new Map<string, string>(lista.body.data.items.map((i: { code: string; label: string }) => [i.code, i.label]));
    for (const [code, label] of CARGA_INICIAL) expect(viaApi.get(code)).toBe(label);
  });

  it('2. item criado pelo admin recebe `code = id::text`', async () => {
    const novo = await chamar('POST', BASE, U.admin, { label: `${PREFIXO}Cambio de disponibilidad` });
    expect(novo.status).toBe(201);
    expect(novo.body.data).toMatchObject({ label: `${PREFIXO}Cambio de disponibilidad`, active: true });
    expect(novo.body.data.code).toBe(novo.body.data.id);
    const db = await pool.query<{ code: string }>(`SELECT code FROM service_exit_reasons WHERE id = $1`, [novo.body.data.id]);
    expect(db.rows[0].code).toBe(novo.body.data.id);
  });

  it('3. `UPDATE … SET code` é recusado pelo trigger; o PATCH de rótulo não mexe no código', async () => {
    await expect(
      pool.query(`UPDATE service_exit_reasons SET code = 'OUTRO_CODIGO' WHERE code = 'OTHER'`),
    ).rejects.toThrow(/imut[aá]vel/i);
    const depois = await pool.query<{ label: string }>(`SELECT label FROM service_exit_reasons WHERE code = 'OTHER'`);
    expect(depois.rows).toHaveLength(1);

    const item = await pool.query<{ id: string; code: string }>(
      `SELECT id, code FROM service_exit_reasons WHERE label = $1`, [`${PREFIXO}Cambio de disponibilidad`],
    );
    const renomeado = await chamar('PATCH', `${BASE}/${item.rows[0].id}`, U.admin, { label: `${PREFIXO}Cambio de turno` });
    expect(renomeado.status).toBe(200);
    expect(renomeado.body.data.code).toBe(item.rows[0].code);
  });

  it('4. rótulo duplicado entre ativos → 409 catalog_label_taken (case/espaços ignorados)', async () => {
    const dup = await chamar('POST', BASE, U.admin, { label: `  ${PREFIXO.toLowerCase()}CAMBIO DE TURNO ` });
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe('catalog_label_taken');
  });

  it('5. `options` devolve só ativos, ordenados por sort_order e rótulo; quem só tem patient_services:read consegue ler', async () => {
    const extra = await chamar('POST', BASE, U.admin, { label: `${PREFIXO}Motivo desativado` });
    expect(extra.status).toBe(201);
    const off = await chamar('PATCH', `${BASE}/${extra.body.data.id}`, U.admin, { active: false });
    expect(off.body.data.active).toBe(false);

    const opcoes = await chamar('GET', `${BASE}/options`, U.leitor);
    expect(opcoes.status).toBe(200);
    const items: Array<{ code: string; label: string }> = opcoes.body.data.items;
    expect(items.some((i) => i.label === `${PREFIXO}Motivo desativado`)).toBe(false);
    expect(items.some((i) => i.code === 'OTHER')).toBe(true);
    for (const i of items) expect(Object.keys(i).sort()).toEqual(['code', 'label']);

    const esperado = await pool.query<{ code: string }>(
      `SELECT code FROM service_exit_reasons WHERE active ORDER BY sort_order, lower(label)`,
    );
    expect(items.map((i) => i.code)).toEqual(esperado.rows.map((r) => r.code));
    expect(items.length).toBeGreaterThanOrEqual(5);
  });

  it('6. sem a célula `catalog_service_exit_reasons:create` → 403 no POST, e nada é criado', async () => {
    const r = await chamar('POST', BASE, U.leitor, { label: `${PREFIXO}Sem permissão` });
    expect(r.status).toBe(403);
    const db = await pool.query(`SELECT 1 FROM service_exit_reasons WHERE label = $1`, [`${PREFIXO}Sem permissão`]);
    expect(db.rowCount).toBe(0);
    // A leitura da lista de administração também exige a célula própria (não basta patient_services:read).
    const lista = await chamar('GET', BASE, U.leitor);
    expect(lista.status).toBe(403);
  });

  it('7. a migration 492 aplicada 2× não dá erro e não duplica a carga', async () => {
    const sql = fs.readFileSync(path.join(__dirname, '../../migrations/492_service_exit_reasons.sql'), 'utf8');
    await pool.query(sql);
    await pool.query(sql);
    const carga = await pool.query(`SELECT 1 FROM service_exit_reasons WHERE code = ANY($1)`, [CARGA_INICIAL.map(([c]) => c)]);
    expect(carga.rowCount).toBe(4);
    const celulas = await pool.query(`SELECT 1 FROM iam.permissions WHERE resource = 'catalog_service_exit_reasons'`);
    expect(celulas.rowCount).toBe(3);
  });
});
