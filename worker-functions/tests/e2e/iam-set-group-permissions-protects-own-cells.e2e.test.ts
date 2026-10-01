import { Pool, PoolClient } from 'pg';

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5442/enlite_e2e';

/**
 * iam-set-group-permissions-protects-own-cells.e2e.test.ts — R5-2 (change
 * 022-ux-mencao-e-notificacao, Rodada 5, achado A5 do gate da rodada 4, decisão do
 * Gabriel 22/09).
 *
 * O QUE PROVA (Postgres real, `iam.set_group_permissions`, migration 470):
 *   `iam.set_group_permissions` (279) é REPLACE TOTAL — grava exatamente o conjunto
 *   enviado, removendo tudo que sobrar. Como as células `own_*` nascem concedidas na
 *   criação do grupo (469), salvar a matriz do painel SEM marcá-las revogava o sino e
 *   a presença daquele grupo (medido em prd: 111 DENY em 2h quando a presença faltava).
 *   A migration 470 exclui `resource LIKE 'own\_%' ESCAPE '\'` do DELETE — este arquivo
 *   é o teste que MORRE se essa exclusão sumir (ver docs/diario de sabotagem no
 *   tasks.md da change).
 *
 * Casos:
 *   1. lista SEM as own_* → as 3 continuam em `group_permissions`; a trilha NÃO grava
 *      'remove' fantasma para elas.
 *   2. lista COM uma own_* → idempotente, sem duplicar linha nem trilha 'add' repetida.
 *   3. célula NÃO-own fora da lista É removida normalmente (a semântica REPLACE segue
 *      valendo para o resto) — obrigatório, senão a proteção vira buraco que esconde
 *      qualquer célula sensível atrás do prefixo errado.
 *
 * Padrão do harness: igual a `iam-permissions-foundation.test.ts` — `SET LOCAL ROLE
 * app_runtime` dentro de transação + GUC `app.user_uid`, nunca parâmetro.
 */
describe('iam.set_group_permissions protege own_* do REPLACE TOTAL (migration 470, R5-2)', () => {
  let pool: Pool;

  const TENANT = 'e0700000-0000-0000-0000-000000000005';
  const U = { gestor: 'iam-r5-gestor' };
  const GROUP_NAME = 'IAM R5 Protege Own';

  let groupId: string;
  let ownIds: { notifRead: string; notifUpdate: string; presenceUpdate: string };
  let vacancyIds: { read: string; create: string; update: string };

  async function cleanup(): Promise<void> {
    // 'IAM R5 %' cobre os DOIS grupos: o grupo sob teste (GROUP_NAME) e o grupo de
    // gestão criado só para dar permission_management:write ao ator ('IAM R5 Gestores')
    // — sem limpar o segundo, o DELETE de iam.tenants no fim quebra por FK.
    await pool.query(
      `DELETE FROM iam.permission_group_changes WHERE group_id IN (SELECT id FROM iam.permission_groups WHERE name LIKE 'IAM R5 %')`,
    );
    await pool.query(
      `DELETE FROM iam.group_permissions WHERE group_id IN (SELECT id FROM iam.permission_groups WHERE name LIKE 'IAM R5 %')`,
    );
    await pool.query(`DELETE FROM iam.user_groups WHERE user_id = $1`, [U.gestor]);
    await pool.query(`DELETE FROM iam.permission_groups WHERE name LIKE 'IAM R5 %'`);
    await pool.query(`DELETE FROM users WHERE firebase_uid = $1`, [U.gestor]);
    await pool.query(`DELETE FROM iam.tenants WHERE id = $1`, [TENANT]);
  }

  async function asRole<T>(
    role: 'app_runtime',
    ctx: { uid: string },
    fn: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL ROLE ${role}`);
      await client.query(`SELECT set_config('app.user_uid', $1, true)`, [ctx.uid]);
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  async function cellsOf(gid: string): Promise<Array<{ resource: string; action: string }>> {
    const r = await pool.query<{ resource: string; action: string }>(
      `SELECT p.resource, p.action FROM iam.group_permissions gp JOIN iam.permissions p ON p.id = gp.permission_id
        WHERE gp.group_id = $1 ORDER BY 1, 2`,
      [gid],
    );
    return r.rows;
  }

  async function trailOf(gid: string): Promise<Array<{ op: string; resource: string; action: string }>> {
    const r = await pool.query<{ op: string; resource: string; action: string }>(
      `SELECT c.op, p.resource, p.action FROM iam.permission_group_changes c JOIN iam.permissions p ON p.id = c.permission_id
        WHERE c.group_id = $1 ORDER BY c.changed_at, p.resource, p.action`,
      [gid],
    );
    return r.rows;
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    await cleanup();

    await pool.query(`INSERT INTO iam.tenants (id, name, region, status) VALUES ($1, 'IAM R5 Tenant', 'SA', 'ACTIVE')`, [TENANT]);
    await pool.query(
      `INSERT INTO users (firebase_uid, email, role, status, is_active, tenant_id) VALUES ($1, 'iam-r5-gestor@e2e.local', 'admin', 'ACTIVE', true, $2)`,
      [U.gestor, TENANT],
    );
    // grupo próprio com permission_management:write — actor vira gestor SEM depender do
    // Acesso Master compartilhado (isolamento entre suítes)
    const g = await pool.query(
      `INSERT INTO iam.permission_groups (tenant_id, name, description, is_system) VALUES ($1, 'IAM R5 Gestores', 'e2e', false) RETURNING id`,
      [TENANT],
    );
    await pool.query(
      `INSERT INTO iam.group_permissions (group_id, permission_id) SELECT $1, id FROM iam.permissions WHERE resource = 'permission_management'`,
      [g.rows[0].id],
    );
    await pool.query(`INSERT INTO iam.user_groups (user_id, group_id, tenant_id) VALUES ($1, $2, $3)`, [U.gestor, g.rows[0].id, TENANT]);

    const own = await pool.query<{ id: string; resource: string; action: string }>(
      `SELECT id, resource, action FROM iam.permissions WHERE resource LIKE 'own\\_%' ESCAPE '\\'`,
    );
    ownIds = {
      notifRead: own.rows.find((r) => r.resource === 'own_notifications' && r.action === 'read')!.id,
      notifUpdate: own.rows.find((r) => r.resource === 'own_notifications' && r.action === 'update')!.id,
      presenceUpdate: own.rows.find((r) => r.resource === 'own_presence' && r.action === 'update')!.id,
    };
    const vac = await pool.query<{ id: string; action: string }>(
      `SELECT id, action FROM iam.permissions WHERE resource = 'vacancy' AND deprecated_at IS NULL`,
    );
    vacancyIds = {
      read: vac.rows.find((r) => r.action === 'read')!.id,
      create: vac.rows.find((r) => r.action === 'create')!.id,
      update: vac.rows.find((r) => r.action === 'update')!.id,
    };
  });

  afterAll(async () => {
    await cleanup();
    await pool.end();
  });

  it('setup: iam.create_group concede as 3 own_* na criação (linha de base — mig 469)', async () => {
    groupId = await asRole('app_runtime', { uid: U.gestor }, async (c) => {
      const r = await c.query(`SELECT iam.create_group($1, $2, 'e2e r5') AS id`, [TENANT, GROUP_NAME]);
      return r.rows[0].id as string;
    });
    expect(await cellsOf(groupId)).toEqual([
      { resource: 'own_notifications', action: 'read' },
      { resource: 'own_notifications', action: 'update' },
      { resource: 'own_presence', action: 'update' },
    ]);
  });

  it('1. set_group_permissions com lista SEM own_* preserva as 3 own_* e NÃO grava remove fantasma na trilha', async () => {
    await asRole('app_runtime', { uid: U.gestor }, (c) =>
      c.query(`SELECT iam.set_group_permissions($1, $2, 'setup vacancy')`, [
        groupId,
        [vacancyIds.read, vacancyIds.create, vacancyIds.update],
      ]),
    );

    const cells = await cellsOf(groupId);
    const ownCells = cells.filter((r) => r.resource.startsWith('own_'));
    const vacancyCells = cells.filter((r) => r.resource === 'vacancy');
    expect(ownCells).toHaveLength(3); // as 3 own_* SOBREVIVEM ao REPLACE
    expect(vacancyCells).toHaveLength(3);
    expect(cells).toHaveLength(6);

    const trail = await trailOf(groupId);
    const ownRemoves = trail.filter((r) => r.resource.startsWith('own_') && r.op === 'remove');
    const vacancyAdds = trail.filter((r) => r.resource === 'vacancy' && r.op === 'add');
    expect(ownRemoves).toHaveLength(0); // NENHUM remove fantasma para own_*
    expect(vacancyAdds).toHaveLength(3);
    expect(trail).toHaveLength(3); // só os 3 adds — sem os 3 removes que o bug gravava
  });

  it('2. lista INCLUINDO uma own_* é idempotente — sem duplicar linha nem trilha add repetida', async () => {
    await asRole('app_runtime', { uid: U.gestor }, (c) =>
      c.query(`SELECT iam.set_group_permissions($1, $2, 'inclui own_presence explicitamente')`, [
        groupId,
        [vacancyIds.read, vacancyIds.create, vacancyIds.update, ownIds.presenceUpdate],
      ]),
    );

    const cells = await cellsOf(groupId);
    expect(cells).toHaveLength(6); // mesmas 6 — nenhuma duplicata
    const presenceCount = cells.filter((r) => r.resource === 'own_presence').length;
    expect(presenceCount).toBe(1);

    const trail = await trailOf(groupId);
    // own_presence já estava concedida (linha de base) — NOT EXISTS barra o 'add' repetido
    const presenceAdds = trail.filter((r) => r.resource === 'own_presence' && r.op === 'add');
    expect(presenceAdds).toHaveLength(0);
    expect(trail).toHaveLength(3); // trilha não cresceu em relação ao teste anterior
  });

  it('3. célula NÃO-own fora da lista continua sendo REMOVIDA normalmente (a proteção não virou buraco)', async () => {
    await asRole('app_runtime', { uid: U.gestor }, (c) =>
      c.query(`SELECT iam.set_group_permissions($1, $2, 'tira vacancy:create')`, [
        groupId,
        [vacancyIds.read, vacancyIds.update],
      ]),
    );

    const cells = await cellsOf(groupId);
    const ownCells = cells.filter((r) => r.resource.startsWith('own_'));
    const vacancyCells = cells.filter((r) => r.resource === 'vacancy');
    expect(ownCells).toHaveLength(3); // own_* seguem intocadas
    expect(vacancyCells).toEqual([
      { resource: 'vacancy', action: 'read' },
      { resource: 'vacancy', action: 'update' },
    ]); // vacancy:create SAIU — REPLACE continua valendo para não-own

    const trail = await trailOf(groupId);
    const vacancyCreateRemoves = trail.filter(
      (r) => r.resource === 'vacancy' && r.action === 'create' && r.op === 'remove',
    );
    expect(vacancyCreateRemoves).toHaveLength(1); // a remoção REAL fica registrada na trilha
  });
});
