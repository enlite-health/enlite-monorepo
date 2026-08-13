import { Pool, PoolClient } from 'pg';

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

/**
 * E2E de banco real: policies RLS de país (abac-pais-fase1, task 2.6)
 *
 * Prova as migrations 268-272 contra Postgres real, do jeito que o runtime vai usar:
 * cada cenário roda numa transação com `SET LOCAL ROLE app_runtime` (não-owner, sem
 * BYPASSRLS — a role de grupo da migration 269) e as variáveis de contexto setadas
 * via set_config(..., true), exatamente o contrato do withActorContext (task 3.1).
 *
 * Cenários exigidos pela task 2.6:
 *   1. staff AR não vê BR (lista + detalhe + escrita)
 *   2. grant vivo de grupo vê cross-país
 *   3. grant revogado deixa de ver na request seguinte
 *   4. contexto ausente = zero linhas (fail-closed)
 *   5. contexto de sistema explícito vê tudo
 * + satélites seguem o pai (patient_addresses) e WITH CHECK barra INSERT cross-país.
 *
 * IMPORTANTE: o superuser do harness (enlite_admin) é OWNER das tabelas aqui — sem
 * FORCE, ele ignora as policies (comportamento pretendido para prod hoje). Por isso
 * cada asserção de RLS PRECISA do SET LOCAL ROLE.
 */
describe('RLS por país — policies de patients e satélites (banco real)', () => {
  let pool: Pool;

  const TENANT = '00000000-0000-0000-0000-000000000001';
  const STAFF_UID = 'rls-test-staff-uid';
  const IDS = {
    patientAR: 'ee270000-0a00-0001-0001-000000000001',
    patientBR: 'ee270000-0a00-0001-0002-000000000001',
    addressAR: 'ee270000-0a00-0002-0001-000000000001',
    addressBR: 'ee270000-0a00-0002-0002-000000000001',
    group: 'ee270000-0a00-0003-0001-000000000001',
    scope: 'ee270000-0a00-0004-0001-000000000001',
  };

  async function cleanup(p: Pool): Promise<void> {
    await p.query(`DELETE FROM group_country_scopes WHERE id = $1`, [IDS.scope]).catch(() => {});
    await p.query(`DELETE FROM user_groups WHERE user_id = $1`, [STAFF_UID]).catch(() => {});
    await p.query(`DELETE FROM permission_groups WHERE id = $1`, [IDS.group]).catch(() => {});
    await p.query(`DELETE FROM users WHERE firebase_uid = $1`, [STAFF_UID]).catch(() => {});
    await p.query(`DELETE FROM patient_addresses WHERE id = ANY($1)`, [[IDS.addressAR, IDS.addressBR]]).catch(() => {});
    await p.query(`DELETE FROM patients WHERE id = ANY($1)`, [[IDS.patientAR, IDS.patientBR]]).catch(() => {});
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    await cleanup(pool);

    // Seed como owner (bypassa RLS sem FORCE — provado no teste de sanidade abaixo)
    await pool.query(
      `INSERT INTO patients (id, clickup_task_id, first_name, last_name, country) VALUES
         ($1, 'rls-e2e-task-ar', 'Paciente', 'Argentino', 'AR'),
         ($2, 'rls-e2e-task-br', 'Paciente', 'Brasileiro', 'BR')`,
      [IDS.patientAR, IDS.patientBR],
    );
    await pool.query(
      `INSERT INTO patient_addresses (id, patient_id, address_type, address_formatted) VALUES
         ($1, $2, 'primary', 'Av. Corrientes 1234, CABA'),
         ($3, $4, 'primary', 'Av. Paulista 1000, São Paulo')`,
      [IDS.addressAR, IDS.patientAR, IDS.addressBR, IDS.patientBR],
    );
    await pool.query(
      `INSERT INTO users (firebase_uid, email, role, tenant_id) VALUES ($1, 'rls-staff@e2e.local', 'admin', $2)`,
      [STAFF_UID, TENANT],
    );
    await pool.query(
      `INSERT INTO permission_groups (id, tenant_id, name) VALUES ($1, $2, 'RLS Test Cross País')`,
      [IDS.group, TENANT],
    );
    await pool.query(
      `INSERT INTO user_groups (user_id, group_id, tenant_id) VALUES ($1, $2, $3)`,
      [STAFF_UID, IDS.group, TENANT],
    );
  });

  afterAll(async () => {
    await cleanup(pool);
    await pool.end();
  });

  /**
   * Roda `fn` numa transação como app_runtime com o contexto dado, e desfaz tudo.
   * Espelha o contrato do withActorContext: SET LOCAL, nunca SET (pooling).
   */
  async function asRuntime<T>(
    ctx: { userCountry?: string; userUid?: string; systemContext?: string },
    fn: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE app_runtime');
      if (ctx.userCountry) await client.query(`SELECT set_config('app.user_country', $1, true)`, [ctx.userCountry]);
      if (ctx.userUid) await client.query(`SELECT set_config('app.user_uid', $1, true)`, [ctx.userUid]);
      if (ctx.systemContext) await client.query(`SELECT set_config('app.system_context', $1, true)`, [ctx.systemContext]);
      return await fn(client);
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
    }
  }

  const listTestPatients = `SELECT id, country FROM patients WHERE id = ANY($1) ORDER BY country`;

  it('sanidade: owner (sem FORCE) segue vendo tudo — comportamento de prod inalterado', async () => {
    const res = await pool.query(listTestPatients, [[IDS.patientAR, IDS.patientBR]]);
    expect(res.rows.map((r) => r.country)).toEqual(['AR', 'BR']);
  });

  it('1a. staff AR vê AR e NÃO vê BR na lista', async () => {
    const rows = await asRuntime({ userCountry: 'AR', userUid: STAFF_UID }, async (c) => {
      const res = await c.query(listTestPatients, [[IDS.patientAR, IDS.patientBR]]);
      return res.rows;
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].country).toBe('AR');
  });

  it('1b. staff AR não vê BR no detalhe (por id)', async () => {
    const rows = await asRuntime({ userCountry: 'AR', userUid: STAFF_UID }, async (c) => {
      const res = await c.query(`SELECT id FROM patients WHERE id = $1`, [IDS.patientBR]);
      return res.rows;
    });
    expect(rows).toHaveLength(0);
  });

  it('1c. staff AR não ESCREVE em BR (UPDATE atinge 0 linhas)', async () => {
    const count = await asRuntime({ userCountry: 'AR', userUid: STAFF_UID }, async (c) => {
      const res = await c.query(`UPDATE patients SET needs_attention = true WHERE id = $1`, [IDS.patientBR]);
      return res.rowCount;
    });
    expect(count).toBe(0);
  });

  it('1d. WITH CHECK: staff AR não INSERE paciente BR', async () => {
    await expect(
      asRuntime({ userCountry: 'AR', userUid: STAFF_UID }, async (c) => {
        await c.query(
          `INSERT INTO patients (id, first_name, last_name, country)
           VALUES ('ee270000-0a00-0001-0003-000000000001', 'Intruso', 'Cross', 'BR')`,
        );
      }),
    ).rejects.toThrow(/row-level security/);
  });

  it('2. grant VIVO de grupo dá visão cross-país', async () => {
    await pool.query(
      `INSERT INTO group_country_scopes (id, group_id, country, granted_by, reason)
       VALUES ($1, $2, 'BR', 'rls-test-admin', 'e2e: valida grant vivo')`,
      [IDS.scope, IDS.group],
    );

    const rows = await asRuntime({ userCountry: 'AR', userUid: STAFF_UID }, async (c) => {
      const res = await c.query(listTestPatients, [[IDS.patientAR, IDS.patientBR]]);
      return res.rows;
    });
    expect(rows.map((r) => r.country)).toEqual(['AR', 'BR']);
  });

  it('3. grant REVOGADO deixa de ver na request seguinte (efeito imediato)', async () => {
    await pool.query(`UPDATE group_country_scopes SET revoked_at = now() WHERE id = $1`, [IDS.scope]);

    const rows = await asRuntime({ userCountry: 'AR', userUid: STAFF_UID }, async (c) => {
      const res = await c.query(listTestPatients, [[IDS.patientAR, IDS.patientBR]]);
      return res.rows;
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].country).toBe('AR');
  });

  it('4. contexto ausente = ZERO linhas (fail-closed)', async () => {
    const rows = await asRuntime({}, async (c) => {
      const res = await c.query(listTestPatients, [[IDS.patientAR, IDS.patientBR]]);
      return res.rows;
    });
    expect(rows).toHaveLength(0);
  });

  it('5. contexto de sistema explícito vê tudo', async () => {
    const rows = await asRuntime({ systemContext: 'job:e2e-rls-proof' }, async (c) => {
      const res = await c.query(listTestPatients, [[IDS.patientAR, IDS.patientBR]]);
      return res.rows;
    });
    expect(rows.map((r) => r.country)).toEqual(['AR', 'BR']);
  });

  it('6. satélite SEGUE o pai: staff AR só vê o endereço do paciente AR', async () => {
    const rows = await asRuntime({ userCountry: 'AR', userUid: STAFF_UID }, async (c) => {
      const res = await c.query(
        `SELECT id, patient_id FROM patient_addresses WHERE id = ANY($1)`,
        [[IDS.addressAR, IDS.addressBR]],
      );
      return res.rows;
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].patient_id).toBe(IDS.patientAR);
  });

  it('7. satélite com contexto de sistema vê os dois', async () => {
    const rows = await asRuntime({ systemContext: 'job:e2e-rls-proof' }, async (c) => {
      const res = await c.query(
        `SELECT id FROM patient_addresses WHERE id = ANY($1)`,
        [[IDS.addressAR, IDS.addressBR]],
      );
      return res.rows;
    });
    expect(rows).toHaveLength(2);
  });

  it('8. resource_access_log: app roles inserem mas NÃO leem nem apagam (lex C2)', async () => {
    await asRuntime({ systemContext: 'job:e2e-rls-proof' }, async (c) => {
      await c.query(
        `INSERT INTO resource_access_log (operator_uid, operator_role, resource_type, resource_id, action, origin)
         VALUES ('rls-test-staff-uid', 'admin', 'patient', $1, 'detail_view', 'system')`,
        [IDS.patientAR],
      );
      await expect(c.query(`SELECT * FROM resource_access_log LIMIT 1`)).rejects.toThrow(/permission denied/);
    });
    // DELETE também negado (append-only) — transação nova porque a anterior abortou no SELECT
    await asRuntime({ systemContext: 'job:e2e-rls-proof' }, async (c) => {
      await expect(c.query(`DELETE FROM resource_access_log`)).rejects.toThrow(/permission denied/);
    });
  });
});
