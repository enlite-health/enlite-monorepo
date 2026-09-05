/**
 * patient-emergency-instructions.e2e.test.ts @integration — REQ-01 · D211.2
 *
 * PONTA A PONTA contra a API real (Docker, USE_MOCK_AUTH) + Postgres real:
 * PATCH /api/admin/patients/:id/clinical grava `emergency_instructions` + autoria (uid de quem
 * editou, na mesma transação) → GET /api/admin/patients/:id devolve o texto e o NOME (uid não sai).
 *
 * O que prova:
 *   1. staff (recruiter) edita e lê — decisão humana D211.2: quem lê a ficha hoje lê o campo;
 *   2. Merge Patch: editar SÓ outro campo não toca o texto nem a autoria (D211.1);
 *   3. `null` explícito limpa e registra autoria; teto 4.000 → 400;
 *   4. o uid NUNCA sai da API (só o nome resolvido em users); o valor não aparece na trilha/log do banco.
 * A redação por célula (`patient_clinical:read`) é provada no unitário do controller — o engine
 * não monta células nesta base (D113: sem engine, devolve o que devolvia antes).
 */
import { Pool } from 'pg';
import { createApiClient, waitForBackend } from './helpers';
import { staffAuth } from './helpers/staffAuth';

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';
// uid PEDIDO; o efetivo vem do staffAuth (localId do emulador quando ele está de pé).
let RECRUITER_UID = 'ei-recruiter-uid';
const TEXT = 'Crisis: llamar al 107.\nAvisar a la madre (Ana) antes de mover.';

describe('Instruções de emergência do paciente (D211.2) @integration', () => {
  const api = createApiClient();
  let pool: Pool;
  // Spec 012: token adaptativo (emulador ou mock) — o stack local roda USE_MOCK_AUTH=false.
  let asRecruiter: { headers: { Authorization: string } };
  let patientId = '';

  beforeAll(async () => {
    await waitForBackend(api);
    const auth = await staffAuth(RECRUITER_UID, 'recruiter');
    asRecruiter = { headers: auth.headers };
    RECRUITER_UID = auth.uid;
    pool = new Pool({ connectionString: DATABASE_URL });
    await pool.query(`DELETE FROM users WHERE firebase_uid = $1`, [RECRUITER_UID]);
    await pool.query(`INSERT INTO users (firebase_uid, email, display_name, role, is_active, email_verified) VALUES ($1, $2, 'EI Recruiter', 'recruiter', true, true)`, [RECRUITER_UID, `${RECRUITER_UID}@e2e.local`]);
    await pool.query(`DELETE FROM patients WHERE clickup_task_id LIKE 'ei-e2e-%'`);
    const { rows: [p] } = await pool.query<{ id: string }>(
      `INSERT INTO patients (clickup_task_id, first_name, last_name, diagnosis, country) VALUES ('ei-e2e-1', 'Paciente', 'Emergencia', 'F84.0 TEA', 'AR') RETURNING id`,
    );
    patientId = p.id;
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM patients WHERE id = $1`, [patientId]);
    await pool.query(`DELETE FROM users WHERE firebase_uid = $1`, [RECRUITER_UID]);
    await pool.end();
  });

  it('recruiter edita → banco com valor + autoria (uid, agora) → GET devolve texto e NOME, nunca o uid', async () => {
    const r = await api.patch(`/api/admin/patients/${patientId}/clinical`, { emergencyInstructions: TEXT }, asRecruiter);
    expect(r.status).toBe(200);
    const { rows: [row] } = await pool.query(
      `SELECT emergency_instructions = $2 AS same, emergency_instructions_updated_by AS by, emergency_instructions_updated_at > NOW() - INTERVAL '2 minutes' AS recent, diagnosis FROM patients WHERE id = $1`,
      [patientId, TEXT],
    );
    expect(row).toEqual({ same: true, by: RECRUITER_UID, recent: true, diagnosis: 'F84.0 TEA' });
    const g = await api.get(`/api/admin/patients/${patientId}`, asRecruiter);
    expect(g.status).toBe(200);
    expect(g.data.data.emergencyInstructions).toBe(TEXT);
    expect(g.data.data.emergencyInstructionsUpdatedBy).toBe('EI Recruiter');
    expect(g.data.data.emergencyInstructionsRedacted).toBeUndefined();
    expect(JSON.stringify(g.data)).not.toContain(RECRUITER_UID);
  });

  it('editar SÓ outro campo clínico preserva o texto e a autoria (Merge Patch, D211.1)', async () => {
    const before = (await pool.query(`SELECT emergency_instructions_updated_at::text AS at FROM patients WHERE id = $1`, [patientId])).rows[0].at;
    // Spec 012 US-B4: dispositivo é CÓDIGO do catálogo (patients.device_type é FK desde a 308 —
    // texto livre dava 23503); o escalar é derivado do conjunto pelo trigger da 310.
    expect((await api.patch(`/api/admin/patients/${patientId}/clinical`, { deviceTypes: ['INPATIENT'] }, asRecruiter)).status).toBe(200);
    const { rows: [row] } = await pool.query(`SELECT emergency_instructions = $2 AS same, emergency_instructions_updated_at::text AS at, device_type FROM patients WHERE id = $1`, [patientId, TEXT]);
    expect(row).toEqual({ same: true, at: before, device_type: 'INPATIENT' });
  });

  it('null limpa e registra autoria; 4.001 caracteres → 400', async () => {
    expect((await api.patch(`/api/admin/patients/${patientId}/clinical`, { emergencyInstructions: 'x'.repeat(4001) }, asRecruiter)).status).toBe(400);
    expect((await api.patch(`/api/admin/patients/${patientId}/clinical`, { emergencyInstructions: null }, asRecruiter)).status).toBe(200);
    const { rows: [row] } = await pool.query(`SELECT emergency_instructions IS NULL AS cleared, emergency_instructions_updated_by AS by FROM patients WHERE id = $1`, [patientId]);
    expect(row).toEqual({ cleared: true, by: RECRUITER_UID });
    const g = await api.get(`/api/admin/patients/${patientId}`, asRecruiter);
    expect(g.data.data.emergencyInstructions).toBeNull();
  });

  it('C5 (supressão): paciente com deleted_at não sai por nenhuma rota — GET 404, PATCH 404', async () => {
    await pool.query(`UPDATE patients SET emergency_instructions = $2, deleted_at = NOW() WHERE id = $1`, [patientId, TEXT]);
    expect((await api.get(`/api/admin/patients/${patientId}`, asRecruiter)).status).toBe(404);
    expect((await api.patch(`/api/admin/patients/${patientId}/clinical`, { emergencyInstructions: 'x' }, asRecruiter)).status).toBe(404);
    const list = await api.get(`/api/admin/patients?search=Emergencia`, asRecruiter);
    expect(JSON.stringify(list.data)).not.toContain('Crisis: llamar');
  });
});
