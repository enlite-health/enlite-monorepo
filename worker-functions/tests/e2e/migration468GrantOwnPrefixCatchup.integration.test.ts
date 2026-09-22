/**
 * migration468GrantOwnPrefixCatchup.integration.test.ts — R4-1 (change 022-ux-mencao-e-notificacao,
 * Rodada 4, pedido do Gabriel 22/09): prova que a migration 468 fecha o gap medido em prd —
 * 145 DENY de `own_presence:update` em 6h, 3 grupos criados no mesmo dia (Coordinación Clínica,
 * Admisión y Supervisión, Finanzas) sem NENHUMA célula `own_*`.
 *
 * Molde de `migration467CatchupNewGroups.integration.test.ts` (mesmo motivo de banco descartável:
 * migration roda UMA VEZ — `schema_migrations`, D-16 — então "grupo criado depois" só se prova
 * reaplicando o SQL num banco já totalmente migrado).
 *
 * DIFERENÇA que este arquivo prova e a 467 não provava: a 468 usa um filtro de PREFIXO
 * (`resource LIKE 'own\_%'`), não uma lista de resources — cobre `own_notifications` E
 * `own_presence` na MESMA passada (a 467 só cobria `own_notifications`; `own_presence` ficou de
 * fora até hoje). O teste 3 é o que fecha o achado: um grupo novo recebe as DUAS famílias.
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
const MIGRATION_468_SQL = fs.readFileSync(
  path.join(__dirname, '..', '..', 'migrations', '468_grant_own_prefix_cells_catchup_new_groups.sql'),
  'utf-8',
);
const TENANT_E2E = '00000000-0000-0000-0000-000000000001';

const urlPara = (db: string): string => {
  const u = new URL(BASE_URL);
  u.pathname = `/${db}`;
  return u.toString();
};

async function bancoDescartavel(sufixo: string): Promise<{ url: string; pool: Pool; destruir: () => Promise<void> }> {
  const nome = `mig468_catchup_${sufixo}_${Date.now()}`;
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

describe('migration 468 — catch-up GENÉRICO (prefixo own_*) para grupo criado depois das migrations nomeadas (spec 022, R4-1)', () => {
  jest.setTimeout(180_000);

  let db: { url: string; pool: Pool; destruir: () => Promise<void> };
  let grupoNovoId: string;
  let grupoArquivadoId: string;

  beforeAll(async () => {
    db = await bancoDescartavel('r4');

    // Grupo ATIVO criado DEPOIS que TODAS as migrations (incl. 468) já rodaram neste banco —
    // o cenário real de "Coordinación Clínica"/"Admisión y Supervisión"/"Finanzas" em prd.
    const g1 = await db.pool.query<{ id: string }>(
      `INSERT INTO iam.permission_groups (tenant_id, name, description) VALUES ($1, $2, 'e2e — R4-1') RETURNING id`,
      [TENANT_E2E, 'E468 Finanzas (pós-migração)'],
    );
    grupoNovoId = g1.rows[0].id;

    const g2 = await db.pool.query<{ id: string }>(
      `INSERT INTO iam.permission_groups (tenant_id, name, description, archived_at)
       VALUES ($1, $2, 'e2e — R4-1 controle', now()) RETURNING id`,
      [TENANT_E2E, 'E468 Grupo Arquivado (controle)'],
    );
    grupoArquivadoId = g2.rows[0].id;
  });

  afterAll(async () => {
    if (db) await db.destruir();
  });

  it('1. banco totalmente migrado: Master tem read+update de own_notifications e update de own_presence (468 não quebrou 464/466/467)', async () => {
    const masterId = 'a0000000-0000-0000-0000-000000000001';
    expect(await grantCount(db.pool, masterId, 'own_notifications', 'read')).toBeGreaterThan(0);
    expect(await grantCount(db.pool, masterId, 'own_notifications', 'update')).toBeGreaterThan(0);
    expect(await grantCount(db.pool, masterId, 'own_presence', 'update')).toBeGreaterThan(0);
  });

  it('2. grupo ATIVO criado depois da migração completa: nasce SEM NENHUMA célula own_* (a classe do bug — 145 DENY/6h em prd)', async () => {
    expect(await grantCount(db.pool, grupoNovoId, 'own_notifications', 'read')).toBe(0);
    expect(await grantCount(db.pool, grupoNovoId, 'own_notifications', 'update')).toBe(0);
    expect(await grantCount(db.pool, grupoNovoId, 'own_presence', 'update')).toBe(0);
  });

  it('3. reaplicar o SQL da 468: o grupo novo PASSA a ter as DUAS famílias own_* na MESMA passada (o catch-up genérico)', async () => {
    await db.pool.query(MIGRATION_468_SQL);
    expect(await grantCount(db.pool, grupoNovoId, 'own_notifications', 'read')).toBeGreaterThan(0);
    expect(await grantCount(db.pool, grupoNovoId, 'own_notifications', 'update')).toBeGreaterThan(0);
    expect(await grantCount(db.pool, grupoNovoId, 'own_presence', 'update')).toBeGreaterThan(0);
  });

  it('4. idempotência: reaplicar de novo não duplica (ON CONFLICT DO NOTHING) nem falha', async () => {
    const antes = await grantCount(db.pool, grupoNovoId, 'own_presence', 'update');
    await expect(db.pool.query(MIGRATION_468_SQL)).resolves.toBeDefined();
    const depois = await grantCount(db.pool, grupoNovoId, 'own_presence', 'update');
    expect(depois).toBe(antes);
    expect(depois).toBe(1);
  });

  it('5. grupo ARQUIVADO: nunca recebe grant nenhum, mesmo depois do catch-up rodar 2x', async () => {
    expect(await grantCount(db.pool, grupoArquivadoId, 'own_notifications', 'read')).toBe(0);
    expect(await grantCount(db.pool, grupoArquivadoId, 'own_notifications', 'update')).toBe(0);
    expect(await grantCount(db.pool, grupoArquivadoId, 'own_presence', 'update')).toBe(0);
  });
});
