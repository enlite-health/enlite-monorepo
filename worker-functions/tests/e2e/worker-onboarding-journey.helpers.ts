/**
 * worker-onboarding-journey.helpers.ts
 *
 * Helpers reutilizáveis para o teste de jornada contínua de onboarding do worker.
 * Encapsula criação de worker, preenchimento incremental de INFO, service_area,
 * availability, documentos e limpeza completa de dados.
 *
 * NUNCA usa mock de banco — apenas banco real via endpoints HTTP + queries diretas
 * para assertions e cleanup.
 */

import { Pool } from 'pg';
import { AxiosInstance } from 'axios';
import { getMockToken } from './helpers';

// ── Tipos de domínio ────────────────────────────────────────────────────────

export interface JourneyWorker {
  id: string;
  authUid: string;
  email: string;
}

export interface JourneyVacancy {
  id: string;
  patientId: string;
}

export interface BlockedAttemptRow {
  worker_id: string;
  job_posting_id: string;
  blocked_reason_at_attempt: string;
  missing_fields_at_attempt: string[];
  attempt_count: number;
}

// ── Dados de info pessoal base (sem phone/documentNumber — devem ser únicos por worker) ─

const PERSONAL_INFO_BASE = {
  firstName: 'María',
  lastName: 'García',
  sex: 'FEMALE',
  gender: 'FEMALE',
  birthDate: '1990-05-15',
  documentType: 'DNI',
  languages: ['ES'],
  profession: 'CAREGIVER',
  knowledgeLevel: 'BASIC',
  titleCertificate: 'DEGREE',
  yearsExperience: '3-5',
  experienceTypes: ['TEA'],
  preferredTypes: ['TEA'],
  preferredAgeRange: ['CHILD'],
  termsAccepted: true,
  privacyAccepted: true,
} as const;

/** Gera info pessoal com phone e documentNumber únicos para evitar violação de constraint. */
export function makePersonalInfo(suffix: string): typeof PERSONAL_INFO_BASE & {
  phone: string;
  documentNumber: string;
} {
  // Phone: 11 dígitos após +549, usando os últimos 11 chars do suffix (numérico)
  const numSuffix = suffix.replace(/\D/g, '').slice(-8).padStart(8, '0');
  return {
    ...PERSONAL_INFO_BASE,
    phone: `+54911555${numSuffix}`,
    documentNumber: `321${numSuffix}`,
  };
}

export const COMPLETE_SERVICE_AREA = {
  address: 'Av. Corrientes 1234',
  serviceRadiusKm: 10,
  lat: -34.6037,
  lng: -58.3816,
  city: 'Buenos Aires',
  neighborhood: 'Centro',
} as const;

export const COMPLETE_AVAILABILITY = [
  { dayOfWeek: 1, startTime: '08:00', endTime: '18:00', crossesMidnight: false },
  { dayOfWeek: 3, startTime: '08:00', endTime: '18:00', crossesMidnight: false },
] as const;

// Documentos para worker CAREGIVER (não-AT): identity_front + criminal.
// identity_document_back é OPCIONAL desde migration 212 — incluído aqui
// apenas para validar que o upload de um doc opcional continua funcionando.
export const DOCS_NON_AT = {
  identity_document:      'gs://e2e-bucket/workers/test/identity_front.pdf',
  identity_document_back: 'gs://e2e-bucket/workers/test/identity_back.pdf', // opcional
  criminal_record:        'gs://e2e-bucket/workers/test/criminal_record.pdf',
} as const;

// Documentos para worker AT: os três acima + resume_cv + at_certificate
export const DOCS_AT_FULL = {
  ...DOCS_NON_AT,
  resume_cv:    'gs://e2e-bucket/workers/test/resume_cv.pdf',
  at_certificate: 'gs://e2e-bucket/workers/test/at_cert.pdf',
} as const;

// ── Criação de worker via API (/api/workers/init) ───────────────────────────

export async function createWorker(
  api: AxiosInstance,
  tag: string,
): Promise<JourneyWorker> {
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const authUid = `uid-journey-${tag}-${suffix}`;
  const email = `journey-${tag}-${suffix}@e2e.test`;

  const res = await api.post('/api/workers/init', {
    authUid,
    email,
    country: 'AR',
  });

  if (res.status !== 201 && res.status !== 200) {
    throw new Error(
      `createWorker: unexpected status ${res.status}: ${JSON.stringify(res.data)}`,
    );
  }

  const worker = res.data.data.worker as { id: string };

  return { id: worker.id, authUid, email };
}

// ── Token de worker ─────────────────────────────────────────────────────────

export async function getWorkerToken(
  api: AxiosInstance,
  worker: JourneyWorker,
): Promise<string> {
  return getMockToken(api, {
    uid: worker.authUid,
    email: worker.email,
    role: 'worker',
  });
}

// ── Salvar INFO pessoal via PUT /api/workers/me/general-info ────────────────

export async function savePersonalInfo(
  api: AxiosInstance,
  token: string,
  /** suffix único por worker para garantir phone/documentNumber únicos no banco */
  uniqueSuffix: string,
): Promise<void> {
  const payload = makePersonalInfo(uniqueSuffix);
  const res = await api.put('/api/workers/me/general-info', payload, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status !== 200) {
    throw new Error(
      `savePersonalInfo: unexpected status ${res.status}: ${JSON.stringify(res.data)}`,
    );
  }
}

// ── Salvar service_area via PUT /api/workers/me/service-area ────────────────

export async function saveServiceArea(
  api: AxiosInstance,
  token: string,
): Promise<void> {
  const res = await api.put('/api/workers/me/service-area', COMPLETE_SERVICE_AREA, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status !== 200) {
    throw new Error(
      `saveServiceArea: unexpected status ${res.status}: ${JSON.stringify(res.data)}`,
    );
  }
}

// ── Salvar availability via PUT /api/workers/me/availability ────────────────

export async function saveAvailability(
  api: AxiosInstance,
  token: string,
): Promise<void> {
  const res = await api.put(
    '/api/workers/me/availability',
    { availability: COMPLETE_AVAILABILITY },
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (res.status !== 200) {
    throw new Error(
      `saveAvailability: unexpected status ${res.status}: ${JSON.stringify(res.data)}`,
    );
  }
}

// ── Salvar documentos individualmente via POST /api/workers/me/documents/save ─

export async function saveDocuments(
  api: AxiosInstance,
  token: string,
  docs: Record<string, string>,
): Promise<void> {
  for (const [docType, filePath] of Object.entries(docs)) {
    const res = await api.post(
      '/api/workers/me/documents/save',
      { docType, filePath },
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (res.status !== 200) {
      throw new Error(
        `saveDocuments(${docType}): unexpected status ${res.status}: ${JSON.stringify(res.data)}`,
      );
    }
  }
}

// ── Tentar postular via POST /api/worker-applications/track-channel ─────────

export async function tryApply(
  api: AxiosInstance,
  token: string,
  vacancyId: string,
): Promise<{ status: number; data: Record<string, unknown> }> {
  // channel='facebook' é obrigatório por comportamento atual do Zod
  // (null e omissão são rejeitados por validação mesmo com nullable().default(null) no schema)
  const res = await api.post(
    '/api/worker-applications/track-channel',
    { jobPostingId: vacancyId, channel: 'facebook' },
    { headers: { Authorization: `Bearer ${token}` } },
  );
  return { status: res.status, data: res.data as Record<string, unknown> };
}

// ── Criar vaga de teste via SQL direto ──────────────────────────────────────

export async function createVacancyFixture(
  pool: Pool,
  tag: string,
): Promise<JourneyVacancy> {
  const clickupTaskId = `e2e-journey-${tag}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const { rows: pRows } = await pool.query<{ id: string }>(
    `INSERT INTO patients (clickup_task_id, first_name, last_name, country, status)
     VALUES ($1, $2, $3, 'AR', 'ACTIVE')
     RETURNING id`,
    [clickupTaskId, `JourneyPatient-${tag}`, 'E2E'],
  );
  const patientId = pRows[0].id;

  const caseNumber = Math.floor(Math.random() * 900000) + 99000;
  const { rows: vRows } = await pool.query<{ id: string }>(
    `INSERT INTO job_postings (title, country, status, patient_id, case_number)
     VALUES ($1, 'AR', 'SEARCHING', $2, $3)
     RETURNING id`,
    [`Vaga E2E Journey ${tag}`, patientId, caseNumber],
  );

  return { id: vRows[0].id, patientId };
}

// ── Ler worker_blocked_applications do banco ─────────────────────────────────

export async function getBlockedAttempt(
  pool: Pool,
  workerId: string,
  vacancyId: string,
): Promise<BlockedAttemptRow | null> {
  const { rows } = await pool.query<BlockedAttemptRow>(
    `SELECT worker_id, job_posting_id, blocked_reason_at_attempt,
            missing_fields_at_attempt, attempt_count
     FROM worker_blocked_applications
     WHERE worker_id = $1 AND job_posting_id = $2`,
    [workerId, vacancyId],
  );
  return rows[0] ?? null;
}

// ── Ler status do worker no banco ────────────────────────────────────────────

export async function getWorkerStatus(
  pool: Pool,
  workerId: string,
): Promise<string> {
  const { rows } = await pool.query<{ status: string }>(
    `SELECT status FROM workers WHERE id = $1`,
    [workerId],
  );
  if (rows.length === 0) throw new Error(`Worker ${workerId} not found`);
  return rows[0].status;
}

// ── Cleanup de todos os dados de um conjunto de workers e vagas ──────────────

export async function cleanupJourneyData(
  pool: Pool,
  workerIds: string[],
  vacancyIds: string[],
  patientIds: string[],
): Promise<void> {
  if (workerIds.length > 0) {
    await pool.query(
      `DELETE FROM worker_blocked_applications WHERE worker_id = ANY($1::uuid[])`,
      [workerIds],
    );
    await pool.query(
      `DELETE FROM worker_job_applications WHERE worker_id = ANY($1::uuid[])`,
      [workerIds],
    );
    await pool.query(
      `DELETE FROM encuadres WHERE worker_id = ANY($1::uuid[])`,
      [workerIds],
    );
    await pool.query(
      `DELETE FROM worker_documents WHERE worker_id = ANY($1::uuid[])`,
      [workerIds],
    );
    await pool.query(
      `DELETE FROM worker_service_areas WHERE worker_id = ANY($1::uuid[])`,
      [workerIds],
    );
    await pool.query(
      `DELETE FROM worker_availability WHERE worker_id = ANY($1::uuid[])`,
      [workerIds],
    );
    await pool.query(
      `DELETE FROM workers WHERE id = ANY($1::uuid[])`,
      [workerIds],
    );
  }
  if (vacancyIds.length > 0) {
    await pool.query(
      `DELETE FROM job_postings WHERE id = ANY($1::uuid[])`,
      [vacancyIds],
    );
  }
  if (patientIds.length > 0) {
    await pool.query(
      `DELETE FROM patients WHERE id = ANY($1::uuid[])`,
      [patientIds],
    );
  }
}
