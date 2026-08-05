/**
 * profile-edit-source-trail.e2e.test.ts
 *
 * Rastreabilidade de fonte da edição de perfil (change luz-cadastro-assistido-rastreavel, D92):
 * toda escrita de campo de cadastro gera linha em worker_profile_changes_audit com a FONTE
 * (`changed_by` ∈ luz_conversation | worker_self | admin_panel | sync_import) e valor REDIGIDO.
 *
 * Banco REAL (invariante que mock não pega):
 *   - self (/api/workers/me/general-info) deixou de ser cego → worker_self
 *   - re-save idêntico do wizard NÃO duplica linhas (diff de verdade)
 *   - admin PATCH → admin_panel na MESMA trilha (além do worker_admin_audit_log rico)
 *   - PII nunca em claro na trilha (nome mascarado, doc last-4)
 */

import { Pool } from 'pg';
import { createApiClient, getMockToken, waitForBackend } from './helpers';

const DATABASE_URL =
  process.env.DATABASE_URL ||
  'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

describe('trilha de fonte de edição de perfil (worker_profile_changes_audit)', () => {
  const api = createApiClient();
  let adminToken: string;
  let workerToken: string;
  let pool: Pool;
  let workerId: string;

  const authUid = `edit-source-trail-e2e-${Date.now()}`;
  const email = `edit-source-trail-${Date.now()}@e2e.local`;

  const generalInfo = {
    firstName: 'Trilha',
    lastName: 'Fonte',
    sex: 'female',
    gender: 'female',
    birthDate: '1991-02-03',
    documentType: 'DNI',
    documentNumber: '87654321',
    phone: '+5491166666666',
    languages: ['es'],
    profession: 'CAREGIVER',
    knowledgeLevel: 'UNIVERSITY',
    titleCertificate: 'Titulo E2E',
    experienceTypes: ['TEA'],
    yearsExperience: '5_10',
    preferredTypes: ['TEA'],
    preferredAgeRange: ['children'],
    termsAccepted: true,
    privacyAccepted: true,
  };

  function trailRows() {
    return pool.query(
      `SELECT field_name, old_value_redacted, new_value_redacted, changed_by, source
       FROM worker_profile_changes_audit
       WHERE worker_id = $1
       ORDER BY created_at ASC`,
      [workerId],
    );
  }

  beforeAll(async () => {
    await waitForBackend(api);

    adminToken = await getMockToken(api, {
      uid: 'edit-source-trail-admin-e2e',
      email: 'edit-source-trail-admin@e2e.local',
      role: 'admin',
    });
    workerToken = await getMockToken(api, { uid: authUid, email, role: 'worker' });

    pool = new Pool({ connectionString: DATABASE_URL });

    const initRes = await api.post('/api/workers/init', {
      authUid,
      email,
      country: 'AR',
    });
    if (initRes.status !== 200 && initRes.status !== 201) {
      throw new Error(`Failed to seed worker: ${JSON.stringify(initRes.data)}`);
    }
    workerId = initRes.data.data.worker.id;
  });

  afterAll(async () => {
    if (pool && workerId) {
      await pool.query('DELETE FROM worker_profile_changes_audit WHERE worker_id = $1', [workerId]);
      await pool.query('DELETE FROM worker_service_areas WHERE worker_id = $1', [workerId]);
      await pool.query('DELETE FROM workers WHERE id = $1', [workerId]);
    }
    if (pool) await pool.end();
  });

  it('self (general-info) grava a trilha com worker_self — o canal deixou de ser cego', async () => {
    const res = await api.put('/api/workers/me/general-info', generalInfo, {
      headers: { Authorization: `Bearer ${workerToken}` },
    });
    expect(res.status).toBe(200);

    const { rows } = await trailRows();
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.changed_by === 'worker_self')).toBe(true);
    expect(rows.every((r) => r.source === 'platform')).toBe(true);

    const fields = rows.map((r) => r.field_name);
    expect(fields).toEqual(
      expect.arrayContaining(['firstName', 'documentNumber', 'profession', 'birthDate']),
    );
  });

  it('re-save idêntico do wizard NÃO duplica linhas (diff contra o estado atual)', async () => {
    const before = (await trailRows()).rows.length;

    const res = await api.put('/api/workers/me/general-info', generalInfo, {
      headers: { Authorization: `Bearer ${workerToken}` },
    });
    expect(res.status).toBe(200);

    const after = (await trailRows()).rows.length;
    expect(after).toBe(before);
  });

  it('admin PATCH entra na MESMA trilha com admin_panel', async () => {
    const res = await api.patch(
      `/api/admin/workers/${workerId}/profile`,
      { firstName: 'Editada', profession: 'AT' },
      { headers: { Authorization: `Bearer ${adminToken}` } },
    );
    expect(res.status).toBe(200);

    const { rows } = await trailRows();
    const adminRows = rows.filter((r) => r.changed_by === 'admin_panel');
    expect(adminRows.map((r) => r.field_name)).toEqual(
      expect.arrayContaining(['firstName', 'profession']),
    );
    expect(adminRows.every((r) => r.source === 'admin')).toBe(true);

    // profession (plaintext, não-PII) legível com antes→depois
    const prof = adminRows.find((r) => r.field_name === 'profession');
    expect(prof).toMatchObject({ old_value_redacted: 'CAREGIVER', new_value_redacted: 'AT' });
  });

  it('PII NUNCA em claro na trilha (nome mascarado, doc last-4, nascimento só ano)', async () => {
    const { rows } = await trailRows();

    const raw = JSON.stringify(rows);
    expect(raw).not.toContain('Trilha');
    expect(raw).not.toContain('Editada');
    expect(raw).not.toContain('87654321');

    const doc = rows.find((r) => r.field_name === 'documentNumber');
    expect(doc?.new_value_redacted).toBe('***4321');
    const birth = rows.find((r) => r.field_name === 'birthDate');
    expect(birth?.new_value_redacted).toBe('1991');
    const name = rows.find((r) => r.field_name === 'firstName' && r.changed_by === 'worker_self');
    expect(name?.new_value_redacted).toBe('***');
  });

  it('a distribuição por fonte responde numa query só (a pergunta do D92)', async () => {
    const { rows } = await pool.query(
      `SELECT CASE WHEN changed_by = 'luz' THEN 'luz_conversation' ELSE changed_by END AS source,
              COUNT(*)::int AS edits
       FROM worker_profile_changes_audit
       WHERE worker_id = $1
       GROUP BY 1`,
      [workerId],
    );
    const bySource = Object.fromEntries(rows.map((r) => [r.source, r.edits]));
    expect(bySource.worker_self).toBeGreaterThan(0);
    expect(bySource.admin_panel).toBeGreaterThan(0);
  });
});
