/**
 * permissions-iam-schema.e2e.test.ts
 *
 * Valida o schema IAM criado pela migration 206 contra o banco real (sem mocks).
 *
 * Cobertura:
 *   S1 — Tabelas existem com colunas/constraints chave
 *   S2 — users tem tenant_id e status; trigger mantém is_active em sync
 *   S3 — Seed: tenant Enlite, count exato de permissions (43), 5 grupos de sistema
 *   S4 — get_user_effective_permissions() retorna array correto
 */

import { Pool, PoolClient } from 'pg';

const DATABASE_URL =
  process.env.DATABASE_URL ||
  'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

// UUID fixos usados na migration 206 (idempotentes)
const TENANT_ENLITE  = '00000000-0000-0000-0000-000000000001';
const GROUP_MASTER   = 'a0000000-0000-0000-0000-000000000001';
const GROUP_REC      = 'a0000000-0000-0000-0000-000000000002';
const GROUP_CM       = 'a0000000-0000-0000-0000-000000000003';
const GROUP_FIN      = 'a0000000-0000-0000-0000-000000000004';
const GROUP_SUPER    = 'a0000000-0000-0000-0000-000000000005';

// Total de permissões seedadas (matriz exata 01-requirements-and-decisions.md)
// worker:4 + worker_pii:1 + worker_document:4 + vacancy:3 + funnel:2 +
// interview:3 + match:2 + patient:2 + recruitment:2 + talentum:2 +
// prescreening:2 + analytics:2 + dedup:2 + dashboard:1 + messaging:2 +
// upload:2 + user_management:3 + permission_management:2 = 41
const EXPECTED_PERMISSION_COUNT = 41;

// IDs determinísticos para fixtures deste teste
const TEST_UID_PREFIX = 'e2e-iam-206';
const TEST_USER_UID   = `${TEST_UID_PREFIX}-user-001`;
const TEST_USER_EMAIL = 'iam-schema-e2e-001@enlite.test';

let pool: Pool;

// ─── Setup / Teardown ─────────────────────────────────────────────────────────

beforeAll(async () => {
  pool = new Pool({ connectionString: DATABASE_URL });
  await cleanupTestFixtures();
});

afterAll(async () => {
  await cleanupTestFixtures();
  await pool.end();
});

async function cleanupTestFixtures(): Promise<void> {
  // Cleanup em ordem de FK (filhos primeiro)
  await pool.query(
    `DELETE FROM user_groups WHERE user_id = $1`,
    [TEST_USER_UID],
  );
  await pool.query(
    `DELETE FROM user_departments WHERE user_id = $1`,
    [TEST_USER_UID],
  );
  await pool.query(
    `DELETE FROM users WHERE firebase_uid = $1`,
    [TEST_USER_UID],
  );
}

// ─── S1: Tabelas existem com colunas/constraints ──────────────────────────────

describe('S1 — Tabelas IAM existem com colunas e constraints corretas', () => {

  it('tabela tenants: id, name, region (CHECK), status (CHECK), created_at', async () => {
    const cols = await getColumns('tenants');
    expect(cols).toContain('id');
    expect(cols).toContain('name');
    expect(cols).toContain('region');
    expect(cols).toContain('status');
    expect(cols).toContain('created_at');
  });

  it('tenants.region: CHECK constraint existe e inclui SA', async () => {
    const chk = await getCheckConstraint('tenants', 'region');
    expect(chk).toContain('SA');
  });

  it('tenants.status: CHECK constraint existe e inclui ACTIVE', async () => {
    const chk = await getCheckConstraint('tenants', 'status');
    expect(chk).toContain('ACTIVE');
    expect(chk).toContain('SUSPENDED');
    expect(chk).toContain('DEACTIVATED');
  });

  it('tabela permissions: id, resource, action, description, category + UNIQUE(resource,action)', async () => {
    const cols = await getColumns('permissions');
    expect(cols).toContain('id');
    expect(cols).toContain('resource');
    expect(cols).toContain('action');
    expect(cols).toContain('description');
    expect(cols).toContain('category');

    // UNIQUE constraint
    const uq = await pool.query<{ conname: string }>(`
      SELECT conname FROM pg_constraint
      WHERE conrelid = 'permissions'::regclass AND contype = 'u'
        AND pg_get_constraintdef(oid) LIKE '%resource%action%'
    `);
    expect(uq.rows.length).toBeGreaterThanOrEqual(1);
  });

  it('tabela permission_groups: tenant_id NOT NULL, UNIQUE(tenant_id, name)', async () => {
    const nullable = await pool.query<{ is_nullable: string }>(`
      SELECT is_nullable FROM information_schema.columns
      WHERE table_name = 'permission_groups' AND column_name = 'tenant_id'
    `);
    expect(nullable.rows[0]?.is_nullable).toBe('NO');

    const uq = await pool.query<{ conname: string }>(`
      SELECT conname FROM pg_constraint
      WHERE conrelid = 'permission_groups'::regclass AND contype = 'u'
        AND pg_get_constraintdef(oid) LIKE '%tenant_id%name%'
    `);
    expect(uq.rows.length).toBeGreaterThanOrEqual(1);
  });

  it('tabela group_permissions: PK composta (group_id, permission_id) com CASCADE', async () => {
    const pk = await pool.query<{ def: string }>(`
      SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
      WHERE conrelid = 'group_permissions'::regclass AND contype = 'p'
    `);
    expect(pk.rows[0]?.def).toContain('group_id');
    expect(pk.rows[0]?.def).toContain('permission_id');

    // FK com CASCADE
    const fks = await pool.query<{ def: string }>(`
      SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
      WHERE conrelid = 'group_permissions'::regclass AND contype = 'f'
    `);
    const defs = fks.rows.map(r => r.def).join(' ');
    expect(defs).toContain('ON DELETE CASCADE');
  });

  it('tabela user_groups: tenant_id NOT NULL, PK(user_id, group_id)', async () => {
    const nullable = await pool.query<{ is_nullable: string }>(`
      SELECT is_nullable FROM information_schema.columns
      WHERE table_name = 'user_groups' AND column_name = 'tenant_id'
    `);
    expect(nullable.rows[0]?.is_nullable).toBe('NO');

    const pk = await pool.query<{ def: string }>(`
      SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
      WHERE conrelid = 'user_groups'::regclass AND contype = 'p'
    `);
    expect(pk.rows[0]?.def).toContain('user_id');
    expect(pk.rows[0]?.def).toContain('group_id');
  });

  it('tabela user_departments: PK(user_id, department_name), tenant_id NOT NULL', async () => {
    const pk = await pool.query<{ def: string }>(`
      SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
      WHERE conrelid = 'user_departments'::regclass AND contype = 'p'
    `);
    expect(pk.rows[0]?.def).toContain('user_id');
    expect(pk.rows[0]?.def).toContain('department_name');

    const nullable = await pool.query<{ is_nullable: string }>(`
      SELECT is_nullable FROM information_schema.columns
      WHERE table_name = 'user_departments' AND column_name = 'tenant_id'
    `);
    expect(nullable.rows[0]?.is_nullable).toBe('NO');
  });

  it('tabela permission_audit_log: decision CHECK ALLOW/DENY, tenant_id NOT NULL, sem coluna user_agent/PII', async () => {
    const chk = await getCheckConstraint('permission_audit_log', 'decision');
    expect(chk).toContain('ALLOW');
    expect(chk).toContain('DENY');

    const nullable = await pool.query<{ is_nullable: string }>(`
      SELECT is_nullable FROM information_schema.columns
      WHERE table_name = 'permission_audit_log' AND column_name = 'tenant_id'
    `);
    expect(nullable.rows[0]?.is_nullable).toBe('NO');

    // Garantir que NÃO existe coluna user_agent (proibido por policy)
    const badCols = await pool.query<{ column_name: string }>(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'permission_audit_log'
        AND column_name IN ('user_agent', 'user_name', 'user_email')
    `);
    expect(badCols.rows.length).toBe(0);
  });

  it('permission_audit_log: índices por user_id/created_at, resource/action, tenant_id/created_at', async () => {
    const idxs = await pool.query<{ indexname: string }>(`
      SELECT indexname FROM pg_indexes
      WHERE tablename = 'permission_audit_log'
    `);
    const names = idxs.rows.map(r => r.indexname);
    expect(names.some(n => n.includes('user') && n.includes('date') || n.includes('user_date'))).toBe(true);
    expect(names.some(n => n.includes('resource') || n.includes('resource_action'))).toBe(true);
    expect(names.some(n => n.includes('tenant') && n.includes('date') || n.includes('tenant_date'))).toBe(true);
  });
});

// ─── S2: users.tenant_id e users.status + trigger is_active ──────────────────

describe('S2 — users.tenant_id e users.status; trigger is_active em sync', () => {

  it('users tem coluna tenant_id UUID', async () => {
    const col = await pool.query<{ data_type: string }>(`
      SELECT data_type FROM information_schema.columns
      WHERE table_name = 'users' AND column_name = 'tenant_id'
    `);
    expect(col.rows[0]?.data_type).toBe('uuid');
  });

  it('users tem coluna status VARCHAR CHECK ACTIVE/PENDING_ONBOARDING/SUSPENDED/DEACTIVATED', async () => {
    const col = await pool.query<{ data_type: string }>(`
      SELECT data_type FROM information_schema.columns
      WHERE table_name = 'users' AND column_name = 'status'
    `);
    expect(col.rows[0]?.data_type).toBe('character varying');

    const chk = await getCheckConstraint('users', 'status');
    expect(chk).toContain('ACTIVE');
    expect(chk).toContain('PENDING_ONBOARDING');
    expect(chk).toContain('SUSPENDED');
    expect(chk).toContain('DEACTIVATED');
  });

  it('trigger trg_sync_user_status_to_is_active existe em users', async () => {
    // Usar pg_trigger para evitar row-per-event do information_schema.triggers
    const trg = await pool.query<{ tgname: string }>(`
      SELECT t.tgname
      FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      WHERE c.relname = 'users'
        AND t.tgname = 'trg_sync_user_status_to_is_active'
        AND NOT t.tgisinternal
    `);
    expect(trg.rows.length).toBe(1);
    expect(trg.rows[0].tgname).toBe('trg_sync_user_status_to_is_active');
  });

  it('trigger: UPDATE status=DEACTIVATED → is_active=false automaticamente', async () => {
    // Inserir user de teste com status=ACTIVE
    await pool.query(`
      INSERT INTO users (firebase_uid, email, role, tenant_id, status, is_active)
      VALUES ($1, $2, 'admin', $3, 'ACTIVE', true)
      ON CONFLICT (firebase_uid) DO UPDATE
        SET email = EXCLUDED.email, status = 'ACTIVE', is_active = true
    `, [TEST_USER_UID, TEST_USER_EMAIL, TENANT_ENLITE]);

    // UPDATE status → DEACTIVATED
    await pool.query(`
      UPDATE users SET status = 'DEACTIVATED' WHERE firebase_uid = $1
    `, [TEST_USER_UID]);

    const row = await pool.query<{ is_active: boolean; status: string }>(`
      SELECT is_active, status FROM users WHERE firebase_uid = $1
    `, [TEST_USER_UID]);

    expect(row.rows[0].status).toBe('DEACTIVATED');
    expect(row.rows[0].is_active).toBe(false);
  });

  it('trigger: UPDATE status=ACTIVE → is_active=true automaticamente', async () => {
    await pool.query(`
      UPDATE users SET status = 'ACTIVE' WHERE firebase_uid = $1
    `, [TEST_USER_UID]);

    const row = await pool.query<{ is_active: boolean; status: string }>(`
      SELECT is_active, status FROM users WHERE firebase_uid = $1
    `, [TEST_USER_UID]);

    expect(row.rows[0].status).toBe('ACTIVE');
    expect(row.rows[0].is_active).toBe(true);
  });

  it('trigger: UPDATE status=PENDING_ONBOARDING → is_active=false', async () => {
    await pool.query(`
      UPDATE users SET status = 'PENDING_ONBOARDING' WHERE firebase_uid = $1
    `, [TEST_USER_UID]);

    const row = await pool.query<{ is_active: boolean; status: string }>(`
      SELECT is_active, status FROM users WHERE firebase_uid = $1
    `, [TEST_USER_UID]);

    expect(row.rows[0].status).toBe('PENDING_ONBOARDING');
    expect(row.rows[0].is_active).toBe(false);
  });

  it('trigger: UPDATE status=SUSPENDED → is_active=false', async () => {
    await pool.query(`
      UPDATE users SET status = 'SUSPENDED' WHERE firebase_uid = $1
    `, [TEST_USER_UID]);

    const row = await pool.query<{ is_active: boolean; status: string }>(`
      SELECT is_active, status FROM users WHERE firebase_uid = $1
    `, [TEST_USER_UID]);

    expect(row.rows[0].status).toBe('SUSPENDED');
    expect(row.rows[0].is_active).toBe(false);
  });
});

// ─── S3: Seeds ────────────────────────────────────────────────────────────────

describe('S3 — Seeds: tenant Enlite, 43 permissions, 5 grupos de sistema', () => {

  it('tenant Enlite existe com UUID 00000000-...-0001 e region=SA', async () => {
    const row = await pool.query<{ id: string; name: string; region: string; status: string }>(`
      SELECT id::text, name, region, status FROM tenants WHERE id = $1
    `, [TENANT_ENLITE]);

    expect(row.rows.length).toBe(1);
    expect(row.rows[0].name).toBe('Enlite');
    expect(row.rows[0].region).toBe('SA');
    expect(row.rows[0].status).toBe('ACTIVE');
  });

  it(`permissions count == ${EXPECTED_PERMISSION_COUNT} (matriz exata 01-requirements)`, async () => {
    const count = await pool.query<{ cnt: string }>(`SELECT COUNT(*) AS cnt FROM permissions`);
    expect(Number(count.rows[0].cnt)).toBe(EXPECTED_PERMISSION_COUNT);
  });

  it('permissions: todos os 18 recursos presentes', async () => {
    const resources = await pool.query<{ resource: string }>(`
      SELECT DISTINCT resource FROM permissions ORDER BY resource
    `);
    const names = resources.rows.map(r => r.resource);

    const expectedResources = [
      'analytics', 'dashboard', 'dedup', 'funnel', 'interview', 'match',
      'messaging', 'patient', 'permission_management', 'prescreening',
      'recruitment', 'talentum', 'upload', 'user_management',
      'vacancy', 'worker', 'worker_document', 'worker_pii',
    ];
    for (const r of expectedResources) {
      expect(names).toContain(r);
    }
    expect(names.length).toBe(18);
  });

  it('permissions: ações corretas por recurso (amostragem chave)', async () => {
    type PermRow = { resource: string; action: string };
    const rows = await pool.query<PermRow>(`
      SELECT resource, action FROM permissions ORDER BY resource, action
    `);
    const set = new Set(rows.rows.map(r => `${r.resource}:${r.action}`));

    // worker: 4 ações
    expect(set.has('worker:read')).toBe(true);
    expect(set.has('worker:write')).toBe(true);
    expect(set.has('worker:delete')).toBe(true);
    expect(set.has('worker:export')).toBe(true);

    // worker_pii: só read
    expect(set.has('worker_pii:read')).toBe(true);
    expect(set.has('worker_pii:write')).toBe(false);

    // worker_document: 4 ações incluindo validate
    expect(set.has('worker_document:validate')).toBe(true);

    // match: read + execute
    expect(set.has('match:read')).toBe(true);
    expect(set.has('match:execute')).toBe(true);
    expect(set.has('match:write')).toBe(false);

    // messaging: read + send (não write)
    expect(set.has('messaging:read')).toBe(true);
    expect(set.has('messaging:send')).toBe(true);
    expect(set.has('messaging:write')).toBe(false);

    // patient: read + write (sem delete — dado clínico)
    expect(set.has('patient:read')).toBe(true);
    expect(set.has('patient:write')).toBe(true);
    expect(set.has('patient:delete')).toBe(false);

    // dashboard: só read
    expect(set.has('dashboard:read')).toBe(true);
    expect(set.has('dashboard:write')).toBe(false);

    // dedup: read + execute
    expect(set.has('dedup:execute')).toBe(true);
    expect(set.has('dedup:delete')).toBe(false);
  });

  it('5 grupos de sistema existem com is_system=true', async () => {
    const groups = await pool.query<{ id: string; name: string; is_system: boolean }>(`
      SELECT id::text, name, is_system FROM permission_groups
      WHERE tenant_id = $1 AND is_system = true
      ORDER BY name
    `, [TENANT_ENLITE]);

    expect(groups.rows.length).toBe(5);

    const ids = groups.rows.map(r => r.id);
    expect(ids).toContain(GROUP_MASTER);
    expect(ids).toContain(GROUP_REC);
    expect(ids).toContain(GROUP_CM);
    expect(ids).toContain(GROUP_FIN);
    expect(ids).toContain(GROUP_SUPER);

    const names = groups.rows.map(r => r.name);
    expect(names).toContain('Acesso Master');
    expect(names).toContain('Recrutador');
    expect(names).toContain('Community Manager');
    expect(names).toContain('Financeiro');
    expect(names).toContain('Super Admin');
  });

  it('grupo Acesso Master tem todas as 43 permissões', async () => {
    const count = await pool.query<{ cnt: string }>(`
      SELECT COUNT(*) AS cnt FROM group_permissions WHERE group_id = $1
    `, [GROUP_MASTER]);
    expect(Number(count.rows[0].cnt)).toBe(EXPECTED_PERMISSION_COUNT);
  });

  it('grupo Recrutador: não tem worker:delete, dedup:execute, user_management:write/delete, permission_management:*', async () => {
    type PermRow = { resource: string; action: string };
    const rows = await pool.query<PermRow>(`
      SELECT p.resource, p.action FROM group_permissions gp
      JOIN permissions p ON p.id = gp.permission_id
      WHERE gp.group_id = $1
    `, [GROUP_REC]);
    const set = new Set(rows.rows.map(r => `${r.resource}:${r.action}`));

    expect(set.has('worker:delete')).toBe(false);
    expect(set.has('dedup:execute')).toBe(false);
    expect(set.has('user_management:write')).toBe(false);
    expect(set.has('user_management:delete')).toBe(false);
    expect(set.has('permission_management:read')).toBe(false);
    expect(set.has('permission_management:write')).toBe(false);
    // Mas tem o essencial
    expect(set.has('worker:read')).toBe(true);
    expect(set.has('vacancy:write')).toBe(true);
    expect(set.has('funnel:write')).toBe(true);
  });

  it('grupo Community Manager: tem messaging:send, não tem vacancy:write nem talentum:*', async () => {
    type PermRow = { resource: string; action: string };
    const rows = await pool.query<PermRow>(`
      SELECT p.resource, p.action FROM group_permissions gp
      JOIN permissions p ON p.id = gp.permission_id
      WHERE gp.group_id = $1
    `, [GROUP_CM]);
    const set = new Set(rows.rows.map(r => `${r.resource}:${r.action}`));

    expect(set.has('messaging:send')).toBe(true);
    expect(set.has('messaging:read')).toBe(true);
    expect(set.has('worker:read')).toBe(true);
    expect(set.has('vacancy:write')).toBe(false);
    expect(set.has('talentum:read')).toBe(false);
    expect(set.has('interview:write')).toBe(false);
    expect(set.has('dedup:execute')).toBe(false);
  });

  it('grupo Financeiro: tem analytics:read/export, worker:read, vacancy:read, dashboard:read', async () => {
    type PermRow = { resource: string; action: string };
    const rows = await pool.query<PermRow>(`
      SELECT p.resource, p.action FROM group_permissions gp
      JOIN permissions p ON p.id = gp.permission_id
      WHERE gp.group_id = $1
    `, [GROUP_FIN]);
    const set = new Set(rows.rows.map(r => `${r.resource}:${r.action}`));

    expect(set.has('analytics:read')).toBe(true);
    expect(set.has('analytics:export')).toBe(true);
    expect(set.has('worker:read')).toBe(true);
    expect(set.has('vacancy:read')).toBe(true);
    expect(set.has('dashboard:read')).toBe(true);
  });
});

// ─── S4: get_user_effective_permissions() ────────────────────────────────────

describe('S4 — get_user_effective_permissions() retorna array correto', () => {

  beforeAll(async () => {
    // Garantir que o user de teste existe e está resetado para ACTIVE
    await pool.query(`
      INSERT INTO users (firebase_uid, email, role, tenant_id, status, is_active)
      VALUES ($1, $2, 'admin', $3, 'ACTIVE', true)
      ON CONFLICT (firebase_uid) DO UPDATE
        SET status = 'ACTIVE', is_active = true, tenant_id = $3
    `, [TEST_USER_UID, TEST_USER_EMAIL, TENANT_ENLITE]);
  });

  it('user sem grupo → retorna array vazio', async () => {
    // Garantir que o user não está em nenhum grupo
    await pool.query(
      `DELETE FROM user_groups WHERE user_id = $1`,
      [TEST_USER_UID],
    );

    const result = await pool.query<{ perms: string[] }>(`
      SELECT get_user_effective_permissions($1) AS perms
    `, [TEST_USER_UID]);

    expect(result.rows[0].perms).toEqual([]);
  });

  it('user em grupo Community Manager → retorna permissions corretas do CM', async () => {
    // Atribuir ao grupo Community Manager
    await pool.query(`
      INSERT INTO user_groups (user_id, group_id, tenant_id)
      VALUES ($1, $2, $3)
      ON CONFLICT (user_id, group_id) DO NOTHING
    `, [TEST_USER_UID, GROUP_CM, TENANT_ENLITE]);

    const result = await pool.query<{ perms: string[] }>(`
      SELECT get_user_effective_permissions($1) AS perms
    `, [TEST_USER_UID]);

    const perms = result.rows[0].perms;
    expect(perms).toContain('messaging:send');
    expect(perms).toContain('messaging:read');
    expect(perms).toContain('worker:read');
    expect(perms).toContain('dashboard:read');
    expect(perms).not.toContain('vacancy:write');
    expect(perms).not.toContain('dedup:execute');
  });

  it('user em 2 grupos → retorna UNION das permissões (sem duplicatas)', async () => {
    // Adicionar também ao grupo Financeiro
    await pool.query(`
      INSERT INTO user_groups (user_id, group_id, tenant_id)
      VALUES ($1, $2, $3)
      ON CONFLICT (user_id, group_id) DO NOTHING
    `, [TEST_USER_UID, GROUP_FIN, TENANT_ENLITE]);

    const result = await pool.query<{ perms: string[] }>(`
      SELECT get_user_effective_permissions($1) AS perms
    `, [TEST_USER_UID]);

    const perms = result.rows[0].perms;

    // Do CM
    expect(perms).toContain('messaging:send');
    // Do Financeiro (que CM não tem)
    expect(perms).toContain('analytics:export');
    // Sem duplicatas (DISTINCT na função)
    const uniquePerms = [...new Set(perms)];
    expect(perms.length).toBe(uniquePerms.length);
  });

  it('retorno é no formato "resource:action" (string concatenada)', async () => {
    const result = await pool.query<{ perms: string[] }>(`
      SELECT get_user_effective_permissions($1) AS perms
    `, [TEST_USER_UID]);

    const perms = result.rows[0].perms;
    for (const p of perms) {
      expect(p).toMatch(/^[a-z_]+:[a-z_]+$/);
    }
  });
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function getColumns(tableName: string): Promise<string[]> {
  const result = await pool.query<{ column_name: string }>(`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = $1
    ORDER BY ordinal_position
  `, [tableName]);
  return result.rows.map(r => r.column_name);
}

async function getCheckConstraint(tableName: string, columnName: string): Promise<string> {
  const result = await pool.query<{ def: string }>(`
    SELECT pg_get_constraintdef(oid) AS def
    FROM pg_constraint
    WHERE conrelid = $1::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) LIKE $2
  `, [tableName, `%${columnName}%`]);
  return result.rows.map(r => r.def).join(' ');
}
