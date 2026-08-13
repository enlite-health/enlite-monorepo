import { Pool } from 'pg';
import { loggingAls } from '@shared/logging';
import { createRlsAwarePool } from '@shared/database/rlsAwarePool';
import { releaseDbSession, type DbSession } from '@shared/database/requestDbSession';
import { withActorContext } from '@shared/database/actorContext';

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

/**
 * E2E de banco real: o MECANISMO DA APLICAÇÃO contra as policies (abac-pais-fase1,
 * grupo 3).
 *
 * A task 2.6 provou as policies com SQL cru. Esta prova o que o runtime realmente
 * faz: `getPool()` devolvendo o pool-proxy, o contexto vindo do ALS da request, o
 * client FIXADO com os GUCs, e a limpeza na devolução ao pool. É o ensaio da task
 * 4.1 sem depender de staging.
 *
 * Conecta como uma role de LOGIN membro de `app_runtime`/`app_system` (não-owner,
 * sem BYPASSRLS) — que é exatamente o que a virada faz com a connection do app.
 * Como `enlite_admin` é superuser e bypassa RLS sempre, ele serve só para semear e
 * conferir estado.
 */
describe('contexto de país da aplicação contra as policies (banco real)', () => {
  let adminPool: Pool;
  let runtimePool: Pool;
  let systemPool: Pool;
  /** O que os 115 repositórios recebem de `DatabaseConnection.getPool()`. */
  let appPool: Pool;

  const TENANT = '00000000-0000-0000-0000-000000000001';
  const STAFF_UID = 'abac-app-e2e-staff';
  const RUNTIME_USER = 'abac_app_e2e_runtime';
  const SYSTEM_USER = 'abac_app_e2e_system';
  const PASSWORD = 'abac_app_e2e_pw';

  const IDS = {
    patientAR: 'ee270000-0b00-0001-0001-000000000001',
    patientBR: 'ee270000-0b00-0001-0002-000000000001',
    group: 'ee270000-0b00-0003-0001-000000000001',
    scope: 'ee270000-0b00-0004-0001-000000000001',
  };

  const urlFor = (user: string): string => {
    const url = new URL(DATABASE_URL);
    url.username = user;
    url.password = PASSWORD;
    return url.toString();
  };

  /** Roda `fn` como se fosse uma request com o contexto declarado. */
  async function asRequest<T>(context: DbSession['context'], fn: () => Promise<T>): Promise<T> {
    const session: DbSession = { context, released: false };
    try {
      return await loggingAls.run({ traceId: 'abac-e2e', dbSession: session }, fn);
    } finally {
      await releaseDbSession(session);
    }
  }

  const visiblePatientIds = async (pool: Pool): Promise<string[]> => {
    const res = await pool.query<{ id: string }>(
      `SELECT id FROM patients WHERE id = ANY($1) ORDER BY country`,
      [[IDS.patientAR, IDS.patientBR]],
    );
    return res.rows.map((r) => r.id);
  };

  async function cleanup(): Promise<void> {
    await adminPool.query(`DELETE FROM group_country_scopes WHERE id = $1`, [IDS.scope]);
    await adminPool.query(`DELETE FROM user_groups WHERE user_id = $1`, [STAFF_UID]);
    await adminPool.query(`DELETE FROM permission_groups WHERE id = $1`, [IDS.group]);
    await adminPool.query(`DELETE FROM users WHERE firebase_uid = $1`, [STAFF_UID]);
    await adminPool.query(`DELETE FROM patients WHERE id = ANY($1)`, [[IDS.patientAR, IDS.patientBR]]);
  }

  beforeAll(async () => {
    process.env.COUNTRY_RLS_ENABLED = 'true';
    adminPool = new Pool({ connectionString: DATABASE_URL });

    // Usuários de LOGIN por ambiente (o que o terraform cria em stg/prd — task 2.2).
    for (const [user, group] of [[RUNTIME_USER, 'app_runtime'], [SYSTEM_USER, 'app_system']]) {
      await adminPool.query(`DO $$
        BEGIN
          IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${user}') THEN
            CREATE ROLE ${user} LOGIN PASSWORD '${PASSWORD}';
          END IF;
        END $$;`);
      await adminPool.query(`GRANT ${group} TO ${user}`);
    }

    await cleanup();
    await adminPool.query(
      `INSERT INTO patients (id, clickup_task_id, first_name, last_name, country) VALUES
         ($1, 'abac-app-e2e-ar', 'Paciente', 'Argentino', 'AR'),
         ($2, 'abac-app-e2e-br', 'Paciente', 'Brasileiro', 'BR')`,
      [IDS.patientAR, IDS.patientBR],
    );
    await adminPool.query(
      `INSERT INTO users (firebase_uid, email, role, is_active, tenant_id) VALUES ($1, 'abac-app-e2e@enlite.health', 'recruiter', true, $2)`,
      [STAFF_UID, TENANT],
    );

    runtimePool = new Pool({ connectionString: urlFor(RUNTIME_USER), max: 4 });
    systemPool = new Pool({ connectionString: urlFor(SYSTEM_USER), max: 2 });
    appPool = createRlsAwarePool(runtimePool);
  });

  afterAll(async () => {
    await cleanup();
    await runtimePool?.end();
    await systemPool?.end();
    await adminPool?.query(`DROP ROLE IF EXISTS ${RUNTIME_USER}`);
    await adminPool?.query(`DROP ROLE IF EXISTS ${SYSTEM_USER}`);
    await adminPool?.end();
    delete process.env.COUNTRY_RLS_ENABLED;
  });

  it('staff AR enxerga só o paciente AR — em query SEM filtro de país nenhum', async () => {
    const ids = await asRequest({ kind: 'staff', uid: STAFF_UID, country: 'AR' }, () =>
      visiblePatientIds(appPool),
    );
    expect(ids).toEqual([IDS.patientAR]);
  });

  it('a request inteira sai por UM client só — é o que faz o SET valer nas leituras', async () => {
    const pids = await asRequest({ kind: 'staff', uid: STAFF_UID, country: 'AR' }, async () => {
      const a = await appPool.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
      const b = await appPool.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
      return [a.rows[0].pid, b.rows[0].pid];
    });
    expect(pids[0]).toBe(pids[1]);
  });

  it('contexto ausente = zero linhas (fail-closed), não "mostra tudo"', async () => {
    const ids = await asRequest(undefined, () => visiblePatientIds(appPool));
    expect(ids).toEqual([]);
  });

  it('o país NÃO vaza para a request seguinte: o client volta ao pool limpo', async () => {
    // Esgota o pool de propósito para forçar o reuso do MESMO backend.
    await asRequest({ kind: 'staff', uid: STAFF_UID, country: 'AR' }, () => visiblePatientIds(appPool));

    const leftover = await runtimePool.query<{ country: string }>(
      `SELECT current_setting('app.user_country', true) AS country`,
    );
    expect(leftover.rows[0].country ?? '').toBe('');

    const ids = await asRequest(undefined, () => visiblePatientIds(appPool));
    expect(ids).toEqual([]);
  });

  it('grant vivo de grupo abre o outro país — e a revogação vale na request seguinte', async () => {
    await adminPool.query(
      `INSERT INTO permission_groups (id, tenant_id, name) VALUES ($1, $2, 'abac-app-e2e-br')`,
      [IDS.group, TENANT],
    );
    await adminPool.query(`INSERT INTO user_groups (user_id, group_id, tenant_id) VALUES ($1, $2, $3)`, [STAFF_UID, IDS.group, TENANT]);
    await adminPool.query(
      `INSERT INTO group_country_scopes (id, group_id, country, granted_by, reason)
       VALUES ($1, $2, 'BR', 'abac-app-e2e-admin', 'e2e do mecanismo da aplicação')`,
      [IDS.scope, IDS.group],
    );

    const withGrant = await asRequest({ kind: 'staff', uid: STAFF_UID, country: 'AR' }, () =>
      visiblePatientIds(appPool),
    );
    expect(withGrant).toEqual([IDS.patientAR, IDS.patientBR]);

    await adminPool.query(`UPDATE group_country_scopes SET revoked_at = now() WHERE id = $1`, [IDS.scope]);

    const afterRevoke = await asRequest({ kind: 'staff', uid: STAFF_UID, country: 'AR' }, () =>
      visiblePatientIds(appPool),
    );
    expect(afterRevoke).toEqual([IDS.patientAR]);
  });

  it('contexto de sistema declarado (cron/webhook/MCP) enxerga os dois países', async () => {
    const systemAppPool = createRlsAwarePool(systemPool);
    const ids = await asRequest({ kind: 'system', systemContext: 'job:e2e' }, () =>
      visiblePatientIds(systemAppPool),
    );
    expect(ids).toEqual([IDS.patientAR, IDS.patientBR]);
  });

  it('o GUC de sistema NÃO fura o caminho de staff (o gate é a role)', async () => {
    // Mesmo declarando contexto de sistema, quem conecta como app_runtime segue
    // confinada — a policy exige MEMBRO de app_system.
    const ids = await asRequest({ kind: 'system', systemContext: 'job:tentativa' }, () =>
      visiblePatientIds(appPool),
    );
    expect(ids).toEqual([]);
  });

  it('escrita respeita a mesma fronteira: staff AR não altera paciente BR', async () => {
    const updated = await asRequest({ kind: 'staff', uid: STAFF_UID, country: 'AR' }, () =>
      withActorContext(runtimePool, async (client) => {
        const res = await client.query(`UPDATE patients SET first_name = 'Invadido' WHERE id = $1`, [
          IDS.patientBR,
        ]);
        return res.rowCount;
      }),
    );
    expect(updated).toBe(0);

    const check = await adminPool.query<{ first_name: string }>(
      `SELECT first_name FROM patients WHERE id = $1`,
      [IDS.patientBR],
    );
    expect(check.rows[0].first_name).toBe('Paciente');
  });
});
