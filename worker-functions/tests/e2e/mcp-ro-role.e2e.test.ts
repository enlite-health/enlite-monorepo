/**
 * mcp-ro-role.e2e.test.ts @integration — D216 · D218 (MCP `db.query.readonly` sem texto clínico)
 *
 * Banco REAL do stack (Postgres do docker-compose), SEM mock: aplica `scripts/create-mcp-ro-role.sql`
 * via `psql` (o script usa \if/\gexec, que só o psql entende) e prova, como `enlite_mcp_ro`:
 *   1. o script é idempotente (roda duas vezes, rc=0 nas duas);
 *   2. `SELECT * FROM patients` e `SELECT diagnosis FROM patients` → permission denied
 *      (tanto logando como a role quanto via `SET ROLE` a partir do superuser);
 *   3. `SELECT id, status FROM patients` e `count(*)` passam (item 1 da Regra: contagem sempre);
 *   4. `to_jsonb(p)` — a forma que a guarda por nome de coluna do ReadonlyDbQueryService não vê —
 *      também é negada PELO BANCO;
 *   5. nada de texto clínico sai por `patients_ro` (só has_/len), e a role não é membro de
 *      `pg_read_all_data` (lex C1).
 * Requer `psql` no PATH (ubuntu-latest do CI já traz; local: brew install libpq).
 *
 * ⚠️ RLS (F1 do ABAC, `patients_country_isolation`): quando a política está LIGADA em `patients`
 * (QA/local com a F1 aplicada; NÃO no CI desta branch, cujas migrations não a trazem), ela lê
 * `iam.user_groups`, onde `enlite_mcp_ro` não tem USAGE — e aí NENHUMA coluna de patients sai,
 * nem as permitidas. O teste mede o estado da RLS e prova o que cabe em cada caso: sem RLS, as
 * colunas nomeadas SAEM; com RLS, o que barra é a POLÍTICA (`user_groups`), nunca `patients` —
 * ou seja, o grant de coluna está certo e o achado é o cruzamento D216 × F1 (registrado na LISTA).
 */
import { execFileSync } from 'child_process';
import path from 'path';
import { Pool } from 'pg';

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';
const SCRIPT = path.resolve(__dirname, '../../../scripts/create-mcp-ro-role.sql');
// Credencial do e2e local, não é segredo: a role só existe no Postgres descartável do stack.
const ROLE_CREDENTIAL = process.env.E2E_MCP_RO_CREDENTIAL || 'e2e-local-only';
const CLINICAL_TEXT = 'Texto clinico que NUNCA pode sair pelo MCP 4f2a';

function applyScript(): string {
  return execFileSync(
    'psql',
    [DATABASE_URL, '-v', 'ON_ERROR_STOP=1', '-v', 'VERBOSITY=terse', '-v', `mcp_ro_password=${ROLE_CREDENTIAL}`, '-1', '-q', '-f', SCRIPT],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
}

describe('Role enlite_mcp_ro — SELECT por coluna em patients (D216) @integration', () => {
  let admin: Pool;
  let ro: Pool;
  let patientId = '';
  let rlsLigada = false;

  /** Colunas permitidas: passam pelo grant; sob RLS, quem barra é a política (user_groups), não patients. */
  async function expectAllowedColumns(run: (sql: string, params: unknown[]) => Promise<{ rows: unknown[] }>): Promise<void> {
    const q = run('SELECT id, status FROM patients WHERE id = $1', [patientId]);
    if (rlsLigada) {
      await expect(q).rejects.toThrow(/permission denied for table user_groups/);
      await expect(q).rejects.not.toThrow(/for table patients/);
      return;
    }
    expect((await q).rows).toEqual([{ id: patientId, status: 'ACTIVE' }]);
    const n = await run('SELECT count(*) AS n FROM patients WHERE id = $1', [patientId]);
    expect((n.rows[0] as { n: string }).n).toBe('1');
  }

  beforeAll(async () => {
    admin = new Pool({ connectionString: DATABASE_URL });
    // Idempotência: duas aplicações seguidas, ambas sem erro (execFileSync lança se rc≠0).
    applyScript();
    applyScript();
    const u = new URL(DATABASE_URL);
    ro = new Pool({ host: u.hostname, port: Number(u.port || 5432), database: u.pathname.slice(1), user: 'enlite_mcp_ro', password: ROLE_CREDENTIAL });
    await admin.query(`DELETE FROM patients WHERE clickup_task_id = 'mcp-ro-e2e-1'`);
    const { rows: [p] } = await admin.query<{ id: string }>(
      `INSERT INTO patients (clickup_task_id, first_name, last_name, diagnosis, additional_comments, country, status)
       VALUES ('mcp-ro-e2e-1', 'Paciente', 'McpRo', $1, $1, 'AR', 'ACTIVE') RETURNING id`,
      [CLINICAL_TEXT],
    );
    patientId = p.id;
    rlsLigada = (await admin.query<{ on: boolean }>(`SELECT relrowsecurity AS "on" FROM pg_class WHERE oid = 'public.patients'::regclass`)).rows[0].on;
  });

  afterAll(async () => {
    await admin.query(`DELETE FROM patients WHERE id = $1`, [patientId]);
    await ro.end();
    await admin.end();
  });

  it('como enlite_mcp_ro: `select * from patients` e `select diagnosis` → permission denied; colunas nomeadas e count(*) passam', async () => {
    await expect(ro.query('SELECT * FROM patients LIMIT 1')).rejects.toThrow(/permission denied for table patients/);
    await expect(ro.query('SELECT diagnosis FROM patients LIMIT 1')).rejects.toThrow(/permission denied for table patients/);
    await expect(ro.query('SELECT additional_comments FROM patients LIMIT 1')).rejects.toThrow(/permission denied for table patients/);
    await expectAllowedColumns((sql, params) => ro.query(sql, params));
  });

  it('via SET ROLE a partir do superuser: a mesma negação (o privilégio é da role, não da conexão)', async () => {
    // Cada statement na própria transação: um erro aborta a transação, e o client volta ao pool limpo.
    const asRole = async (sql: string, params: unknown[]): Promise<{ rows: unknown[] }> => {
      const client = await admin.connect();
      try {
        await client.query('BEGIN');
        await client.query('SET LOCAL ROLE enlite_mcp_ro');
        return await client.query(sql, params);
      } finally {
        await client.query('ROLLBACK').catch(() => undefined);
        client.release();
      }
    };
    await expect(asRole('SELECT * FROM patients LIMIT 1', [])).rejects.toThrow(/permission denied for table patients/);
    await expectAllowedColumns(asRole);
  });

  it('formas de linha inteira que a guarda por nome de coluna não vê (to_jsonb, row_to_json, p.*) são negadas pelo BANCO', async () => {
    await expect(ro.query('SELECT to_jsonb(p) FROM patients p WHERE id = $1', [patientId])).rejects.toThrow(/permission denied/);
    await expect(ro.query('SELECT row_to_json(patients) FROM patients WHERE id = $1', [patientId])).rejects.toThrow(/permission denied/);
    await expect(ro.query('SELECT p.* FROM patients p WHERE id = $1', [patientId])).rejects.toThrow(/permission denied/);
  });

  it('patients_ro devolve metadado (has_/len), nunca o texto; a role não herda pg_read_all_data nem tem SELECT de tabela', async () => {
    const view = await ro.query('SELECT * FROM patients_ro WHERE id = $1', [patientId]);
    expect(view.rows).toHaveLength(1);
    expect(view.rows[0]).toMatchObject({ has_diagnosis: true, diagnosis_len: CLINICAL_TEXT.length, has_additional_comments: true });
    expect(Object.keys(view.rows[0])).not.toEqual(expect.arrayContaining(['diagnosis', 'additional_comments', 'first_name', 'last_name']));
    expect(JSON.stringify(view.rows)).not.toContain(CLINICAL_TEXT);

    const residual = await admin.query(
      `SELECT r.rolname FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.roleid JOIN pg_roles g ON g.oid = m.member WHERE g.rolname = 'enlite_mcp_ro'`,
    );
    expect(residual.rows).toEqual([]);
    const priv = await admin.query<{ t: boolean; c: boolean }>(
      `SELECT has_table_privilege('enlite_mcp_ro', 'public.patients', 'SELECT') AS t,
              has_column_privilege('enlite_mcp_ro', 'public.patients', 'diagnosis', 'SELECT') AS c`,
    );
    expect(priv.rows[0]).toEqual({ t: false, c: false });
  });

  it('spec 012 lex C2.1: patient_addresses.access_notes é negado à role (colunas irmãs passam); C3.1: provider_code não reabre patient_insurance_verified', async () => {
    const { rows: [a] } = await admin.query<{ id: string }>(
      `INSERT INTO patient_addresses (patient_id, address_type, address_formatted, access_notes) VALUES ($1, 'primary', 'Calle Falsa 123', $2) RETURNING id`,
      [patientId, CLINICAL_TEXT],
    );
    try {
      await expect(ro.query('SELECT access_notes FROM patient_addresses WHERE id = $1', [a.id])).rejects.toThrow(/permission denied for table patient_addresses/);
      await expect(ro.query('SELECT * FROM patient_addresses WHERE id = $1', [a.id])).rejects.toThrow(/permission denied for table patient_addresses/);
      // colunas não sensíveis seguem legíveis (item 1: contagem/rótulo sempre)
      const ok = await ro.query('SELECT id, address_type, country, neighborhood, logistics_corridor FROM patient_addresses WHERE id = $1', [a.id]);
      expect(ok.rows).toEqual([{ id: a.id, address_type: 'primary', country: 'AR', neighborhood: null, logistics_corridor: null }]);
      const priv = await admin.query<{ t: boolean; c: boolean; n: boolean }>(
        `SELECT has_table_privilege('enlite_mcp_ro', 'public.patient_addresses', 'SELECT') AS t,
                has_column_privilege('enlite_mcp_ro', 'public.patient_addresses', 'access_notes', 'SELECT') AS c,
                has_column_privilege('enlite_mcp_ro', 'public.patient_addresses', 'neighborhood', 'SELECT') AS n`,
      );
      expect(priv.rows[0]).toEqual({ t: false, c: false, n: true });
      // CONTROLE POSITIVO (D157): GRANT reabre; REVOKE fecha
      await admin.query('GRANT SELECT (access_notes) ON public.patient_addresses TO enlite_mcp_ro');
      try {
        expect((await ro.query<{ access_notes: string }>('SELECT access_notes FROM patient_addresses WHERE id = $1', [a.id])).rows[0].access_notes).toBe(CLINICAL_TEXT);
      } finally {
        await admin.query('REVOKE SELECT (access_notes) ON public.patient_addresses FROM enlite_mcp_ro');
      }
      await expect(ro.query('SELECT access_notes FROM patient_addresses WHERE id = $1', [a.id])).rejects.toThrow(/permission denied/);
    } finally {
      await admin.query('DELETE FROM patient_addresses WHERE id = $1', [a.id]);
    }
    // C3.1: a coluna nova (312) herda a revogação da tabela inteira
    await expect(ro.query('SELECT provider_code FROM patient_insurance_verified LIMIT 1')).rejects.toThrow(/permission denied for table patient_insurance_verified/);
    // patients: as colunas novas do bloco B NÃO entraram na lista positiva (lex C7.1-d / B9)
    for (const col of ['on_hold_note', 'on_hold_reason', 'service_start_date', 'admission_status']) {
      await expect(ro.query(`SELECT ${col} FROM patients WHERE id = $1`, [patientId])).rejects.toThrow(/permission denied for table patients/);
    }
  });

  it('spec 013 bloco C (achado QA-caça #1): patient_contracted_services.professional_profile/hourly_value negados; colunas irmãs, contracted_service_providers, contracted_service_devices e service_types passam', async () => {
    const { rows: [svc] } = await admin.query<{ id: string }>(
      `INSERT INTO patient_contracted_services (patient_id, service_code, professional_profile, hourly_value, providers_needed, created_by, updated_by)
       VALUES ($1, 'AT', $2, 15000, 2, 'e2e-test', 'e2e-test') RETURNING id`,
      [patientId, CLINICAL_TEXT],
    );
    const { rows: [worker] } = await admin.query<{ id: string }>(
      `INSERT INTO workers (auth_uid, email) VALUES ('mcp-ro-e2e-worker', 'mcp-ro-e2e-worker@example.com') RETURNING id`,
    );
    const { rows: [provider] } = await admin.query<{ id: string }>(
      `INSERT INTO contracted_service_providers (service_id, worker_id, created_by, updated_by) VALUES ($1, $2, 'e2e-test', 'e2e-test') RETURNING id`,
      [svc.id, worker.id],
    );
    await admin.query(`INSERT INTO contracted_service_devices (service_id, device_type) SELECT $1, code FROM device_types LIMIT 1`, [svc.id]);
    try {
      // negadas: texto livre e valor do contrato (D216/D218, mesma classe)
      await expect(ro.query('SELECT professional_profile FROM patient_contracted_services WHERE id = $1', [svc.id])).rejects.toThrow(/permission denied for table patient_contracted_services/);
      await expect(ro.query('SELECT hourly_value FROM patient_contracted_services WHERE id = $1', [svc.id])).rejects.toThrow(/permission denied for table patient_contracted_services/);
      await expect(ro.query('SELECT * FROM patient_contracted_services WHERE id = $1', [svc.id])).rejects.toThrow(/permission denied for table patient_contracted_services/);
      // colunas irmãs (sem texto livre/valor) e count(*) passam — item 1 da Regra
      const ok = await ro.query(
        'SELECT id, service_code, providers_needed, care_location, active FROM patient_contracted_services WHERE id = $1',
        [svc.id],
      );
      expect(ok.rows).toEqual([{ id: svc.id, service_code: 'AT', providers_needed: 2, care_location: null, active: true }]);
      const n = await ro.query('SELECT count(*) AS n FROM patient_contracted_services WHERE id = $1', [svc.id]);
      expect((n.rows[0] as { n: string }).n).toBe('1');
      // contracted_service_providers: sem texto livre/valor no schema (319) — liberada por coluna
      const provOk = await ro.query('SELECT id, service_id, worker_id, weekly_hours, active FROM contracted_service_providers WHERE id = $1', [provider.id]);
      expect(provOk.rows).toEqual([{ id: provider.id, service_id: svc.id, worker_id: worker.id, weekly_hours: null, active: true }]);
      // contracted_service_devices e service_types: catálogo/junção sem PII — liberadas
      const devOk = await ro.query('SELECT service_id, device_type FROM contracted_service_devices WHERE service_id = $1', [svc.id]);
      expect(devOk.rows).toHaveLength(1);
      const typesOk = await ro.query(`SELECT code FROM service_types WHERE code = 'AT'`);
      expect(typesOk.rows).toEqual([{ code: 'AT' }]);
      const priv = await admin.query<{ t: boolean; profile: boolean; value: boolean }>(
        `SELECT has_table_privilege('enlite_mcp_ro', 'public.patient_contracted_services', 'SELECT') AS t,
                has_column_privilege('enlite_mcp_ro', 'public.patient_contracted_services', 'professional_profile', 'SELECT') AS profile,
                has_column_privilege('enlite_mcp_ro', 'public.patient_contracted_services', 'hourly_value', 'SELECT') AS value`,
      );
      expect(priv.rows[0]).toEqual({ t: false, profile: false, value: false });
      // CONTROLE POSITIVO (D157): GRANT reabre; REVOKE fecha
      await admin.query('GRANT SELECT (professional_profile) ON public.patient_contracted_services TO enlite_mcp_ro');
      try {
        expect((await ro.query<{ professional_profile: string }>('SELECT professional_profile FROM patient_contracted_services WHERE id = $1', [svc.id])).rows[0].professional_profile).toBe(CLINICAL_TEXT);
      } finally {
        await admin.query('REVOKE SELECT (professional_profile) ON public.patient_contracted_services FROM enlite_mcp_ro');
      }
      await expect(ro.query('SELECT professional_profile FROM patient_contracted_services WHERE id = $1', [svc.id])).rejects.toThrow(/permission denied/);
    } finally {
      await admin.query('DELETE FROM patient_contracted_services WHERE id = $1', [svc.id]);
      await admin.query('DELETE FROM workers WHERE id = $1', [worker.id]);
    }
  });

  it('CONTROLE POSITIVO (D157): GRANT da coluna reabre a leitura; REVOKE fecha de novo', async () => {
    await admin.query('GRANT SELECT (diagnosis) ON public.patients TO enlite_mcp_ro');
    try {
      const q = ro.query<{ diagnosis: string }>('SELECT diagnosis FROM patients WHERE id = $1', [patientId]);
      if (rlsLigada) await expect(q).rejects.toThrow(/permission denied for table user_groups/); // passou por patients
      else expect((await q).rows[0].diagnosis).toBe(CLINICAL_TEXT);
    } finally {
      await admin.query('REVOKE SELECT (diagnosis) ON public.patients FROM enlite_mcp_ro');
    }
    await expect(ro.query('SELECT diagnosis FROM patients WHERE id = $1', [patientId])).rejects.toThrow(/permission denied/);
  });
});
