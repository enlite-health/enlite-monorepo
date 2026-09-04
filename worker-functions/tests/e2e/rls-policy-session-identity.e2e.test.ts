/**
 * 411 — A policy de país de `patients` decide pelo IAM SEM exigir privilégio do chamador em `iam`,
 * recusa EM VOZ ALTA a sessão sem identidade, e só honra as GUCs de sessão para roles do APP.
 * Banco real, duas roles criadas pelo teste:
 *
 *   APP_SEM_IAM  — membro de `app_runtime` com NOINHERIT: conta como role do app
 *                  (`pg_has_role(..., 'MEMBER')`), mas NÃO herda privilégio nenhum em `iam`.
 *                  É a prova da CLASSE: a decisão roda com o privilégio da dona, não do chamador.
 *   FORA_DO_APP  — imita `enlite_mcp_ro` (conector claude.ai do CEO, criado fora das migrations
 *                  por `scripts/create-mcp-ro-role.sql`): SELECT em colunas de `patients`, zero
 *                  em `iam`, e NÃO é membro de role do app. Achado do lex (04/09): antes da 411
 *                  ela era fail-closed por ACIDENTE (`permission denied for schema iam`); uma
 *                  versão da 411 sem gate de role a deixaria declarar o próprio país por
 *                  `set_config` — e ver.
 *
 * O que cada teste prova:
 *   1. sem identidade → erro NOMEADO (`rls_session_without_identity`, 42501). Nunca vazio,
 *      nunca `permission denied for schema iam`. Controle NEGATIVO em voz alta.
 *   2. só país na sessão → vê o país (ramo 2, agora dentro da função).
 *   3. uid em grupo com escopo BR, role SEM privilégio em iam → VÊ BR. Controle POSITIVO da classe.
 *   4. vínculo REMOVIDO (`removed_at`) deixa de dar visão — a 274 ignorava `removed_at`.
 *   5. a função é executável por PUBLIC e é SECURITY DEFINER (mecanismo, não só efeito).
 *   6. role FORA do app que declara país e uid por set_config → erro NOMEADO
 *      (`rls_role_without_session_identity`), nunca uma linha. Condição 2 do lex.
 *   7. `status='DEACTIVATED'` → `effective_countries` = [] e a policy nega; `is_active` divergente sozinha
 *      não muda nada (é derivada, 206). Precheck da 278, painel e policy respondem pela MESMA função.
 */
import { Pool, PoolClient } from 'pg';

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

describe('411 — policy de país via função SECDEF, gate de role e recusa sem identidade (banco real)', () => {
  let pool: Pool;
  const APP_SEM_IAM = 'e2e_app_sem_iam_411';
  const FORA_DO_APP = 'e2e_fora_do_app_411';
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

  async function dropRole(p: Pool, role: string): Promise<void> {
    await p.query(`REVOKE ALL ON patients FROM ${role}`).catch(() => {});
    await p.query(`REVOKE USAGE ON SCHEMA public FROM ${role}`).catch(() => {});
    await p.query(`DROP ROLE IF EXISTS ${role}`);
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    await cleanup(pool);

    await dropRole(pool, APP_SEM_IAM);
    await dropRole(pool, FORA_DO_APP);
    // Role do app SEM privilégio: membro de app_runtime, mas NOINHERIT — não herda nada de iam.
    await pool.query(`CREATE ROLE ${APP_SEM_IAM} NOLOGIN NOBYPASSRLS NOINHERIT IN ROLE app_runtime`);
    await pool.query(`GRANT USAGE ON SCHEMA public TO ${APP_SEM_IAM}`);
    await pool.query(`GRANT SELECT (id, country, status) ON patients TO ${APP_SEM_IAM}`);
    // Role de leitura externa (como a mcp_ro): colunas nomeadas em patients, NADA em iam, fora do app.
    await pool.query(`CREATE ROLE ${FORA_DO_APP} NOLOGIN NOBYPASSRLS`);
    await pool.query(`GRANT USAGE ON SCHEMA public TO ${FORA_DO_APP}`);
    await pool.query(`GRANT SELECT (id, country, status) ON patients TO ${FORA_DO_APP}`);

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
    await dropRole(pool, APP_SEM_IAM);
    await dropRole(pool, FORA_DO_APP);
    await pool.end();
  });

  async function asRole<T>(
    role: string,
    ctx: { userCountry?: string; userUid?: string },
    fn: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL ROLE ${role}`);
      if (ctx.userCountry) await client.query(`SELECT set_config('app.user_country', $1, true)`, [ctx.userCountry]);
      if (ctx.userUid) await client.query(`SELECT set_config('app.user_uid', $1, true)`, [ctx.userUid]);
      return await fn(client);
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
    }
  }
  const listar = (role: string, ctx: { userCountry?: string; userUid?: string }) =>
    asRole(role, ctx, async (c) => (await c.query(listTestPatients, [[IDS.patientAR, IDS.patientBR]])).rows);

  it('0. premissas medidas: nenhuma das duas roles tem privilégio em iam; só uma é do app', async () => {
    const r = await pool.query(
      `SELECT has_schema_privilege($1, 'iam', 'USAGE') AS app_usage, pg_has_role($1, 'app_runtime', 'MEMBER') AS app_member,
              has_schema_privilege($2, 'iam', 'USAGE') AS fora_usage, pg_has_role($2, 'app_runtime', 'MEMBER') AS fora_member`,
      [APP_SEM_IAM, FORA_DO_APP],
    );
    expect(r.rows[0]).toEqual({ app_usage: false, app_member: true, fora_usage: false, fora_member: false });
  });

  it('1. role do app sem identidade nenhuma → erro NOMEADO 42501, nunca vazio, nunca "permission denied for schema iam"', async () => {
    const q = listar(APP_SEM_IAM, {});
    await expect(q).rejects.toMatchObject({ code: '42501' });
    await expect(q).rejects.toThrow(/rls_session_without_identity/);
    await expect(q).rejects.not.toThrow(/schema iam/);
  });

  it('2. role do app só com o país na sessão → vê o país', async () => {
    expect((await listar(APP_SEM_IAM, { userCountry: 'AR' })).map((r) => r.country)).toEqual(['AR']);
  });

  it('3. controle POSITIVO da classe: uid em grupo com escopo BR, role sem privilégio em iam → VÊ BR', async () => {
    await pool.query(`INSERT INTO iam.user_groups (user_id, group_id, tenant_id) VALUES ($1, $2, $3)`, [STAFF_UID, IDS.group, TENANT]);
    await pool.query(
      `INSERT INTO iam.group_country_scopes (id, group_id, country, granted_by, reason) VALUES ($1, $2, 'BR', 'rls-411-admin', 'e2e 411: controle positivo')`,
      [IDS.scope, IDS.group],
    );
    expect((await listar(APP_SEM_IAM, { userCountry: 'AR', userUid: STAFF_UID })).map((r) => r.country)).toEqual(['AR', 'BR']);
  });

  it('4. vínculo REMOVIDO (removed_at) deixa de dar visão cross-país — a 274 ignorava isso', async () => {
    await pool.query(`UPDATE iam.user_groups SET removed_at = now() WHERE user_id = $1 AND group_id = $2`, [STAFF_UID, IDS.group]);
    expect((await listar(APP_SEM_IAM, { userCountry: 'AR', userUid: STAFF_UID })).map((r) => r.country)).toEqual(['AR']);
  });

  it('5. a função é executável por PUBLIC e é SECURITY DEFINER (o mecanismo, não só o efeito)', async () => {
    const r = await pool.query(
      `SELECT has_function_privilege($1, 'iam.session_may_see_country(text, name, boolean)', 'EXECUTE') AS exec,
              (SELECT prosecdef FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                WHERE n.nspname = 'iam' AND p.proname = 'session_may_see_country') AS secdef`,
      [FORA_DO_APP],
    );
    expect(r.rows[0]).toEqual({ exec: true, secdef: true });
  });

  it('7. fonte única com o precheck da 278 e o painel: status DEACTIVATED → effective_countries = [] E a policy nega; is_active sozinha não é fonte', async () => {
    await pool.query(`UPDATE iam.user_groups SET removed_at = NULL WHERE user_id = $1 AND group_id = $2`, [STAFF_UID, IDS.group]);
    await pool.query(`UPDATE users SET status = 'DEACTIVATED' WHERE firebase_uid = $1`, [STAFF_UID]);
    try {
      expect((await pool.query(`SELECT iam.effective_countries($1, $2) AS c`, [STAFF_UID, TENANT])).rows[0].c).toEqual([]);
      expect((await listar(APP_SEM_IAM, { userCountry: 'AR', userUid: STAFF_UID })).map((r) => r.country)).toEqual(['AR']);
    } finally {
      await pool.query(`UPDATE users SET status = 'ACTIVE' WHERE firebase_uid = $1`, [STAFF_UID]);
    }
    // `is_active` é derivada de `status` (trigger da 206) e deprecated: divergente sozinha, NÃO muda a
    // decisão — a 274 olhava is_active, e apertar as funções efetivas para as duas flags fecharia células
    // no boot sem contagem (gate de 04/09). Controle positivo com status ACTIVE e is_active divergente.
    await pool.query(`UPDATE users SET is_active = false WHERE firebase_uid = $1`, [STAFF_UID]);
    try {
      expect((await pool.query(`SELECT iam.effective_countries($1, $2) AS c`, [STAFF_UID, TENANT])).rows[0].c).toEqual(['BR']);
      expect((await listar(APP_SEM_IAM, { userCountry: 'AR', userUid: STAFF_UID })).map((r) => r.country)).toEqual(['AR', 'BR']);
    } finally {
      await pool.query(`UPDATE users SET is_active = true WHERE firebase_uid = $1`, [STAFF_UID]);
    }
  });

  it('6. role FORA do app que declara o próprio país (e até o uid do gestor) por set_config → erro NOMEADO, nunca uma linha', async () => {
    // Vínculo vivo de novo: se o gate falhar, o uid forjado abriria BR — o teste tem de ter algo a proteger.
    await pool.query(`UPDATE iam.user_groups SET removed_at = NULL WHERE user_id = $1 AND group_id = $2`, [STAFF_UID, IDS.group]);
    for (const ctx of [{}, { userCountry: 'BR' }, { userCountry: 'AR', userUid: STAFF_UID }]) {
      const q = listar(FORA_DO_APP, ctx);
      await expect(q).rejects.toMatchObject({ code: '42501' });
      await expect(q).rejects.toThrow(/rls_role_without_session_identity/);
    }
  });
});
