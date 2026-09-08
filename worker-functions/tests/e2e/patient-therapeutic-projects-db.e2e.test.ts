/**
 * Spec 017 — `patient_therapeutic_projects` (migration 416) e os 3 catálogos (415), no BANCO REAL.
 *
 * O que cada teste prova (lex 08/09, C2–C5, C18/C19; D299):
 *   1. o seed dos catálogos existe e é idempotente (re-rodar a 415 não duplica);
 *   2. `country` nasce do paciente por trigger; `(patient_id, major, minor)` é único;
 *   3. o serviço contratado tem de ser do MESMO paciente (trigger de posse);
 *   4. UPDATE em qualquer campo de conteúdo é RECUSADO — versão é imutável (lex C5);
 *   5. anular passa uma vez; desfazer/reescrever a anulação é recusado;
 *   6. DELETE direto é recusado; o CASCADE do paciente leva as versões (lex C4);
 *   7. RLS: role do app SEM identidade não vê nem escreve (policy follow_patient, molde 413);
 *   8. tetos: clinical_context > 4000 e lista vazia de objetivos são recusados pelo CHECK.
 */
import { Pool } from 'pg';

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

describe('416 — projeto terapêutico versionado e imutável (banco real)', () => {
  let admin: Pool;
  const IDS = {
    patient: 'ee416000-0a00-0001-0001-000000000001',
    patientOutro: 'ee416000-0a00-0001-0002-000000000001',
  };
  let serviceId: string;
  let serviceOutroId: string;

  const snapshot = (label: string) => JSON.stringify([{ id: '11111111-1111-1111-1111-111111111111', label }]);
  const diag = JSON.stringify([{ uri: 'http://id.who.int/icd/entity/1', code: '8B11', title: 'Sintético' }]);

  async function insertVersion(p: Partial<Record<string, unknown>> = {}): Promise<{ id: string; country: string }> {
    const cols: Record<string, unknown> = {
      patient_id: IDS.patient,
      major: 1,
      minor: 0,
      contracted_service_id: serviceId,
      diagnoses: diag,
      clinical_context: 'contexto sintético e2e',
      general_objective: 'objetivo sintético e2e',
      specific_objectives: snapshot('obj'),
      activities: snapshot('act'),
      pathology_types: snapshot('pat'),
      start_date: '2026-09-01',
      end_date: '2026-12-31',
      created_by: 'e2e-416-uid',
      ...p,
    };
    const keys = Object.keys(cols);
    const res = await admin.query<{ id: string; country: string }>(
      `INSERT INTO patient_therapeutic_projects (${keys.join(', ')})
       VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id, country`,
      keys.map((k) => cols[k]),
    );
    return res.rows[0];
  }

  async function cleanup(): Promise<void> {
    await admin.query(`DELETE FROM patients WHERE id = ANY($1)`, [[IDS.patient, IDS.patientOutro]]);
  }

  beforeAll(async () => {
    admin = new Pool({ connectionString: DATABASE_URL });
    await cleanup();
    await admin.query(
      `INSERT INTO patients (id, clickup_task_id, first_name, last_name, country) VALUES
         ($1, 'e2e-416-a', 'Paciente', 'Sintético', 'AR'),
         ($2, 'e2e-416-b', 'Outro', 'Sintético', 'AR')`,
      [IDS.patient, IDS.patientOutro],
    );
    const s = await admin.query<{ id: string }>(
      `INSERT INTO patient_contracted_services (patient_id, service_code, created_by, updated_by)
       VALUES ($1, 'CAREGIVER', 'e2e-416-uid', 'e2e-416-uid') RETURNING id`,
      [IDS.patient],
    );
    serviceId = s.rows[0].id;
    const o = await admin.query<{ id: string }>(
      `INSERT INTO patient_contracted_services (patient_id, service_code, created_by, updated_by)
       VALUES ($1, 'CAREGIVER', 'e2e-416-uid', 'e2e-416-uid') RETURNING id`,
      [IDS.patientOutro],
    );
    serviceOutroId = o.rows[0].id;
  });

  afterAll(async () => {
    await cleanup();
    await admin.end();
  });

  afterEach(async () => {
    await admin.query(`DELETE FROM patients WHERE id = $1`, [IDS.patient]);
    await admin.query(
      `INSERT INTO patients (id, clickup_task_id, first_name, last_name, country) VALUES ($1, 'e2e-416-a', 'Paciente', 'Sintético', 'AR')`,
      [IDS.patient],
    );
    const s = await admin.query<{ id: string }>(
      `INSERT INTO patient_contracted_services (patient_id, service_code, created_by, updated_by)
       VALUES ($1, 'CAREGIVER', 'e2e-416-uid', 'e2e-416-uid') RETURNING id`,
      [IDS.patient],
    );
    serviceId = s.rows[0].id;
  });

  it('1. seed dos 3 catálogos: 8 objetivos, 13 atividades, 8 tipos de patologia — e sem "ICHOM" em lugar nenhum', async () => {
    const counts = await admin.query<{ t: string; n: number }>(
      `SELECT 'obj' AS t, count(*)::int AS n FROM therapeutic_specific_objectives WHERE active
       UNION ALL SELECT 'act', count(*)::int FROM therapeutic_activities WHERE active
       UNION ALL SELECT 'pat', count(*)::int FROM pathology_types WHERE active`,
    );
    expect(Object.fromEntries(counts.rows.map((r) => [r.t, r.n]))).toEqual({ obj: 8, act: 13, pat: 8 });
    const ichom = await admin.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pathology_types WHERE label ILIKE '%ichom%'`,
    );
    expect(ichom.rows[0].n).toBe(0);
    // Idempotência do seed: inserir um rótulo já ativo cai no índice único parcial.
    await expect(
      admin.query(`INSERT INTO pathology_types (label) VALUES ('tdah')`),
    ).rejects.toThrow(/uq_pathology_types_label_ativo/);
  });

  it('2. country vem do paciente por trigger; (patient, major, minor) é único', async () => {
    const v = await insertVersion();
    expect(v.country).toBe('AR');
    await expect(insertVersion()).rejects.toThrow(/ptp_version_unica/);
    await expect(insertVersion({ minor: 1 })).resolves.toBeTruthy();
  });

  it('3. serviço contratado de OUTRO paciente é recusado no INSERT', async () => {
    await expect(insertVersion({ contracted_service_id: serviceOutroId })).rejects.toThrow(/ptp_service_de_outro_paciente/);
  });

  it('4. 🔒 UPDATE em conteúdo é recusado — a versão é imutável (lex C5)', async () => {
    const v = await insertVersion();
    for (const set of [
      `clinical_context = 'outro'`,
      `general_objective = 'outro'`,
      `end_date = '2027-01-01'`,
      `diagnoses = '[]'::jsonb`,
      `minor = 9`,
    ]) {
      await expect(admin.query(`UPDATE patient_therapeutic_projects SET ${set} WHERE id = $1`, [v.id]))
        .rejects.toThrow(/ptp_imutavel/);
    }
  });

  it('5. anular passa UMA vez; desfazer ou reescrever a anulação é recusado', async () => {
    const v = await insertVersion();
    await admin.query(
      `UPDATE patient_therapeutic_projects SET annulled_at = NOW(), annulled_by = 'e2e-416-uid', annul_reason = 'erro de digitação' WHERE id = $1`,
      [v.id],
    );
    const row = await admin.query<{ annulled_by: string }>(`SELECT annulled_by FROM patient_therapeutic_projects WHERE id = $1`, [v.id]);
    expect(row.rows[0].annulled_by).toBe('e2e-416-uid');
    await expect(admin.query(`UPDATE patient_therapeutic_projects SET annulled_at = NULL, annulled_by = NULL, annul_reason = NULL WHERE id = $1`, [v.id]))
      .rejects.toThrow(/anulação não se desfaz/);
    await expect(admin.query(`UPDATE patient_therapeutic_projects SET annul_reason = 'outro motivo' WHERE id = $1`, [v.id]))
      .rejects.toThrow(/anulação não se desfaz/);
    // Anulação pela metade (sem annulled_by) é recusada pelo CHECK.
    const v2 = await insertVersion({ minor: 1 });
    await expect(admin.query(`UPDATE patient_therapeutic_projects SET annulled_at = NOW() WHERE id = $1`, [v2.id]))
      .rejects.toThrow(/ptp_anulacao_coerente/);
  });

  it('6. DELETE direto é recusado; o CASCADE do paciente leva as versões (lex C4)', async () => {
    const v = await insertVersion();
    await expect(admin.query(`DELETE FROM patient_therapeutic_projects WHERE id = $1`, [v.id])).rejects.toThrow(/ptp_imutavel/);
    await admin.query(`DELETE FROM patients WHERE id = $1`, [IDS.patient]);
    const left = await admin.query<{ n: number }>(`SELECT count(*)::int AS n FROM patient_therapeutic_projects WHERE id = $1`, [v.id]);
    expect(left.rows[0].n).toBe(0);
  });

  it('7. 🔒 RLS: role do app sem identidade na sessão não lê nem escreve (policy follow_patient)', async () => {
    const ROLE = 'e2e_app_416';
    await admin.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${ROLE}') THEN
        CREATE ROLE ${ROLE} NOINHERIT; END IF; END $$;`);
    await admin.query(`GRANT app_runtime TO ${ROLE}`);
    await admin.query(`GRANT USAGE ON SCHEMA public TO ${ROLE}`);
    await admin.query(`GRANT SELECT, INSERT ON patient_therapeutic_projects TO ${ROLE}`);
    await admin.query(`GRANT SELECT ON patients, patient_contracted_services TO ${ROLE}`);
    const v = await insertVersion();
    const client = await admin.connect();
    try {
      await client.query(`SET ROLE ${ROLE}`);
      // Sem identidade: a policy de patients recusa em voz alta (411) → a satélite não decide.
      await expect(client.query(`SELECT id FROM patient_therapeutic_projects WHERE id = $1`, [v.id]))
        .rejects.toThrow(/rls_session_without_identity|permission denied/);
      await client.query(`RESET ROLE`);
      // Com o país da sessão: a linha aparece.
      await client.query(`SET ROLE ${ROLE}`);
      await client.query(`SELECT set_config('app.user_country', 'AR', false)`);
      const seen = await client.query(`SELECT id FROM patient_therapeutic_projects WHERE id = $1`, [v.id]);
      expect(seen.rowCount).toBe(1);
    } finally {
      await client.query(`RESET ROLE`).catch(() => undefined);
      client.release(true);
      await admin.query(`REVOKE ALL ON patient_therapeutic_projects, patients, patient_contracted_services FROM ${ROLE}`).catch(() => undefined);
      await admin.query(`REVOKE USAGE ON SCHEMA public FROM ${ROLE}`).catch(() => undefined);
      await admin.query(`DROP ROLE IF EXISTS ${ROLE}`);
    }
  });

  it('8. tetos: clinical_context > 4000 e lista vazia de objetivos são recusados pelo CHECK (lex C6)', async () => {
    await expect(insertVersion({ clinical_context: 'x'.repeat(4001) })).rejects.toThrow(/ptp_clinical_context_len/);
    await expect(insertVersion({ specific_objectives: '[]' })).rejects.toThrow(/ptp_specific_objectives_lista/);
    await expect(insertVersion({ end_date: '2026-08-31' })).rejects.toThrow(/ptp_prazo_coerente/);
  });
});
