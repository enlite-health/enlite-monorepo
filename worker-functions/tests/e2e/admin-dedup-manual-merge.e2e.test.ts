/**
 * admin-dedup-manual-merge.e2e.test.ts
 *
 * Testes E2E — Merge Manual no Centro de Duplicados.
 * Sem mocks. Banco real Docker.
 *
 * Cobre:
 *   1. GET /api/admin/dedup/candidates?q=<nome> → acha worker por nome (blind index)
 *   2. GET /api/admin/dedup/candidates?q=<telefone> → acha worker por telefone
 *   3. GET /api/admin/dedup/candidates?q=<1 char> → retorna []
 *   4. POST /api/admin/dedup/manual-group → retorna accounts + survivor_suggested_id
 *      (1 real + 1 importado → real_account_absorbs_imported)
 *   5. POST /api/admin/dedup/manual-group → 2 reais → conflict (survivor_suggested_id=null)
 *   6. POST /api/admin/dedup/manual-group → id inexistente → 400
 *   7. POST /api/admin/dedup/manual-group → id mergeado → 400
 *   8. Gate admin: 403 para não-admin
 *
 * Pré-requisito: Docker stack em pé (`npm run test:e2e:docker` ou equivalente).
 * STAMP único garante isolamento de outros testes no banco.
 */

import { Pool } from 'pg';
import { BlindIndexService } from '../../src/shared/security/BlindIndexService';
import { createApiClient, getMockToken, waitForBackend } from './helpers';
import type { AxiosInstance } from 'axios';

const DATABASE_URL =
  process.env.DATABASE_URL ||
  'postgresql://enlite_admin:enlite_password@localhost:5433/enlite_e2e';

const STAMP = `mm_e2e_${Date.now()}`;
const TS12 = String(Date.now()).slice(-12);

// ── Helpers de seed ────────────────────────────────────────────────────────────

/**
 * Insere um worker mínimo.
 * Se nameTrgmBidx fornecido, injeta o blind index de nome (sem KMS — só para seed E2E).
 */
async function insertWorker(
  pool: Pool,
  params: {
    id: string;
    auth_uid: string;
    email: string;
    phone?: string;
    nameTrgmBidx?: Buffer[];
    merged_into_id?: string;
  },
): Promise<void> {
  // phone_normalized é GENERATED ALWAYS AS (normalize_phone_ar(phone)) — não
  // se insere; basta gravar `phone` cru e o banco gera o normalizado.
  await pool.query(
    `INSERT INTO workers (id, auth_uid, email, phone, status, country, created_at, updated_at)
     VALUES ($1::uuid, $2, $3, $4, 'INCOMPLETE_REGISTER', 'AR', NOW(), NOW())`,
    [
      params.id,
      params.auth_uid,
      params.email,
      params.phone ?? null,
    ],
  );

  if (params.nameTrgmBidx && params.nameTrgmBidx.length > 0) {
    await pool.query(
      `UPDATE workers SET name_trgm_bidx = $1::bytea[] WHERE id = $2::uuid`,
      [params.nameTrgmBidx, params.id],
    );
  }

  if (params.merged_into_id) {
    await pool.query(
      `UPDATE workers SET merged_into_id = $1::uuid WHERE id = $2::uuid`,
      [params.merged_into_id, params.id],
    );
  }
}

// ── Setup / teardown ──────────────────────────────────────────────────────────

let pool: Pool;
let api: AxiosInstance;
let adminToken: string;
let workerToken: string;

const seededIds: string[] = [];

// Workers semeados:
//   REAL1  — conta real com nameTrgmBidx + phone_normalized único
//   IMP1   — conta importada com mesmo nameTrgmBidx de REAL1
//   REAL2  — segunda conta real (para testar conflict)
//   MERGED — worker já absorvido (para testar 400)

const REAL1_ID   = `a0000001-0001-0001-0001-${TS12}`;
const IMP1_ID    = `b0000002-0002-0002-0002-${TS12}`;
const REAL2_ID   = `c0000003-0003-0003-0003-${TS12}`;
const MERGED_ID  = `d0000004-0004-0004-0004-${TS12}`;

// phone cru de REAL1 (10 dígitos AR: '11' + 8 únicos) → normaliza pra '54911XXXXXXXX'.
const REAL1_PHONE = `11${TS12.slice(-8)}`;
// Preenchido após o seed lendo a coluna gerada phone_normalized de REAL1.
let PHONE_NORMALIZED = '';

// BlindIndexService em testMode (NODE_ENV=test) usa chave fixa determinística
const BLIND_INDEX = new BlindIndexService();

beforeAll(async () => {
  api = createApiClient();
  await waitForBackend(api);

  pool = new Pool({ connectionString: DATABASE_URL });

  adminToken = await getMockToken(api, {
    uid: `mm-admin-${STAMP}`,
    email: `mm-admin-${STAMP}@e2e.local`,
    role: 'admin',
  });

  workerToken = await getMockToken(api, {
    uid: `mm-worker-${STAMP}`,
    email: `mm-worker-${STAMP}@enlite.import`,
    role: 'worker',
  });

  // Blind index para o nome "Valentina Cabrera" (determinístico em testMode)
  const sharedNameBidx = await BLIND_INDEX.generateNameTrigramBidx('Valentina', `Cabrera_${STAMP}`);

  await insertWorker(pool, {
    id: REAL1_ID,
    auth_uid: `FirebaseReal_mm_${STAMP}`,
    email: `mm_real_${STAMP}@example.com`,
    phone: REAL1_PHONE,
    nameTrgmBidx: sharedNameBidx,
  });

  // Lê o phone_normalized GERADO pelo banco — fonte da verdade pros asserts.
  const pnRes = await pool.query<{ phone_normalized: string }>(
    `SELECT phone_normalized FROM workers WHERE id = $1::uuid`,
    [REAL1_ID],
  );
  PHONE_NORMALIZED = pnRes.rows[0].phone_normalized;

  await insertWorker(pool, {
    id: IMP1_ID,
    auth_uid: `base1import_mm_${STAMP}`,
    email: `mm_imported_${STAMP}@enlite.import`,
    nameTrgmBidx: sharedNameBidx,
  });

  await insertWorker(pool, {
    id: REAL2_ID,
    auth_uid: `FirebaseReal2_mm_${STAMP}`,
    email: `mm_real2_${STAMP}@example.com`,
    // nameTrgmBidx diferente — só vamos incluir este no manual-group conflict
  });

  // MERGED: worker já absorvido — deve retornar 400 em manual-group
  await insertWorker(pool, {
    id: MERGED_ID,
    auth_uid: `base1import_merged_${STAMP}`,
    email: `mm_merged_${STAMP}@enlite.import`,
    nameTrgmBidx: sharedNameBidx,
    merged_into_id: REAL1_ID,
  });

  seededIds.push(REAL1_ID, IMP1_ID, REAL2_ID, MERGED_ID);
});

afterAll(async () => {
  if (!pool) return;

  // Remove merged_into_id antes de deletar workers
  await pool.query(
    `UPDATE workers SET merged_into_id = NULL WHERE id = ANY($1::uuid[])`,
    [seededIds],
  ).catch(() => {});

  await pool.query(
    `DELETE FROM workers WHERE id = ANY($1::uuid[])`,
    [seededIds],
  ).catch(() => {});

  await pool.end();
});

// ── 1. Gate admin ─────────────────────────────────────────────────────────────

describe('Gate ADMIN — manual-merge endpoints', () => {
  it('worker token recebe 403 em GET /candidates', async () => {
    const res = await api.get('/api/admin/dedup/candidates?q=test', {
      headers: { Authorization: `Bearer ${workerToken}` },
    });
    expect(res.status).toBe(403);
  });

  it('worker token recebe 403 em POST /manual-group', async () => {
    const res = await api.post('/api/admin/dedup/manual-group',
      { ids: [REAL1_ID, IMP1_ID] },
      { headers: { Authorization: `Bearer ${workerToken}` } },
    );
    expect(res.status).toBe(403);
  });
});

// ── 2. GET /api/admin/dedup/candidates — q < 2 chars ─────────────────────────

describe('GET /api/admin/dedup/candidates — q curto', () => {
  it('retorna [] quando q tem 1 char', async () => {
    const res = await api.get('/api/admin/dedup/candidates?q=a', {
      headers: { Authorization: `Bearer ${adminToken}` },
    });

    expect(res.status).toBe(200);
    expect(res.data.success).toBe(true);
    expect(res.data.data).toEqual([]);
  });
});

// ── 3. GET /api/admin/dedup/candidates — busca por nome ──────────────────────

describe('GET /api/admin/dedup/candidates — busca por nome (blind index)', () => {
  it('acha REAL1 pelo nome "Valentina"', async () => {
    // "Valentina" tem >= 3 chars → gera trigramas → deve bater no REAL1_ID
    const res = await api.get(
      `/api/admin/dedup/candidates?q=Valentina&limit=20`,
      { headers: { Authorization: `Bearer ${adminToken}` } },
    );

    expect(res.status).toBe(200);
    expect(res.data.success).toBe(true);

    const ids = (res.data.data as Array<{ id: string }>).map(c => c.id);
    expect(ids).toContain(REAL1_ID);
  });

  it('também acha IMP1 (mesmo blind index de nome que REAL1)', async () => {
    const res = await api.get(
      `/api/admin/dedup/candidates?q=Valentina&limit=20`,
      { headers: { Authorization: `Bearer ${adminToken}` } },
    );

    const ids = (res.data.data as Array<{ id: string }>).map(c => c.id);
    expect(ids).toContain(IMP1_ID);
  });

  it('shape de CandidateItem correto para REAL1', async () => {
    const res = await api.get(
      `/api/admin/dedup/candidates?q=Valentina&limit=20`,
      { headers: { Authorization: `Bearer ${adminToken}` } },
    );

    const candidates = res.data.data as Array<{
      id: string;
      name: string;
      phone: string | null;
      email: string | null;
      login_real: boolean;
      is_imported: boolean;
    }>;

    const real1 = candidates.find(c => c.id === REAL1_ID);
    expect(real1).toBeDefined();
    expect(real1!.is_imported).toBe(false);
    expect(real1!.login_real).toBe(true);
    expect(real1!.phone).toBe(PHONE_NORMALIZED);

    const imp1 = candidates.find(c => c.id === IMP1_ID);
    expect(imp1).toBeDefined();
    expect(imp1!.is_imported).toBe(true);
    expect(imp1!.login_real).toBe(false);
  });

  it('não inclui worker já mergeado (MERGED_ID)', async () => {
    const res = await api.get(
      `/api/admin/dedup/candidates?q=Valentina&limit=20`,
      { headers: { Authorization: `Bearer ${adminToken}` } },
    );

    const ids = (res.data.data as Array<{ id: string }>).map(c => c.id);
    expect(ids).not.toContain(MERGED_ID);
  });
});

// ── 4. GET /api/admin/dedup/candidates — busca por telefone ──────────────────

describe('GET /api/admin/dedup/candidates — busca por telefone', () => {
  it('acha REAL1 pelos últimos dígitos do phone_normalized', async () => {
    // Últimos 8 dígitos do PHONE_NORMALIZED (garantidamente únicos pra este teste)
    const suffix = PHONE_NORMALIZED.slice(-8);
    const res = await api.get(
      `/api/admin/dedup/candidates?q=${suffix}&limit=20`,
      { headers: { Authorization: `Bearer ${adminToken}` } },
    );

    expect(res.status).toBe(200);
    const ids = (res.data.data as Array<{ id: string }>).map(c => c.id);
    expect(ids).toContain(REAL1_ID);
  });
});

// ── 5. POST /api/admin/dedup/manual-group — 1 real + 1 importado ─────────────

describe('POST /api/admin/dedup/manual-group — 1 real + 1 importado', () => {
  it('retorna 200 com accounts e survivor = real', async () => {
    const res = await api.post('/api/admin/dedup/manual-group',
      { ids: [REAL1_ID, IMP1_ID] },
      { headers: { Authorization: `Bearer ${adminToken}` } },
    );

    expect(res.status).toBe(200);
    expect(res.data.success).toBe(true);

    const { accounts, survivor_suggested_id, survivor_reason } = res.data.data as {
      accounts: Array<{
        id: string;
        name: string;
        phone_normalized: string | null;
        login_real: boolean;
        is_imported: boolean;
        tier: number;
        wja_count: number;
        docs_count: number;
        encuadres_count: number;
      }>;
      survivor_suggested_id: string | null;
      survivor_reason: string;
    };

    expect(accounts).toHaveLength(2);
    expect(survivor_suggested_id).toBe(REAL1_ID);
    expect(survivor_reason).toBe('real_account_absorbs_imported');

    const real1Acc = accounts.find(a => a.id === REAL1_ID);
    const imp1Acc  = accounts.find(a => a.id === IMP1_ID);

    expect(real1Acc).toBeDefined();
    expect(real1Acc!.is_imported).toBe(false);
    expect(real1Acc!.login_real).toBe(true);
    expect(real1Acc!.tier).toBe(1);
    expect(real1Acc!.phone_normalized).toBe(PHONE_NORMALIZED);
    expect(typeof real1Acc!.name).toBe('string');
    expect(real1Acc!.name.length).toBeGreaterThan(0);

    expect(imp1Acc).toBeDefined();
    expect(imp1Acc!.is_imported).toBe(true);
    expect(imp1Acc!.login_real).toBe(false);
    expect(imp1Acc!.tier).toBe(3);
  });
});

// ── 6. POST /api/admin/dedup/manual-group — 2 reais → conflict ───────────────

describe('POST /api/admin/dedup/manual-group — 2 reais → conflict', () => {
  it('survivor_suggested_id=null, reason=conflict_multiple_real_accounts', async () => {
    const res = await api.post('/api/admin/dedup/manual-group',
      { ids: [REAL1_ID, REAL2_ID] },
      { headers: { Authorization: `Bearer ${adminToken}` } },
    );

    expect(res.status).toBe(200);
    expect(res.data.success).toBe(true);
    expect(res.data.data.survivor_suggested_id).toBeNull();
    expect(res.data.data.survivor_reason).toBe('conflict_multiple_real_accounts');
  });
});

// ── 7. POST /api/admin/dedup/manual-group — validações ───────────────────────

describe('POST /api/admin/dedup/manual-group — validações', () => {
  it('400 com ids < 2 (Zod)', async () => {
    const res = await api.post('/api/admin/dedup/manual-group',
      { ids: [REAL1_ID] },
      { headers: { Authorization: `Bearer ${adminToken}` } },
    );
    expect(res.status).toBe(400);
  });

  it('400 com ids > 5 (Zod)', async () => {
    const ids = Array.from({ length: 6 }, (_, i) =>
      `eeeeeeee-0000-0000-0000-00000000000${i + 1}`,
    );
    const res = await api.post('/api/admin/dedup/manual-group',
      { ids },
      { headers: { Authorization: `Bearer ${adminToken}` } },
    );
    expect(res.status).toBe(400);
  });

  it('400 com id não-UUID', async () => {
    const res = await api.post('/api/admin/dedup/manual-group',
      { ids: ['nao-e-uuid', REAL1_ID] },
      { headers: { Authorization: `Bearer ${adminToken}` } },
    );
    expect(res.status).toBe(400);
  });

  it('400 quando id não existe no banco', async () => {
    const GHOST_ID = 'ffffffff-ffff-ffff-ffff-ffffffffffff';
    const res = await api.post('/api/admin/dedup/manual-group',
      { ids: [REAL1_ID, GHOST_ID] },
      { headers: { Authorization: `Bearer ${adminToken}` } },
    );
    expect(res.status).toBe(400);
    expect(res.data.success).toBe(false);
    expect(String(res.data.error)).toContain(GHOST_ID);
  });

  it('400 quando worker já está mergeado', async () => {
    const res = await api.post('/api/admin/dedup/manual-group',
      { ids: [REAL1_ID, MERGED_ID] },
      { headers: { Authorization: `Bearer ${adminToken}` } },
    );
    expect(res.status).toBe(400);
    expect(res.data.success).toBe(false);
    expect(String(res.data.error)).toContain(MERGED_ID);
  });
});
