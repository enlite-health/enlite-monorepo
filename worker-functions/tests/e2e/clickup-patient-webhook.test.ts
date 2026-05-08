/**
 * clickup-patient-webhook.test.ts
 *
 * E2E tests for POST /api/webhooks/clickup/patient.
 *
 * Strategy: spin up a local Express server (supertest) with the real
 * ClickUpHmacMiddleware + ClickUpPatientWebhookController wired together,
 * but with:
 *   - global.fetch mocked (prevents real HTTP calls to api.clickup.com)
 *   - DatabaseConnection pointing at the real test Postgres (via DATABASE_URL)
 *
 * This validates the full HTTP pipeline (HMAC → body schema → list filter →
 * task fetch → UseCase → DB) without depending on CLICKUP_API_TOKEN being
 * set in the test environment, since ClickUpFieldResolver.fromList is also
 * mocked.
 *
 * Why supertest instead of calling the Docker API server:
 *   The Docker API server (enlite-api) does not set CLICKUP_WEBHOOK_SECRET,
 *   so the route is unavailable at runtime. Mounting our own server is the
 *   only way to test this route end-to-end without modifying production code.
 *
 * What IS real:
 *   - Express middleware stack (rawBody capture, HMAC verification)
 *   - ClickUpPatientWebhookController.handle() logic
 *   - SyncPatientFromClickUpTaskUseCase
 *   - PatientService + PatientIdentityRepository
 *   - PostgreSQL (real DB via DATABASE_URL)
 *
 * What IS mocked:
 *   - global.fetch  (intercepted by the controller's fetchTask + ClickUpFieldResolver.fromList)
 */

// ── Mocks must come before any module imports ─────────────────────────────────

const mockFetch = jest.fn();
global.fetch = mockFetch as unknown as typeof fetch;

// Silence firebase-functions logger in tests
jest.mock('firebase-functions', () => ({
  logger: {
    info:  jest.fn(),
    warn:  jest.fn(),
    error: jest.fn(),
  },
}));

// ── Imports ───────────────────────────────────────────────────────────────────

import * as crypto from 'crypto';
import express, { Request, Response } from 'express';
import supertest from 'supertest';
import { Pool } from 'pg';
import { ClickUpPatientWebhookController } from '../../src/modules/integration/interfaces/webhooks/controllers/ClickUpPatientWebhookController';
import { ClickUpHmacMiddleware } from '../../src/modules/integration/interfaces/webhooks/middleware/ClickUpHmacMiddleware';
import { ClickUpFieldResolver } from '../../src/modules/integration/infrastructure/clickup/ClickUpFieldResolver';
import { ClickUpPatientMapper } from '../../src/modules/integration/infrastructure/clickup/ClickUpPatientMapper';
import { PatientService } from '../../src/modules/case/application/PatientService';

// ── Constants ─────────────────────────────────────────────────────────────────

const WEBHOOK_SECRET  = 'test-secret-e2e-clickup';
const PATIENT_LIST_ID = '901304883903';
const OTHER_LIST_ID   = '999000000001';
const DATABASE_URL    =
  process.env.DATABASE_URL ||
  'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

// Task IDs use a prefix that allows surgical cleanup in afterEach
const TASK_PREFIX = 'cu-e2e-webhook-test-';

// ── Helpers ───────────────────────────────────────────────────────────────────

function signBody(rawBody: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
}

/**
 * Build a ClickUp task fixture.
 * All required name fields are filled so ClickUpPatientMapper does not return
 * null (which would cause SKIPPED_NO_PATIENT_NAME, not a persistence).
 */
function makeClickUpTask(
  taskId: string,
  overrides: { listId?: string; parent?: string | null; caseNumber?: number } = {},
) {
  const listId     = overrides.listId     ?? PATIENT_LIST_ID;
  const parent     = overrides.parent     ?? null;
  const caseNumber = overrides.caseNumber ?? 9001;

  return {
    id:     taskId,
    name:   'García, Ana E2E',
    status: { status: 'activo', color: '#00c800', type: 'custom' },
    parent,
    url:    `https://app.clickup.com/t/${taskId}`,
    date_created: '1700000000000',
    date_updated: '1700100000000',
    list:   { id: listId, name: 'Estado de Pacientes' },
    custom_fields: [
      { id: 'cf-nombre',    name: 'Nombre de Paciente',   type: 'text', value: 'Ana E2E' },
      { id: 'cf-apellido',  name: 'Apellido del Paciente', type: 'text', value: 'García' },
      { id: 'cf-caso',      name: 'Caso Número',           type: 'number', value: caseNumber },
      { id: 'cf-dom1',      name: 'Domicilio 1 Principal Paciente', type: 'location', value: null },
      { id: 'cf-raw1',      name: 'Domicilio Informado Paciente 1', type: 'text', value: null },
      { id: 'cf-dom2',      name: 'Domicilio 2 Principal Paciente', type: 'location', value: null },
      { id: 'cf-raw2',      name: 'Domicilio Informado Paciente 2', type: 'text', value: null },
      { id: 'cf-dom3',      name: 'Domicilio 3 Principal Paciente', type: 'location', value: null },
      { id: 'cf-raw3',      name: 'Domicilio Informado Paciente 3', type: 'text', value: null },
    ],
  };
}

/**
 * Build a minimal stub ClickUpFieldResolver that resolves nothing (all nulls).
 * This is sufficient because the mapper tests we care about (name extraction)
 * do not rely on dropdown resolution.
 */
function makeStubResolver(): ClickUpFieldResolver {
  return {
    resolveDropdown: () => null,
    resolveLabel:    () => null,
    resolveLabels:   () => [],
    getFieldType:    () => null,
    dropdownFieldNames: [],
    labelsFieldNames:   [],
    getDropdownOptions: () => ({}),
    getLabelsOptions:   () => ({}),
  } as unknown as ClickUpFieldResolver;
}

/**
 * Build a valid webhook body JSON string and its HMAC signature.
 */
function makeSignedWebhookBody(body: Record<string, unknown>): {
  bodyJson: string;
  signature: string;
} {
  const bodyJson  = JSON.stringify(body);
  const signature = signBody(bodyJson, WEBHOOK_SECRET);
  return { bodyJson, signature };
}

// ── App factory ───────────────────────────────────────────────────────────────

/**
 * Build a minimal Express app with the real middleware + controller stack.
 * rawBody capture mirrors the production app.use(express.json({ verify: ... })).
 */
function buildTestApp(pool: Pool): express.Express {
  const app = express();

  app.use(
    express.json({
      verify: (req, _res, buf) => {
        (req as Request & { rawBody?: string }).rawBody = buf.toString('utf8');
      },
    }),
  );

  const hmac = new ClickUpHmacMiddleware(WEBHOOK_SECRET);

  const resolver     = makeStubResolver();
  const mapper       = new ClickUpPatientMapper(resolver);
  const patientSvc   = new PatientService();
  const controller   = new ClickUpPatientWebhookController(
    'mock-clickup-token',
    resolver,
    mapper,
    patientSvc,
    pool,
  );

  app.post(
    '/api/webhooks/clickup/patient',
    hmac.verify(),
    (req: Request, res: Response) => controller.handle(req, res),
  );

  return app;
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe('POST /api/webhooks/clickup/patient (E2E with real DB)', () => {
  let pool: Pool;
  let app: express.Express;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    app  = buildTestApp(pool);
  });

  afterAll(async () => {
    // Belt-and-suspenders cleanup of any lingering test rows
    await pool.query(
      `DELETE FROM patients WHERE clickup_task_id LIKE $1`,
      [`${TASK_PREFIX}%`],
    ).catch(() => {});
    await pool.end();
  });

  afterEach(async () => {
    // Clean rows inserted or soft-deleted during the test
    await pool.query(
      `DELETE FROM patients WHERE clickup_task_id LIKE $1`,
      [`${TASK_PREFIX}%`],
    ).catch(() => {});
    mockFetch.mockReset();
  });

  // ──────────────────────────────────────────────────────────────────
  // Auth layer — HMAC
  // ──────────────────────────────────────────────────────────────────

  describe('Auth — HMAC', () => {
    it('1. HMAC inválido → 401 e nenhuma linha inserida', async () => {
      const taskId  = `${TASK_PREFIX}hmac-bad`;
      const bodyJson = JSON.stringify({
        event:      'taskCreated',
        webhook_id: 'wh-test',
        task_id:    taskId,
        list_id:    PATIENT_LIST_ID,
      });

      const res = await supertest(app)
        .post('/api/webhooks/clickup/patient')
        .set('Content-Type', 'application/json')
        .set('X-Signature', 'wrong-signature-hex')
        .send(bodyJson);

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);

      // No DB write expected
      const { rows } = await pool.query(
        `SELECT id FROM patients WHERE clickup_task_id = $1`,
        [taskId],
      );
      expect(rows).toHaveLength(0);
    });

    it('2. Sem header X-Signature → 401', async () => {
      const bodyJson = JSON.stringify({
        event:      'taskCreated',
        webhook_id: 'wh-test',
        task_id:    `${TASK_PREFIX}no-sig`,
        list_id:    PATIENT_LIST_ID,
      });

      const res = await supertest(app)
        .post('/api/webhooks/clickup/patient')
        .set('Content-Type', 'application/json')
        .send(bodyJson);

      expect(res.status).toBe(401);
      expect(res.body.error).toContain('X-Signature');
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // Body schema validation
  // ──────────────────────────────────────────────────────────────────

  describe('Body schema validation', () => {
    it('3. Body com HMAC válido mas sem task_id → 400', async () => {
      // Missing task_id — Zod should reject
      const { bodyJson, signature } = makeSignedWebhookBody({
        event:      'taskCreated',
        webhook_id: 'wh-test',
        // task_id intentionally absent
        list_id: PATIENT_LIST_ID,
      });

      const res = await supertest(app)
        .post('/api/webhooks/clickup/patient')
        .set('Content-Type', 'application/json')
        .set('X-Signature', signature)
        .send(bodyJson);

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('invalid body schema');
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // Filtering layers (no DB writes expected)
  // ──────────────────────────────────────────────────────────────────

  describe('Filtering layers', () => {
    it('4. list_id no payload diferente do PATIENT_LIST_ID → 200 skipped_other_list (sem fetch)', async () => {
      const taskId = `${TASK_PREFIX}other-list-body`;

      const { bodyJson, signature } = makeSignedWebhookBody({
        event:      'taskCreated',
        webhook_id: 'wh-test',
        task_id:    taskId,
        list_id:    OTHER_LIST_ID,
      });

      const res = await supertest(app)
        .post('/api/webhooks/clickup/patient')
        .set('Content-Type', 'application/json')
        .set('X-Signature', signature)
        .send(bodyJson);

      expect(res.status).toBe(200);
      expect(res.body.action).toBe('skipped_other_list');
      // fetch was never called (early return before GET task)
      expect(mockFetch).not.toHaveBeenCalled();

      // No row in DB
      const { rows } = await pool.query(
        `SELECT id FROM patients WHERE clickup_task_id = $1`,
        [taskId],
      );
      expect(rows).toHaveLength(0);
    });

    it('5. task.list.id diferente (verificado após GET task) → 200 skipped_task_other_list', async () => {
      const taskId = `${TASK_PREFIX}other-list-task`;
      const task   = makeClickUpTask(taskId, { listId: OTHER_LIST_ID });

      mockFetch.mockResolvedValueOnce({ ok: true, json: async () => task });

      const { bodyJson, signature } = makeSignedWebhookBody({
        event:      'taskCreated',
        webhook_id: 'wh-test',
        task_id:    taskId,
        // No list_id in body → skip layer 3, proceed to GET task
      });

      const res = await supertest(app)
        .post('/api/webhooks/clickup/patient')
        .set('Content-Type', 'application/json')
        .set('X-Signature', signature)
        .send(bodyJson);

      expect(res.status).toBe(200);
      expect(res.body.action).toBe('skipped_task_other_list');

      // Fetch was called once (GET task)
      expect(mockFetch).toHaveBeenCalledTimes(1);

      const { rows } = await pool.query(
        `SELECT id FROM patients WHERE clickup_task_id = $1`,
        [taskId],
      );
      expect(rows).toHaveLength(0);
    });

    it('6. task.parent !== null (subtask) → 200 synced com kind=SKIPPED_SUBTASK', async () => {
      const taskId = `${TASK_PREFIX}subtask`;
      const task   = makeClickUpTask(taskId, { parent: 'parent-task-000' });

      mockFetch.mockResolvedValueOnce({ ok: true, json: async () => task });

      const { bodyJson, signature } = makeSignedWebhookBody({
        event:      'taskCreated',
        webhook_id: 'wh-test',
        task_id:    taskId,
        list_id:    PATIENT_LIST_ID,
      });

      const res = await supertest(app)
        .post('/api/webhooks/clickup/patient')
        .set('Content-Type', 'application/json')
        .set('X-Signature', signature)
        .send(bodyJson);

      expect(res.status).toBe(200);
      expect(res.body.action).toBe('synced');
      expect(res.body.result.kind).toBe('SKIPPED_SUBTASK');

      const { rows } = await pool.query(
        `SELECT id FROM patients WHERE clickup_task_id = $1`,
        [taskId],
      );
      expect(rows).toHaveLength(0);
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // Happy path — taskCreated persists patient in DB
  // ──────────────────────────────────────────────────────────────────

  describe('Happy path — persistence', () => {
    it('7. taskCreated com task válida → 200, patient criado no DB', async () => {
      const taskId = `${TASK_PREFIX}created-ok`;
      const task   = makeClickUpTask(taskId, { caseNumber: 9900 });

      mockFetch.mockResolvedValueOnce({ ok: true, json: async () => task });

      const { bodyJson, signature } = makeSignedWebhookBody({
        event:      'taskCreated',
        webhook_id: 'wh-test',
        task_id:    taskId,
        list_id:    PATIENT_LIST_ID,
      });

      const res = await supertest(app)
        .post('/api/webhooks/clickup/patient')
        .set('Content-Type', 'application/json')
        .set('X-Signature', signature)
        .send(bodyJson);

      expect(res.status).toBe(200);
      expect(res.body.action).toBe('synced');
      expect(['CREATED', 'UPDATED']).toContain(res.body.result.kind);

      // Verify DB row
      const { rows } = await pool.query(
        `SELECT clickup_task_id, first_name, last_name, case_number
         FROM patients
         WHERE clickup_task_id = $1`,
        [taskId],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].clickup_task_id).toBe(taskId);
      // Mapper extracts name from custom fields
      expect(rows[0].first_name).toBe('Ana E2E');
      expect(rows[0].last_name).toBe('García');
      expect(Number(rows[0].case_number)).toBe(9900);
    });

    it('8. taskUpdated re-disparo da mesma task → idempotência (mesmo clickup_task_id, sem duplicata)', async () => {
      const taskId = `${TASK_PREFIX}idempotent`;
      const task   = makeClickUpTask(taskId, { caseNumber: 9901 });

      // First call — taskCreated
      mockFetch.mockResolvedValueOnce({ ok: true, json: async () => task });

      const body1 = makeSignedWebhookBody({
        event: 'taskCreated', webhook_id: 'wh-1', task_id: taskId, list_id: PATIENT_LIST_ID,
      });

      const res1 = await supertest(app)
        .post('/api/webhooks/clickup/patient')
        .set('Content-Type', 'application/json')
        .set('X-Signature', body1.signature)
        .send(body1.bodyJson);

      expect(res1.status).toBe(200);
      expect(res1.body.result.kind).toBe('CREATED');

      // Second call — taskUpdated (same task, same clickup_task_id)
      mockFetch.mockResolvedValueOnce({ ok: true, json: async () => task });

      const body2 = makeSignedWebhookBody({
        event: 'taskUpdated', webhook_id: 'wh-2', task_id: taskId, list_id: PATIENT_LIST_ID,
      });

      const res2 = await supertest(app)
        .post('/api/webhooks/clickup/patient')
        .set('Content-Type', 'application/json')
        .set('X-Signature', body2.signature)
        .send(body2.bodyJson);

      expect(res2.status).toBe(200);
      expect(res2.body.result.kind).toBe('UPDATED');

      // Only one row
      const { rows } = await pool.query(
        `SELECT id FROM patients WHERE clickup_task_id = $1`,
        [taskId],
      );
      expect(rows).toHaveLength(1);
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // taskDeleted
  // ──────────────────────────────────────────────────────────────────

  describe('taskDeleted', () => {
    it('9. taskDeleted para patient existente → 200 soft_deleted, deleted_at IS NOT NULL no DB', async () => {
      const taskId = `${TASK_PREFIX}to-delete`;

      // Seed a patient row directly in DB
      await pool.query(
        `INSERT INTO patients (clickup_task_id, first_name, last_name, country)
         VALUES ($1, 'Ana', 'García', 'AR')
         ON CONFLICT (clickup_task_id) DO NOTHING`,
        [taskId],
      );

      const { bodyJson, signature } = makeSignedWebhookBody({
        event:      'taskDeleted',
        webhook_id: 'wh-del',
        task_id:    taskId,
        list_id:    PATIENT_LIST_ID,
      });

      const res = await supertest(app)
        .post('/api/webhooks/clickup/patient')
        .set('Content-Type', 'application/json')
        .set('X-Signature', signature)
        .send(bodyJson);

      expect(res.status).toBe(200);
      expect(res.body.action).toBe('soft_deleted');
      expect(res.body.affectedRows).toBe(1);

      // No fetch needed for taskDeleted
      expect(mockFetch).not.toHaveBeenCalled();

      // Verify soft delete in DB
      const { rows } = await pool.query(
        `SELECT deleted_at FROM patients WHERE clickup_task_id = $1`,
        [taskId],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].deleted_at).not.toBeNull();
    });

    it('10. taskDeleted para clickup_task_id que não existe no DB → 200 affectedRows=0', async () => {
      const taskId = `${TASK_PREFIX}nonexistent-delete`;

      const { bodyJson, signature } = makeSignedWebhookBody({
        event:      'taskDeleted',
        webhook_id: 'wh-del-none',
        task_id:    taskId,
        list_id:    PATIENT_LIST_ID,
      });

      const res = await supertest(app)
        .post('/api/webhooks/clickup/patient')
        .set('Content-Type', 'application/json')
        .set('X-Signature', signature)
        .send(bodyJson);

      expect(res.status).toBe(200);
      expect(res.body.action).toBe('soft_deleted');
      expect(res.body.affectedRows).toBe(0);
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // Edge cases
  // ──────────────────────────────────────────────────────────────────

  describe('Edge cases', () => {
    it('11. CASE_NUMBER_CONFLICT — segundo sync com mesmo case_number: patient2 criado com case_number NULL e needs_attention=true', async () => {
      const taskId1 = `${TASK_PREFIX}conflict-first`;
      const taskId2 = `${TASK_PREFIX}conflict-second`;
      // Use a unique high case number unlikely to collide with existing data
      const sharedCaseNumber = 99801;

      // First sync — creates patient1 with case_number=sharedCaseNumber
      const task1 = makeClickUpTask(taskId1, { caseNumber: sharedCaseNumber });
      mockFetch.mockResolvedValueOnce({ ok: true, json: async () => task1 });

      const body1 = makeSignedWebhookBody({
        event: 'taskCreated', webhook_id: 'wh-c1', task_id: taskId1, list_id: PATIENT_LIST_ID,
      });

      const res1 = await supertest(app)
        .post('/api/webhooks/clickup/patient')
        .set('Content-Type', 'application/json')
        .set('X-Signature', body1.signature)
        .send(body1.bodyJson);

      expect(res1.status).toBe(200);
      expect(res1.body.result.kind).toBe('CREATED');

      // Second sync — different task but same case_number → CONFLICT
      const task2 = makeClickUpTask(taskId2, { caseNumber: sharedCaseNumber });
      mockFetch.mockResolvedValueOnce({ ok: true, json: async () => task2 });

      const body2 = makeSignedWebhookBody({
        event: 'taskCreated', webhook_id: 'wh-c2', task_id: taskId2, list_id: PATIENT_LIST_ID,
      });

      const res2 = await supertest(app)
        .post('/api/webhooks/clickup/patient')
        .set('Content-Type', 'application/json')
        .set('X-Signature', body2.signature)
        .send(body2.bodyJson);

      expect(res2.status).toBe(200);
      expect(res2.body.action).toBe('synced');
      expect(res2.body.result.kind).toBe('CASE_NUMBER_CONFLICT');

      // Verify patient2 has case_number=NULL and needs_attention=true
      const { rows } = await pool.query(
        `SELECT case_number, needs_attention, attention_reasons
         FROM patients
         WHERE clickup_task_id = $1`,
        [taskId2],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].case_number).toBeNull();
      expect(rows[0].needs_attention).toBe(true);
      expect(rows[0].attention_reasons).toContain('CASE_NUMBER_CONFLICT');
    });

    it('12. GET task falha (5xx do ClickUp) → 200 fetch_failed sem escrita no DB', async () => {
      const taskId = `${TASK_PREFIX}fetch-fail`;

      mockFetch.mockResolvedValueOnce({
        ok:         false,
        status:     503,
        statusText: 'Service Unavailable',
      });

      const { bodyJson, signature } = makeSignedWebhookBody({
        event:      'taskCreated',
        webhook_id: 'wh-fail',
        task_id:    taskId,
        list_id:    PATIENT_LIST_ID,
      });

      const res = await supertest(app)
        .post('/api/webhooks/clickup/patient')
        .set('Content-Type', 'application/json')
        .set('X-Signature', signature)
        .send(bodyJson);

      expect(res.status).toBe(200);
      expect(res.body.action).toBe('fetch_failed');

      const { rows } = await pool.query(
        `SELECT id FROM patients WHERE clickup_task_id = $1`,
        [taskId],
      );
      expect(rows).toHaveLength(0);
    });
  });
});
