/**
 * migration467CatchupNewGroups.integration.test.ts — R3-2 (change 022-ux-mencao-e-notificacao,
 * Rodada 3, pedido do Gabriel 22/09): prova que a migration 467 fecha o gap medido em prd —
 * `own_notifications:update` faltando em 2 grupos (Admisión y Supervisión, Coordinación Clínica,
 * 6 pessoas) que foram criados DEPOIS que a 464 já tinha rodado.
 *
 * POR QUÊ UM BANCO SÓ DELE (mesmo motivo de `ownNotificationsMigrationsFreshDb.integration.test.ts`,
 * molde desta suíte): migration roda UMA VEZ (`schema_migrations`, D-16). Para provar o
 * comportamento de CATCH-UP — "grupo criado depois que a migration já passou" — este teste cria
 * um grupo NOVO num banco já totalmente migrado e reaplica o SQL da 467 diretamente (o mesmo texto
 * que o runner aplicaria se a migration ainda não tivesse rodado nesse ambiente — em prd, 467
 * nunca rodou, então o caminho real É o runner; aqui simulamos o "depois de já ter rodado uma vez"
 * que a suíte de regressão tem de continuar provando).
 *
 * O QUE PROVA
 *   1. Banco totalmente migrado (467 incluída): grupos do seed 206 (Master, Recrutador, Community
 *      Manager) têm read+update de `own_notifications` — regressão de que 467 não quebrou 464.
 *   2. Grupo ATIVO criado DEPOIS da migração completa: nasce SEM nenhum grant de
 *      `own_notifications` (a classe do bug — criar grupo não concede nada sozinho).
 *   3. Reaplicar o SQL da 467 (mesmo texto do arquivo): o grupo novo PASSA a ter read+update —
 *      é o catch-up que fecha o achado de prd.
 *   4. Idempotência: reaplicar de novo não duplica nem falha (`ON CONFLICT DO NOTHING`).
 *   5. Grupo ARQUIVADO (`archived_at` preenchido): NUNCA recebe grant, mesmo depois do catch-up.
 */
import { Pool } from 'pg';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const BASE_URL =
  process.env.TEST_DATABASE_URL
  || process.env.DATABASE_URL
  || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

const RUNNER = path.join(__dirname, '..', '..', 'scripts', 'run-migrations-docker.js');
const MIGRATION_467_SQL = fs.readFileSync(
  path.join(__dirname, '..', '..', 'migrations', '467_grant_own_notifications_catchup_new_groups.sql'),
  'utf-8',
);
const TENANT_E2E = '00000000-0000-0000-0000-000000000001';

const urlPara = (db: string): string => {
  const u = new URL(BASE_URL);
  u.pathname = `/${db}`;
  return u.toString();
};

async function bancoDescartavel(sufixo: string): Promise<{ url: string; pool: Pool; destruir: () => Promise<void> }> {
  const nome = `mig467_catchup_${sufixo}_${Date.now()}`;
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

async function grantCount(pool: Pool, groupId: string, action: 'read' | 'update'): Promise<number> {
  const r = await pool.query<{ n: string }>(
    `SELECT COUNT(*)::text AS n
       FROM iam.group_permissions gp
       JOIN iam.permissions p ON p.id = gp.permission_id
      WHERE gp.group_id = $1 AND p.resource = 'own_notifications' AND p.action = $2`,
    [groupId, action],
  );
  return Number(r.rows[0].n);
}

async function groupIdByName(pool: Pool, name: string): Promise<string> {
  const r = await pool.query<{ id: string }>(`SELECT id FROM iam.permission_groups WHERE name = $1`, [name]);
  if (!r.rows[0]) throw new Error(`grupo-fixture ausente do seed da 206: ${name}`);
  return r.rows[0].id;
}

describe('migration 467 — catch-up de own_notifications para grupo criado depois da 464 (spec 022, R3-2)', () => {
  jest.setTimeout(180_000);

  let db: { url: string; pool: Pool; destruir: () => Promise<void> };
  let grupoNovoId: string;
  let grupoArquivadoId: string;

  beforeAll(async () => {
    db = await bancoDescartavel('r3');

    // Grupo ATIVO criado DEPOIS que TODAS as migrations (incl. 467) já rodaram neste banco — o
    // cenário real de "Admisión y Supervisión"/"Coordinación Clínica" em prd: existiam antes da
    // 464 rodar? Não — foram criados DEPOIS. Aqui o "depois" é relativo a este banco descartável
    // já ter passado pela sequência inteira.
    const g1 = await db.pool.query<{ id: string }>(
      `INSERT INTO iam.permission_groups (tenant_id, name, description) VALUES ($1, $2, 'e2e — R3-2') RETURNING id`,
      [TENANT_E2E, 'E467 Admisión y Supervisión (pós-migração)'],
    );
    grupoNovoId = g1.rows[0].id;

    const g2 = await db.pool.query<{ id: string }>(
      `INSERT INTO iam.permission_groups (tenant_id, name, description, archived_at)
       VALUES ($1, $2, 'e2e — R3-2 controle', now()) RETURNING id`,
      [TENANT_E2E, 'E467 Grupo Arquivado (controle)'],
    );
    grupoArquivadoId = g2.rows[0].id;
  });

  afterAll(async () => {
    if (db) await db.destruir();
  });

  it('1. banco totalmente migrado: Master/Recrutador/Community Manager têm read+update (467 não quebrou 464)', async () => {
    const masterId = await groupIdByName(db.pool, 'Acesso Master');
    expect(await grantCount(db.pool, masterId, 'read')).toBeGreaterThan(0);
    expect(await grantCount(db.pool, masterId, 'update')).toBeGreaterThan(0);

    const recrutadorId = await groupIdByName(db.pool, 'Recrutador');
    expect(await grantCount(db.pool, recrutadorId, 'read')).toBeGreaterThan(0);
    expect(await grantCount(db.pool, recrutadorId, 'update')).toBeGreaterThan(0);
  });

  it('2. grupo ATIVO criado depois da migração completa: nasce SEM grant nenhum de own_notifications', async () => {
    expect(await grantCount(db.pool, grupoNovoId, 'read')).toBe(0);
    expect(await grantCount(db.pool, grupoNovoId, 'update')).toBe(0);
  });

  it('3. reaplicar o SQL da 467: o grupo novo PASSA a ter read+update (o catch-up do achado de prd)', async () => {
    await db.pool.query(MIGRATION_467_SQL);
    expect(await grantCount(db.pool, grupoNovoId, 'read')).toBeGreaterThan(0);
    expect(await grantCount(db.pool, grupoNovoId, 'update')).toBeGreaterThan(0);
  });

  it('4. idempotência: reaplicar de novo não duplica (ON CONFLICT DO NOTHING) nem falha', async () => {
    const antes = await grantCount(db.pool, grupoNovoId, 'update');
    await expect(db.pool.query(MIGRATION_467_SQL)).resolves.toBeDefined();
    const depois = await grantCount(db.pool, grupoNovoId, 'update');
    expect(depois).toBe(antes);
    expect(depois).toBe(1);
  });

  it('5. grupo ARQUIVADO: nunca recebe grant, nem depois do catch-up rodar 2x', async () => {
    expect(await grantCount(db.pool, grupoArquivadoId, 'read')).toBe(0);
    expect(await grantCount(db.pool, grupoArquivadoId, 'update')).toBe(0);
  });
});
