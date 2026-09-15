import { readFileSync } from 'fs';
import { join } from 'path';
import { Pool } from 'pg';

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

/**
 * E2E de banco real: migration 435 (spec 018, PR-8b, ADR-2/SUP-30) — conversão de grants
 * `<recurso>:write` → `<recurso>:create` + `<recurso>:update` para os 23 recursos splitados.
 *
 * PROVA contra Postgres real (não mock — CLAUDE.md "Testes de repositório usam banco real"):
 *   · grupo só com `write` de recurso splitado (uma célula) ganha `create`+`update`, SEM perder
 *     o `write` (SUP-31: a linha antiga fica até a remoção do alias);
 *   · grupo com `write` de recurso splitado + `delete` de OUTRO recurso: só o `write` do recurso
 *     splitado gera create/update — o `delete` do outro fica intocado (a migration não pode
 *     conceder nada além do previsto);
 *   · grupo ARQUIVADO também tem o grant convertido (a migration não filtra por
 *     `archived_at` — grants de grupo arquivado já não valem em `effective_permissions`, então
 *     convertê-los é inócuo, e NÃO convertê-los deixaria o grupo pela metade se um dia for
 *     reativado);
 *   · grupo SEM NENHUMA permissão continua sem nenhuma (não inventa grant do nada);
 *   · `permission_management:write` nunca vira `create`/`update` — é a ÚNICA rota que continua
 *     sob `write` (contracts/permissions-split.md linha 11);
 *   · reaplicar a migration (idempotência) não muda a contagem — `ON CONFLICT DO NOTHING` nos
 *     dois passos (seed do catálogo + conversão de grants).
 */
describe('migration 435 — split write→create+update (banco real)', () => {
  let pool: Pool;

  const TENANT = '00000000-0000-0000-0000-000000000001';
  const PREFIX = 'pr8b-435-e2e';
  const GROUPS = {
    soWrite: `${PREFIX}-so-write`,
    writeMaisDelete: `${PREFIX}-write-mais-delete`,
    arquivado: `${PREFIX}-arquivado`,
    semPermissao: `${PREFIX}-sem-permissao`,
  };

  async function cleanupGroups(p: Pool): Promise<void> {
    await p.query(
      `DELETE FROM iam.group_permissions WHERE group_id IN (SELECT id FROM iam.permission_groups WHERE name LIKE $1)`,
      [`${PREFIX}%`],
    );
    await p.query(`DELETE FROM iam.permission_groups WHERE name LIKE $1`, [`${PREFIX}%`]);
  }

  async function permissionId(p: Pool, resource: string, action: string): Promise<string> {
    const r = await p.query<{ id: string }>(`SELECT id FROM iam.permissions WHERE resource = $1 AND action = $2`, [resource, action]);
    if (!r.rows[0]) throw new Error(`célula ausente do catálogo: ${resource}:${action} — a migration 435 deveria tê-la semeado`);
    return r.rows[0].id;
  }

  async function createGroup(p: Pool, name: string, opts: { archived?: boolean } = {}): Promise<string> {
    const r = await p.query<{ id: string }>(
      `INSERT INTO iam.permission_groups (tenant_id, name, description, is_system, archived_at, created_by)
       VALUES ($1, $2, 'fixture 435', false, $3, NULL)
       RETURNING id`,
      [TENANT, name, opts.archived ? new Date() : null],
    );
    return r.rows[0].id;
  }

  async function grant(p: Pool, groupId: string, resource: string, action: string): Promise<void> {
    const permId = await permissionId(p, resource, action);
    await p.query(`INSERT INTO iam.group_permissions (group_id, permission_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [groupId, permId]);
  }

  async function cellsOf(p: Pool, groupId: string): Promise<string[]> {
    const r = await p.query<{ key: string }>(
      `SELECT po.resource || ':' || po.action AS key
         FROM iam.group_permissions gp JOIN iam.permissions po ON po.id = gp.permission_id
        WHERE gp.group_id = $1 ORDER BY 1`,
      [groupId],
    );
    return r.rows.map((row) => row.key);
  }

  async function runMigration435(p: Pool): Promise<void> {
    const sql = readFileSync(join(__dirname, '..', '..', 'migrations', '435_split_write_grants_create_update.sql'), 'utf8');
    await p.query(sql);
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    await cleanupGroups(pool);
  });

  afterAll(async () => {
    await cleanupGroups(pool);
    await pool.end();
  });

  it('foto ANTES: os 4 grupos-fixture nascem só com o que o teste concedeu', async () => {
    const gSoWrite = await createGroup(pool, GROUPS.soWrite);
    await grant(pool, gSoWrite, 'patient_family', 'write');
    expect(await cellsOf(pool, gSoWrite)).toEqual(['patient_family:write']);

    const gWriteMaisDelete = await createGroup(pool, GROUPS.writeMaisDelete);
    await grant(pool, gWriteMaisDelete, 'patient_family', 'write');
    await grant(pool, gWriteMaisDelete, 'patient', 'delete');
    expect(await cellsOf(pool, gWriteMaisDelete)).toEqual(['patient:delete', 'patient_family:write']);

    const gArquivado = await createGroup(pool, GROUPS.arquivado, { archived: true });
    await grant(pool, gArquivado, 'vacancy', 'write');
    expect(await cellsOf(pool, gArquivado)).toEqual(['vacancy:write']);

    await createGroup(pool, GROUPS.semPermissao);
  });

  it('roda a migration 435: cada grupo ganha create+update do recurso splitado, sem perder o write e sem tocar em mais nada', async () => {
    await runMigration435(pool);

    const gSoWrite = (await pool.query<{ id: string }>(`SELECT id FROM iam.permission_groups WHERE name = $1`, [GROUPS.soWrite])).rows[0].id;
    expect(await cellsOf(pool, gSoWrite)).toEqual(['patient_family:create', 'patient_family:update', 'patient_family:write']);

    const gWriteMaisDelete = (await pool.query<{ id: string }>(`SELECT id FROM iam.permission_groups WHERE name = $1`, [GROUPS.writeMaisDelete])).rows[0].id;
    expect(await cellsOf(pool, gWriteMaisDelete)).toEqual([
      'patient:delete', // intocado — delete não é write, a migration nunca olha para ele
      'patient_family:create', 'patient_family:update', 'patient_family:write',
    ]);

    const gArquivado = (await pool.query<{ id: string; archived_at: Date | null }>(`SELECT id, archived_at FROM iam.permission_groups WHERE name = $1`, [GROUPS.arquivado])).rows[0];
    expect(gArquivado.archived_at).not.toBeNull(); // continua arquivado — a migration não mexe em archived_at
    expect(await cellsOf(pool, gArquivado.id)).toEqual(['vacancy:create', 'vacancy:update', 'vacancy:write']);

    const gSemPermissao = (await pool.query<{ id: string }>(`SELECT id FROM iam.permission_groups WHERE name = $1`, [GROUPS.semPermissao])).rows[0].id;
    expect(await cellsOf(pool, gSemPermissao)).toEqual([]); // não inventa grant do nada
  });

  it('permission_management:write nunca vira create/update — é a única rota que continua sob write', async () => {
    const r = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM iam.permissions WHERE resource = 'permission_management' AND action IN ('create', 'update')`);
    expect(r.rows[0].n).toBe(0);
  });

  it('reaplicar a migration (idempotência): mesma contagem de grants na 2ª rodada', async () => {
    const antes = (await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM iam.group_permissions`)).rows[0].n;
    await runMigration435(pool);
    const depois = (await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM iam.group_permissions`)).rows[0].n;
    expect(depois).toBe(antes);
  });
});
