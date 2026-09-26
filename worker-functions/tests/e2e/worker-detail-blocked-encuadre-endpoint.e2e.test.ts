/**
 * worker-detail-blocked-encuadre-endpoint.e2e.test.ts
 *
 * ClickUp 86ajeu7vw — prova de GARANTIA end-to-end (endpoint real) de que a aba
 * de Encuadres do perfil do prestador inclui os casos em status REJECTED com o
 * estágio (coluna do Kanban) — o caso "Júlia" da reunião: clicou postular, ficou
 * bloqueada por cadastro incompleto e NÃO aparecia na lista dela.
 *
 * Diferente do repo-level (blocked-application-repos.integration): aqui vai pelo
 * HTTP GET /api/admin/workers/:id, batendo na API que roda ESTE código, provando
 * o caminho endpoint → AdminWorkersDetailBuilder (união WJA ∪ blocked) → DB.
 *
 * Rodar isolado:
 *   cd worker-functions && DATABASE_URL=...:5433/enlite_e2e API_URL=http://localhost:8081 \
 *     npx jest --config jest.config.e2e.js worker-detail-blocked-encuadre-endpoint
 */

import { Pool } from 'pg';
import { createApiClient, getMockToken, waitForBackend } from './helpers';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { BlockedApplicationRepository } = require('../../src/modules/matching/infrastructure/BlockedApplicationRepository') as typeof import('../../src/modules/matching/infrastructure/BlockedApplicationRepository');

const DATABASE_URL =
  process.env.DATABASE_URL ||
  'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

if (!process.env.DATABASE_URL) process.env.DATABASE_URL = DATABASE_URL;

const SUFFIX = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const CASE_NUMBER = 99801;

const api = createApiClient();
let pool: Pool;
let adminToken: string;
let workerId: string;
let patientId: string;
let vacancyId: string;

interface Encuadre {
  caseNumber: number | null;
  kanbanStage: string;
  isBlocked?: boolean;
}

beforeAll(async () => {
  await waitForBackend(api);
  adminToken = await getMockToken(api, {
    uid: `blk-endpoint-admin-${SUFFIX}`,
    email: `blk-endpoint-admin-${SUFFIX}@blocked.test`,
    role: 'admin',
  });

  pool = new Pool({ connectionString: DATABASE_URL });

  const { rows: pRows } = await pool.query<{ id: string }>(
    `INSERT INTO patients (clickup_task_id, first_name, last_name, country, status)
     VALUES ($1, 'Julia', 'Bloqueada', 'AR', 'ACTIVE') RETURNING id`,
    [`e2e-blk-endpoint-${SUFFIX}`],
  );
  patientId = pRows[0].id;

  const { rows: vRows } = await pool.query<{ id: string }>(
    `INSERT INTO job_postings (title, country, status, patient_id, case_number)
     VALUES ('Vaga Bloqueada Endpoint', 'AR', 'SEARCHING', $1, $2) RETURNING id`,
    [patientId, CASE_NUMBER],
  );
  vacancyId = vRows[0].id;

  const { rows: wRows } = await pool.query<{ id: string }>(
    `INSERT INTO workers (auth_uid, email, status, country, timezone)
     VALUES ($1, $2, 'INCOMPLETE_REGISTER', 'AR', 'America/Argentina/Buenos_Aires') RETURNING id`,
    [`uid-blk-endpoint-${SUFFIX}`, `blk-endpoint-${SUFFIX}@blocked.test`],
  );
  workerId = wRows[0].id;

  // Write path real: registra a tentativa bloqueada (cadastro incompleto).
  const repo = new BlockedApplicationRepository();
  await repo.upsert({
    workerId,
    jobPostingId: vacancyId,
    reason: 'registration_incomplete',
    acquisitionChannel: 'e2e',
  });
});

afterAll(async () => {
  if (!pool) return;
  await pool.query(`DELETE FROM worker_blocked_applications WHERE worker_id = $1`, [workerId]);
  await pool.query(`DELETE FROM workers WHERE id = $1`, [workerId]);
  await pool.query(`DELETE FROM job_postings WHERE id = $1`, [vacancyId]);
  await pool.query(`DELETE FROM patients WHERE id = $1`, [patientId]);
  await pool.end();
});

describe('GET /api/admin/workers/:id — aba Encuadres inclui casos REJECTED (endpoint real)', () => {
  it('o caso bloqueado aparece nos encuadres com kanbanStage=REJECTED e isBlocked', async () => {
    const res = await api.get(`/api/admin/workers/${workerId}`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(res.status).toBe(200);
    expect(res.data.success).toBe(true);

    const encuadres: Encuadre[] = res.data.data.encuadres;
    expect(Array.isArray(encuadres)).toBe(true);

    const blockedCase = encuadres.find((e) => e.caseNumber === CASE_NUMBER);
    expect(blockedCase).toBeDefined();
    expect(blockedCase?.kanbanStage).toBe('REJECTED');
    expect(blockedCase?.isBlocked).toBe(true);
  });
});
