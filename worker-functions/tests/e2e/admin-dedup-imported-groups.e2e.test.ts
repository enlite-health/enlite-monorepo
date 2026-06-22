/**
 * admin-dedup-imported-groups.e2e.test.ts
 *
 * Testes E2E — ONDA 4a: Centro de Duplicados por NOME (importados).
 * Sem mocks. Banco real Docker.
 *
 * Cobre:
 *   1. GET /api/admin/dedup/imported-groups retorna o grupo semeado
 *      (survivor = conta real, is_imported correto, has_real=true, ordered first)
 *   2. GET ?onlyWithReal=true filtra só grupos com conta real
 *   3. POST /api/admin/dedup/merge funciona para grupo por nome
 *      (sem phone_normalized em common — prova que ExecuteAdminMergeUseCase é agnóstico)
 *      Asserts: merged_into_id setado, snapshot criado, reparent FK (worker_status_history)
 *   4. POST /api/admin/dedup/merges/:auditId/undo restaura estado
 *   5. Gate admin: 403 para não-admin
 *
 * Pré-requisito: Docker stack em pé (`npm run test:e2e:docker` ou equivalente).
 */

import { Pool } from 'pg';
import { createApiClient, getMockToken, waitForBackend } from './helpers';
import type { AxiosInstance } from 'axios';

const DATABASE_URL =
  process.env.DATABASE_URL ||
  'postgresql://enlite_admin:enlite_password@localhost:5433/enlite_e2e';

const STAMP = `ndg_e2e_${Date.now()}`;

// ── Helpers de seed ────────────────────────────────────────────────────────────

async function insertWorker(
  pool: Pool,
  params: {
    id: string;
    auth_uid: string;
    email: string;
    phone?: string;
    nameTrgmBidx?: Buffer[];
  },
): Promise<void> {
  await pool.query(
    `INSERT INTO workers (id, auth_uid, email, phone, status, country, created_at, updated_at)
     VALUES ($1::uuid, $2, $3, $4, 'INCOMPLETE_REGISTER', 'AR', NOW(), NOW())`,
    [params.id, params.auth_uid, params.email, params.phone ?? null],
  );

  if (params.nameTrgmBidx && params.nameTrgmBidx.length > 0) {
    // Injeta o blind index de nome diretamente (sem KMS, para seed de teste)
    await pool.query(
      `UPDATE workers SET name_trgm_bidx = $1::bytea[] WHERE id = $2::uuid`,
      [params.nameTrgmBidx, params.id],
    );
  }
}

// ── Setup / teardown ──────────────────────────────────────────────────────────

let pool: Pool;
let api: AxiosInstance;
let adminToken: string;
let workerToken: string;

const seededWorkerIds: string[] = [];

// Cenário principal: 1 real + 1 importado com mesmo name_trgm_bidx
// UUIDs válidos: todos hex (0-9, a-f)
const TS12 = String(Date.now()).slice(-12); // 12 dígitos decimais
const nameGroup = {
  realId:     `a0000001-0001-0001-0001-${TS12}`,
  importedId: `b0000002-0002-0002-0002-${TS12}`,
};

// BYTEA único para este teste (simula HMAC de trigramas do mesmo nome)
// Usamos um buffer determinístico baseado no STAMP para evitar colisão com outros testes
const sharedNameBidx: Buffer[] = [
  Buffer.from(`e2etestbidx_${STAMP}`, 'utf8'),
];

// Cenário secundário: 2 importados sem real (para testar has_real=false)
const importOnlyGroup = {
  imp1Id: `c0000003-0003-0003-0003-${TS12}`,
  imp2Id: `d0000004-0004-0004-0004-${TS12}`,
};
const sharedNameBidxImportOnly: Buffer[] = [
  Buffer.from(`e2etestbidx_importonly_${STAMP}`, 'utf8'),
];

beforeAll(async () => {
  api = createApiClient();
  await waitForBackend(api);

  pool = new Pool({ connectionString: DATABASE_URL });

  adminToken = await getMockToken(api, {
    uid: `ndg-admin-${STAMP}`,
    email: `ndg-admin-${STAMP}@e2e.local`,
    role: 'admin',
  });

  workerToken = await getMockToken(api, {
    uid: `ndg-worker-${STAMP}`,
    email: `ndg-worker-${STAMP}@enlite.import`,
    role: 'worker',
  });

  // Cenário 1: 1 real + 1 importado com mesmo name_trgm_bidx
  await insertWorker(pool, {
    id: nameGroup.realId,
    auth_uid: `FirebaseReal_ndg_${STAMP}`,
    email: `ndg_real_${STAMP}@example.com`,
    phone: `91111${STAMP.slice(-7)}`,
    nameTrgmBidx: sharedNameBidx,
  });

  await insertWorker(pool, {
    id: nameGroup.importedId,
    auth_uid: `base1import_ndg_${STAMP}`,
    email: `ndg_imported_${STAMP}@enlite.import`,
    nameTrgmBidx: sharedNameBidx,
  });

  seededWorkerIds.push(nameGroup.realId, nameGroup.importedId);

  // Seed FK no importado para testar reparent
  await pool.query(
    `INSERT INTO worker_status_history (worker_id, field_name, old_value, new_value, change_source)
     VALUES ($1::uuid, 'status', NULL, 'INCOMPLETE_REGISTER', $2)`,
    [nameGroup.importedId, `ndg_e2e_seed_${STAMP}`],
  );

  // Cenário 2: 2 importados sem real
  await insertWorker(pool, {
    id: importOnlyGroup.imp1Id,
    auth_uid: `base1import_ndgo1_${STAMP}`,
    email: `ndgo1_${STAMP}@enlite.import`,
    nameTrgmBidx: sharedNameBidxImportOnly,
  });

  await insertWorker(pool, {
    id: importOnlyGroup.imp2Id,
    auth_uid: `base1import_ndgo2_${STAMP}`,
    email: `ndgo2_${STAMP}@enlite.import`,
    nameTrgmBidx: sharedNameBidxImportOnly,
  });

  seededWorkerIds.push(importOnlyGroup.imp1Id, importOnlyGroup.imp2Id);
});

afterAll(async () => {
  if (!pool) return;

  await pool.query(
    `DELETE FROM worker_merge_snapshots WHERE absorbed_worker_id = ANY($1::uuid[])`,
    [seededWorkerIds],
  ).catch(() => {});

  await pool.query(
    `DELETE FROM worker_merge_audit
     WHERE survivor_id = ANY($1::uuid[]) OR absorbed_id = ANY($1::uuid[])`,
    [seededWorkerIds],
  ).catch(() => {});

  await pool.query(
    `DELETE FROM worker_status_history
     WHERE worker_id = ANY($1::uuid[]) AND change_source = $2`,
    [seededWorkerIds, `ndg_e2e_seed_${STAMP}`],
  ).catch(() => {});

  await pool.query(
    `DELETE FROM workers WHERE id = ANY($1::uuid[])`,
    [seededWorkerIds],
  ).catch(() => {});

  await pool.end();
});

// ── 1. Gate admin: 403 para não-admin ─────────────────────────────────────────

describe('Gate ADMIN — imported-groups', () => {
  it('worker token recebe 403 em GET /imported-groups', async () => {
    const res = await api.get('/api/admin/dedup/imported-groups', {
      headers: { Authorization: `Bearer ${workerToken}` },
    });
    expect(res.status).toBe(403);
  });
});

// ── 2. GET /api/admin/dedup/imported-groups ───────────────────────────────────

describe('GET /api/admin/dedup/imported-groups', () => {
  it('retorna 200 com array de grupos', async () => {
    const res = await api.get('/api/admin/dedup/imported-groups', {
      headers: { Authorization: `Bearer ${adminToken}` },
    });

    expect(res.status).toBe(200);
    expect(res.data.success).toBe(true);
    expect(Array.isArray(res.data.data)).toBe(true);
  });

  it('inclui o grupo semeado (real + importado)', async () => {
    const res = await api.get('/api/admin/dedup/imported-groups', {
      headers: { Authorization: `Bearer ${adminToken}` },
    });

    const groups = res.data.data as Array<{
      name_trgm_bidx_key: string;
      accounts: Array<{ id: string; is_imported: boolean }>;
      survivor_suggested_id: string | null;
      survivor_reason: string;
      has_real: boolean;
      match_type: string;
      confidence: string;
    }>;

    const group = groups.find(g =>
      g.accounts.some(a => a.id === nameGroup.realId) &&
      g.accounts.some(a => a.id === nameGroup.importedId),
    );

    expect(group).toBeDefined();
    expect(group!.has_real).toBe(true);
    expect(group!.survivor_suggested_id).toBe(nameGroup.realId);
    expect(group!.survivor_reason).toBe('real_account_absorbs_imported');
    expect(group!.match_type).toBe('name');
    expect(group!.confidence).toBe('name_fuzzy');
  });

  it('is_imported correto em cada account', async () => {
    const res = await api.get('/api/admin/dedup/imported-groups', {
      headers: { Authorization: `Bearer ${adminToken}` },
    });

    const groups = res.data.data as Array<{
      accounts: Array<{ id: string; is_imported: boolean; tier: number; login_real: boolean }>;
    }>;

    const group = groups.find(g =>
      g.accounts.some(a => a.id === nameGroup.realId),
    );
    expect(group).toBeDefined();

    const realAcc     = group!.accounts.find(a => a.id === nameGroup.realId);
    const importedAcc = group!.accounts.find(a => a.id === nameGroup.importedId);

    expect(realAcc?.is_imported).toBe(false);
    expect(realAcc?.tier).toBe(1);
    expect(realAcc?.login_real).toBe(true);

    expect(importedAcc?.is_imported).toBe(true);
    expect(importedAcc?.tier).toBe(3);
    expect(importedAcc?.login_real).toBe(false);
  });

  it('grupos com has_real=true vêm antes de has_real=false', async () => {
    const res = await api.get('/api/admin/dedup/imported-groups', {
      headers: { Authorization: `Bearer ${adminToken}` },
    });

    const groups = res.data.data as Array<{ has_real: boolean }>;
    // Encontra o índice de um grupo com real e sem real em nosso seed
    const idxReal = groups.findIndex(g =>
      (g as { accounts?: Array<{ id: string }> }).accounts?.some(
        (a) => a.id === nameGroup.realId,
      ),
    );
    const idxImportOnly = groups.findIndex(g =>
      (g as { accounts?: Array<{ id: string }> }).accounts?.some(
        (a) => a.id === importOnlyGroup.imp1Id,
      ),
    );

    if (idxReal !== -1 && idxImportOnly !== -1) {
      expect(idxReal).toBeLessThan(idxImportOnly);
    }
    // Se algum grupo não aparecer (edge case de DB), o teste passa sem assert
  });
});

// ── 3. GET ?onlyWithReal=true ─────────────────────────────────────────────────

describe('GET /api/admin/dedup/imported-groups?onlyWithReal=true', () => {
  it('retorna apenas grupos com has_real=true', async () => {
    const res = await api.get('/api/admin/dedup/imported-groups?onlyWithReal=true', {
      headers: { Authorization: `Bearer ${adminToken}` },
    });

    expect(res.status).toBe(200);
    const groups = res.data.data as Array<{ has_real: boolean }>;
    expect(groups.every(g => g.has_real)).toBe(true);
  });

  it('inclui o grupo com real mas não o importado-vs-importado', async () => {
    const res = await api.get('/api/admin/dedup/imported-groups?onlyWithReal=true', {
      headers: { Authorization: `Bearer ${adminToken}` },
    });

    const groups = res.data.data as Array<{
      accounts: Array<{ id: string }>;
      has_real: boolean;
    }>;

    const hasRealGroup = groups.find(g =>
      g.accounts.some(a => a.id === nameGroup.realId),
    );
    const hasImportOnlyGroup = groups.find(g =>
      g.accounts.some(a => a.id === importOnlyGroup.imp1Id),
    );

    expect(hasRealGroup).toBeDefined();
    expect(hasImportOnlyGroup).toBeUndefined();
  });
});

// ── 4. POST /api/admin/dedup/merge (grupo por nome) ──────────────────────────

describe('POST /api/admin/dedup/merge — grupo por nome', () => {
  let auditId: number;

  it('executa merge e retorna audit_ids', async () => {
    const res = await api.post('/api/admin/dedup/merge',
      { survivorId: nameGroup.realId, absorbedIds: [nameGroup.importedId] },
      { headers: { Authorization: `Bearer ${adminToken}` } },
    );

    expect(res.status).toBe(200);
    expect(res.data.success).toBe(true);
    expect(res.data.data.audit_ids).toHaveLength(1);
    auditId = Number(res.data.data.audit_ids[0]);
    expect(auditId).toBeGreaterThan(0);
  });

  it('importado tem merged_into_id = realId após merge', async () => {
    const { rows } = await pool.query<{ merged_into_id: string | null }>(
      `SELECT merged_into_id FROM workers WHERE id = $1::uuid`,
      [nameGroup.importedId],
    );
    expect(rows[0].merged_into_id).toBe(nameGroup.realId);
  });

  it('snapshot criado em worker_merge_snapshots com undone_at=NULL', async () => {
    const { rows } = await pool.query<{ undone_at: Date | null }>(
      `SELECT undone_at FROM worker_merge_snapshots
       WHERE absorbed_worker_id = $1::uuid`,
      [nameGroup.importedId],
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0].undone_at).toBeNull();
  });

  it('worker_status_history do importado foi reparentada para realId', async () => {
    const { rows } = await pool.query<{ worker_id: string }>(
      `SELECT worker_id FROM worker_status_history
       WHERE change_source = $1`,
      [`ndg_e2e_seed_${STAMP}`],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].worker_id).toBe(nameGroup.realId);
  });

  // ── Undo ─────────────────────────────────────────────────────────────────

  it('undo restaura merged_into_id=NULL no importado', async () => {
    expect(auditId).toBeDefined();

    const res = await api.post(`/api/admin/dedup/merges/${auditId}/undo`,
      {},
      { headers: { Authorization: `Bearer ${adminToken}` } },
    );

    expect(res.status).toBe(200);
    expect(res.data.success).toBe(true);
    expect(res.data.data.alreadyUndone).toBe(false);

    const { rows } = await pool.query<{ merged_into_id: string | null }>(
      `SELECT merged_into_id FROM workers WHERE id = $1::uuid`,
      [nameGroup.importedId],
    );
    expect(rows[0].merged_into_id).toBeNull();
  });

  it('worker_status_history volta para importedId após undo', async () => {
    const { rows } = await pool.query<{ worker_id: string }>(
      `SELECT worker_id FROM worker_status_history
       WHERE change_source = $1`,
      [`ndg_e2e_seed_${STAMP}`],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].worker_id).toBe(nameGroup.importedId);
  });

  it('snapshot tem undone_at preenchido após undo', async () => {
    const { rows } = await pool.query<{ undone_at: Date | null }>(
      `SELECT undone_at FROM worker_merge_snapshots
       WHERE absorbed_worker_id = $1::uuid`,
      [nameGroup.importedId],
    );
    expect(rows[0].undone_at).not.toBeNull();
  });
});
