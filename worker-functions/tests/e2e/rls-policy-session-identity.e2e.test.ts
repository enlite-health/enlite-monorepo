/**
 * 411 — A policy de país de `patients` decide pelo IAM SEM exigir privilégio do chamador em `iam`,
 * e recusa EM VOZ ALTA a sessão sem identidade nenhuma. Banco real.
 *
 * A role deste teste imita `enlite_mcp_ro` (o conector claude.ai do CEO, criado fora das
 * migrations por `scripts/create-mcp-ro-role.sql`): SELECT em algumas colunas de `patients`,
 * ZERO privilégio em `iam`. Até a 411, qualquer leitura dela em `patients` morria com
 * `permission denied for schema iam` — e uma sessão sem contexto recebia conjunto VAZIO.
 *
 * O que cada teste prova:
 *   1. sem identidade → erro NOMEADO (`rls_session_without_identity`, 42501). Nunca vazio,
 *      nunca `permission denied for schema iam`. É o controle NEGATIVO em voz alta.
 *   2. só país na sessão → vê o país (ramo 2, inline; a função nem precisa ser chamada).
 *   3. uid em grupo com escopo BR, role SEM grant em iam → VÊ BR. É o controle POSITIVO da
 *      classe: a decisão roda com o privilégio da dona, não do chamador.
 *   4. vínculo REMOVIDO (`removed_at`) deixa de dar visão — a 274 ignorava `removed_at`.
 *   5. a função é executável por PUBLIC (sem isso, o teste 3 seria "permission denied for
 *      function", que é o mesmo defeito com outra cara).
 */
import { Pool, PoolClient } from 'pg';

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

describe('411 — policy de país via função SECDEF + recusa sem identidade (banco real)', () => {
  let pool: Pool;
  const ROLE = 'e2e_ro_sem_iam_411';
  const TENANT = '00000000-0000-0000-0000-000000000001';
  const STAFF_UID = 'rls-411-staff-uid';
  const IDS = {
    patientAR: 'ee411000-0a00-0001-0001-000000000001',
    patientBR: 'ee411000-0a00-0001-0002-000000000001',
    group: 'ee411000-0a00-0003-0001-000000000001',
    scope: 'ee411000-0a00-0004-0001-000000000001',
  };
  const listTestPatients = `SELECT id, country FROM patients WHERE id = ANY($1) ORDER BY country`;

  async function cleanup(p: Pool): Promise<void> {
    await p.query(`DELETE FROM iam.group_country_scopes WHERE id = $1`, [IDS.scope]);
    await p.query(`DELETE FROM iam.user_groups WHERE user_id = $1`, [STAFF_UID]);
    await p.query(`DELETE FROM iam.permission_groups WHERE id = $1`, [IDS.group]);
    await p.query(`DELETE FROM users WHERE firebase_uid = $1`, [STAFF_UID]);
    await p.query(`DELETE FROM patients WHERE id = ANY($1)`, [[IDS.patientAR, IDS.patientBR]]);
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    await cleanup(pool);

    // Role de leitura externa: colunas nomeadas em patients, NADA em iam (como a mcp_ro).
    await pool.query(`DROP ROLE IF EXISTS ${ROLE}`);
    await pool.query(`CREATE ROLE ${ROLE} NOLOGIN NOBYPASSRLS`);
    await pool.query(`GRANT USAGE ON SCHEMA public TO ${ROLE}`);
    await pool.query(`GRANT SELECT (id, country, status) ON patients TO ${ROLE}`);

    await pool.query(
      `INSERT INTO patients (id, clickup_task_id, first_name, last_name, country) VALUES
         ($1, 'rls-411-task-ar', 'Paciente', 'Argentino', 'AR'),
         ($2, 'rls-411-task-br', 'Paciente', 'Brasileiro', 'BR')`,
      [IDS.patientAR, IDS.patientBR],
    );
    await pool.query(
      `INSERT INTO users (firebase_uid, email, role, tenant_id, is_active) VALUES ($1, 'rls-411@e2e.local', 'admin', $2, true)`,
      [STAFF_UID, TENANT],
    );
    await pool.query(`INSERT INTO iam.permission_groups (id, tenant_id, name) VALUES ($1, $2, 'RLS 411 Cross País')`, [
      IDS.group,
      TENANT,
    ]);
  });

  afterAll(async () => {
    await cleanup(pool);
    await pool.query(`REVOKE ALL ON patients FROM ${ROLE}`);
    await pool.query(`REVOKE USAGE ON SCHEMA public FROM ${ROLE}`);
    await pool.query(`DROP ROLE IF EXISTS ${ROLE}`);
    await pool.end();
  });

  async function asRole<T>(
    ctx: { userCountry?: string; userUid?: string },
    fn: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL ROLE ${ROLE}`);
      if (ctx.userCountry) await client.query(`SELECT set_config('app.user_country', $1, true)`, [ctx.userCountry]);
      if (ctx.userUid) await client.query(`SELECT set_config('app.user_uid', $1, true)`, [ctx.userUid]);
      return await fn(client);
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
    }
  }

  it('0. a role NÃO tem privilégio em iam (premissa do teste, medida)', async () => {
    const r = await pool.query(`SELECT has_schema_privilege($1, 'iam', 'USAGE') AS usage`, [ROLE]);
    expect(r.rows[0].usage).toBe(false);
  });

  it('1. sem identidade nenhuma → erro NOMEADO 42501, nunca vazio, nunca "permission denied for schema iam"', async () => {
    const q = asRole({}, (c) => c.query(listTestPatients, [[IDS.patientAR, IDS.patientBR]]));
    await expect(q).rejects.toMatchObject({ code: '42501' });
    await expect(q).rejects.toThrow(/rls_session_without_identity/);
    await expect(q).rejects.not.toThrow(/schema iam/);
  });

  it('2. só o país na sessão → vê o país (ramo 2 inline, sem tocar em iam)', async () => {
    const rows = await asRole({ userCountry: 'AR' }, async (c) => (await c.query(listTestPatients, [[IDS.patientAR, IDS.patientBR]])).rows);
    expect(rows.map((r) => r.country)).toEqual(['AR']);
  });

  it('3. controle POSITIVO da classe: uid em grupo com escopo BR, role sem grant em iam → VÊ BR', async () => {
    await pool.query(`INSERT INTO iam.user_groups (user_id, group_id, tenant_id) VALUES ($1, $2, $3)`, [STAFF_UID, IDS.group, TENANT]);
    await pool.query(`INSERT INTO iam.group_country_scopes (id, group_id, country, granted_by, reason) VALUES ($1, $2, 'BR', 'rls-411-admin', 'e2e 411: controle positivo')`, [IDS.scope, IDS.group]);

    const rows = await asRole({ userCountry: 'AR', userUid: STAFF_UID }, async (c) => (await c.query(listTestPatients, [[IDS.patientAR, IDS.patientBR]])).rows);
    expect(rows.map((r) => r.country)).toEqual(['AR', 'BR']);
  });

  it('4. vínculo REMOVIDO (removed_at) deixa de dar visão cross-país — a 274 ignorava isso', async () => {
    await pool.query(`UPDATE iam.user_groups SET removed_at = now() WHERE user_id = $1 AND group_id = $2`, [STAFF_UID, IDS.group]);
    const rows = await asRole({ userCountry: 'AR', userUid: STAFF_UID }, async (c) => (await c.query(listTestPatients, [[IDS.patientAR, IDS.patientBR]])).rows);
    expect(rows.map((r) => r.country)).toEqual(['AR']);
  });

  it('5. a função é executável por PUBLIC e é SECURITY DEFINER (o mecanismo, não só o efeito)', async () => {
    const r = await pool.query(
      `SELECT has_function_privilege($1, 'iam.session_may_see_country(text)', 'EXECUTE') AS exec,
              (SELECT prosecdef FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                WHERE n.nspname = 'iam' AND p.proname = 'session_may_see_country') AS secdef`,
      [ROLE],
    );
    expect(r.rows[0]).toEqual({ exec: true, secdef: true });
  });
});
