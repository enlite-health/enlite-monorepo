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
 *   5. POST /api/admin/dedup/merges/:id/undo → roundtrip: merge → undo → estado restaurado
 *   6. GET  /api/admin/dedup/history        → can_undo=true após merge, false após undo
 *   7. Gate admin:
 *      - 403 para não-admin em todos os endpoints
 *      - Recruiter também leva 403
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

// ── Helpers de seed ────────────────────────────────────────────────────────

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

// ── Setup / teardown ──────────────────────────────────────────────────────

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

  // ── Cenário 1: grupo para merge + undo ──────────────────────────────────
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

  // ── Cenário 2: grupo para dismiss ───────────────────────────────────────
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
});

afterAll(async () => {
  if (!pool) return;

  // Limpeza
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
    `DELETE FROM workers WHERE id = ANY($1::uuid[])`,
    [seededWorkerIds],
  ).catch(() => {});

  // Recria índice único
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_workers_phone_normalized_unique
      ON workers (phone_normalized)
      WHERE phone_normalized IS NOT NULL AND merged_into_id IS NULL
  `).catch(() => {});

  await pool.end();
});

// ── 1. Gate admin: 403 para não-admin ────────────────────────────────────

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

// ── 2. GET /api/admin/dedup/groups ────────────────────────────────────────

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

// ── 3. GET /api/admin/dedup/groups/:phoneNormalized ───────────────────────

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

  it('retorna 404 para phone não existente', async () => {
    const res = await api.get('/api/admin/dedup/groups/999999999999999', {
      headers: { Authorization: `Bearer ${adminToken}` },
    });

    expect(res.status).toBe(404);
  });
});

// ── 4. POST /api/admin/dedup/dismiss ─────────────────────────────────────

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

// ── 5. POST /api/admin/dedup/merge ───────────────────────────────────────

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

  it('snapshot foi criado em worker_merge_snapshots', async () => {
    const { rows } = await pool.query<{ id: string; undone_at: Date | null }>(
      `SELECT id, undone_at FROM worker_merge_snapshots
       WHERE absorbed_worker_id = $1::uuid`,
      [mergeGroup.absorbedId],
    );

    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0].undone_at).toBeNull();
  });

  it('retorna 400 com survivorId inválido', async () => {
    const res = await api.post('/api/admin/dedup/merge',
      { survivorId: 'nao-e-uuid', absorbedIds: [mergeGroup.absorbedId] },
      { headers: { Authorization: `Bearer ${adminToken}` } },
    );

    expect(res.status).toBe(400);
  });
});

// ── 6. GET /api/admin/dedup/history ──────────────────────────────────────

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

// ── 7. POST /api/admin/dedup/merges/:auditId/undo ────────────────────────

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
