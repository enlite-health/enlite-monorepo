/**
 * fn-worker-missing-fields.integration.test.ts
 *
 * Testes de integração com banco REAL para fn_worker_missing_fields().
 *
 * Cobre TODAS as branches da função SQL (migration 209):
 *   - worker inexistente → ["worker_not_found"]
 *   - worker mesclado (merged_into_id != null) → ["worker_not_found"]
 *   - cada grupo de campo pessoal faltando (first_name, phone, etc.)
 *   - worker_service_areas ausente
 *   - worker_availability ausente
 *   - worker_documents: não-AT com básicos incompletos
 *   - worker_documents: AT sem resume_cv e at_certificate
 *   - worker_documents: não-AT com básicos completos → NÃO falta
 *   - worker_documents: AT com todos obrigatórios → NÃO falta
 *   - worker completo → [] (elegível)
 *
 * Não usa API — acessa pool diretamente.
 */

import { Pool } from 'pg';

const DATABASE_URL =
  process.env.DATABASE_URL ||
  'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

const pool = new Pool({ connectionString: DATABASE_URL });

const SUFFIX = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const ALL_WORKER_IDS: string[] = [];

// ── Helpers ────────────────────────────────────────────────────────────

async function makeWorker(
  status: 'INCOMPLETE_REGISTER' | 'DISABLED' | 'REGISTERED',
  tag: string,
  profession?: string,
): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    profession
      ? `INSERT INTO workers (auth_uid, email, status, country, timezone, profession)
         VALUES ($1, $2, $3, 'AR', 'America/Argentina/Buenos_Aires', $4) RETURNING id`
      : `INSERT INTO workers (auth_uid, email, status, country, timezone)
         VALUES ($1, $2, $3, 'AR', 'America/Argentina/Buenos_Aires') RETURNING id`,
    profession
      ? [`uid-fn-${SUFFIX}-${tag}`, `fn-${SUFFIX}-${tag}@fn.test`, status, profession]
      : [`uid-fn-${SUFFIX}-${tag}`, `fn-${SUFFIX}-${tag}@fn.test`, status],
  );
  ALL_WORKER_IDS.push(rows[0].id);
  return rows[0].id;
}

async function callFn(workerId: string): Promise<string[]> {
  const { rows } = await pool.query<{ result: unknown }>(
    `SELECT fn_worker_missing_fields($1::uuid) AS result`,
    [workerId],
  );
  const raw = rows[0]?.result;
  if (Array.isArray(raw)) return raw as string[];
  if (typeof raw === 'string') return JSON.parse(raw) as string[];
  return [];
}

// ── Teardown ───────────────────────────────────────────────────────────

afterAll(async () => {
  if (ALL_WORKER_IDS.length) {
    await pool.query(`DELETE FROM worker_service_areas WHERE worker_id = ANY($1::uuid[])`, [ALL_WORKER_IDS]);
    await pool.query(`DELETE FROM worker_availability WHERE worker_id = ANY($1::uuid[])`, [ALL_WORKER_IDS]);
    await pool.query(`DELETE FROM worker_documents WHERE worker_id = ANY($1::uuid[])`, [ALL_WORKER_IDS]);
    await pool.query(`DELETE FROM workers WHERE id = ANY($1::uuid[])`, [ALL_WORKER_IDS]);
  }
  await pool.end();
});

// ── Tests ──────────────────────────────────────────────────────────────

describe('fn_worker_missing_fields — branches SQL (banco real)', () => {
  it('worker inexistente → ["worker_not_found"]', async () => {
    const result = await callFn('00000000-0000-0000-0000-000000000004');
    expect(result).toEqual(['worker_not_found']);
  });

  it('worker mesclado (merged_into_id != null) → contém "worker_not_found"', async () => {
    const w1 = await makeWorker('REGISTERED', 'merged-1');
    const w2 = await makeWorker('REGISTERED', 'merged-2');

    await pool.query(`UPDATE workers SET merged_into_id = $1 WHERE id = $2`, [w2, w1]);
    const result = await callFn(w1);
    await pool.query(`UPDATE workers SET merged_into_id = NULL WHERE id = $1`, [w1]);

    expect(result).toContain('worker_not_found');
  });

  it('worker sem first_name_encrypted → inclui "first_name"', async () => {
    const workerId = await makeWorker('INCOMPLETE_REGISTER', 'no-fname');
    expect(await callFn(workerId)).toContain('first_name');
  });

  it('worker sem phone → inclui "phone"', async () => {
    const workerId = await makeWorker('INCOMPLETE_REGISTER', 'no-phone');
    expect(await callFn(workerId)).toContain('phone');
  });

  it('worker sem worker_service_areas → inclui "worker_service_areas"', async () => {
    const workerId = await makeWorker('INCOMPLETE_REGISTER', 'no-sa');
    expect(await callFn(workerId)).toContain('worker_service_areas');
  });

  it('worker sem worker_availability → inclui "worker_availability"', async () => {
    const workerId = await makeWorker('INCOMPLETE_REGISTER', 'no-av');
    expect(await callFn(workerId)).toContain('worker_availability');
  });

  it('worker sem worker_documents → inclui "worker_documents"', async () => {
    const workerId = await makeWorker('INCOMPLETE_REGISTER', 'no-docs');
    expect(await callFn(workerId)).toContain('worker_documents');
  });

  it('AT com apenas documentos básicos (sem resume_cv + at_certificate) → inclui "worker_documents"', async () => {
    const workerId = await makeWorker('INCOMPLETE_REGISTER', 'at-no-extra', 'AT');

    await pool.query(
      `INSERT INTO worker_documents (worker_id, identity_document_url, identity_document_back_url, criminal_record_url)
       VALUES ($1, 'http://e.com/id', 'http://e.com/id-back', 'http://e.com/cr')`,
      [workerId],
    );

    expect(await callFn(workerId)).toContain('worker_documents');
  });

  it('não-AT com documentos básicos completos → NÃO inclui "worker_documents"', async () => {
    const workerId = await makeWorker('REGISTERED', 'caregiver-docs', 'CAREGIVER');

    await pool.query(
      `INSERT INTO worker_documents (worker_id, identity_document_url, identity_document_back_url, criminal_record_url)
       VALUES ($1, 'http://e.com/id', 'http://e.com/id-back', 'http://e.com/cr')`,
      [workerId],
    );

    expect(await callFn(workerId)).not.toContain('worker_documents');
  });

  it('AT com todos os documentos obrigatórios → NÃO inclui "worker_documents"', async () => {
    const workerId = await makeWorker('REGISTERED', 'at-all-docs', 'AT');

    await pool.query(
      `INSERT INTO worker_documents
         (worker_id, identity_document_url, identity_document_back_url,
          criminal_record_url, resume_cv_url, at_certificate_url)
       VALUES ($1, 'http://e.com/id', 'http://e.com/id-back', 'http://e.com/cr',
               'http://e.com/cv', 'http://e.com/cert')`,
      [workerId],
    );

    expect(await callFn(workerId)).not.toContain('worker_documents');
  });

  it('worker com TODOS os campos preenchidos → [] (elegível)', async () => {
    const workerId = await makeWorker('REGISTERED', 'complete', 'CAREGIVER');

    await pool.query(
      `UPDATE workers SET
         first_name_encrypted      = 'enc-fname',
         last_name_encrypted       = 'enc-lname',
         sex_encrypted             = 'enc-sex',
         gender_encrypted          = 'enc-gender',
         birth_date_encrypted      = 'enc-bd',
         document_number_encrypted = 'enc-doc',
         document_type             = 'DNI',
         languages_encrypted       = 'enc-lang',
         phone                     = '+5411999999999',
         knowledge_level           = 'BASIC',
         title_certificate         = 'DEGREE',
         years_experience          = '3-5',
         experience_types          = ARRAY['TEA','TLP'],
         preferred_types           = ARRAY['TEA'],
         preferred_age_range       = ARRAY['CHILD']
       WHERE id = $1`,
      [workerId],
    );

    await pool.query(
      `INSERT INTO worker_service_areas (worker_id, address_line, radius_km)
       VALUES ($1, 'Av. Corrientes 1234', 10)`,
      [workerId],
    );

    await pool.query(
      `INSERT INTO worker_availability (worker_id, day_of_week, start_time, end_time, timezone)
       VALUES ($1, 1, '08:00', '18:00', 'America/Argentina/Buenos_Aires')`,
      [workerId],
    );

    await pool.query(
      `INSERT INTO worker_documents
         (worker_id, identity_document_url, identity_document_back_url, criminal_record_url)
       VALUES ($1, 'http://e.com/id', 'http://e.com/id-back', 'http://e.com/cr')`,
      [workerId],
    );

    expect(await callFn(workerId)).toEqual([]);
  });
});
