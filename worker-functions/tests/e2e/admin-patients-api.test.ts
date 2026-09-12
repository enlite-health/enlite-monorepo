/**
 * admin-patients-api.test.ts
 *
 * End-to-end tests for:
 *   GET /api/admin/patients       — list with filters + pagination
 *   GET /api/admin/patients/stats — aggregate counters
 *
 * Uses MockAuth (USE_MOCK_AUTH=true) — no real Firebase.
 * Seeds its own patients and cleans up after each suite.
 */

import { Pool } from 'pg';
import { createApiClient, getMockToken, waitForBackend } from './helpers';
import { randomUUID } from 'crypto';

const DATABASE_URL =
  process.env.DATABASE_URL ||
  'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

const TENANT_ID = '00000000-0000-0000-0000-000000000001';
const ADMIN_GROUP_ID = 'ee270000-0f00-0002-0001-000000000001';
const ADMIN_SCOPE_ID = 'ee270000-0f00-0003-0001-000000000001';

describe('Admin Patients API', () => {
  const api = createApiClient();
  let adminToken: string;
  let staffToken: string;
  let workerToken: string;
  let pool: Pool;
  const insertedIds: string[] = [];

  // ── helpers ────────────────────────────────────────────────────────────────

  function authHeaders(token: string) {
    return { headers: { Authorization: `Bearer ${token}` } };
  }

  interface SeedInput {
    firstName?: string;
    lastName?: string;
    documentNumber?: string;
    needsAttention?: boolean;
    attentionReasons?: string[];
    clinicalSpecialty?: string | null;
    dependencyLevel?: string | null;
  }

  async function seedPatient(input: SeedInput = {}): Promise<string> {
    const id = randomUUID();
    const taskId = `task-${id}`;
    await pool.query(
      `INSERT INTO patients (
         id, clickup_task_id,
         first_name, last_name, document_number,
         needs_attention, attention_reasons,
         clinical_specialty, dependency_level
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        id,
        taskId,
        input.firstName ?? null,
        input.lastName ?? null,
        input.documentNumber ?? null,
        input.needsAttention ?? false,
        input.attentionReasons ?? [],
        input.clinicalSpecialty ?? null,
        input.dependencyLevel ?? null,
      ],
    );
    insertedIds.push(id);
    return id;
  }

  // ── lifecycle ──────────────────────────────────────────────────────────────

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    await waitForBackend(api);

    adminToken = await getMockToken(api, {
      uid: 'patients-admin-e2e',
      email: 'patients-admin@e2e.local',
      role: 'admin',
    });

    staffToken = await getMockToken(api, {
      uid: 'patients-staff-e2e',
      email: 'patients-staff@e2e.local',
      role: 'recruiter', // recruiter is a valid staff role (admin | recruiter | community_manager)
    });

    workerToken = await getMockToken(api, {
      uid: 'patients-worker-e2e',
      email: 'patients-worker@e2e.local',
      role: 'worker',
    });

    // Grupo com escopo AR VIVO (PR-9, `lex` #9): /patients/stats|funnel agora resolvem
    // país via `resolveCountryScope` (iam.effective_countries, por GRUPO — não pelo
    // `role`/claim do mock token). Sem este grant, `adminToken` teria [] e os testes
    // 16/17 (200 + contagem real) virariam 403. Os pacientes semeados abaixo nascem
    // 'AR' (default da coluna, migration 037) — o grant casa com o dado.
    // `getMockToken` NÃO grava `users` (token puro) — `user_groups.user_id` tem FK
    // para `users.firebase_uid`, então a linha precisa existir antes do grupo.
    await pool.query(
      `INSERT INTO users (firebase_uid, email, role, is_active, tenant_id) VALUES ($1, $2, 'admin', true, $3)
       ON CONFLICT (firebase_uid) DO NOTHING`,
      ['patients-admin-e2e', 'patients-admin@e2e.local', TENANT_ID],
    );
    await pool.query(
      `INSERT INTO permission_groups (id, tenant_id, name) VALUES ($1, $2, 'admin-patients-api e2e AR')`,
      [ADMIN_GROUP_ID, TENANT_ID],
    );
    await pool.query(
      `INSERT INTO user_groups (user_id, group_id, tenant_id) VALUES ($1, $2, $3)`,
      ['patients-admin-e2e', ADMIN_GROUP_ID, TENANT_ID],
    );
    await pool.query(
      `INSERT INTO group_country_scopes (id, group_id, country, granted_by, reason) VALUES ($1, $2, 'AR', 'admin-patients-api-e2e', 'grant do teste de stats/funnel')`,
      [ADMIN_SCOPE_ID, ADMIN_GROUP_ID],
    );

    // Seed patients for filter tests
    await seedPatient({ firstName: 'Francisco', lastName: 'Alomon', documentNumber: 'DOC-E2E-001', needsAttention: false });
    await seedPatient({ firstName: 'MariaNeural', lastName: 'TestNeuro', needsAttention: true, attentionReasons: ['MISSING_INFO'], clinicalSpecialty: 'NEUROLOGICAL', dependencyLevel: 'SEVERE' });
    await seedPatient({ firstName: 'JuanModerado', lastName: 'TestMod', needsAttention: false, dependencyLevel: 'MODERATE' });
    await seedPatient({ firstName: 'LuisSevere', lastName: 'TestSev', needsAttention: true, attentionReasons: ['MISSING_INFO'], dependencyLevel: 'SEVERE' });
    await seedPatient({ firstName: 'AnaGeriatric', lastName: 'TestGer', needsAttention: false, clinicalSpecialty: 'GERIATRIC' });
  });

  afterAll(async () => {
    if (insertedIds.length > 0) {
      await pool.query(
        `DELETE FROM patients WHERE id = ANY($1::uuid[])`,
        [insertedIds],
      );
    }
    await pool.query(`DELETE FROM group_country_scopes WHERE id = $1`, [ADMIN_SCOPE_ID]);
    await pool.query(`DELETE FROM user_groups WHERE group_id = $1`, [ADMIN_GROUP_ID]);
    await pool.query(`DELETE FROM permission_groups WHERE id = $1`, [ADMIN_GROUP_ID]);
    await pool.query(`DELETE FROM users WHERE firebase_uid = $1`, ['patients-admin-e2e']);
    await pool.end();
  });

  // ── GET /api/admin/patients ────────────────────────────────────────────────

  describe('GET /api/admin/patients', () => {
    it('1. returns list structure with data array and total', async () => {
      const res = await api.get('/api/admin/patients', authHeaders(adminToken));

      expect(res.status).toBe(200);
      expect(res.data.success).toBe(true);
      expect(Array.isArray(res.data.data)).toBe(true);
      expect(typeof res.data.total).toBe('number');
      expect(res.data.total).toBeGreaterThanOrEqual(5); // at least the 5 seeded
    });

    it('2. each patient has required fields', async () => {
      const res = await api.get('/api/admin/patients?limit=5', authHeaders(adminToken));

      expect(res.status).toBe(200);
      for (const p of res.data.data) {
        expect(p).toHaveProperty('id');
        expect(p).toHaveProperty('clickupTaskId');
        expect(p).toHaveProperty('firstName');
        expect(p).toHaveProperty('lastName');
        expect(p).toHaveProperty('diagnosis');
        expect(p).toHaveProperty('dependencyLevel');
        expect(p).toHaveProperty('clinicalSpecialty');
        expect(p).toHaveProperty('serviceType');
        expect(Array.isArray(p.serviceType)).toBe(true);
        expect(p).toHaveProperty('documentType');
        expect(p).toHaveProperty('documentNumber');
        expect(p).toHaveProperty('sex');
        expect(p).toHaveProperty('needsAttention');
        expect(typeof p.needsAttention).toBe('boolean');
        expect(p).toHaveProperty('attentionReasons');
        expect(Array.isArray(p.attentionReasons)).toBe(true);
        expect(p).toHaveProperty('createdAt');
        expect(p).toHaveProperty('updatedAt');
      }
    });

    it('3. search filters by firstName', async () => {
      const res = await api.get(
        '/api/admin/patients?search=Francisco',
        authHeaders(adminToken),
      );

      expect(res.status).toBe(200);
      const ids = res.data.data.map((p: any) => p.id);
      // Must include the seeded Francisco
      const seededFranciscoId = insertedIds[0];
      expect(ids).toContain(seededFranciscoId);
      // Must not include patients whose names don't match
      for (const p of res.data.data) {
        const nameMatch =
          (p.firstName ?? '').toLowerCase().includes('francisco') ||
          (p.lastName ?? '').toLowerCase().includes('francisco') ||
          (p.documentNumber ?? '').toLowerCase().includes('francisco');
        expect(nameMatch).toBe(true);
      }
    });

    it('4. search filters by documentNumber', async () => {
      const res = await api.get(
        '/api/admin/patients?search=DOC-E2E-001',
        authHeaders(adminToken),
      );

      expect(res.status).toBe(200);
      const ids = res.data.data.map((p: any) => p.id);
      expect(ids).toContain(insertedIds[0]);
    });

    it('5. needs_attention=true returns only flagged patients', async () => {
      const res = await api.get(
        '/api/admin/patients?needs_attention=true&limit=100',
        authHeaders(adminToken),
      );

      expect(res.status).toBe(200);
      expect(res.data.data.length).toBeGreaterThanOrEqual(2); // at least 2 seeded
      for (const p of res.data.data) {
        expect(p.needsAttention).toBe(true);
      }
    });

    it('6. needs_attention=false returns only non-flagged patients', async () => {
      const res = await api.get(
        '/api/admin/patients?needs_attention=false&limit=100',
        authHeaders(adminToken),
      );

      expect(res.status).toBe(200);
      for (const p of res.data.data) {
        expect(p.needsAttention).toBe(false);
      }
    });

    it('7. attention_reason=MISSING_INFO returns patients with that reason', async () => {
      const res = await api.get(
        '/api/admin/patients?attention_reason=MISSING_INFO&limit=100',
        authHeaders(adminToken),
      );

      expect(res.status).toBe(200);
      expect(res.data.data.length).toBeGreaterThanOrEqual(2);
      for (const p of res.data.data) {
        expect(p.attentionReasons).toContain('MISSING_INFO');
      }
    });

    it('8. clinical_specialty=NEUROLOGICAL filters correctly', async () => {
      const res = await api.get(
        '/api/admin/patients?clinical_specialty=NEUROLOGICAL&limit=100',
        authHeaders(adminToken),
      );

      expect(res.status).toBe(200);
      expect(res.data.data.length).toBeGreaterThanOrEqual(1);
      for (const p of res.data.data) {
        expect(p.clinicalSpecialty).toBe('NEUROLOGICAL');
      }
      const ids = res.data.data.map((p: any) => p.id);
      expect(ids).toContain(insertedIds[1]); // MariaNeural
    });

    it('9. dependency_level=SEVERE filters correctly', async () => {
      const res = await api.get(
        '/api/admin/patients?dependency_level=SEVERE&limit=100',
        authHeaders(adminToken),
      );

      expect(res.status).toBe(200);
      expect(res.data.data.length).toBeGreaterThanOrEqual(2); // NEUROLOGICAL + LuisSevere
      for (const p of res.data.data) {
        expect(p.dependencyLevel).toBe('SEVERE');
      }
    });

    it('10. limit and offset paginate correctly', async () => {
      const page1 = await api.get(
        '/api/admin/patients?limit=2&offset=0',
        authHeaders(adminToken),
      );
      const page2 = await api.get(
        '/api/admin/patients?limit=2&offset=2',
        authHeaders(adminToken),
      );

      expect(page1.status).toBe(200);
      expect(page2.status).toBe(200);
      expect(page1.data.data.length).toBe(2);
      // Pages must not share the same ids
      const ids1 = page1.data.data.map((p: any) => p.id);
      const ids2 = page2.data.data.map((p: any) => p.id);
      const overlap = ids1.filter((id: string) => ids2.includes(id));
      expect(overlap.length).toBe(0);
      // total is consistent across pages
      expect(page1.data.total).toBe(page2.data.total);
    });

    it('11. invalid dependency_level returns 400', async () => {
      const res = await api.get(
        '/api/admin/patients?dependency_level=INVALID',
        authHeaders(adminToken),
      );

      expect(res.status).toBe(400);
      expect(res.data.success).toBe(false);
    });

    it('12. invalid clinical_specialty returns 400', async () => {
      const res = await api.get(
        '/api/admin/patients?clinical_specialty=BOGUS_VALUE',
        authHeaders(adminToken),
      );

      expect(res.status).toBe(400);
      expect(res.data.success).toBe(false);
    });

    it('13. returns 401 without auth token', async () => {
      const res = await api.get('/api/admin/patients');
      expect(res.status).toBe(401);
    });

    it('14. returns 403 for worker role', async () => {
      const res = await api.get('/api/admin/patients', authHeaders(workerToken));
      expect(res.status).toBe(403);
    });

    it('15. staff role can access list', async () => {
      const res = await api.get('/api/admin/patients', authHeaders(staffToken));
      expect(res.status).toBe(200);
      expect(res.data.success).toBe(true);
    });
  });

  // ── GET /api/admin/patients/stats ─────────────────────────────────────────

  describe('GET /api/admin/patients/stats', () => {
    it('16. returns aggregate counters with correct shape', async () => {
      const res = await api.get('/api/admin/patients/stats', authHeaders(adminToken));

      expect(res.status).toBe(200);
      expect(res.data.success).toBe(true);
      expect(res.data.data).toHaveProperty('total');
      expect(res.data.data).toHaveProperty('complete');
      expect(res.data.data).toHaveProperty('needsAttention');
      expect(res.data.data).toHaveProperty('createdToday');
      expect(res.data.data).toHaveProperty('createdYesterday');
      expect(res.data.data).toHaveProperty('createdLast7Days');

      const d = res.data.data;
      expect(typeof d.total).toBe('number');
      expect(typeof d.complete).toBe('number');
      expect(typeof d.needsAttention).toBe('number');
      expect(typeof d.createdToday).toBe('number');
      expect(typeof d.createdYesterday).toBe('number');
      expect(typeof d.createdLast7Days).toBe('number');

      // Invariant: complete + needsAttention == total
      expect(d.complete + d.needsAttention).toBe(d.total);
    });

    it('17. stats reflect seeded patients (total >= 5)', async () => {
      const res = await api.get('/api/admin/patients/stats', authHeaders(adminToken));

      expect(res.status).toBe(200);
      expect(res.data.data.total).toBeGreaterThanOrEqual(5);
      // 2 seeded with needsAttention=true
      expect(res.data.data.needsAttention).toBeGreaterThanOrEqual(2);
      // 3 seeded with needsAttention=false
      expect(res.data.data.complete).toBeGreaterThanOrEqual(3);
      // All 5 seeded today
      expect(res.data.data.createdToday).toBeGreaterThanOrEqual(5);
      expect(res.data.data.createdLast7Days).toBeGreaterThanOrEqual(5);
    });

    it('18. returns 401 without auth token', async () => {
      const res = await api.get('/api/admin/patients/stats');
      expect(res.status).toBe(401);
    });

    it('19. returns 403 for worker role', async () => {
      const res = await api.get('/api/admin/patients/stats', authHeaders(workerToken));
      expect(res.status).toBe(403);
    });
  });
});
