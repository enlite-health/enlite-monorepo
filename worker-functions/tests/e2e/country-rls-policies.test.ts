import { Pool, PoolClient } from 'pg';

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

/**
 * E2E de banco real: policies RLS de país (abac-pais-fase1, task 2.6)
 *
 * Prova as migrations 268-272 contra Postgres real, do jeito que o runtime vai usar:
 * cada cenário roda numa transação com `SET LOCAL ROLE app_runtime|app_system`
 * (roles de grupo da migration 269 — não-owner, sem BYPASSRLS) e as variáveis de
 * contexto setadas via set_config(..., true), o contrato do withActorContext (3.1).
 *
 * Cenários exigidos pela task 2.6:
 *   1. staff AR não vê BR (lista + detalhe + escrita)
 *   2. grant vivo de grupo vê cross-país
 *   3. grant revogado deixa de ver na request seguinte
 *   4. contexto ausente = zero linhas (fail-closed)
 *   5. role de sistema com contexto explícito vê tudo
 * + endurecimentos do review 13/08: o atalho de sistema é gated por ROLE (app_runtime
 * com o GUC setado continua confinada); app_runtime não forja o próprio grant; trilhas
 * de auditoria são append-only INCLUSIVE por acesso direto à partição; usuário
 * inativo perde o grant; e duas invariantes de catálogo (cobertura de satélites por
 * FK e ausência de FORCE) que seguram regressões futuras.
 *
 * NOTA: o superuser do harness (enlite_admin) bypassa RLS SEMPRE (até com FORCE) —
 * ele serve para seed/asserção de estado, nunca para provar comportamento de owner.
 * A prova "prod inalterado" é a invariante relforcerowsecurity=false + o fato de
 * enlite_app (owner, sem BYPASSRLS) só ser afetado por FORCE.
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
    // Ordem FK-segura; delete de 0 linhas não é erro — falha aqui deve APARECER.
    await p.query(`DELETE FROM group_country_scopes WHERE id = $1`, [IDS.scope]);
    await p.query(`DELETE FROM user_groups WHERE user_id = $1`, [STAFF_UID]);
    await p.query(`DELETE FROM permission_groups WHERE id = $1`, [IDS.group]);
    await p.query(`DELETE FROM users WHERE firebase_uid = $1`, [STAFF_UID]);
    await p.query(`DELETE FROM patient_addresses WHERE id = ANY($1)`, [[IDS.addressAR, IDS.addressBR]]);
    await p.query(`DELETE FROM patients WHERE id = ANY($1)`, [[IDS.patientAR, IDS.patientBR]]);
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    await cleanup(pool);

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
   * Roda `fn` numa transação como a role dada com o contexto dado, e desfaz tudo.
   * Espelha o contrato do withActorContext: SET LOCAL, nunca SET (pooling).
   */
  async function asRole<T>(
    role: 'app_runtime' | 'app_system',
    ctx: { userCountry?: string; userUid?: string; systemContext?: string },
    fn: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL ROLE ${role}`);
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

  it('sanidade do seed: harness (superuser) vê os 2 pacientes de teste', async () => {
    const res = await pool.query(listTestPatients, [[IDS.patientAR, IDS.patientBR]]);
    expect(res.rows.map((r) => r.country)).toEqual(['AR', 'BR']);
  });

  it('invariante: NENHUMA tabela da leva tem FORCE (owner enlite_app segue ileso em prod)', async () => {
    const res = await pool.query(
      `SELECT relname FROM pg_class
       WHERE relrowsecurity = true AND relforcerowsecurity = true
         AND relnamespace = 'public'::regnamespace`,
    );
    expect(res.rows).toEqual([]);
  });

  it('invariante: TODA tabela com FK para patients tem RLS ligada (menos exceções justificadas)', async () => {
    // job_postings: tem coluna country própria e é superfície de vaga, não dossiê
    // clínico — entra na leva workers/vagas (task 4.3 da change abac-pais-fase1).
    const ALLOWLIST = ['job_postings'];
    const res = await pool.query(
      `SELECT DISTINCT c.relname
       FROM pg_constraint con
       JOIN pg_class c ON c.oid = con.conrelid
       JOIN pg_class ref ON ref.oid = con.confrelid
       WHERE ref.relname = 'patients' AND con.contype = 'f'
         AND c.relrowsecurity = false
       ORDER BY 1`,
    );
    const unprotected = res.rows.map((r) => r.relname).filter((t) => !ALLOWLIST.includes(t));
    expect(unprotected).toEqual([]);
  });

  it('1a. staff AR vê AR e NÃO vê BR na lista', async () => {
    const rows = await asRole('app_runtime', { userCountry: 'AR', userUid: STAFF_UID }, async (c) => {
      const res = await c.query(listTestPatients, [[IDS.patientAR, IDS.patientBR]]);
      return res.rows;
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].country).toBe('AR');
  });

  it('1b. staff AR não vê BR no detalhe (por id)', async () => {
    const rows = await asRole('app_runtime', { userCountry: 'AR', userUid: STAFF_UID }, async (c) => {
      const res = await c.query(`SELECT id FROM patients WHERE id = $1`, [IDS.patientBR]);
      return res.rows;
    });
    expect(rows).toHaveLength(0);
  });

  it('1c. staff AR não ESCREVE em BR (UPDATE atinge 0 linhas)', async () => {
    const count = await asRole('app_runtime', { userCountry: 'AR', userUid: STAFF_UID }, async (c) => {
      const res = await c.query(`UPDATE patients SET needs_attention = true WHERE id = $1`, [IDS.patientBR]);
      return res.rowCount;
    });
    expect(count).toBe(0);
  });

  it('1d. WITH CHECK: staff AR não INSERE paciente BR', async () => {
    await expect(
      asRole('app_runtime', { userCountry: 'AR', userUid: STAFF_UID }, async (c) => {
        await c.query(
          `INSERT INTO patients (id, clickup_task_id, first_name, last_name, country)
           VALUES ('ee270000-0a00-0001-0003-000000000001', 'rls-e2e-task-x', 'Intruso', 'Cross', 'BR')`,
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

    const rows = await asRole('app_runtime', { userCountry: 'AR', userUid: STAFF_UID }, async (c) => {
      const res = await c.query(listTestPatients, [[IDS.patientAR, IDS.patientBR]]);
      return res.rows;
    });
    expect(rows.map((r) => r.country)).toEqual(['AR', 'BR']);
  });

  it('2b. usuário INATIVO perde o grant na hora (offboarding fail-closed)', async () => {
    // `status` é a fonte (206); o trigger deriva is_active. A 274 olhava só is_active; a 411 olha status (276).
    await pool.query(`UPDATE users SET status = 'DEACTIVATED' WHERE firebase_uid = $1`, [STAFF_UID]);
    try {
      const rows = await asRole('app_runtime', { userCountry: 'AR', userUid: STAFF_UID }, async (c) => {
        const res = await c.query(listTestPatients, [[IDS.patientAR, IDS.patientBR]]);
        return res.rows;
      });
      expect(rows).toHaveLength(1);
      expect(rows[0].country).toBe('AR');
    } finally {
      await pool.query(`UPDATE users SET status = 'ACTIVE' WHERE firebase_uid = $1`, [STAFF_UID]);
    }
  });

  it('3. grant REVOGADO deixa de ver na request seguinte (efeito imediato)', async () => {
    await pool.query(`UPDATE group_country_scopes SET revoked_at = now() WHERE id = $1`, [IDS.scope]);

    const rows = await asRole('app_runtime', { userCountry: 'AR', userUid: STAFF_UID }, async (c) => {
      const res = await c.query(listTestPatients, [[IDS.patientAR, IDS.patientBR]]);
      return res.rows;
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].country).toBe('AR');
  });

  it('4. contexto ausente = ERRO NOMEADO, nunca zero linhas (411: fail-closed em voz alta)', async () => {
    // Até a 411, sessão sem identidade recebia conjunto VAZIO — indistinguível de "não há pacientes".
    const q = asRole('app_runtime', {}, (c) => c.query(listTestPatients, [[IDS.patientAR, IDS.patientBR]]));
    await expect(q).rejects.toMatchObject({ code: '42501' });
    await expect(q).rejects.toThrow(/rls_session_without_identity/);
  });

  it('5. role de SISTEMA com contexto explícito vê tudo', async () => {
    const rows = await asRole('app_system', { systemContext: 'job:e2e-rls-proof' }, async (c) => {
      const res = await c.query(listTestPatients, [[IDS.patientAR, IDS.patientBR]]);
      return res.rows;
    });
    expect(rows.map((r) => r.country)).toEqual(['AR', 'BR']);
  });

  it('5b. o atalho de sistema é GATED POR ROLE: app_runtime com o GUC setado segue confinada', async () => {
    const rows = await asRole('app_runtime', { systemContext: 'job:forjado-no-caminho-staff' }, async (c) => {
      const res = await c.query(listTestPatients, [[IDS.patientAR, IDS.patientBR]]);
      return res.rows;
    });
    expect(rows).toHaveLength(0);
  });

  it('5c. app_system SEM contexto explícito é recusada em voz alta (sistema nunca é default; 411)', async () => {
    const q = asRole('app_system', {}, (c) => c.query(listTestPatients, [[IDS.patientAR, IDS.patientBR]]));
    await expect(q).rejects.toThrow(/rls_session_without_identity/);
  });

  it('6. satélite SEGUE o pai: staff AR só vê o endereço do paciente AR', async () => {
    const rows = await asRole('app_runtime', { userCountry: 'AR', userUid: STAFF_UID }, async (c) => {
      const res = await c.query(
        `SELECT id, patient_id FROM patient_addresses WHERE id = ANY($1)`,
        [[IDS.addressAR, IDS.addressBR]],
      );
      return res.rows;
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].patient_id).toBe(IDS.patientAR);
  });

  it('7. satélite com role de sistema + contexto vê os dois', async () => {
    const rows = await asRole('app_system', { systemContext: 'job:e2e-rls-proof' }, async (c) => {
      const res = await c.query(
        `SELECT id FROM patient_addresses WHERE id = ANY($1)`,
        [[IDS.addressAR, IDS.addressBR]],
      );
      return res.rows;
    });
    expect(rows).toHaveLength(2);
  });

  it('8. resource_access_log: app roles inserem mas NÃO leem nem apagam (lex C2)', async () => {
    await asRole('app_system', { systemContext: 'job:e2e-rls-proof' }, async (c) => {
      await c.query(
        `INSERT INTO resource_access_log (operator_uid, operator_role, resource_type, resource_id, action, origin)
         VALUES ('rls-test-staff-uid', 'admin', 'patient', $1, 'detail_view', 'system')`,
        [IDS.patientAR],
      );
      await expect(c.query(`SELECT * FROM resource_access_log LIMIT 1`)).rejects.toThrow(/permission denied/);
    });
    await asRole('app_system', { systemContext: 'job:e2e-rls-proof' }, async (c) => {
      await expect(c.query(`DELETE FROM resource_access_log`)).rejects.toThrow(/permission denied/);
    });
  });

  it('8b. partição NOMEADA também é negada (o ACL checado é o da relação da query)', async () => {
    await asRole('app_runtime', { userCountry: 'AR', userUid: STAFF_UID }, async (c) => {
      await expect(c.query(`SELECT * FROM resource_access_log_2026_08 LIMIT 1`)).rejects.toThrow(/permission denied/);
    });
    await asRole('app_system', { systemContext: 'job:x' }, async (c) => {
      await expect(c.query(`DELETE FROM resource_access_log_default`)).rejects.toThrow(/permission denied/);
    });
  });

  it('8c. nenhuma partição de resource_access_log tem privilégio para as roles do app', async () => {
    // Trava de drift: partição futura criada por runbook sem repetir o REVOKE
    // (default privileges re-concedem DML) quebra AQUI, não em prod.
    const res = await pool.query(
      `SELECT c.relname
       FROM pg_inherits i
       JOIN pg_class c ON c.oid = i.inhrelid
       WHERE i.inhparent = 'resource_access_log'::regclass
         AND (
           has_table_privilege('app_runtime', c.oid, 'SELECT, UPDATE, DELETE')
           OR has_table_privilege('app_system', c.oid, 'SELECT, UPDATE, DELETE')
         )`,
    );
    expect(res.rows).toEqual([]);
  });

  it('9. app_runtime NÃO forja o próprio grant (tabelas de controle são SELECT-only)', async () => {
    await asRole('app_runtime', { userCountry: 'AR', userUid: STAFF_UID }, async (c) => {
      await expect(
        c.query(
          `INSERT INTO group_country_scopes (group_id, country, granted_by, reason)
           VALUES ($1, 'BR', 'forjado', 'ataque')`,
          [IDS.group],
        ),
      ).rejects.toThrow(/permission denied/);
    });
    await asRole('app_runtime', { userCountry: 'AR', userUid: STAFF_UID }, async (c) => {
      await expect(
        c.query(`UPDATE group_country_scopes SET revoked_at = NULL WHERE id = $1`, [IDS.scope]),
      ).rejects.toThrow(/permission denied/);
    });
    await asRole('app_runtime', { userCountry: 'AR', userUid: STAFF_UID }, async (c) => {
      await expect(
        c.query(`INSERT INTO user_groups (user_id, group_id, tenant_id) VALUES ('x', $1, $2)`, [IDS.group, TENANT]),
      ).rejects.toThrow(/permission denied/);
    });
  });

  it('10. trilhas de auditoria são append-only para as roles do app', async () => {
    await asRole('app_runtime', { userCountry: 'AR', userUid: STAFF_UID }, async (c) => {
      await expect(
        c.query(`DELETE FROM worker_profile_changes_audit WHERE worker_id = '00000000-0000-0000-0000-000000000000'`),
      ).rejects.toThrow(/permission denied/);
    });
    await asRole('app_runtime', { userCountry: 'AR', userUid: STAFF_UID }, async (c) => {
      await expect(
        c.query(`UPDATE worker_status_history SET changed_by = 'x' WHERE worker_id = '00000000-0000-0000-0000-000000000000'`),
      ).rejects.toThrow(/permission denied/);
    });
  });
});
