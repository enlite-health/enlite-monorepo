import { Pool } from 'pg';
import { loggingAls } from '@shared/logging';
import { createRlsAwarePool } from '@shared/database/rlsAwarePool';
import {
  releaseDbSession,
  withSystemDbContext,
  type DbSession,
} from '@shared/database/requestDbSession';
import { withActorContext } from '@shared/database/actorContext';

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

/**
 * UM PROCESSO, DUAS IDENTIDADES DE BANCO — contra o banco real (task 3.2).
 *
 * `country-context-app.test.ts` já provou o mecanismo de contexto usando dois
 * pools SEPARADOS, escolhidos à mão pelo próprio teste. Aqui a escolha é do
 * runtime: existe UM objeto — o que `DatabaseConnection.getPool()` entrega —
 * e é a classe da request que decide se a conexão sai como `app_runtime`
 * (staff, confinado ao país) ou como `app_system` (cron/webhook/rota pública).
 *
 * Por que dois pools e não `SET ROLE`: `RESET ROLE` é uma linha de SQL. Com um
 * login único membro das duas roles, qualquer injection no caminho de staff
 * viraria escalada; com dois pools a fronteira é do servidor — `abac_dp_runtime`
 * simplesmente não é membro de `app_system`, e o teste (c) mostra que declarar
 * `app.system_context` na mão não compra nada.
 */
describe('roteamento dual-pool contra as policies (banco real)', () => {
  let adminPool: Pool;
  let runtimePool: Pool;
  let systemPool: Pool;
  /** O que os 115 repositórios recebem de `DatabaseConnection.getPool()`. */
  let appPool: Pool;

  const TENANT = '00000000-0000-0000-0000-000000000001';
  const STAFF_UID = 'abac-dp-e2e-staff';
  const RUNTIME_USER = 'abac_dp_runtime';
  const SYSTEM_USER = 'abac_dp_system';
  const PASSWORD = 'abac_dp_e2e_pw';

  const IDS = {
    patientAR: 'ee270000-0d00-0001-0001-000000000001',
    patientBR: 'ee270000-0d00-0001-0002-000000000001',
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
      return await loggingAls.run({ traceId: 'abac-dual-pool', dbSession: session }, fn);
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

  const currentUser = async (pool: Pool): Promise<string> => {
    const res = await pool.query<{ who: string }>('SELECT current_user AS who');
    return res.rows[0].who;
  };

  const firstNameOf = async (id: string): Promise<string> => {
    const res = await adminPool.query<{ first_name: string }>(
      `SELECT first_name FROM patients WHERE id = $1`,
      [id],
    );
    return res.rows[0].first_name;
  };

  async function cleanup(): Promise<void> {
    await adminPool.query(`DELETE FROM users WHERE firebase_uid = $1`, [STAFF_UID]);
    await adminPool.query(`DELETE FROM patients WHERE id = ANY($1)`, [[IDS.patientAR, IDS.patientBR]]);
  }

  beforeAll(async () => {
    process.env.COUNTRY_RLS_ENABLED = 'true';
    adminPool = new Pool({ connectionString: DATABASE_URL });

    // Usuários de LOGIN por identidade (o que o terraform cria em stg/prd — task 2.2):
    // cada um membro de UMA role de grupo só. É essa separação que o dual-pool usa.
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
         ($1, 'abac-dp-e2e-ar', 'Paciente', 'Argentino', 'AR'),
         ($2, 'abac-dp-e2e-br', 'Paciente', 'Brasileiro', 'BR')`,
      [IDS.patientAR, IDS.patientBR],
    );
    await adminPool.query(
      `INSERT INTO users (firebase_uid, email, role, is_active, tenant_id) VALUES ($1, 'abac-dp-e2e@enlite.health', 'recruiter', true, $2)`,
      [STAFF_UID, TENANT],
    );

    runtimePool = new Pool({ connectionString: urlFor(RUNTIME_USER), max: 4 });
    systemPool = new Pool({ connectionString: urlFor(SYSTEM_USER), max: 2 });
    // UM objeto para todo o app, com as DUAS identidades por dentro.
    appPool = createRlsAwarePool(runtimePool, systemPool);
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

  it('(a) request de staff sai como app_runtime e enxerga só o país dela', async () => {
    const { who, ids } = await asRequest({ kind: 'staff', uid: STAFF_UID, country: 'AR' }, async () => ({
      who: await currentUser(appPool),
      ids: await visiblePatientIds(appPool),
    }));

    expect(who).toBe(RUNTIME_USER);
    expect(ids).toEqual([IDS.patientAR]);
  });

  it('(b) withSystemDbContext NO MESMO PROCESSO sai como app_system e enxerga os dois países', async () => {
    const { who, ids } = await withSystemDbContext('job:dual-pool-e2e', async () => ({
      who: await currentUser(appPool),
      ids: await visiblePatientIds(appPool),
    }));

    expect(who).toBe(SYSTEM_USER);
    expect(ids).toEqual([IDS.patientAR, IDS.patientBR]);
  });

  it('(b2) as duas identidades convivem no mesmo processo, uma logo após a outra', async () => {
    const staff = await asRequest({ kind: 'staff', uid: STAFF_UID, country: 'AR' }, () =>
      visiblePatientIds(appPool),
    );
    const system = await withSystemDbContext('job:dual-pool-e2e', () => visiblePatientIds(appPool));
    const staffDepois = await asRequest({ kind: 'staff', uid: STAFF_UID, country: 'BR' }, () =>
      visiblePatientIds(appPool),
    );

    expect(staff).toEqual([IDS.patientAR]);
    expect(system).toEqual([IDS.patientAR, IDS.patientBR]);
    expect(staffDepois).toEqual([IDS.patientBR]);
  });

  it('(c) staff que declara app.system_context na mão continua confinado — a membership manda', async () => {
    const { who, ids, guc } = await asRequest(
      { kind: 'staff', uid: STAFF_UID, country: 'AR', systemContext: 'job:tentativa-de-atalho' },
      async () => ({
        who: await currentUser(appPool),
        ids: await visiblePatientIds(appPool),
        guc: (
          await appPool.query<{ v: string }>(
            `SELECT current_setting('app.system_context', true) AS v`,
          )
        ).rows[0].v,
      }),
    );

    // O GUC foi mesmo aplicado (o teste não passa por acidente de não ter setado)…
    expect(guc).toBe('job:tentativa-de-atalho');
    // …mas a conexão é a de runtime, e a policy exige MEMBRO de app_system.
    expect(who).toBe(RUNTIME_USER);
    expect(ids).toEqual([IDS.patientAR]);
  });

  it('(d) escrita: staff AR não altera o paciente BR; o mesmo código sob contexto de sistema altera', async () => {
    const comoStaff = await asRequest({ kind: 'staff', uid: STAFF_UID, country: 'AR' }, () =>
      withActorContext(appPool, async (client) => {
        const res = await client.query(`UPDATE patients SET first_name = 'Invadido' WHERE id = $1`, [
          IDS.patientBR,
        ]);
        return res.rowCount;
      }),
    );
    expect(comoStaff).toBe(0);
    expect(await firstNameOf(IDS.patientBR)).toBe('Paciente');

    const comoSistema = await withSystemDbContext('job:dual-pool-e2e-write', () =>
      withActorContext(appPool, async (client) => {
        const res = await client.query(`UPDATE patients SET first_name = 'Sincronizado' WHERE id = $1`, [
          IDS.patientBR,
        ]);
        return res.rowCount;
      }),
    );
    expect(comoSistema).toBe(1);
    expect(await firstNameOf(IDS.patientBR)).toBe('Sincronizado');

    // E o paciente AR segue intocado — o atalho de sistema é amplo, não cego.
    expect(await firstNameOf(IDS.patientAR)).toBe('Paciente');
  });

  it('a sessão devolve cada client ao SEU pool — nenhuma conexão fica pendurada', async () => {
    await asRequest({ kind: 'staff', uid: STAFF_UID, country: 'AR' }, async () => {
      await visiblePatientIds(appPool);
      await withSystemDbContext('job:dual-pool-e2e-trilha', () => visiblePatientIds(appPool));
    });

    expect(runtimePool.idleCount).toBe(runtimePool.totalCount);
    expect(systemPool.idleCount).toBe(systemPool.totalCount);
    expect(runtimePool.waitingCount).toBe(0);
    expect(systemPool.waitingCount).toBe(0);

    // E os clients voltaram LIMPOS: nenhum país sobrou na conexão.
    const leftoverRuntime = await runtimePool.query<{ c: string }>(
      `SELECT current_setting('app.user_country', true) AS c`,
    );
    const leftoverSystem = await systemPool.query<{ s: string }>(
      `SELECT current_setting('app.system_context', true) AS s`,
    );
    expect(leftoverRuntime.rows[0].c ?? '').toBe('');
    expect(leftoverSystem.rows[0].s ?? '').toBe('');
  });

  it('com a flag desligada, o pool de sistema não é tocado (invariante da virada)', async () => {
    delete process.env.COUNTRY_RLS_ENABLED;
    try {
      const antes = systemPool.totalCount;
      // Sob app_runtime sem contexto nenhum, a RLS já responde zero linhas —
      // o ponto aqui é que a query saiu pelo pool principal, não pelo de sistema.
      const who = await asRequest({ kind: 'system', systemContext: 'job:x' }, () =>
        currentUser(appPool),
      );
      expect(who).toBe(RUNTIME_USER);
      expect(systemPool.totalCount).toBe(antes);
    } finally {
      process.env.COUNTRY_RLS_ENABLED = 'true';
    }
  });
});
