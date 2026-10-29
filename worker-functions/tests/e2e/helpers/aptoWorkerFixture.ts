/**
 * aptoWorkerFixture.ts — spec 067: UM helper para semear um prestador no limiar de "apto"/"enviado" (fn_worker_is_apto).
 *
 * "Apto" = REGISTERED + cadastro completo + documentos obrigatórios VALIDADOS (a regra vive no SQL; este arquivo só
 * semeia a massa, não repete a regra). Dados SINTÉTICOS, sem PII.
 *
 *   validated   : documentos obrigatórios enviados E com a chave em document_validations → apto
 *   unvalidated : enviados, SEM validação → REGISTERED mas NÃO apto (Bloqueados)
 *   none        : cadastro completo, sem worker_documents → o dono diz incompleto
 */
import type { Pool } from 'pg';

export type AptoDocs = 'validated' | 'unvalidated' | 'none';

/** Modo passthrough do KMS nos testes (NODE_ENV=test): o "ciphertext" é o base64 do texto — assim o prestador também lê pela API (Worker). */
const enc = (plain: string): string => Buffer.from(plain, 'utf8').toString('base64');

const VALIDATION = { validated_by: 'qa@example.test', validated_at: '2026-10-22T00:00:00Z' };

/** Completa o cadastro de um prestador JÁ existente (UPDATE idempotente) e semeia área, disponibilidade e documentos. */
export async function completeWorkerProfile(pool: Pool, workerId: string, docs: AptoDocs = 'validated'): Promise<void> {
  await pool.query(
    `UPDATE workers SET
       phone = COALESCE(NULLIF(phone, ''), '+5411' || right(replace(id::text, '-', ''), 10)),
       profession = 'CAREGIVER', first_name_encrypted = $2, last_name_encrypted = $3, sex_encrypted = $4,
       gender_encrypted = $5, birth_date_encrypted = $6, document_number_encrypted = $7, document_type = 'DNI',
       languages_encrypted = $8, knowledge_level = 'BASIC', title_certificate = 'DEGREE', years_experience = '3-5',
       experience_types = ARRAY['TEA'], preferred_types = ARRAY['TEA'], preferred_age_range = ARRAY['CHILD']
     WHERE id = $1`,
    [workerId, enc('Ficticia'), enc('Teste'), enc('FEMALE'), enc('FEMALE'), enc('1990-01-01'), enc('12345678'), enc('["es"]')],
  );
  await pool.query(`DELETE FROM worker_service_areas WHERE worker_id = $1`, [workerId]);
  await pool.query(`INSERT INTO worker_service_areas (worker_id, address_line, radius_km) VALUES ($1, 'Av. Test 1', 5)`, [workerId]);
  await pool.query(`DELETE FROM worker_availability WHERE worker_id = $1`, [workerId]);
  await pool.query(
    `INSERT INTO worker_availability (worker_id, day_of_week, start_time, end_time, timezone)
     VALUES ($1, 1, '08:00', '18:00', 'America/Argentina/Buenos_Aires')`,
    [workerId],
  );
  await pool.query(`DELETE FROM worker_documents WHERE worker_id = $1`, [workerId]);
  if (docs === 'none') return;
  const validations =
    docs === 'validated' ? { identity_document: VALIDATION, criminal_record: VALIDATION } : {};
  await pool.query(
    `INSERT INTO worker_documents (worker_id, identity_document_url, criminal_record_url, document_validations)
     VALUES ($1, 'http://e.example.test/id', 'http://e.example.test/cr', $2::jsonb)`,
    [workerId, JSON.stringify(validations)],
  );
}

/** Limpeza dos filhos que o helper cria (o DELETE do worker não os leva em todos os esquemas). */
export async function cleanWorkerProfile(pool: Pool, workerIds: string[]): Promise<void> {
  if (workerIds.length === 0) return;
  await pool.query(`DELETE FROM worker_documents WHERE worker_id = ANY($1::uuid[])`, [workerIds]);
  await pool.query(`DELETE FROM worker_availability WHERE worker_id = ANY($1::uuid[])`, [workerIds]);
  await pool.query(`DELETE FROM worker_service_areas WHERE worker_id = ANY($1::uuid[])`, [workerIds]);
}
