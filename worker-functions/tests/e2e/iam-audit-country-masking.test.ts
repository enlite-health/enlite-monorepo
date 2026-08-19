import { Pool, PoolClient } from 'pg';

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

/**
 * E2E de banco real — mig 283: mascaramento de `resource_id` por país em
 * `iam.query_audit` (lex 0.2, condição M2-5).
 *
 * O que este arquivo PROVA, e que mock nenhum provaria (a regra vive em SQL,
 * dentro de uma função SECURITY DEFINER):
 *
 *   1. a LINHA nunca é suprimida — o auditor fora do escopo continua vendo QUE
 *      houve acesso, a quê e por quem. Suprimir cegaria a detecção de acesso
 *      cross-país, que é o motivo de a trilha existir (Ley 25.326 art. 9);
 *   2. o IDENTIFICADOR do titular é que some, virando o sentinela '<oculto>' —
 *      sentinela, não NULL, para o auditor saber que houve ocultação;
 *   3. auditor que cobre todos os países suportados vê tudo;
 *   4. fail-closed: linha sem país (contexto de sistema) fica oculta para quem
 *      tem escopo restrito.
 */
describe('IAM — mascaramento por país na auditoria (mig 283, banco real)', () => {
  let pool: Pool;

  const TENANT = '00000000-0000-0000-0000-000000000001';
  const AUDITOR = 'iam-mask-auditor';
  const ATOR = 'iam-mask-ator';
  const GROUP_NAME = 'IAM E2E Auditoria';
  const ID_AR = 'aaaa1111-0000-0000-0000-0000000000ar'.replace('ar', 'a1');
  const ID_BR = 'bbbb2222-0000-0000-0000-0000000000br'.replace('br', 'b2');
  const ID_SEM_PAIS = 'cccc3333-0000-0000-0000-0000000000c3';
  let groupId: string;

  async function limpar(p: Pool): Promise<void> {
    await p.query(`DELETE FROM iam.permission_audit_log WHERE user_id = ANY($1)`, [[AUDITOR, ATOR]]);
    await p.query(
      `DELETE FROM iam.group_country_scopes WHERE group_id IN (SELECT id FROM iam.permission_groups WHERE name = $1)`,
      [GROUP_NAME],
    );
    await p.query(
      `DELETE FROM iam.user_groups WHERE group_id IN (SELECT id FROM iam.permission_groups WHERE name = $1)`,
      [GROUP_NAME],
    );
    await p.query(`DELETE FROM iam.permission_groups WHERE name = $1`, [GROUP_NAME]);
    await p.query(`DELETE FROM users WHERE firebase_uid = ANY($1)`, [[AUDITOR, ATOR]]);
  }

  /** Contrato do `withActorContext`: role de grupo + ator no GUC, dentro da transação. */
  async function comoAuditor<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE app_runtime');
      await client.query(`SELECT set_config('app.user_uid', $1, true)`, [AUDITOR]);
      const out = await fn(client);
      await client.query('COMMIT');
      return out;
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  async function auditar(): Promise<{ resource_id: string | null; country: string | null }[]> {
    const r = await comoAuditor((c) =>
      c.query<{ resource_id: string | null; country: string | null }>(
        `SELECT resource_id, country FROM iam.query_audit($1, NULL, NULL, NULL, 100) ORDER BY country NULLS LAST`,
        [ATOR],
      ),
    );
    return r.rows;
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    await limpar(pool);

    await pool.query(
      `INSERT INTO users (firebase_uid, email, role, status, is_active, tenant_id) VALUES
         ($1, 'iam-mask-auditor@e2e.local', 'admin',     'ACTIVE', true, $3),
         ($2, 'iam-mask-ator@e2e.local',    'recruiter', 'ACTIVE', true, $3)`,
      [AUDITOR, ATOR, TENANT],
    );

    const g = await pool.query<{ id: string }>(
      `INSERT INTO iam.permission_groups (tenant_id, name, description, is_system)
       VALUES ($1, $2, 'e2e mascaramento', false) RETURNING id`,
      [TENANT, GROUP_NAME],
    );
    groupId = g.rows[0].id;
    await pool.query(
      `INSERT INTO iam.group_permissions (group_id, permission_id)
       SELECT $1, id FROM iam.permissions WHERE resource = 'permission_management' AND action = 'read'`,
      [groupId],
    );
    await pool.query(`INSERT INTO iam.user_groups (user_id, group_id, tenant_id) VALUES ($1, $2, $3)`, [
      AUDITOR,
      groupId,
      TENANT,
    ]);
    await pool.query(
      `INSERT INTO iam.group_country_scopes (group_id, country, granted_by, reason)
       VALUES ($1, 'AR', $2, 'e2e mascaramento')`,
      [groupId, AUDITOR],
    );

    // 3 acessos do MESMO ator, em contextos de país diferentes.
    await pool.query(
      `INSERT INTO iam.permission_audit_log (tenant_id, user_id, resource, action, resource_id, decision, country) VALUES
         ($1, $2, 'patient', 'read', $3, 'ALLOW', 'AR'),
         ($1, $2, 'patient', 'read', $4, 'ALLOW', 'BR'),
         ($1, $2, 'patient', 'read', $5, 'ALLOW', NULL)`,
      [TENANT, ATOR, ID_AR, ID_BR, ID_SEM_PAIS],
    );
  });

  afterAll(async () => {
    await limpar(pool);
    await pool.end();
  });

  it('auditor {AR}: vê as TRÊS linhas — nenhuma é suprimida', async () => {
    const linhas = await auditar();
    expect(linhas).toHaveLength(3);
    expect(linhas.map((l) => l.country)).toEqual(['AR', 'BR', null]);
  });

  it('auditor {AR}: mantém o id do seu país e OCULTA o do outro (e o sem país — fail-closed)', async () => {
    const linhas = await auditar();
    const porPais = Object.fromEntries(linhas.map((l) => [String(l.country), l.resource_id]));

    expect(porPais.AR).toBe(ID_AR);
    expect(porPais.BR).toBe('<oculto>');
    expect(porPais.null).toBe('<oculto>');
    // o identificador do titular BR não sai da função de forma nenhuma
    expect(JSON.stringify(linhas)).not.toContain(ID_BR);
  });

  it('auditor que cobre todos os países suportados vê tudo, inclusive a linha sem país', async () => {
    await pool.query(
      `INSERT INTO iam.group_country_scopes (group_id, country, granted_by, reason)
       VALUES ($1, 'BR', $2, 'e2e mascaramento — vira global')`,
      [groupId, AUDITOR],
    );

    const porPais = Object.fromEntries((await auditar()).map((l) => [String(l.country), l.resource_id]));
    expect(porPais).toEqual({ AR: ID_AR, BR: ID_BR, null: ID_SEM_PAIS });

    await pool.query(`DELETE FROM iam.group_country_scopes WHERE group_id = $1 AND country = 'BR'`, [groupId]);
  });

  it('o gate de permissão continua valendo: sem permission_management:read → 42501', async () => {
    await pool.query(`UPDATE iam.user_groups SET removed_at = now() WHERE user_id = $1`, [AUDITOR]);
    await expect(auditar()).rejects.toMatchObject({ code: '42501' });
    await pool.query(`UPDATE iam.user_groups SET removed_at = NULL WHERE user_id = $1`, [AUDITOR]);
  });
});
