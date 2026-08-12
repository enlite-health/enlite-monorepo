/**
 * admin-dedup-center.e2e.test.ts
 *
 * Testes E2E do Centro de Duplicados contra Postgres + API reais (Docker local).
 *
 * Cobertos:
 *   1. GET  /api/admin/dedup/groups         → lista grupos não dispensados
 *   2. GET  /api/admin/dedup/groups/:phone  → detalhe do grupo com preview
 *   3. POST /api/admin/dedup/dismiss        → dispensa persiste; idempotente
 *   4. POST /api/admin/dedup/merge          → merge via endpoint, snapshot criado
 *      FK seed: worker_status_history (reparent UPDATE) + worker_availability (upsert_delete)
 *      Asserts via SELECT: audit content, reparent de WJA, snapshot criado
 *   5. POST /api/admin/dedup/merges/:id/undo → roundtrip: merge → undo → estado restaurado
 *      Asserts via SELECT: merged_into_id=NULL, FK restored, undone_at preenchido
 *   6. GET  /api/admin/dedup/history        → can_undo=true após merge, false após undo
 *   7. Gate admin:
 *      - 403 para não-admin em todos os endpoints
 *      - Recruiter também leva 403
 *   8. DISMISS: asserts via SELECT em dedup_dismissed (gravação real no banco)
 *
 * Pré-requisito: Docker stack em pé (make test-integration ou npm run test:e2e:docker).
 */

import { Pool } from 'pg';
import { createApiClient, getMockToken, waitForBackend } from './helpers';
import type { AxiosInstance } from 'axios';

const DATABASE_URL =
  process.env.DATABASE_URL ||
  'postgresql://enlite_admin:enlite_password@localhost:5433/enlite_e2e';

const STAMP = `dedup_e2e_${Date.now()}`;

// ── Helpers de seed ────────────────────────────────────────────────────────────

async function insertWorker(
  pool: Pool,
  params: {
    id: string;
    auth_uid: string;
    email: string;
    phone: string;
    profession?: string | null;
  },
): Promise<void> {
  await pool.query(
    `INSERT INTO workers (id, auth_uid, email, phone, status, country, created_at, updated_at)
     VALUES ($1::uuid, $2, $3, $4, 'INCOMPLETE_REGISTER', 'AR', NOW(), NOW())`,
    [params.id, params.auth_uid, params.email, params.phone],
  );

  if (params.profession) {
    await pool.query(
      `UPDATE workers SET profession = $1 WHERE id = $2::uuid`,
      [params.profession, params.id],
    );
  }
}

async function seedCollision(
  pool: Pool,
  phoneNormalized: string,
  workerIds: string[],
): Promise<void> {
  await pool.query(
    `INSERT INTO worker_phone_collisions (phone_normalized, worker_ids, worker_count)
     VALUES ($1, $2::uuid[], $3)
     ON CONFLICT (phone_normalized) DO NOTHING`,
    [phoneNormalized, workerIds, workerIds.length],
  );
}

// ── Setup / teardown ──────────────────────────────────────────────────────────

let pool: Pool;
let api: AxiosInstance;
let adminToken: string;
let recruiterToken: string;
let workerToken: string;

// IDs semeados
const seededWorkerIds: string[] = [];
const seededPhones: string[] = [];

// Dados do cenário de merge/undo
const mergeGroup = {
  survivorId: `aaaa0001-0001-0001-0001-${STAMP.slice(-12)}`,
  absorbedId: `aaaa0002-0002-0002-0002-${STAMP.slice(-12)}`,
  phoneNorm: `549100${STAMP.slice(-7)}`,
  phoneSurvivor: `100${STAMP.slice(-7)}`,      // 10 dígitos → phone_normalized = 549100...
  phoneAbsorbed:  `54100${STAMP.slice(-7)}`,   // 12 dígitos → mesmo phone_normalized
};

// Dados do cenário de dismiss
const dismissGroup = {
  survivorId: `bbbb0001-0001-0001-0001-${STAMP.slice(-12)}`,
  absorbedId: `bbbb0002-0002-0002-0002-${STAMP.slice(-12)}`,
  phoneNorm: `549200${STAMP.slice(-7)}`,
  phoneSurvivor: `200${STAMP.slice(-7)}`,
  phoneAbsorbed:  `54200${STAMP.slice(-7)}`,
};

// Cenário de merge com choice de campo ENCRIPTADO (modo avançado).
// Survivor e absorbed têm first_name_encrypted distintos; o admin escolhe o do
// absorbed → o ciphertext do absorbed deve vencer no survivor após o merge.
const encChoiceGroup = {
  survivorId: `cccc0001-0001-0001-0001-${STAMP.slice(-12)}`,
  absorbedId: `cccc0002-0002-0002-0002-${STAMP.slice(-12)}`,
  phoneNorm: `549400${STAMP.slice(-7)}`,
  phoneSurvivor: `400${STAMP.slice(-7)}`,
  phoneAbsorbed:  `54400${STAMP.slice(-7)}`,
  survivorFirstName: 'SurvivorName',
  absorbedFirstName: 'AbsorbedName',
};

// Cenário de regressão (bug de prod 23514): merge cujo PRINCIPAL está
// INCOMPLETE_REGISTER e o absorvido tem worker_job_applications com source='manual'.
// O reparent da WJA dispara trg_enforce_worker_registered; sem o bypass (mig 229) o
// merge inteiro faz ROLLBACK e o operador vê "Erro interno".
const guardGroup = {
  survivorId: `dddd0001-0001-0001-0001-${STAMP.slice(-12)}`,
  absorbedId: `dddd0002-0002-0002-0002-${STAMP.slice(-12)}`,
  phoneNorm: `549500${STAMP.slice(-7)}`,
  phoneSurvivor: `500${STAMP.slice(-7)}`,
  phoneAbsorbed: `54500${STAMP.slice(-7)}`,
  jobPostingId: '',
};

// Cenário de regressão (bug de prod 23514 / check_document_type_required): principal
// SEM documento; absorvido COM document_number + document_type. O COALESCE precisa herdar
// document_type junto com o número, senão o principal fica com número sem tipo → viola a
// constraint check_document_type_required (mig 026) e o merge faz ROLLBACK ("Erro interno").
const docTypeGroup = {
  survivorId: `eeee0001-0001-0001-0001-${STAMP.slice(-12)}`,
  absorbedId: `eeee0002-0002-0002-0002-${STAMP.slice(-12)}`,
  phoneNorm: `549600${STAMP.slice(-7)}`,
  phoneSurvivor: `600${STAMP.slice(-7)}`,
  phoneAbsorbed: `54600${STAMP.slice(-7)}`,
};

// Em modo passthrough (USE_KMS_ENCRYPTION=false no docker de e2e) o "ciphertext"
// é só base64 do plaintext — espelha KMSEncryptionService.encrypt/decrypt.
function fakeCiphertext(plaintext: string): string {
  return Buffer.from(plaintext, 'utf8').toString('base64');
}

beforeAll(async () => {
  api = createApiClient();
  await waitForBackend(api);

  pool = new Pool({ connectionString: DATABASE_URL });

  // Tokens
  adminToken = await getMockToken(api, {
    uid: `dedup-admin-${STAMP}`,
    email: `dedup-admin-${STAMP}@e2e.local`,
    role: 'admin',
  });

  recruiterToken = await getMockToken(api, {
    uid: `dedup-recruiter-${STAMP}`,
    email: `dedup-recruiter-${STAMP}@e2e.local`,
    role: 'recruiter',
  });

  workerToken = await getMockToken(api, {
    uid: `dedup-worker-${STAMP}`,
    email: `dedup-worker-${STAMP}@enlite.import`,
    role: 'worker',
  });

  // Remove índice único temporariamente para semear duplicados
  await pool.query(`DROP INDEX IF EXISTS idx_workers_phone_normalized_unique`);

  // ── Cenário 1: grupo para merge + undo ──────────────────────────────────────
  await insertWorker(pool, {
    id: mergeGroup.survivorId,
    auth_uid: `FirebaseSurvivor_${STAMP}`,
    email: `survivor_${STAMP}@example.com`,
    phone: mergeGroup.phoneSurvivor,
    profession: 'AT',
  });

  await insertWorker(pool, {
    id: mergeGroup.absorbedId,
    auth_uid: `base1import_absorbed_${STAMP}`,
    email: `absorbed_${STAMP}@enlite.import`,
    phone: mergeGroup.phoneAbsorbed,
  });

  await seedCollision(pool, mergeGroup.phoneNorm, [mergeGroup.survivorId, mergeGroup.absorbedId]);
  seededWorkerIds.push(mergeGroup.survivorId, mergeGroup.absorbedId);
  seededPhones.push(mergeGroup.phoneNorm);

  // ── Seed FK no absorvido: reparent (worker_status_history, strategy=update) ─
  // INSERT linha em worker_status_history para o absorvido (sem unique em worker_id)
  await pool.query(
    `INSERT INTO worker_status_history (worker_id, field_name, old_value, new_value, change_source)
     VALUES ($1::uuid, 'status', NULL, 'INCOMPLETE_REGISTER', 'e2e_seed_${STAMP}')`,
    [mergeGroup.absorbedId],
  );

  // ── Seed FK no absorvido: upsert_delete (worker_availability, UNIQUE(worker_id, day_of_week, start_time, end_time)) ─
  // Sem conflito com survivor (survivor não tem essa disponibilidade)
  await pool.query(
    `INSERT INTO worker_availability (worker_id, day_of_week, start_time, end_time, timezone)
     VALUES ($1::uuid, 1, '08:00', '12:00', 'America/Buenos_Aires')`,
    [mergeGroup.absorbedId],
  );

  // ── PII encriptada distinta nos 2 (p/ assert de decrypt no detalhe) ─────────
  await pool.query(
    `UPDATE workers SET first_name_encrypted = $1, sex_encrypted = $2 WHERE id = $3::uuid`,
    [fakeCiphertext('SurvivorFirst'), fakeCiphertext('MALE'), mergeGroup.survivorId],
  );
  await pool.query(
    `UPDATE workers SET first_name_encrypted = $1, sex_encrypted = $2 WHERE id = $3::uuid`,
    [fakeCiphertext('AbsorbedFirst'), fakeCiphertext('FEMALE'), mergeGroup.absorbedId],
  );

  // ── Cenário 3: merge com choice de campo encriptado ─────────────────────────
  await insertWorker(pool, {
    id: encChoiceGroup.survivorId,
    auth_uid: `EncSurvivor_${STAMP}`,
    email: `enc_sv_${STAMP}@example.com`,
    phone: encChoiceGroup.phoneSurvivor,
  });
  await insertWorker(pool, {
    id: encChoiceGroup.absorbedId,
    auth_uid: `EncAbsorbed_${STAMP}`,
    email: `enc_abs_${STAMP}@example.com`,
    phone: encChoiceGroup.phoneAbsorbed,
  });
  await pool.query(
    `UPDATE workers SET first_name_encrypted = $1 WHERE id = $2::uuid`,
    [fakeCiphertext(encChoiceGroup.survivorFirstName), encChoiceGroup.survivorId],
  );
  await pool.query(
    `UPDATE workers SET first_name_encrypted = $1 WHERE id = $2::uuid`,
    [fakeCiphertext(encChoiceGroup.absorbedFirstName), encChoiceGroup.absorbedId],
  );
  await seedCollision(pool, encChoiceGroup.phoneNorm, [encChoiceGroup.survivorId, encChoiceGroup.absorbedId]);
  seededWorkerIds.push(encChoiceGroup.survivorId, encChoiceGroup.absorbedId);
  seededPhones.push(encChoiceGroup.phoneNorm);

  // ── Cenário 2: grupo para dismiss ───────────────────────────────────────────
  await insertWorker(pool, {
    id: dismissGroup.survivorId,
    auth_uid: `DismissSurvivor_${STAMP}`,
    email: `dismiss_sv_${STAMP}@example.com`,
    phone: dismissGroup.phoneSurvivor,
  });

  await insertWorker(pool, {
    id: dismissGroup.absorbedId,
    auth_uid: `DismissAbsorbed_${STAMP}`,
    email: `dismiss_abs_${STAMP}@example.com`,
    phone: dismissGroup.phoneAbsorbed,
  });

  await seedCollision(pool, dismissGroup.phoneNorm, [dismissGroup.survivorId, dismissGroup.absorbedId]);
  seededWorkerIds.push(dismissGroup.survivorId, dismissGroup.absorbedId);
  seededPhones.push(dismissGroup.phoneNorm);

  // ── Cenário 4: regressão do guard (mig 229) ─────────────────────────────────
  // Principal Firebase real porém INCOMPLETE_REGISTER; absorvido com WJA source='manual'.
  await insertWorker(pool, {
    id: guardGroup.survivorId,
    auth_uid: `FirebaseGuardSurvivor_${STAMP}`,
    email: `guard_sv_${STAMP}@example.com`,
    phone: guardGroup.phoneSurvivor,
  });
  await insertWorker(pool, {
    id: guardGroup.absorbedId,
    auth_uid: `guard_absorbed_${STAMP}`,
    email: `guard_abs_${STAMP}@enlite.import`,
    phone: guardGroup.phoneAbsorbed,
  });

  // job_posting mínimo (patient_id nullable — vaga órfã)
  const jp = await pool.query<{ id: string }>(
    `INSERT INTO job_postings (title, description, country, status)
     VALUES ('Vaga E2E dedup guard', 'desc', 'AR', 'SEARCHING')
     RETURNING id`,
  );
  guardGroup.jobPostingId = jp.rows[0].id;

  // Semeia a WJA manual no absorvido INCOMPLETE sem acionar o guard no seed:
  // INSERT com source bypass ('talentum'), depois UPDATE só de `source` — coluna
  // FORA da lista do trigger (worker_id, job_posting_id, application_funnel_stage).
  await pool.query(
    `INSERT INTO worker_job_applications (worker_id, job_posting_id, application_funnel_stage, source)
     VALUES ($1::uuid, $2::uuid, 'INITIATED', 'talentum')`,
    [guardGroup.absorbedId, guardGroup.jobPostingId],
  );
  await pool.query(
    `UPDATE worker_job_applications SET source = 'manual'
     WHERE worker_id = $1::uuid AND job_posting_id = $2::uuid`,
    [guardGroup.absorbedId, guardGroup.jobPostingId],
  );

  await seedCollision(pool, guardGroup.phoneNorm, [guardGroup.survivorId, guardGroup.absorbedId]);
  seededWorkerIds.push(guardGroup.survivorId, guardGroup.absorbedId);
  seededPhones.push(guardGroup.phoneNorm);

  // ── Cenário 5: regressão check_document_type_required ───────────────────────
  // Principal sem documento; absorvido com número + tipo (linha self-consistente).
  await insertWorker(pool, {
    id: docTypeGroup.survivorId,
    auth_uid: `FirebaseDocSurvivor_${STAMP}`,
    email: `doc_sv_${STAMP}@example.com`,
    phone: docTypeGroup.phoneSurvivor,
  });
  await insertWorker(pool, {
    id: docTypeGroup.absorbedId,
    auth_uid: `doc_absorbed_${STAMP}`,
    email: `doc_abs_${STAMP}@enlite.import`,
    phone: docTypeGroup.phoneAbsorbed,
  });
  // Absorvido: número + tipo juntos (satisfaz a constraint na própria linha).
  await pool.query(
    `UPDATE workers SET document_number_encrypted = $1, document_type = 'DNI' WHERE id = $2::uuid`,
    [fakeCiphertext('20304050'), docTypeGroup.absorbedId],
  );
  await seedCollision(pool, docTypeGroup.phoneNorm, [docTypeGroup.survivorId, docTypeGroup.absorbedId]);
  seededWorkerIds.push(docTypeGroup.survivorId, docTypeGroup.absorbedId);
  seededPhones.push(docTypeGroup.phoneNorm);
});

afterAll(async () => {
  if (!pool) return;

  // Limpeza na ordem correta (FK constraints)
  await pool.query(
    `DELETE FROM worker_merge_snapshots
     WHERE absorbed_worker_id = ANY($1::uuid[])`,
    [seededWorkerIds],
  ).catch(() => {});

  await pool.query(
    `DELETE FROM worker_merge_audit
     WHERE survivor_id = ANY($1::uuid[]) OR absorbed_id = ANY($1::uuid[])`,
    [seededWorkerIds],
  ).catch(() => {});

  await pool.query(
    `DELETE FROM dedup_dismissed WHERE phone_normalized = ANY($1)`,
    [seededPhones],
  ).catch(() => {});

  await pool.query(
    `DELETE FROM worker_phone_collisions WHERE phone_normalized = ANY($1)`,
    [seededPhones],
  ).catch(() => {});

  await pool.query(
    `DELETE FROM worker_availability WHERE worker_id = ANY($1::uuid[])`,
    [seededWorkerIds],
  ).catch(() => {});

  await pool.query(
    `DELETE FROM worker_status_history WHERE worker_id = ANY($1::uuid[]) AND change_source LIKE 'e2e_seed_%'`,
    [seededWorkerIds],
  ).catch(() => {});

  await pool.query(
    `DELETE FROM worker_job_applications WHERE worker_id = ANY($1::uuid[])`,
    [seededWorkerIds],
  ).catch(() => {});

  await pool.query(
    `DELETE FROM workers WHERE id = ANY($1::uuid[])`,
    [seededWorkerIds],
  ).catch(() => {});

  if (guardGroup.jobPostingId) {
    await pool.query(
      `DELETE FROM job_postings WHERE id = $1::uuid`,
      [guardGroup.jobPostingId],
    ).catch(() => {});
  }

  // Garante que o índice único não vaza para outras suítes (self-contained)
  // A migration 222 está deferida em prod — o índice não existe por migration no conjunto atual.
  await pool.query(`DROP INDEX IF EXISTS idx_workers_phone_normalized_unique`).catch(() => {});

  await pool.end();
});

// ── 1. Gate admin: 403 para não-admin ────────────────────────────────────────

describe('Gate ADMIN — 403 para não-admin', () => {
  const endpoints = [
    { method: 'get',  path: '/api/admin/dedup/groups',  isGet: true  },
    { method: 'get',  path: '/api/admin/dedup/history', isGet: true  },
    { method: 'post', path: '/api/admin/dedup/merge',   isGet: false, body: { survivorId: 'x', absorbedIds: ['y'] } },
    { method: 'post', path: '/api/admin/dedup/dismiss', isGet: false, body: { phoneNormalized: 'x' } },
    { method: 'post', path: '/api/admin/dedup/merges/1/undo', isGet: false },
  ];

  async function callWithToken(method: string, path: string, isGet: boolean, body: unknown, token: string): Promise<{ status: number }> {
    const headers = { Authorization: `Bearer ${token}` };
    if (isGet) {
      return api.get(path, { headers });
    }
    return api.post(path, body ?? {}, { headers });
  }

  for (const { method, path, isGet, body } of endpoints) {
    it(`recruiter → 403 em ${method.toUpperCase()} ${path}`, async () => {
      const res = await callWithToken(method, path, isGet ?? false, body, recruiterToken);
      expect(res.status).toBe(403);
    });

    it(`worker → 403 em ${method.toUpperCase()} ${path}`, async () => {
      const res = await callWithToken(method, path, isGet ?? false, body, workerToken);
      expect(res.status).toBe(403);
    });
  }
});

// ── 2. GET /api/admin/dedup/groups ────────────────────────────────────────────

describe('GET /api/admin/dedup/groups', () => {
  it('retorna 200 com array de grupos', async () => {
    const res = await api.get('/api/admin/dedup/groups', {
      headers: { Authorization: `Bearer ${adminToken}` },
    });

    expect(res.status).toBe(200);
    expect(res.data.success).toBe(true);
    expect(Array.isArray(res.data.data)).toBe(true);
  });

  it('inclui o grupo de merge semeado', async () => {
    const res = await api.get('/api/admin/dedup/groups', {
      headers: { Authorization: `Bearer ${adminToken}` },
    });

    const groups = res.data.data as Array<{ phone_normalized: string }>;
    const found = groups.find(g => g.phone_normalized === mergeGroup.phoneNorm);
    expect(found).toBeDefined();
  });

  it('não inclui grupo dispensado', async () => {
    // Dispensa o grupo
    await api.post('/api/admin/dedup/dismiss',
      { phoneNormalized: dismissGroup.phoneNorm },
      { headers: { Authorization: `Bearer ${adminToken}` } },
    );

    const res = await api.get('/api/admin/dedup/groups', {
      headers: { Authorization: `Bearer ${adminToken}` },
    });

    const groups = res.data.data as Array<{ phone_normalized: string }>;
    const found = groups.find(g => g.phone_normalized === dismissGroup.phoneNorm);
    expect(found).toBeUndefined();
  });
});

// ── 3. GET /api/admin/dedup/groups/:phoneNormalized ───────────────────────────

describe('GET /api/admin/dedup/groups/:phoneNormalized', () => {
  it('retorna 200 com detalhe do grupo', async () => {
    const res = await api.get(`/api/admin/dedup/groups/${mergeGroup.phoneNorm}`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });

    expect(res.status).toBe(200);
    expect(res.data.success).toBe(true);
    expect(res.data.data.phone_normalized).toBe(mergeGroup.phoneNorm);
    expect(Array.isArray(res.data.data.accounts)).toBe(true);
    expect(res.data.data.accounts.length).toBeGreaterThanOrEqual(2);

    // Contrato consumido pelo frontend (PLURAL) — guarda contra a regressão do crash.
    expect(Array.isArray(res.data.data.field_comparisons)).toBe(true);
    expect(Array.isArray(res.data.data.reparent_preview)).toBe(true);
    expect(typeof res.data.data.survivor_suggested).toBe('string');
    expect(res.data.data.survivor_suggested.length).toBeGreaterThan(0);
    // chave singular antiga não deve existir
    expect(res.data.data.field_comparison).toBeUndefined();
  });

  it('contas têm tier classificado corretamente', async () => {
    const res = await api.get(`/api/admin/dedup/groups/${mergeGroup.phoneNorm}`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });

    const accounts = res.data.data.accounts as Array<{ tier: number; login_real: boolean; id: string }>;
    const survivor = accounts.find(a => a.id === mergeGroup.survivorId);
    const absorbed = accounts.find(a => a.id === mergeGroup.absorbedId);

    expect(survivor?.tier).toBe(1);        // Firebase real
    expect(survivor?.login_real).toBe(true);
    expect(absorbed?.tier).toBe(3);        // sintético base1import_
    expect(absorbed?.login_real).toBe(false);
  });

  it('DECRIPTA campos encriptados no comparativo (admin-only) — valor real, is_encrypted=true', async () => {
    const res = await api.get(`/api/admin/dedup/groups/${mergeGroup.phoneNorm}`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });

    type FC = {
      field: string;
      values: Record<string, string | null>;
      is_encrypted: boolean;
      has_conflict: boolean;
    };
    const comparisons = res.data.data.field_comparisons as FC[];

    const firstName = comparisons.find(c => c.field === 'first_name_encrypted');
    expect(firstName).toBeDefined();
    // Continua marcado como sensível, mas agora COM valor decriptado.
    expect(firstName?.is_encrypted).toBe(true);
    expect(firstName?.values[mergeGroup.survivorId]).toBe('SurvivorFirst');
    expect(firstName?.values[mergeGroup.absorbedId]).toBe('AbsorbedFirst');
    // Valores distintos → conflito detectado sobre o PLAINTEXT.
    expect(firstName?.has_conflict).toBe(true);

    // sex_encrypted retorna o valor canônico (a UI traduz via i18n).
    const sex = comparisons.find(c => c.field === 'sex_encrypted');
    expect(sex?.is_encrypted).toBe(true);
    expect(sex?.values[mergeGroup.survivorId]).toBe('MALE');
    expect(sex?.values[mergeGroup.absorbedId]).toBe('FEMALE');

    // Garantia de que NÃO vaza o ciphertext base64 cru.
    expect(firstName?.values[mergeGroup.survivorId]).not.toBe(
      Buffer.from('SurvivorFirst', 'utf8').toString('base64'),
    );
  });

  it('retorna 404 para phone não existente', async () => {
    const res = await api.get('/api/admin/dedup/groups/999999999999999', {
      headers: { Authorization: `Bearer ${adminToken}` },
    });

    expect(res.status).toBe(404);
  });
});

// ── 4. POST /api/admin/dedup/dismiss ─────────────────────────────────────────

describe('POST /api/admin/dedup/dismiss', () => {
  const dismissPhone = `549300${STAMP.slice(-7)}`;

  it('dispensa um grupo e retorna alreadyDismissed=false', async () => {
    const res = await api.post('/api/admin/dedup/dismiss',
      { phoneNormalized: dismissPhone, reason: 'numero de empresa' },
      { headers: { Authorization: `Bearer ${adminToken}` } },
    );

    expect(res.status).toBe(200);
    expect(res.data.success).toBe(true);
    expect(res.data.data.alreadyDismissed).toBe(false);
  });

  it('persiste no banco: SELECT em dedup_dismissed retorna 1 linha', async () => {
    const { rows } = await pool.query<{ id: number }>(
      `SELECT id FROM dedup_dismissed WHERE phone_normalized = $1`,
      [dismissPhone],
    );

    expect(rows.length).toBe(1);
  });

  it('idempotente: segunda dispensa retorna alreadyDismissed=true', async () => {
    const res = await api.post('/api/admin/dedup/dismiss',
      { phoneNormalized: dismissPhone },
      { headers: { Authorization: `Bearer ${adminToken}` } },
    );

    expect(res.status).toBe(200);
    expect(res.data.data.alreadyDismissed).toBe(true);
  });

  it('retorna 400 sem phoneNormalized', async () => {
    const res = await api.post('/api/admin/dedup/dismiss',
      {},
      { headers: { Authorization: `Bearer ${adminToken}` } },
    );

    expect(res.status).toBe(400);
  });
});

// ── 5. POST /api/admin/dedup/merge ───────────────────────────────────────────

describe('POST /api/admin/dedup/merge', () => {
  let auditId: number;

  it('executa merge e retorna audit_ids', async () => {
    const res = await api.post('/api/admin/dedup/merge',
      { survivorId: mergeGroup.survivorId, absorbedIds: [mergeGroup.absorbedId] },
      { headers: { Authorization: `Bearer ${adminToken}` } },
    );

    expect(res.status).toBe(200);
    expect(res.data.success).toBe(true);
    expect(res.data.data.audit_ids).toHaveLength(1);
    auditId = Number(res.data.data.audit_ids[0]);
    expect(auditId).toBeGreaterThan(0);
  });

  it('absorvido tem merged_into_id = survivorId após o merge', async () => {
    const { rows } = await pool.query<{ merged_into_id: string | null }>(
      `SELECT merged_into_id FROM workers WHERE id = $1::uuid`,
      [mergeGroup.absorbedId],
    );

    expect(rows[0].merged_into_id).toBe(mergeGroup.survivorId);
  });

  it('worker_merge_audit tem linha com survivor_id/absorbed_id/category corretos', async () => {
    const { rows } = await pool.query<{
      survivor_id: string;
      absorbed_id: string;
      category: string;
      phone_normalized: string;
    }>(
      `SELECT survivor_id, absorbed_id, category, phone_normalized
       FROM worker_merge_audit
       WHERE survivor_id = $1::uuid AND absorbed_id = $2::uuid
       ORDER BY created_at DESC LIMIT 1`,
      [mergeGroup.survivorId, mergeGroup.absorbedId],
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].survivor_id).toBe(mergeGroup.survivorId);
    expect(rows[0].absorbed_id).toBe(mergeGroup.absorbedId);
    expect(rows[0].category).toBe('firebase');
    expect(rows[0].phone_normalized).toBe(mergeGroup.phoneNorm);
  });

  it('snapshot foi criado em worker_merge_snapshots com undone_at=NULL', async () => {
    const { rows } = await pool.query<{ id: string; undone_at: Date | null }>(
      `SELECT id, undone_at FROM worker_merge_snapshots
       WHERE absorbed_worker_id = $1::uuid`,
      [mergeGroup.absorbedId],
    );

    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0].undone_at).toBeNull();
  });

  it('worker_status_history do absorvido foi reparentada para survivorId', async () => {
    // A linha semeada com change_source LIKE 'e2e_seed_...' deve agora ter worker_id = survivorId
    const { rows } = await pool.query<{ worker_id: string }>(
      `SELECT worker_id FROM worker_status_history
       WHERE change_source = $1`,
      [`e2e_seed_${STAMP}`],
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].worker_id).toBe(mergeGroup.survivorId);
  });

  it('worker_availability do absorvido foi reparentada (upsert_delete) para survivorId', async () => {
    // A linha de disponibilidade (segunda 08:00-12:00) deve estar no survivorId
    const { rows } = await pool.query<{ worker_id: string }>(
      `SELECT worker_id FROM worker_availability
       WHERE worker_id = $1::uuid AND day_of_week = 1 AND start_time = '08:00' AND end_time = '12:00'`,
      [mergeGroup.survivorId],
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].worker_id).toBe(mergeGroup.survivorId);
  });

  it('retorna 400 com survivorId inválido', async () => {
    const res = await api.post('/api/admin/dedup/merge',
      { survivorId: 'nao-e-uuid', absorbedIds: [mergeGroup.absorbedId] },
      { headers: { Authorization: `Bearer ${adminToken}` } },
    );

    expect(res.status).toBe(400);
  });
});

// ── 5b. POST /api/admin/dedup/merge com fieldChoices ENCRIPTADO ───────────────

describe('POST /api/admin/dedup/merge — choice de campo encriptado', () => {
  it('escolher first_name_encrypted da conta absorvida copia o ciphertext dela pro survivor', async () => {
    // fieldChoices keyed por account id (contrato real do frontend):
    // o admin escolhe o nome da conta ABSORVIDA.
    const res = await api.post('/api/admin/dedup/merge',
      {
        survivorId: encChoiceGroup.survivorId,
        absorbedIds: [encChoiceGroup.absorbedId],
        fieldChoices: { first_name_encrypted: encChoiceGroup.absorbedId },
      },
      { headers: { Authorization: `Bearer ${adminToken}` } },
    );

    expect(res.status).toBe(200);
    expect(res.data.success).toBe(true);

    // Survivor deve ter ficado com o CIPHERTEXT do absorbed (sem re-encriptar).
    const { rows } = await pool.query<{ first_name_encrypted: string | null }>(
      `SELECT first_name_encrypted FROM workers WHERE id = $1::uuid`,
      [encChoiceGroup.survivorId],
    );
    expect(rows[0].first_name_encrypted).toBe(
      fakeCiphertext(encChoiceGroup.absorbedFirstName),
    );
    // E NÃO o do próprio survivor.
    expect(rows[0].first_name_encrypted).not.toBe(
      fakeCiphertext(encChoiceGroup.survivorFirstName),
    );
  });
});

// ── 5c. Regressão guard: principal INCOMPLETE_REGISTER + WJA manual ───────────
// Sem a mig 229 (bypass do trg_enforce_worker_registered na transação de merge/undo),
// o reparent da WJA manual pro principal incompleto levantava 23514 → 500 "Erro interno".

describe('POST /api/admin/dedup/merge — guard não bloqueia merge com WJA manual', () => {
  let auditId: number;

  it('sanidade: o trigger AINDA bloqueia postulação manual direta de worker incompleto', async () => {
    // Prova que o guard segue ativo pro caminho real (não foi simplesmente desligado).
    await expect(
      pool.query(
        `INSERT INTO worker_job_applications (worker_id, job_posting_id, application_funnel_stage, source)
         VALUES ($1::uuid, $2::uuid, 'INITIATED', 'manual')`,
        [guardGroup.survivorId, guardGroup.jobPostingId],
      ),
    ).rejects.toThrow(/must be REGISTERED/);
  });

  it('merge retorna 200 mesmo com principal incompleto (antes: 500)', async () => {
    const res = await api.post('/api/admin/dedup/merge',
      { survivorId: guardGroup.survivorId, absorbedIds: [guardGroup.absorbedId] },
      { headers: { Authorization: `Bearer ${adminToken}` } },
    );

    expect(res.status).toBe(200);
    expect(res.data.success).toBe(true);
    expect(res.data.data.audit_ids).toHaveLength(1);
    auditId = Number(res.data.data.audit_ids[0]);
    expect(auditId).toBeGreaterThan(0);
  });

  it('a WJA manual foi reparentada pro principal', async () => {
    const { rows } = await pool.query<{ worker_id: string; source: string }>(
      `SELECT worker_id, source FROM worker_job_applications
       WHERE job_posting_id = $1::uuid`,
      [guardGroup.jobPostingId],
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].worker_id).toBe(guardGroup.survivorId);
    expect(rows[0].source).toBe('manual');
  });

  it('undo retorna 200 e re-insere a WJA manual no absorvido (antes: tx abortada)', async () => {
    const res = await api.post(`/api/admin/dedup/merges/${auditId}/undo`,
      {},
      { headers: { Authorization: `Bearer ${adminToken}` } },
    );

    expect(res.status).toBe(200);
    expect(res.data.success).toBe(true);
    expect(res.data.data.alreadyUndone).toBe(false);

    const { rows } = await pool.query<{ worker_id: string }>(
      `SELECT worker_id FROM worker_job_applications
       WHERE job_posting_id = $1::uuid`,
      [guardGroup.jobPostingId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].worker_id).toBe(guardGroup.absorbedId);
  });
});

// ── 5d. Regressão check_document_type_required ────────────────────────────────
// Sem o COALESCE de document_type (par com document_number_encrypted), herdar o
// número do absorvido sem o tipo violava check_document_type_required → 500.

describe('POST /api/admin/dedup/merge — herda document_type junto com o número', () => {
  it('merge retorna 200 e o principal fica com número E tipo (constraint satisfeita)', async () => {
    const res = await api.post('/api/admin/dedup/merge',
      { survivorId: docTypeGroup.survivorId, absorbedIds: [docTypeGroup.absorbedId] },
      { headers: { Authorization: `Bearer ${adminToken}` } },
    );

    expect(res.status).toBe(200);
    expect(res.data.success).toBe(true);

    const { rows } = await pool.query<{ document_number_encrypted: string | null; document_type: string | null }>(
      `SELECT document_number_encrypted, document_type FROM workers WHERE id = $1::uuid`,
      [docTypeGroup.survivorId],
    );
    // Número herdado do absorvido — e o tipo veio JUNTO (senão a constraint barraria).
    expect(rows[0].document_number_encrypted).toBe(fakeCiphertext('20304050'));
    expect(rows[0].document_type).toBe('DNI');
  });
});

// ── 6. GET /api/admin/dedup/history ──────────────────────────────────────────

describe('GET /api/admin/dedup/history', () => {
  it('retorna 200 com entries', async () => {
    const res = await api.get('/api/admin/dedup/history', {
      headers: { Authorization: `Bearer ${adminToken}` },
    });

    expect(res.status).toBe(200);
    expect(res.data.success).toBe(true);
    expect(Array.isArray(res.data.data)).toBe(true);
  });

  it('entry do merge semeado tem can_undo=true', async () => {
    const res = await api.get('/api/admin/dedup/history', {
      headers: { Authorization: `Bearer ${adminToken}` },
    });

    const entries = res.data.data as Array<{ absorbed_id: string; can_undo: boolean }>;
    const entry = entries.find(e => e.absorbed_id === mergeGroup.absorbedId);
    expect(entry).toBeDefined();
    expect(entry?.can_undo).toBe(true);
  });
});

// ── 7. POST /api/admin/dedup/merges/:auditId/undo ────────────────────────────

describe('POST /api/admin/dedup/merges/:auditId/undo — roundtrip', () => {
  let auditId: number;

  beforeAll(async () => {
    // Busca o auditId do merge feito no cenário anterior
    const { rows } = await pool.query<{ id: number }>(
      `SELECT id FROM worker_merge_audit
       WHERE absorbed_id = $1::uuid
       ORDER BY created_at DESC LIMIT 1`,
      [mergeGroup.absorbedId],
    );

    auditId = rows[0]?.id;
  });

  it('undo restaura merged_into_id = NULL no absorvido', async () => {
    expect(auditId).toBeDefined();

    const res = await api.post(`/api/admin/dedup/merges/${auditId}/undo`,
      {},
      { headers: { Authorization: `Bearer ${adminToken}` } },
    );

    expect(res.status).toBe(200);
    expect(res.data.success).toBe(true);
    expect(res.data.data.alreadyUndone).toBe(false);

    // Verifica que absorvido foi reativado
    const { rows } = await pool.query<{ merged_into_id: string | null }>(
      `SELECT merged_into_id FROM workers WHERE id = $1::uuid`,
      [mergeGroup.absorbedId],
    );
    expect(rows[0].merged_into_id).toBeNull();
  });

  it('worker_status_history voltou para o absorbedId após undo', async () => {
    const { rows } = await pool.query<{ worker_id: string }>(
      `SELECT worker_id FROM worker_status_history
       WHERE change_source = $1`,
      [`e2e_seed_${STAMP}`],
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].worker_id).toBe(mergeGroup.absorbedId);
  });

  it('worker_availability foi RE-INSERIDA no absorvido após undo (prova do snapshot)', async () => {
    // A linha que foi reparentada para survivor no merge deve ter sido restaurada para absorbedId
    const { rows } = await pool.query<{ worker_id: string }>(
      `SELECT worker_id FROM worker_availability
       WHERE worker_id = $1::uuid AND day_of_week = 1 AND start_time = '08:00' AND end_time = '12:00'`,
      [mergeGroup.absorbedId],
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].worker_id).toBe(mergeGroup.absorbedId);
  });

  it('snapshot tem undone_at preenchido após undo', async () => {
    const { rows } = await pool.query<{ undone_at: Date | null }>(
      `SELECT undone_at FROM worker_merge_snapshots
       WHERE absorbed_worker_id = $1::uuid`,
      [mergeGroup.absorbedId],
    );

    expect(rows[0].undone_at).not.toBeNull();
  });

  it('can_undo=false no history após undo', async () => {
    const res = await api.get('/api/admin/dedup/history', {
      headers: { Authorization: `Bearer ${adminToken}` },
    });

    const entries = res.data.data as Array<{ absorbed_id: string; can_undo: boolean }>;
    const entry = entries.find(e => e.absorbed_id === mergeGroup.absorbedId);
    expect(entry?.can_undo).toBe(false);
  });

  it('undo é idempotente: segunda chamada retorna alreadyUndone=true', async () => {
    const res = await api.post(`/api/admin/dedup/merges/${auditId}/undo`,
      {},
      { headers: { Authorization: `Bearer ${adminToken}` } },
    );

    expect(res.status).toBe(200);
    expect(res.data.data.alreadyUndone).toBe(true);
  });
});
