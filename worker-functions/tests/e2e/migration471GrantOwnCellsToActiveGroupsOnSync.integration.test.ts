/**
 * migration471GrantOwnCellsToActiveGroupsOnSync.integration.test.ts — revogação ESTREITA da
 * D338 (decisão do Gabriel, 23/09/2026, mig 471): célula `own_*` NOVA (nascida DEPOIS do boot,
 * pelo SYNC do catálogo — não pelo catch-up de uma migration nomeada) passa a ser concedida a
 * TODO GRUPO ATIVO, não só ao Acesso Master.
 *
 * Molde de `migration468GrantOwnPrefixCatchup.integration.test.ts` (mesmo motivo de banco
 * descartável: migration roda UMA VEZ — `schema_migrations`, D-16 — então "célula nasceu depois"
 * só se prova inserindo a célula nova DIRETO no catálogo e chamando a função de novo).
 *
 * DIFERENÇA que este arquivo prova e a 468 não prova: a 468 é o catch-up de UMA VEZ, rodado pela
 * PRÓPRIA migration, para o PASSADO (grupo que já existia). Este arquivo prova o mecanismo
 * PERMANENTE — a função `iam.grant_own_cells_to_active_groups()` que o SYNC DE BOOT chama TODA
 * VEZ — cobrindo o FUTURO: célula `own_*` que ainda nem existe hoje, e só nasce quando uma rota
 * nova declarar `perm.require('own_algumacoisa', 'acao')`.
 *
 * 🔴 Controle negativo (c): célula NÃO-own nova não é concedida a ninguém além do Master — prova
 * que a revogação da D338 é ESTREITA (só `own_*`), não uma generalização de "toda célula nova
 * vai a todo grupo".
 */
import { Pool } from 'pg';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const BASE_URL =
  process.env.TEST_DATABASE_URL
  || process.env.DATABASE_URL
  || 'postgresql://enlite_admin:enlite_password@localhost:5442/enlite_e2e';

const RUNNER = path.join(__dirname, '..', '..', 'scripts', 'run-migrations-docker.js');
const TENANT_E2E = '00000000-0000-0000-0000-000000000001';
const MASTER_ID = 'a0000000-0000-0000-0000-000000000001';

const urlPara = (db: string): string => {
  const u = new URL(BASE_URL);
  u.pathname = `/${db}`;
  return u.toString();
};

async function bancoDescartavel(sufixo: string): Promise<{ url: string; pool: Pool; destruir: () => Promise<void> }> {
  const nome = `mig471_own_sync_${sufixo}_${Date.now()}`;
  const admin = new Pool({ connectionString: BASE_URL, max: 1 });
  await admin.query(`CREATE DATABASE ${nome}`);
  const url = urlPara(nome);

  execFileSync('node', [RUNNER], { env: { ...process.env, DATABASE_URL: url }, stdio: 'pipe' });

  const pool = new Pool({ connectionString: url, max: 1 });
  return {
    url,
    pool,
    destruir: async () => {
      await pool.end();
      await admin.query(`DROP DATABASE IF EXISTS ${nome} WITH (FORCE)`);
      await admin.end();
    },
  };
}

async function grantCount(pool: Pool, groupId: string, resource: string, action: string): Promise<number> {
  const r = await pool.query<{ n: string }>(
    `SELECT COUNT(*)::text AS n
       FROM iam.group_permissions gp
       JOIN iam.permissions p ON p.id = gp.permission_id
      WHERE gp.group_id = $1 AND p.resource = $2 AND p.action = $3`,
    [groupId, resource, action],
  );
  return Number(r.rows[0].n);
}

/** Insere uma célula NOVA direto no catálogo — simula o efeito de `iam.sync_permission_cell`
 * (que o SyncPermissionCatalogUseCase chamaria célula a célula) sem precisar do app de pé. */
async function inserirCelula(pool: Pool, resource: string, action: string): Promise<void> {
  await pool.query(
    `INSERT INTO iam.permissions (resource, action, category, owner_service)
     VALUES ($1, $2, 'Comunicação', 'worker-functions')
     ON CONFLICT (resource, action) DO NOTHING`,
    [resource, action],
  );
}

/** Chama a função nomeada declarando `app.system_context` (mesmo contrato de `withSystemWrite`
 * — só o pool de sistema, com o GUC declarado, pode chamar). */
async function chamarGrantOwnCells(pool: Pool): Promise<number> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.system_context', 'e2e-471', true)`);
    const r = await client.query<{ n: number }>('SELECT iam.grant_own_cells_to_active_groups() AS n');
    await client.query('COMMIT');
    return r.rows[0].n;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

describe('migration 471 — sync de boot concede own_* NOVA a todo grupo ativo (spec 022, revogação estreita da D338)', () => {
  jest.setTimeout(180_000);

  let db: { url: string; pool: Pool; destruir: () => Promise<void> };
  let grupoAtivoId: string;
  let grupoArquivadoId: string;

  beforeAll(async () => {
    db = await bancoDescartavel('r6');

    const g1 = await db.pool.query<{ id: string }>(
      `INSERT INTO iam.permission_groups (tenant_id, name, description) VALUES ($1, $2, 'e2e — mig 471') RETURNING id`,
      [TENANT_E2E, 'E471 Grupo Ativo (pós-migração)'],
    );
    grupoAtivoId = g1.rows[0].id;

    const g2 = await db.pool.query<{ id: string }>(
      `INSERT INTO iam.permission_groups (tenant_id, name, description, archived_at)
       VALUES ($1, $2, 'e2e — mig 471 controle', now()) RETURNING id`,
      [TENANT_E2E, 'E471 Grupo Arquivado (controle)'],
    );
    grupoArquivadoId = g2.rows[0].id;
  });

  afterAll(async () => {
    if (db) await db.destruir();
  });

  it('(a) célula own_ NOVA no catálogo + chamada da função → grupos ativos JÁ EXISTENTES passam a tê-la', async () => {
    // Simula uma célula que NÃO existia quando 464-470 rodaram: nasce só agora, direto no
    // catálogo, como o SyncPermissionCatalogUseCase faria a partir de uma rota nova.
    await inserirCelula(db.pool, 'own_favorites', 'update');
    expect(await grantCount(db.pool, grupoAtivoId, 'own_favorites', 'update')).toBe(0);

    const n = await chamarGrantOwnCells(db.pool);
    expect(n).toBeGreaterThan(0);
    expect(await grantCount(db.pool, grupoAtivoId, 'own_favorites', 'update')).toBe(1);
    // O Master também já a tinha (436, roda antes na app real) OU passa a ter aqui também —
    // a função da 471 não distingue Master de outro grupo, ambos são "grupo ativo".
    expect(await grantCount(db.pool, MASTER_ID, 'own_favorites', 'update')).toBe(1);
  });

  it('(b) grupo ARQUIVADO não recebe a célula own_ nova, mesmo depois da função rodar', async () => {
    expect(await grantCount(db.pool, grupoArquivadoId, 'own_favorites', 'update')).toBe(0);
  });

  it('🔴 (c) célula NÃO-own nova NÃO é concedida a ninguém além do Master (a revogação da D338 é ESTREITA)', async () => {
    // Controle negativo: se a função (ou o mecanismo de sync) fosse generalizado por engano
    // para "toda célula nova vai a todo grupo", este teste cai.
    await inserirCelula(db.pool, 'shift_report', 'read');
    expect(await grantCount(db.pool, grupoAtivoId, 'shift_report', 'read')).toBe(0);

    await chamarGrantOwnCells(db.pool);
    // a função da 471 rodou de novo (idempotente para own_favorites) e NÃO tocou a célula
    // NÃO-own — ela continua fora de QUALQUER grupo, Master incluso (o Master só recebe pelo
    // MECANISMO DELE — 436/grant_active_permissions_to_master — não testado aqui).
    expect(await grantCount(db.pool, grupoAtivoId, 'shift_report', 'read')).toBe(0);
    expect(await grantCount(db.pool, grupoArquivadoId, 'shift_report', 'read')).toBe(0);
  });

  it('(d) sync 2× não duplica nem falha — ON CONFLICT DO NOTHING é idempotente', async () => {
    const antes = await grantCount(db.pool, grupoAtivoId, 'own_favorites', 'update');
    await expect(chamarGrantOwnCells(db.pool)).resolves.toBeDefined();
    await expect(chamarGrantOwnCells(db.pool)).resolves.toBeDefined();
    const depois = await grantCount(db.pool, grupoAtivoId, 'own_favorites', 'update');
    expect(depois).toBe(antes);
    expect(depois).toBe(1);
  });

  it('sem `app.system_context` declarado, a função RECUSA (mesmo gate da 436/451 — nunca chamável por app_runtime forjando o GUC)', async () => {
    await expect(db.pool.query('SELECT iam.grant_own_cells_to_active_groups() AS n')).rejects.toMatchObject({
      code: '42501',
    });
  });
});
