/**
 * worker-missing-fields-documents-expansion.integration.test.ts
 *
 * Fase 1 de openspec/changes/postulacao-documento-pendente (DD1): o
 * `GET /api/workers/me` — e a resposta do `PUT /api/workers/me/general-info`,
 * que relê pelo MESMO caminho (`WorkerControllerV2Helpers.readFreshProgress`)
 * — passam a devolver `doc_*` em vez do agregado `worker_documents`, pelo
 * mesmo ponto de expansão que o 403 do track-channel já usava (F3).
 *
 * Banco REAL (Postgres via docker), API REAL rodando — sem mock do endpoint
 * sob teste. Auth via MockAuth (`USE_MOCK_AUTH=true`, `/api/test/auth/token`),
 * que é o padrão desta suíte (ver `worker-application-eligibility.e2e.test.ts`).
 */

import { Pool } from 'pg';
import { createApiClient, createPatientFixture, getMockToken, waitForBackend } from './helpers';

const DATABASE_URL =
  process.env.DATABASE_URL ||
  'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

const SUFFIX = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const ALL_WORKER_IDS: string[] = [];

describe('GET /api/workers/me e PUT /api/workers/me/general-info — expansão doc_* (Fase 1, DD1)', () => {
  const api = createApiClient();
  let pool: Pool;
  let patientId: string;
  let jobPostingId: string;

  beforeAll(async () => {
    await waitForBackend(api);
    pool = new Pool({ connectionString: DATABASE_URL });

    // Vaga PRÓPRIA da suíte (nunca pega emprestada de outro teste via
    // `SELECT ... status='SEARCHING' LIMIT 1` — isso lia estado de fixture
    // alheia e não tinha dono pra limpar). Só o teste de regressão do 403
    // usa, mas nasce aqui pra existir uma fonte única e ser limpa no afterAll
    // mesmo que aquele teste falhe antes de chegar lá.
    patientId = await createPatientFixture(pool, 'docexp');
    const posting = await pool.query<{ id: string }>(
      `INSERT INTO job_postings (title, country, status, patient_id, case_number)
       VALUES ('Caso E2E docexp', 'AR', 'SEARCHING', $1, 99972) RETURNING id`,
      [patientId],
    );
    jobPostingId = posting.rows[0].id;
  });

  afterAll(async () => {
    if (ALL_WORKER_IDS.length) {
      await pool.query(`DELETE FROM worker_blocked_applications WHERE worker_id = ANY($1::uuid[])`, [ALL_WORKER_IDS]);
      await pool.query(`DELETE FROM worker_service_areas WHERE worker_id = ANY($1::uuid[])`, [ALL_WORKER_IDS]);
      await pool.query(`DELETE FROM worker_availability WHERE worker_id = ANY($1::uuid[])`, [ALL_WORKER_IDS]);
      await pool.query(`DELETE FROM worker_documents WHERE worker_id = ANY($1::uuid[])`, [ALL_WORKER_IDS]);
      await pool.query(`DELETE FROM workers WHERE id = ANY($1::uuid[])`, [ALL_WORKER_IDS]);
    }
    if (jobPostingId) await pool.query(`DELETE FROM job_postings WHERE id = $1`, [jobPostingId]);
    if (patientId) await pool.query(`DELETE FROM patients WHERE id = $1`, [patientId]);
    await pool.end();
  });

  /**
   * Worker com cadastro (info geral + área + disponibilidade) 100% completo,
   * profissão dada — SÓ documentos ficam pendentes (o que o caso de uso testa).
   *
   * A info pessoal é gravada pelo `PUT /api/workers/me/general-info` de
   * VERDADE (não `UPDATE workers SET first_name_encrypted = '...'` via SQL
   * cru): os campos pessoais são encriptados por KMS/mock, e um literal como
   * `'enc-fname'` não é ciphertext válido — o `GET /api/workers/me` quebra ao
   * tentar decriptar pra montar a resposta ("Unexpected token ... is not
   * valid JSON"), medido ao rodar esta suíte pela primeira vez. Área de
   * atendimento e disponibilidade não são encriptadas — SQL direto é seguro
   * pra elas (mesmo padrão de `fn-worker-missing-fields.integration.test.ts`).
   */
  async function makeWorkerWithCompleteRegistration(
    tag: string,
    profession: 'AT' | 'CAREGIVER',
  ): Promise<{ id: string; authUid: string; email: string; token: string }> {
    const authUid = `uid-docexp-${SUFFIX}-${tag}`;
    const email = `docexp-${SUFFIX}-${tag}@e2e.test`;
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO workers (auth_uid, email, status, country, timezone)
       VALUES ($1, $2, 'INCOMPLETE_REGISTER', 'AR', 'America/Argentina/Buenos_Aires')
       RETURNING id`,
      [authUid, email],
    );
    const id = rows[0].id;
    ALL_WORKER_IDS.push(id);

    const token = await getMockToken(api, { uid: authUid, email, role: 'worker' });

    const putRes = await api.put(
      '/api/workers/me/general-info',
      {
        firstName: 'Alberto',
        lastName: 'Marquez',
        sex: 'Masculino',
        gender: 'Masculino',
        birthDate: '1960-03-18',
        documentType: 'DNI',
        documentNumber: `${Math.floor(10000000 + Math.random() * 89999999)}`,
        phone: `+549115${Math.floor(1000000 + Math.random() * 8999999)}`,
        languages: ['Español'],
        profession,
        knowledgeLevel: 'BASIC',
        titleCertificate: 'DEGREE',
        experienceTypes: ['TEA', 'TLP'],
        yearsExperience: '3-5',
        preferredTypes: ['TEA'],
        preferredAgeRange: ['CHILD'],
        termsAccepted: true,
        privacyAccepted: true,
      },
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (putRes.status !== 200) {
      throw new Error(`fixture PUT general-info falhou: ${putRes.status} ${JSON.stringify(putRes.data)}`);
    }

    await pool.query(
      `INSERT INTO worker_service_areas (worker_id, address_line, radius_km)
       VALUES ($1, 'Av. Corrientes 1234', 10)`,
      [id],
    );

    await pool.query(
      `INSERT INTO worker_availability (worker_id, day_of_week, start_time, end_time, timezone)
       VALUES ($1, 1, '08:00', '18:00', 'America/Argentina/Buenos_Aires')`,
      [id],
    );

    return { id, authUid, email, token };
  }

  it('AT sem antecedentes e sem CV → missingFields contém doc_criminal_record e doc_resume_cv, e NÃO doc_identity_document/doc_at_certificate/worker_documents', async () => {
    const w = await makeWorkerWithCompleteRegistration('at-partial', 'AT');
    await pool.query(
      `INSERT INTO worker_documents (worker_id, identity_document_url, at_certificate_url)
       VALUES ($1, 'http://e.com/id', 'http://e.com/cert')`,
      [w.id],
    );
    const res = await api.get('/api/workers/me', { headers: { Authorization: `Bearer ${w.token}` } });

    expect(res.status).toBe(200);
    const missingFields: string[] = res.data.data.missingFields;
    expect(missingFields).toContain('doc_criminal_record');
    expect(missingFields).toContain('doc_resume_cv');
    expect(missingFields).not.toContain('doc_identity_document');
    expect(missingFields).not.toContain('doc_at_certificate');
    expect(missingFields).not.toContain('worker_documents');
  });

  it('worker completo (todos os docs presentes) → missingFields = []', async () => {
    const w = await makeWorkerWithCompleteRegistration('at-complete', 'AT');
    await pool.query(
      `INSERT INTO worker_documents
         (worker_id, identity_document_url, criminal_record_url, resume_cv_url, at_certificate_url)
       VALUES ($1, 'http://e.com/id', 'http://e.com/cr', 'http://e.com/cv', 'http://e.com/cert')`,
      [w.id],
    );
    const res = await api.get('/api/workers/me', { headers: { Authorization: `Bearer ${w.token}` } });

    expect(res.status).toBe(200);
    expect(res.data.data.missingFields).toEqual([]);
  });

  it('worker SEM linha em worker_documents → todos os doc_* da profissão (CAREGIVER: só DNI + antecedentes)', async () => {
    const w = await makeWorkerWithCompleteRegistration('caregiver-no-row', 'CAREGIVER');
    // Nenhum INSERT em worker_documents — worker nasce sem linha.
    const res = await api.get('/api/workers/me', { headers: { Authorization: `Bearer ${w.token}` } });

    expect(res.status).toBe(200);
    const missingFields: string[] = res.data.data.missingFields;
    expect(missingFields).toEqual(
      expect.arrayContaining(['doc_identity_document', 'doc_criminal_record']),
    );
    expect(missingFields).not.toContain('doc_resume_cv');
    expect(missingFields).not.toContain('doc_at_certificate');
    expect(missingFields).not.toContain('worker_documents');
  });

  it('worker AT sem linha em worker_documents → os 4 doc_* (identity, criminal_record, resume_cv, at_certificate)', async () => {
    const w = await makeWorkerWithCompleteRegistration('at-no-row', 'AT');
    const res = await api.get('/api/workers/me', { headers: { Authorization: `Bearer ${w.token}` } });

    expect(res.status).toBe(200);
    const missingFields: string[] = res.data.data.missingFields;
    expect(missingFields).toEqual(
      expect.arrayContaining([
        'doc_identity_document',
        'doc_criminal_record',
        'doc_resume_cv',
        'doc_at_certificate',
      ]),
    );
    expect(missingFields).not.toContain('worker_documents');
  });

  it('PUT /api/workers/me/general-info relê pelo MESMO caminho → resposta também traz doc_* expandidos', async () => {
    const w = await makeWorkerWithCompleteRegistration('put-partial', 'AT');
    await pool.query(
      `INSERT INTO worker_documents (worker_id, identity_document_url, criminal_record_url, resume_cv_url)
       VALUES ($1, 'http://e.com/id', 'http://e.com/cr', 'http://e.com/cv')`,
      [w.id],
    );
    // Escrita idempotente de um campo já preenchido — só para disparar o
    // caminho de "escrita confirmada" (readFreshProgress) sem mudar o cenário
    // de documentos montado acima.
    const res = await api.put(
      '/api/workers/me/general-info',
      { firstName: 'Alberto', lastName: 'Marquez' },
      { headers: { Authorization: `Bearer ${w.token}` } },
    );

    expect(res.status).toBe(200);
    const missingFields: string[] = res.data.data.missingFields;
    expect(missingFields).toContain('doc_at_certificate');
    expect(missingFields).not.toContain('worker_documents');
  });

  it('regressão — POST /api/worker-applications/track-channel (403) continua expandindo do MESMO jeito de antes', async () => {
    const w = await makeWorkerWithCompleteRegistration('track-channel-regression', 'AT');
    await pool.query(
      `INSERT INTO worker_documents (worker_id, identity_document_url, criminal_record_url)
       VALUES ($1, 'http://e.com/id', 'http://e.com/cr')`,
      [w.id],
    );
    const res = await api.post(
      '/api/worker-applications/track-channel',
      { jobPostingId, channel: 'facebook' },
      { headers: { Authorization: `Bearer ${w.token}` } },
    );

    expect(res.status).toBe(403);
    expect(res.data.code).toBe('WORKER_NOT_ELIGIBLE');
    expect(res.data.missingFields).toContain('doc_resume_cv');
    expect(res.data.missingFields).toContain('doc_at_certificate');
    expect(res.data.missingFields).not.toContain('worker_documents');
  });
});
