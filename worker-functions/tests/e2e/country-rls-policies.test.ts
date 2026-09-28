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
    // Fase 7, P3 (itinerário: slot/alocação seguem o pai) — mesmo IDS, mesmo prefixo do arquivo.
    serviceAR: 'ee270000-0a00-0005-0001-000000000001',
    serviceBR: 'ee270000-0a00-0005-0002-000000000001',
    jobAR: 'ee270000-0a00-0006-0001-000000000001',
    jobBR: 'ee270000-0a00-0006-0002-000000000001',
    itinWorker: 'ee270000-0a00-0007-0001-000000000001',
    wjaAR: 'ee270000-0a00-0008-0001-000000000001',
    wjaBR: 'ee270000-0a00-0008-0002-000000000001',
    slotAR: 'ee270000-0a00-0009-0001-000000000001',
    slotBR: 'ee270000-0a00-0009-0002-000000000001',
    assignmentAR: 'ee270000-0a00-000a-0001-000000000001',
    assignmentBR: 'ee270000-0a00-000a-0002-000000000001',
    // Fase 10, P4 (contracted_service_rejections: a marca do quadro C segue o pai) — mesmo IDS,
    // mesmo prefixo do arquivo.
    csrServiceAR: 'ee270000-0a00-000b-0001-000000000001',
    csrServiceBR: 'ee270000-0a00-000b-0002-000000000001',
    csrWorker: 'ee270000-0a00-000c-0001-000000000001',
    csrMarkAR: 'ee270000-0a00-000d-0001-000000000001',
    csrMarkBR: 'ee270000-0a00-000d-0002-000000000001',
    // Fase 11, P4 (DX-11.3, DX-11.14) — montado segue o pai; a trava enxerga através da RLS
    // (SECURITY DEFINER) — mesmo IDS, mesmo prefixo do arquivo.
    itin11ServiceAR: 'ee270000-0a00-000e-0001-000000000001',
    itin11ServiceBR: 'ee270000-0a00-000e-0002-000000000001',
    itin11JobAR: 'ee270000-0a00-000f-0001-000000000001',
    itin11JobBR: 'ee270000-0a00-000f-0002-000000000001',
    itin11Worker: 'ee270000-0a00-0010-0001-000000000001',
    itin11WjaAR: 'ee270000-0a00-0011-0001-000000000001',
    itin11WjaBR: 'ee270000-0a00-0011-0002-000000000001',
    itin11SlotAR: 'ee270000-0a00-0012-0001-000000000001',
    itin11SlotBR: 'ee270000-0a00-0012-0002-000000000001',
    itin11AssignmentBR: 'ee270000-0a00-0013-0002-000000000001',
    itin11AssemblyAR: 'ee270000-0a00-0014-0001-000000000001',
    itin11AssemblyBR: 'ee270000-0a00-0014-0002-000000000001',
    // Fase 13, P5 (DX-13.16, casos 6l/6m/6n) — a ausência segue o pai; a trava por data enxerga
    // através da RLS — mesmo IDS, mesmo prefixo do arquivo.
    absSvcAR: 'ee270000-0a00-0015-0001-000000000001',
    absSvcBR: 'ee270000-0a00-0015-0002-000000000001',
    absJobAR: 'ee270000-0a00-0016-0001-000000000001',
    absJobBR: 'ee270000-0a00-0016-0002-000000000001',
    absTitularAR: 'ee270000-0a00-0017-0001-000000000001',
    absTitularBR: 'ee270000-0a00-0017-0002-000000000001',
    absSubstitute: 'ee270000-0a00-0017-0003-000000000001',
    absWjaTitularAR: 'ee270000-0a00-0018-0001-000000000001',
    absWjaTitularBR: 'ee270000-0a00-0018-0002-000000000001',
    absWjaSubAR: 'ee270000-0a00-0018-0003-000000000001',
    absWjaSubBR: 'ee270000-0a00-0018-0004-000000000001',
    absSlotAR: 'ee270000-0a00-0019-0001-000000000001',
    absSlotBR: 'ee270000-0a00-0019-0002-000000000001',
    absAssignmentAR: 'ee270000-0a00-001a-0001-000000000001',
    absAssignmentBR: 'ee270000-0a00-001a-0002-000000000001',
    absSeedAR: 'ee270000-0a00-001b-0001-000000000001',
    absSeedBR: 'ee270000-0a00-001b-0002-000000000001',
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
      `INSERT INTO patient_addresses (id, patient_id, address_formatted) VALUES
         ($1, $2, 'Av. Corrientes 1234, CABA'),
         ($3, $4, 'Av. Paulista 1000, São Paulo')`,
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
    // anacare_shift saiu desta allowlist em 17/09 (migration 444): a justificativa de
    // D345 ("a tabela nasce e permanece VAZIA") não faz mais sentido quando a tabela
    // nem existe mais — o retrato passou a ser agregado por paciente+mês
    // (`anacare_patient_month`, migrations 441/442) e a tabela por turno, órfã desde a
    // F6.4a, foi dropada.
    // axonico_comprobante_lancamento: `document_number` é a chave do índice único de dedupe
    // (`uq_axonico_lancamento_dedupe`) que impede faturar duas vezes no Axonico. A tentativa de
    // cifrar a coluna com blind index (migration 447) foi revertida em 19/09/2026 porque a policy
    // de RLS correspondente tornava a tabela inescrevível e invisível para `app_runtime` — o
    // dedupe morria. Cifra e RLS ficam PENDENTES DE DESENHO.
    const ALLOWLIST = ['job_postings', 'axonico_comprobante_lancamento'];
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

  it('8. resource_access_log: app roles inserem e agora LEEM o pai (decisão do Gabriel, 20/09/2026, mig 455 — sobrepõe o lex C2 abaixo), mas seguem sem apagar', async () => {
    // O `lex C2` motivou originalmente negar leitura do pai a app_runtime/app_system
    // ("append-only de verdade" — REVOKE ALL + GRANT INSERT em 270:69-70). Essa restrição de
    // LEITURA foi SOBREPOSTA por decisão explícita do Gabriel em 20/09/2026 (mig 455): a
    // trilha de auditoria passa a ser legível para as roles de runtime. A restrição de
    // ESCRITA (DELETE) que o mesmo lex C2 motivou segue de pé — só o SELECT mudou. O `lex C2`
    // fica citado aqui como contexto histórico da decisão original, não como regra vigente.
    await asRole('app_system', { systemContext: 'job:e2e-rls-proof' }, async (c) => {
      await c.query(
        `INSERT INTO resource_access_log (operator_uid, operator_role, resource_type, resource_id, action, origin)
         VALUES ('rls-test-staff-uid', 'admin', 'patient', $1, 'detail_view', 'system')`,
        [IDS.patientAR],
      );
      await expect(c.query(`SELECT * FROM resource_access_log LIMIT 1`)).resolves.toBeDefined();
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

  /**
   * Fase 7, P3 (DX-7.1, DX-7.9 (3)) — `patient_itinerary_slot` / `patient_itinerary_assignment`
   * seguem o paciente pela mesma cadeia de RLS que os satélites (413/429): a policy não olha
   * country da própria linha, olha visibilidade de `patient_contracted_services`/`patient_itinerary_slot`
   * (que por sua vez segue `patients`). `beforeAll`/`afterAll` próprios, como dono (`pool`), com ids
   * novos no mesmo `IDS` (prefixo do arquivo) — a semente de cima e os casos existentes não mudam.
   */
  describe('itinerário (Fase 7): patient_itinerary_slot / patient_itinerary_assignment seguem o pai', () => {
    const CREATED_BY = 'rls-e2e-itin';

    beforeAll(async () => {
      // 1 serviço por paciente de teste (AR/BR), reusando os endereços já semeados acima.
      await pool.query(
        `INSERT INTO patient_contracted_services (id, patient_id, service_code, address_id, country, created_by, updated_by)
         VALUES ($1, $2, 'AT', $3, 'AR', $4, $4), ($5, $6, 'AT', $7, 'BR', $4, $4)`,
        [IDS.serviceAR, IDS.patientAR, IDS.addressAR, CREATED_BY, IDS.serviceBR, IDS.patientBR, IDS.addressBR],
      );

      // 1 vaga por serviço (job_postings.contracted_service_id).
      await pool.query(
        `INSERT INTO job_postings (id, title, contracted_service_id, patient_id, country)
         VALUES ($1, 'rls-e2e-itin-vaga-ar', $2, $3, 'AR'), ($4, 'rls-e2e-itin-vaga-br', $5, $6, 'BR')`,
        [IDS.jobAR, IDS.serviceAR, IDS.patientAR, IDS.jobBR, IDS.serviceBR, IDS.patientBR],
      );

      // 1 worker, com 1 WJA por vaga.
      await pool.query(
        `INSERT INTO workers (id, auth_uid, email, country) VALUES ($1, 'rls-e2e-itin-w1', 'rls-e2e-itin-w1@e2e.local', 'AR')`,
        [IDS.itinWorker],
      );
      await pool.query(
        `INSERT INTO worker_job_applications (id, worker_id, job_posting_id, application_funnel_stage, source)
         VALUES ($1, $2, $3, 'INVITED', 'import'), ($4, $2, $5, 'INVITED', 'import')`,
        [IDS.wjaAR, IDS.itinWorker, IDS.jobAR, IDS.wjaBR, IDS.jobBR],
      );

      // 1 slot por serviço.
      await pool.query(
        `INSERT INTO patient_itinerary_slot (id, contracted_service_id, weekday, start_time, end_time, created_by, updated_by)
         VALUES ($1, $2, 1, '08:00', '09:00', $3, $3), ($4, $5, 2, '08:00', '09:00', $3, $3)`,
        [IDS.slotAR, IDS.serviceAR, CREATED_BY, IDS.slotBR, IDS.serviceBR],
      );

      // 1 alocação por slot (candidatura daquela vaga, daquele worker — invariante 5).
      await pool.query(
        `INSERT INTO patient_itinerary_assignment (id, slot_id, worker_id, application_id, valid_from, created_by, updated_by)
         VALUES ($1, $2, $3, $4, '2026-01-01', $5, $5), ($6, $7, $3, $8, '2026-01-01', $5, $5)`,
        [IDS.assignmentAR, IDS.slotAR, IDS.itinWorker, IDS.wjaAR, CREATED_BY, IDS.assignmentBR, IDS.slotBR, IDS.wjaBR],
      );
    });

    afterAll(async () => {
      // Ordem: alocações → WJA → vagas → worker, ANTES do cleanup externo (que apaga os
      // pacientes; job_postings → patients é NO ACTION e recusaria a cascata). O serviço (e o slot,
      // em cascata) sai aqui também — não no cleanup externo — porque este apaga
      // `patient_addresses` ANTES de `patients` (semente de cima, intocada), e `pcs_address_same_patient_fk`
      // recusaria a linha de `patient_addresses` enquanto o serviço ainda a referenciar.
      await pool.query(`DELETE FROM patient_itinerary_assignment WHERE id = ANY($1)`, [[IDS.assignmentAR, IDS.assignmentBR]]);
      await pool.query(`DELETE FROM worker_job_applications WHERE id = ANY($1)`, [[IDS.wjaAR, IDS.wjaBR]]);
      await pool.query(`DELETE FROM job_postings WHERE id = ANY($1)`, [[IDS.jobAR, IDS.jobBR]]);
      await pool.query(`DELETE FROM workers WHERE id = $1`, [IDS.itinWorker]);
      await pool.query(`DELETE FROM patient_contracted_services WHERE id = ANY($1)`, [[IDS.serviceAR, IDS.serviceBR]]);
    });

    it('6c. itinerário segue o pai: staff AR vê só o slot e a alocação do paciente AR', async () => {
      const slots = await asRole('app_runtime', { userCountry: 'AR', userUid: STAFF_UID }, async (c) => {
        const res = await c.query(`SELECT id FROM patient_itinerary_slot WHERE id = ANY($1)`, [[IDS.slotAR, IDS.slotBR]]);
        return res.rows;
      });
      expect(slots).toHaveLength(1);
      expect(slots[0].id).toBe(IDS.slotAR);

      const assignments = await asRole('app_runtime', { userCountry: 'AR', userUid: STAFF_UID }, async (c) => {
        const res = await c.query(`SELECT id FROM patient_itinerary_assignment WHERE id = ANY($1)`, [
          [IDS.assignmentAR, IDS.assignmentBR],
        ]);
        return res.rows;
      });
      expect(assignments).toHaveLength(1);
      expect(assignments[0].id).toBe(IDS.assignmentAR);
    });

    it('6d. itinerário com role de sistema + contexto vê os dois', async () => {
      const slots = await asRole('app_system', { systemContext: 'job:e2e-rls-proof' }, async (c) => {
        const res = await c.query(`SELECT id FROM patient_itinerary_slot WHERE id = ANY($1)`, [[IDS.slotAR, IDS.slotBR]]);
        return res.rows;
      });
      expect(slots).toHaveLength(2);

      const assignments = await asRole('app_system', { systemContext: 'job:e2e-rls-proof' }, async (c) => {
        const res = await c.query(`SELECT id FROM patient_itinerary_assignment WHERE id = ANY($1)`, [
          [IDS.assignmentAR, IDS.assignmentBR],
        ]);
        return res.rows;
      });
      expect(assignments).toHaveLength(2);
    });

    it('6e. staff AR não INSERE slot no serviço BR', async () => {
      // `country` explícito (não-NULL) — o país da linha NÃO entra na policy (que só olha
      // visibilidade de `patient_contracted_services`); sem isso, o trigger de país tentaria
      // herdar de `serviceBR`, essa própria leitura já cairia na RLS de `patient_contracted_services`
      // (que segue `patients`) e o NOT NULL da coluna dispararia ANTES do WITH CHECK — mascarando
      // a prova de que É a policy da tabela nova que bloqueia.
      await expect(
        asRole('app_runtime', { userCountry: 'AR', userUid: STAFF_UID }, async (c) => {
          await c.query(
            `INSERT INTO patient_itinerary_slot (contracted_service_id, weekday, start_time, end_time, country, created_by, updated_by)
             VALUES ($1, 6, '07:00', '08:00', 'AR', $2, $2)`,
            [IDS.serviceBR, CREATED_BY],
          );
        }),
      ).rejects.toThrow(/new row violates row-level security policy/);
    });
  });

  /**
   * Fase 10, P4 (DX-10.2, DX-10.14) — `contracted_service_rejections` (a marca do quadro C) segue
   * o pai pela mesma cadeia de RLS que os satélites (413/429/480): a policy não olha country da
   * própria linha, olha visibilidade de `patient_contracted_services` (que por sua vez segue
   * `patients`). `beforeAll`/`afterAll` próprios, como dono (`pool`), com ids novos no mesmo `IDS`
   * (prefixo do arquivo) — a semente de cima e os casos existentes não mudam.
   */
  describe('marca do quadro C (Fase 10): contracted_service_rejections segue o pai', () => {
    const CREATED_BY = 'rls-e2e-csr';

    beforeAll(async () => {
      // 1 serviço por paciente de teste (AR/BR), reusando os endereços já semeados acima.
      await pool.query(
        `INSERT INTO patient_contracted_services (id, patient_id, service_code, address_id, country, created_by, updated_by)
         VALUES ($1, $2, 'AT', $3, 'AR', $4, $4), ($5, $6, 'AT', $7, 'BR', $4, $4)`,
        [IDS.csrServiceAR, IDS.patientAR, IDS.addressAR, CREATED_BY, IDS.csrServiceBR, IDS.patientBR, IDS.addressBR],
      );

      // 1 worker, com 1 marca por serviço.
      await pool.query(
        `INSERT INTO workers (id, auth_uid, email, country) VALUES ($1, 'rls-e2e-csr-w1', 'rls-e2e-csr-w1@e2e.local', 'AR')`,
        [IDS.csrWorker],
      );
      await pool.query(
        `INSERT INTO contracted_service_rejections (id, service_id, worker_id, rejected_by, reject_reason_category, created_by, updated_by)
         VALUES ($1, $2, $3, $4, 'OTHER', $4, $4), ($5, $6, $3, $4, 'OTHER', $4, $4)`,
        [IDS.csrMarkAR, IDS.csrServiceAR, IDS.csrWorker, CREATED_BY, IDS.csrMarkBR, IDS.csrServiceBR],
      );
    });

    afterAll(async () => {
      // Ordem: marcas → worker, ANTES do cleanup externo (que apaga os pacientes; mesma razão do
      // describe do itinerário acima: o cleanup externo apaga `patient_addresses` ANTES de
      // `patients`, e `pcs_address_same_patient_fk` recusaria a linha enquanto o serviço a referenciar).
      await pool.query(`DELETE FROM contracted_service_rejections WHERE id = ANY($1)`, [[IDS.csrMarkAR, IDS.csrMarkBR]]);
      await pool.query(`DELETE FROM workers WHERE id = $1`, [IDS.csrWorker]);
      await pool.query(`DELETE FROM patient_contracted_services WHERE id = ANY($1)`, [[IDS.csrServiceAR, IDS.csrServiceBR]]);
    });

    it('6f. a marca segue o pai: staff AR vê só a marca do serviço AR', async () => {
      const rows = await asRole('app_runtime', { userCountry: 'AR', userUid: STAFF_UID }, async (c) => {
        const res = await c.query(`SELECT id FROM contracted_service_rejections WHERE id = ANY($1)`, [
          [IDS.csrMarkAR, IDS.csrMarkBR],
        ]);
        return res.rows;
      });
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe(IDS.csrMarkAR);
    });

    it('6g. a marca com role de sistema + contexto vê as duas', async () => {
      const rows = await asRole('app_system', { systemContext: 'job:e2e-rls-proof' }, async (c) => {
        const res = await c.query(`SELECT id FROM contracted_service_rejections WHERE id = ANY($1)`, [
          [IDS.csrMarkAR, IDS.csrMarkBR],
        ]);
        return res.rows;
      });
      expect(rows).toHaveLength(2);
    });

    it('6h. staff AR não INSERE marca no serviço BR', async () => {
      // `country` explícito (não-NULL) — mesma técnica do 6e acima: sem isso, o trigger de país
      // tentaria herdar de `csrServiceBR`, essa própria leitura já cairia na RLS de
      // `patient_contracted_services` (que segue `patients`) e mascararia qual policy bloqueou.
      await expect(
        asRole('app_runtime', { userCountry: 'AR', userUid: STAFF_UID }, async (c) => {
          await c.query(
            `INSERT INTO contracted_service_rejections (service_id, worker_id, rejected_by, reject_reason_category, country, created_by, updated_by)
             VALUES ($1, $2, $3, 'OTHER', 'AR', $3, $3)`,
            [IDS.csrServiceBR, IDS.csrWorker, CREATED_BY],
          );
        }),
      ).rejects.toThrow(/new row violates row-level security policy/);
    });
  });

  /**
   * Fase 11, P4 (DX-11.3, DX-11.14) — `patient_itinerary_assembly` (o montado) segue o pai pela
   * mesma cadeia de RLS que os satélites (413/429/480/CSR): a policy não olha country da própria
   * linha, olha visibilidade de `patients` diretamente. E a trava de sobreposição
   * (`fn_patient_itinerary_assignment_no_overlap`, `SECURITY DEFINER`) enxerga através da RLS: um
   * prestador já alocado num slot do paciente BR (semente como dono) tem a trava acionada mesmo
   * quando quem tenta a 2ª alocação é staff AR, que normalmente não vê nada de BR — sem
   * `SECURITY DEFINER` a trava consultaria como o chamador e falharia ABERTA (deixaria passar).
   * `beforeAll`/`afterAll` próprios, como dono (`pool`), com ids novos no mesmo `IDS` (prefixo do
   * arquivo) — a semente de cima e os casos existentes não mudam.
   */
  describe('montado (Fase 11): patient_itinerary_assembly segue o pai; a trava enxerga através da RLS', () => {
    const CREATED_BY = 'rls-e2e-itin11';

    beforeAll(async () => {
      // 1 serviço por paciente de teste (AR/BR), reusando os endereços já semeados acima.
      await pool.query(
        `INSERT INTO patient_contracted_services (id, patient_id, service_code, address_id, country, created_by, updated_by)
         VALUES ($1, $2, 'AT', $3, 'AR', $4, $4), ($5, $6, 'AT', $7, 'BR', $4, $4)`,
        [
          IDS.itin11ServiceAR,
          IDS.patientAR,
          IDS.addressAR,
          CREATED_BY,
          IDS.itin11ServiceBR,
          IDS.patientBR,
          IDS.addressBR,
        ],
      );

      // 1 vaga por serviço.
      await pool.query(
        `INSERT INTO job_postings (id, title, contracted_service_id, patient_id, country)
         VALUES ($1, 'rls-e2e-itin11-vaga-ar', $2, $3, 'AR'), ($4, 'rls-e2e-itin11-vaga-br', $5, $6, 'BR')`,
        [IDS.itin11JobAR, IDS.itin11ServiceAR, IDS.patientAR, IDS.itin11JobBR, IDS.itin11ServiceBR, IDS.patientBR],
      );

      // 1 worker só, candidato às DUAS vagas (a trava é por worker — precisa do mesmo prestador
      // dos dois lados para provar que ela olha além do país do chamador).
      await pool.query(
        `INSERT INTO workers (id, auth_uid, email, country) VALUES ($1, 'rls-e2e-itin11-w1', 'rls-e2e-itin11-w1@e2e.local', 'AR')`,
        [IDS.itin11Worker],
      );
      await pool.query(
        `INSERT INTO worker_job_applications (id, worker_id, job_posting_id, application_funnel_stage, source)
         VALUES ($1, $2, $3, 'INVITED', 'import'), ($4, $2, $5, 'INVITED', 'import')`,
        [IDS.itin11WjaAR, IDS.itin11Worker, IDS.itin11JobAR, IDS.itin11WjaBR, IDS.itin11JobBR],
      );

      // 1 slot por serviço (endereços diferentes — AR e BR nunca são o mesmo endereço — a 30min de
      // folga entre o fim do BR e o início do AR, abaixo da folga mínima de 60min).
      await pool.query(
        `INSERT INTO patient_itinerary_slot (id, contracted_service_id, weekday, start_time, end_time, created_by, updated_by)
         VALUES ($1, $2, 3, '09:30', '10:30', $3, $3), ($4, $5, 3, '08:00', '09:00', $3, $3)`,
        [IDS.itin11SlotAR, IDS.itin11ServiceAR, CREATED_BY, IDS.itin11SlotBR, IDS.itin11ServiceBR],
      );

      // 1 alocação ACTIVE só no slot BR (a AR fica para o `6k`, que tenta inserir e espera 23P01).
      await pool.query(
        `INSERT INTO patient_itinerary_assignment (id, slot_id, worker_id, application_id, valid_from, created_by, updated_by)
         VALUES ($1, $2, $3, $4, '2026-01-01', $5, $5)`,
        [IDS.itin11AssignmentBR, IDS.itin11SlotBR, IDS.itin11Worker, IDS.itin11WjaBR, CREATED_BY],
      );

      // 1 montado em cada paciente.
      await pool.query(
        `INSERT INTO patient_itinerary_assembly (id, patient_id, assembled_by) VALUES ($1, $2, $3), ($4, $5, $3)`,
        [IDS.itin11AssemblyAR, IDS.patientAR, CREATED_BY, IDS.itin11AssemblyBR, IDS.patientBR],
      );
    });

    afterAll(async () => {
      // Ordem: alocações → montados → WJA → vagas → worker, ANTES do cleanup externo (mesma razão
      // dos describes acima: job_postings → patients é NO ACTION, e o cleanup externo apaga
      // patient_addresses antes de patients — pcs_address_same_patient_fk recusaria a linha
      // enquanto o serviço ainda a referenciar). O 6k pode ter deixado uma 2ª alocação no slot AR
      // se algum dia a trava regredir — o filtro por slot cobre esse caso também.
      await pool.query(`DELETE FROM patient_itinerary_assignment WHERE slot_id = ANY($1)`, [
        [IDS.itin11SlotAR, IDS.itin11SlotBR],
      ]);
      await pool.query(`DELETE FROM patient_itinerary_assembly WHERE id = ANY($1)`, [
        [IDS.itin11AssemblyAR, IDS.itin11AssemblyBR],
      ]);
      await pool.query(`DELETE FROM worker_job_applications WHERE id = ANY($1)`, [
        [IDS.itin11WjaAR, IDS.itin11WjaBR],
      ]);
      await pool.query(`DELETE FROM job_postings WHERE id = ANY($1)`, [[IDS.itin11JobAR, IDS.itin11JobBR]]);
      await pool.query(`DELETE FROM workers WHERE id = $1`, [IDS.itin11Worker]);
      await pool.query(`DELETE FROM patient_contracted_services WHERE id = ANY($1)`, [
        [IDS.itin11ServiceAR, IDS.itin11ServiceBR],
      ]);
    });

    it('6i. o montado segue o pai: staff AR vê só o montado do paciente AR', async () => {
      const rows = await asRole('app_runtime', { userCountry: 'AR', userUid: STAFF_UID }, async (c) => {
        const res = await c.query(`SELECT id FROM patient_itinerary_assembly WHERE id = ANY($1)`, [
          [IDS.itin11AssemblyAR, IDS.itin11AssemblyBR],
        ]);
        return res.rows;
      });
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe(IDS.itin11AssemblyAR);
    });

    it('6j. staff AR não INSERE montado do paciente BR', async () => {
      await expect(
        asRole('app_runtime', { userCountry: 'AR', userUid: STAFF_UID }, async (c) => {
          await c.query(`INSERT INTO patient_itinerary_assembly (patient_id, assembled_by, country) VALUES ($1, $2, 'AR')`, [
            IDS.patientBR,
            CREATED_BY,
          ]);
        }),
      ).rejects.toThrow(/new row violates row-level security policy/);
    });

    it('6k. a trava enxerga através da RLS: staff AR não vê o paciente BR, mas a alocação sobreposta do mesmo worker cai em 23P01', async () => {
      await expect(
        asRole('app_runtime', { userCountry: 'AR', userUid: STAFF_UID }, async (c) => {
          await c.query(
            `INSERT INTO patient_itinerary_assignment (slot_id, worker_id, application_id, valid_from, created_by, updated_by)
             VALUES ($1, $2, $3, '2026-01-01', $4, $4)`,
            [IDS.itin11SlotAR, IDS.itin11Worker, IDS.itin11WjaAR, CREATED_BY],
          );
        }),
      ).rejects.toMatchObject({ code: '23P01' });
    });
  });

  /**
   * Ausência (Fase 13, P5, DX-13.16 casos 6l/6m/6n): `patient_itinerary_absence` segue o pai (a
   * mesma policy `patient_itinerary_absence_follow_assignment`, 484) e a trava por data
   * (`fn_patient_itinerary_absence_no_overlap`, `SECURITY DEFINER`) enxerga através da RLS —
   * espelha exatamente o 6k acima, mas na tabela nova. `beforeAll`/`afterAll` próprios, como dono
   * (`pool`), com ids novos no mesmo `IDS` — a semente de cima e os casos existentes não mudam.
   *
   * Dois titulares (um por país) — não o mesmo worker nos dois lados: se o mesmo worker
   * segurasse as duas alocações semanais, elas teriam de não colidir ENTRE SI (mesmo endereço/
   * gap), e a comparação que a trava faz para a SUBSTITUIÇÃO usa exatamente os mesmos dois slots
   * — ou seja, "titular seguro nos dois" e "substituição cruza" são mutuamente exclusivos para o
   * MESMO worker (confirmado por experimento direto via psql antes de escrever este teste). O
   * elemento que atravessa a fronteira de país é o SUBSTITUTO (W), não o titular — é ele quem
   * prova o `SECURITY DEFINER` no 6n, do jeito que o 6k provou para a alocação semanal.
   */
  describe('ausência (Fase 13): patient_itinerary_absence segue o pai; a trava por data enxerga através da RLS', () => {
    const CREATED_BY = 'rls-e2e-abs13';
    let dateD = '';
    let dateD2 = '';

    beforeAll(async () => {
      const nextMondayRes = await pool.query<{ d: string }>(
        `SELECT to_char(g::date,'YYYY-MM-DD') AS d
           FROM (SELECT (now() AT TIME ZONE 'America/Argentina/Buenos_Aires')::date AS t) x,
                generate_series(x.t + 1, x.t + 7, interval '1 day') g
          WHERE extract(dow FROM g) = 1`,
      );
      dateD = nextMondayRes.rows[0].d;
      const dateD2Res = await pool.query<{ d: string }>(`SELECT to_char($1::date + 7, 'YYYY-MM-DD') AS d`, [dateD]);
      dateD2 = dateD2Res.rows[0].d;

      // 1 serviço por paciente de teste (AR/BR), reusando os endereços já semeados acima.
      await pool.query(
        `INSERT INTO patient_contracted_services (id, patient_id, service_code, address_id, country, created_by, updated_by)
         VALUES ($1, $2, 'AT', $3, 'AR', $4, $4), ($5, $6, 'AT', $7, 'BR', $4, $4)`,
        [IDS.absSvcAR, IDS.patientAR, IDS.addressAR, CREATED_BY, IDS.absSvcBR, IDS.patientBR, IDS.addressBR],
      );

      // 1 vaga por serviço.
      await pool.query(
        `INSERT INTO job_postings (id, title, contracted_service_id, patient_id, country)
         VALUES ($1, 'rls-e2e-abs13-vaga-ar', $2, $3, 'AR'), ($4, 'rls-e2e-abs13-vaga-br', $5, $6, 'BR')`,
        [IDS.absJobAR, IDS.absSvcAR, IDS.patientAR, IDS.absJobBR, IDS.absSvcBR, IDS.patientBR],
      );

      // 2 titulares (um por país) + 1 substituto W, candidato às DUAS vagas.
      await pool.query(
        `INSERT INTO workers (id, auth_uid, email, country) VALUES
           ($1, 'rls-e2e-abs13-tar', 'rls-e2e-abs13-tar@e2e.local', 'AR'),
           ($2, 'rls-e2e-abs13-tbr', 'rls-e2e-abs13-tbr@e2e.local', 'AR'),
           ($3, 'rls-e2e-abs13-w', 'rls-e2e-abs13-w@e2e.local', 'AR')`,
        [IDS.absTitularAR, IDS.absTitularBR, IDS.absSubstitute],
      );
      await pool.query(
        `INSERT INTO worker_job_applications (id, worker_id, job_posting_id, application_funnel_stage, source)
         VALUES
           ($1, $2, $3, 'INVITED', 'import'),
           ($4, $5, $6, 'INVITED', 'import'),
           ($7, $8, $3, 'INVITED', 'import'),
           ($9, $8, $6, 'INVITED', 'import')`,
        [
          IDS.absWjaTitularAR,
          IDS.absTitularAR,
          IDS.absJobAR,
          IDS.absWjaTitularBR,
          IDS.absTitularBR,
          IDS.absJobBR,
          IDS.absWjaSubAR,
          IDS.absSubstitute,
          IDS.absWjaSubBR,
        ],
      );

      // 1 slot por serviço, segunda, endereços diferentes (AR/BR nunca são o mesmo endereço) e
      // apenas 15min de folga entre os dois — abaixo da folga mínima de 60min.
      await pool.query(
        `INSERT INTO patient_itinerary_slot (id, contracted_service_id, weekday, start_time, end_time, created_by, updated_by)
         VALUES ($1, $2, 1, '09:00', '10:00', $3, $3), ($4, $5, 1, '09:15', '10:15', $3, $3)`,
        [IDS.absSlotAR, IDS.absSvcAR, CREATED_BY, IDS.absSlotBR, IDS.absSvcBR],
      );

      // 1 alocação semanal por titular.
      await pool.query(
        `INSERT INTO patient_itinerary_assignment (id, slot_id, worker_id, application_id, valid_from, created_by, updated_by)
         VALUES ($1, $2, $3, $4, '2026-01-01', $5, $5), ($6, $7, $8, $9, '2026-01-01', $5, $5)`,
        [
          IDS.absAssignmentAR,
          IDS.absSlotAR,
          IDS.absTitularAR,
          IDS.absWjaTitularAR,
          CREATED_BY,
          IDS.absAssignmentBR,
          IDS.absSlotBR,
          IDS.absTitularBR,
          IDS.absWjaTitularBR,
        ],
      );

      // ausência SEM substituto no paciente AR em D2 (só para o 6l — não interage com a trava do
      // 6n, que usa a data D noutra alocação).
      await pool.query(
        `INSERT INTO patient_itinerary_absence (id, assignment_id, on_date, created_by, updated_by)
         VALUES ($1, $2, $3, $4, $4)`,
        [IDS.absSeedAR, IDS.absAssignmentAR, dateD2, CREATED_BY],
      );
      // ausência do paciente BR em D, COM substituto W — a semente "como dono" do 6n.
      await pool.query(
        `INSERT INTO patient_itinerary_absence (id, assignment_id, on_date, substitute_worker_id, substitute_application_id, created_by, updated_by)
         VALUES ($1, $2, $3, $4, $5, $6, $6)`,
        [IDS.absSeedBR, IDS.absAssignmentBR, dateD, IDS.absSubstitute, IDS.absWjaSubBR, CREATED_BY],
      );
    });

    afterAll(async () => {
      // ausências → alocações → WJA → vagas → worker → serviços, ANTES do cleanup externo (mesma
      // razão dos describes acima: job_postings → patients é NO ACTION, e o cleanup externo apaga
      // patient_addresses antes de patients). O 6n pode ter deixado uma 2ª ausência aberta no
      // assignmentAR se a trava regredir — o filtro por assignment cobre esse caso também.
      await pool.query(`DELETE FROM patient_itinerary_absence WHERE assignment_id = ANY($1)`, [
        [IDS.absAssignmentAR, IDS.absAssignmentBR],
      ]);
      await pool.query(`DELETE FROM patient_itinerary_assignment WHERE id = ANY($1)`, [
        [IDS.absAssignmentAR, IDS.absAssignmentBR],
      ]);
      await pool.query(`DELETE FROM worker_job_applications WHERE id = ANY($1)`, [
        [IDS.absWjaTitularAR, IDS.absWjaTitularBR, IDS.absWjaSubAR, IDS.absWjaSubBR],
      ]);
      await pool.query(`DELETE FROM job_postings WHERE id = ANY($1)`, [[IDS.absJobAR, IDS.absJobBR]]);
      await pool.query(`DELETE FROM workers WHERE id = ANY($1)`, [
        [IDS.absTitularAR, IDS.absTitularBR, IDS.absSubstitute],
      ]);
      await pool.query(`DELETE FROM patient_contracted_services WHERE id = ANY($1)`, [
        [IDS.absSvcAR, IDS.absSvcBR],
      ]);
    });

    it('6l. a ausência segue o pai: staff AR vê só a ausência do paciente AR', async () => {
      const rows = await asRole('app_runtime', { userCountry: 'AR', userUid: STAFF_UID }, async (c) => {
        const res = await c.query(`SELECT id FROM patient_itinerary_absence WHERE id = ANY($1)`, [
          [IDS.absSeedAR, IDS.absSeedBR],
        ]);
        return res.rows;
      });
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe(IDS.absSeedAR);
    });

    it('6m. staff AR não INSERE ausência em alocação de paciente BR (RLS)', async () => {
      await expect(
        asRole('app_runtime', { userCountry: 'AR', userUid: STAFF_UID }, async (c) => {
          await c.query(
            `INSERT INTO patient_itinerary_absence (assignment_id, on_date, created_by, updated_by)
             VALUES ($1, $2, $3, $3)`,
            [IDS.absAssignmentBR, dateD2, STAFF_UID],
          );
        }),
      ).rejects.toThrow(/new row violates row-level security policy/);
    });

    it('6n. a trava por data enxerga através da RLS: staff AR não vê o paciente BR, mas a substituição sobreposta do mesmo W cai em 23P01', async () => {
      await expect(
        asRole('app_runtime', { userCountry: 'AR', userUid: STAFF_UID }, async (c) => {
          await c.query(
            `INSERT INTO patient_itinerary_absence (assignment_id, on_date, substitute_worker_id, substitute_application_id, created_by, updated_by)
             VALUES ($1, $2, $3, $4, $5, $5)`,
            [IDS.absAssignmentAR, dateD, IDS.absSubstitute, IDS.absWjaSubAR, STAFF_UID],
          );
        }),
      ).rejects.toMatchObject({ code: '23P01' });
    });
  });
});
