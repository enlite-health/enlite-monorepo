/**
 * Spec 048 — migration 502 no BANCO REAL: status por campo do PT, ciclo de lembretes (outbox) e as 2 células do Master.
 *
 *  (a) UPDATE no status → 55000 (imutável)
 *  (b) INSERT de status fora da transação da versão → 55000
 *  (c) status + contato do MESMO kind na mesma versão → 22023
 *  (d) 2º ciclo ABERTO do mesmo paciente → 23505 (invariante do banco, não só do código)
 *  (e) 2º lembrete do mesmo dia no ciclo → 23505
 *  (f) "des-enviar" (sent_at → NULL) → 55000; reabrir lembrete cancelado idem
 *  (g) o Acesso Master tem as 2 células em iam.group_permissions
 *  (h) DELETE do paciente leva ciclo, lembretes e status (CASCADE)
 * Mais: PENDING sem âncora e NOT_NEEDED com âncora violam o CHECK; tipo de notificação semeado; país herdado.
 */
import { Pool, PoolClient } from 'pg';

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';
const MASTER = 'a0000000-0000-0000-0000-000000000001';

describe('502 — status do PT, ciclo e lembretes (banco real)', () => {
  let admin: Pool;
  const PATIENT = 'ee048000-0a00-0001-0001-000000000001';
  const diag = JSON.stringify([{ uri: 'http://id.who.int/icd/entity/1', code: '8B11', title: 'Sintético' }]);
  const snap = (label: string) => JSON.stringify([{ id: '11111111-1111-1111-1111-111111111111', label }]);

  /** Versão numa transação ABERTA (mesmo `now()` para o status). O chamador faz COMMIT/ROLLBACK. */
  async function abrirTransacaoComVersao(major: number): Promise<{ cli: PoolClient; versionId: string }> {
    const cli = await admin.connect();
    await cli.query('BEGIN');
    const s = await cli.query<{ id: string }>(
      `INSERT INTO patient_contracted_services (patient_id, service_code, created_by, updated_by)
       VALUES ($1, 'CAREGIVER', 'e2e-048', 'e2e-048') RETURNING id`, [PATIENT]);
    const v = await cli.query<{ id: string }>(
      `INSERT INTO patient_therapeutic_projects
         (patient_id, major, minor, contracted_service_id, diagnoses, clinical_context, general_objective,
          specific_objectives, activities, pathology_types, start_date, end_date, created_by)
       VALUES ($1, $2, 0, $3, $4, 'contexto sintético', 'objetivo sintético', $5, $6, $7, '2026-09-01', '2026-12-31', 'e2e-048')
       RETURNING id`, [PATIENT, major, s.rows[0].id, diag, snap('o'), snap('a'), snap('p')]);
    return { cli, versionId: v.rows[0].id };
  }

  async function versaoComStatus(major: number, kind: string, status: 'PENDING' | 'NOT_NEEDED'): Promise<string> {
    const { cli, versionId } = await abrirTransacaoComVersao(major);
    try {
      await cli.query(
        `INSERT INTO patient_therapeutic_project_contact_status (version_id, patient_id, contact_kind, status, pending_since, marked_by_uid)
         VALUES ($1, $2, $3, $4, CASE WHEN $4 = 'PENDING' THEN now() END, 'e2e-048')`, [versionId, PATIENT, kind, status]);
      await cli.query('COMMIT');
      return versionId;
    } catch (e) { await cli.query('ROLLBACK').catch(() => undefined); throw e; } finally { cli.release(); }
  }

  const codigo = async (p: Promise<unknown>): Promise<string> => {
    try { await p; return 'OK'; } catch (e) { return (e as { code?: string }).code ?? String(e); }
  };

  async function cleanup(): Promise<void> {
    await admin.query(`DELETE FROM patients WHERE id = $1`, [PATIENT]);
  }

  beforeAll(async () => {
    admin = new Pool({ connectionString: DATABASE_URL });
    await cleanup();
    await admin.query(`INSERT INTO patients (id, clickup_task_id, first_name, last_name, country) VALUES ($1, 'e2e-048-a', 'Paciente', 'Sintético', 'AR')`, [PATIENT]);
  });
  afterAll(async () => { await cleanup(); await admin.end(); });

  it('(a) status é imutável: UPDATE → 55000; país herdado do paciente; âncora coerente com o status (CHECK)', async () => {
    const v = await versaoComStatus(1, 'RESPONSIBLE', 'PENDING');
    expect(await codigo(admin.query(`UPDATE patient_therapeutic_project_contact_status SET status = 'NOT_NEEDED', pending_since = NULL WHERE version_id = $1`, [v]))).toBe('55000');
    expect(await codigo(admin.query(`DELETE FROM patient_therapeutic_project_contact_status WHERE version_id = $1`, [v]))).toBe('55000');
    const row = await admin.query(`SELECT country FROM patient_therapeutic_project_contact_status WHERE version_id = $1`, [v]);
    expect(row.rows[0].country).toBe('AR');

    const { cli, versionId } = await abrirTransacaoComVersao(2);
    try {
      expect(await codigo(cli.query(`SAVEPOINT s1`).then(() => cli.query(
        `INSERT INTO patient_therapeutic_project_contact_status (version_id, patient_id, contact_kind, status, pending_since, marked_by_uid)
         VALUES ($1, $2, 'EXTERNAL', 'PENDING', NULL, 'e2e-048')`, [versionId, PATIENT])))).toBe('23514');
      await cli.query('ROLLBACK TO SAVEPOINT s1');
      expect(await codigo(cli.query(
        `INSERT INTO patient_therapeutic_project_contact_status (version_id, patient_id, contact_kind, status, pending_since, marked_by_uid)
         VALUES ($1, $2, 'EXTERNAL', 'NOT_NEEDED', now(), 'e2e-048')`, [versionId, PATIENT]))).toBe('23514');
    } finally { await cli.query('ROLLBACK').catch(() => undefined); cli.release(); }
  });

  it('(b) INSERT de status FORA da transação da versão → 55000', async () => {
    const { cli, versionId } = await abrirTransacaoComVersao(3);
    await cli.query('COMMIT');
    cli.release();
    expect(await codigo(admin.query(
      `INSERT INTO patient_therapeutic_project_contact_status (version_id, patient_id, contact_kind, status, pending_since, marked_by_uid)
       VALUES ($1, $2, 'COVERAGE', 'PENDING', now(), 'e2e-048')`, [versionId, PATIENT]))).toBe('55000');
  });

  it('(c) status + contato do MESMO kind na mesma versão → 22023; kinds diferentes passam', async () => {
    const ext = await admin.query<{ id: string }>(
      `INSERT INTO patient_external_contacts (patient_id, relation, name, phone_encrypted, created_by)
       VALUES ($1, 'NEIGHBOR', 'Contato Sintético 048', 'cifrado', 'e2e-048') RETURNING id`, [PATIENT]);
    const { cli, versionId } = await abrirTransacaoComVersao(4);
    try {
      await cli.query(
        `INSERT INTO patient_therapeutic_project_contacts (version_id, patient_id, contact_kind, external_contact_id, sort_order)
         VALUES ($1, $2, 'EXTERNAL', $3, 0)`, [versionId, PATIENT, ext.rows[0].id]);
      await cli.query('SAVEPOINT s');
      expect(await codigo(cli.query(
        `INSERT INTO patient_therapeutic_project_contact_status (version_id, patient_id, contact_kind, status, pending_since, marked_by_uid)
         VALUES ($1, $2, 'EXTERNAL', 'PENDING', now(), 'e2e-048')`, [versionId, PATIENT]))).toBe('22023');
      await cli.query('ROLLBACK TO SAVEPOINT s');
      expect(await codigo(cli.query(
        `INSERT INTO patient_therapeutic_project_contact_status (version_id, patient_id, contact_kind, status, pending_since, marked_by_uid)
         VALUES ($1, $2, 'CARE_TEAM', 'PENDING', now(), 'e2e-048')`, [versionId, PATIENT]))).toBe('OK');
    } finally { await cli.query('ROLLBACK').catch(() => undefined); cli.release(); }
  });

  describe('ciclo e lembretes', () => {
    let versionId: string;
    beforeAll(async () => { versionId = await versaoComStatus(10, 'CARE_TEAM', 'PENDING'); });
    afterEach(async () => { await admin.query(`DELETE FROM patient_tp_contact_reminder_cycles WHERE patient_id = $1`, [PATIENT]); });

    const abrirCiclo = async (): Promise<string> => (await admin.query<{ id: string }>(
      `INSERT INTO patient_tp_contact_reminder_cycles (patient_id, anchor_version_id, opened_by_uid) VALUES ($1, $2, 'e2e-048') RETURNING id`,
      [PATIENT, versionId])).rows[0].id;

    it('(d) 2º ciclo ABERTO do mesmo paciente → 23505; depois de fechar o 1º, abrir outro passa', async () => {
      const c1 = await abrirCiclo();
      expect(await codigo(abrirCiclo())).toBe('23505');
      await admin.query(`UPDATE patient_tp_contact_reminder_cycles SET closed_at = now(), close_reason = 'COMPLETED' WHERE id = $1`, [c1]);
      expect(await codigo(abrirCiclo())).toBe('OK');
    });

    it('fechamento incoerente (closed_at sem motivo) é recusado; país herdado do paciente', async () => {
      const c1 = await abrirCiclo();
      expect(await codigo(admin.query(`UPDATE patient_tp_contact_reminder_cycles SET closed_at = now() WHERE id = $1`, [c1]))).toBe('23514');
      expect((await admin.query(`SELECT country FROM patient_tp_contact_reminder_cycles WHERE id = $1`, [c1])).rows[0].country).toBe('AR');
    });

    it('(e) 2º lembrete do mesmo dia no ciclo → 23505; dia fora de 2/5/12 → 23514', async () => {
      const c = await abrirCiclo();
      await admin.query(`INSERT INTO patient_tp_contact_reminders (cycle_id, day_offset, due_at) VALUES ($1, 2, now())`, [c]);
      expect(await codigo(admin.query(`INSERT INTO patient_tp_contact_reminders (cycle_id, day_offset, due_at) VALUES ($1, 2, now())`, [c]))).toBe('23505');
      expect(await codigo(admin.query(`INSERT INTO patient_tp_contact_reminders (cycle_id, day_offset, due_at) VALUES ($1, 3, now())`, [c]))).toBe('23514');
    });

    it('(f) carimbo não volta: sent_at → NULL e reabrir cancelado → 55000; due_at continua ajustável; enviar e cancelar juntos → 23514', async () => {
      const c = await abrirCiclo();
      const r = (await admin.query<{ id: string }>(`INSERT INTO patient_tp_contact_reminders (cycle_id, day_offset, due_at) VALUES ($1, 5, now() + interval '5 days') RETURNING id`, [c])).rows[0].id;
      expect(await codigo(admin.query(`UPDATE patient_tp_contact_reminders SET due_at = now() - interval '1 hour' WHERE id = $1`, [r]))).toBe('OK');
      expect(await codigo(admin.query(`UPDATE patient_tp_contact_reminders SET sent_at = now(), cancelled_at = now(), cancel_reason = 'RESOLVED' WHERE id = $1`, [r]))).toBe('23514');
      expect(await codigo(admin.query(`UPDATE patient_tp_contact_reminders SET sent_at = now() WHERE id = $1`, [r]))).toBe('OK');
      expect(await codigo(admin.query(`UPDATE patient_tp_contact_reminders SET sent_at = NULL WHERE id = $1`, [r]))).toBe('55000');

      const r2 = (await admin.query<{ id: string }>(`INSERT INTO patient_tp_contact_reminders (cycle_id, day_offset, due_at) VALUES ($1, 12, now()) RETURNING id`, [c])).rows[0].id;
      await admin.query(`UPDATE patient_tp_contact_reminders SET cancelled_at = now(), cancel_reason = 'RESOLVED' WHERE id = $1`, [r2]);
      expect(await codigo(admin.query(`UPDATE patient_tp_contact_reminders SET cancelled_at = NULL, cancel_reason = NULL WHERE id = $1`, [r2]))).toBe('55000');
      expect(await codigo(admin.query(`UPDATE patient_tp_contact_reminders SET cycle_id = gen_random_uuid() WHERE id = $1`, [r2]))).toBe('55000');
    });
  });

  it('(g) o Acesso Master tem as 2 células novas (e nenhum outro grupo as tem)', async () => {
    const r = await admin.query<{ action: string; group_id: string }>(
      `SELECT p.action, gp.group_id
         FROM iam.group_permissions gp JOIN iam.permissions p ON p.id = gp.permission_id
        WHERE p.resource = 'patient_therapeutic_project' AND p.action IN ('waive_contact', 'incomplete_alert')`);
    expect(r.rows.map((x) => x.action).sort()).toEqual(['incomplete_alert', 'waive_contact']);
    expect(new Set(r.rows.map((x) => x.group_id))).toEqual(new Set([MASTER]));
  });

  it('o tipo de notificação do sino foi semeado', async () => {
    const r = await admin.query(`SELECT 1 FROM notification_types WHERE code = 'THERAPEUTIC_PROJECT_CONTACTS_PENDING'`);
    expect(r.rowCount).toBe(1);
  });

  it('(h) DELETE do paciente leva ciclo, lembretes e status (CASCADE, sem o trigger barrar)', async () => {
    const v = await versaoComStatus(20, 'COVERAGE', 'PENDING');
    const c = (await admin.query<{ id: string }>(`INSERT INTO patient_tp_contact_reminder_cycles (patient_id, anchor_version_id, opened_by_uid) VALUES ($1, $2, 'e2e-048') RETURNING id`, [PATIENT, v])).rows[0].id;
    await admin.query(`INSERT INTO patient_tp_contact_reminders (cycle_id, day_offset, due_at) VALUES ($1, 2, now())`, [c]);
    await admin.query(`DELETE FROM patients WHERE id = $1`, [PATIENT]);
    const n = async (q: string): Promise<number> => (await admin.query<{ n: number }>(q, [PATIENT, c])).rows[0].n;
    expect(await n(`SELECT count(*)::int n FROM patient_therapeutic_project_contact_status WHERE patient_id = $1 AND $2::text IS NOT NULL`)).toBe(0);
    expect(await n(`SELECT count(*)::int n FROM patient_tp_contact_reminder_cycles WHERE patient_id = $1 AND $2::text IS NOT NULL`)).toBe(0);
    expect(await n(`SELECT count(*)::int n FROM patient_tp_contact_reminders WHERE cycle_id = $2::uuid AND $1::text IS NOT NULL`)).toBe(0);
  });
});
