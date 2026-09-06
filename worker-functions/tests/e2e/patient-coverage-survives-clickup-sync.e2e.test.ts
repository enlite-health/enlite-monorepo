/**
 * patient-coverage-survives-clickup-sync.e2e.test.ts — spec 011, A3 (lex PARE → caminho a).
 *
 * A cobertura que o painel grava fica em `health_insurance_name` (fill-only no
 * upsert do ClickUp). A ficha lia `insurance_informed`, que o MESMO upsert
 * sobrescreve incondicionalmente com o que o mapper manda — e o mapper nunca a
 * seta. Resultado medido: cobertura gravada, invisível; e, se a escrita fosse
 * movida para `insurance_informed`, o próximo webhook a apagaria.
 *
 * Prova exigida pelo lex, contra Postgres REAL, com o webhook real reexecutado:
 *   1. webhook do ClickUp cria o paciente (clickup_task_id);
 *   2. o painel grava a cobertura (PATCH general → PatientService.updatePatientSection);
 *   3. a ficha mostra a cobertura;
 *   4. o webhook roda DE NOVO → `insurance_informed` cru continua NULL
 *      (documenta a sobrescrita) e a ficha CONTINUA mostrando a cobertura.
 * Controle positivo (D157): remover o COALESCE do PatientDetailQueryHelper deixa
 * o passo 3 vermelho — colado no relatório da spec.
 *
 * Molde: clickup-patient-webhook.test.ts (supertest + controller real + fetch mockado).
 */

const mockFetch = jest.fn();
global.fetch = mockFetch as unknown as typeof fetch;

jest.mock('firebase-functions', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import * as crypto from 'crypto';
import express, { Request, Response } from 'express';
import supertest from 'supertest';
import { Pool } from 'pg';
import { ClickUpPatientWebhookController } from '../../src/modules/integration/interfaces/webhooks/controllers/ClickUpPatientWebhookController';
import { ClickUpHmacMiddleware } from '../../src/modules/integration/interfaces/webhooks/middleware/ClickUpHmacMiddleware';
import { ClickUpFieldResolver } from '../../src/modules/integration/infrastructure/clickup/ClickUpFieldResolver';
import { ClickUpPatientMapper } from '../../src/modules/integration/infrastructure/clickup/ClickUpPatientMapper';
import { PatientService } from '../../src/modules/case/application/PatientService';
import { PatientQueryRepository } from '../../src/modules/case/infrastructure/PatientQueryRepository';

const WEBHOOK_SECRET  = 'test-secret-e2e-clickup';
const PATIENT_LIST_ID = '901304883903';
const DATABASE_URL    = process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';
if (!process.env.DATABASE_URL) process.env.DATABASE_URL = DATABASE_URL;

const TASK_ID  = 'cu-e2e-a3-coverage-survives';
const COVERAGE = 'OSDE 210 (e2e A3)';

function makeClickUpTask(taskId: string) {
  return {
    id: taskId,
    name: 'Cobertura, Sobrevive E2E',
    status: { status: 'activo', color: '#00c800', type: 'custom' },
    parent: null,
    url: `https://app.clickup.com/t/${taskId}`,
    date_created: '1700000000000',
    date_updated: '1700100000000',
    list: { id: PATIENT_LIST_ID, name: 'Estado de Pacientes' },
    custom_fields: [
      { id: 'cf-nombre',   name: 'Nombre de Paciente',    type: 'text',   value: 'Sobrevive' },
      { id: 'cf-apellido', name: 'Apellido del Paciente', type: 'text',   value: 'Cobertura E2E' },
      { id: 'cf-caso',     name: 'Caso Número',           type: 'number', value: 9311 },
    ],
  };
}

function makeStubResolver(): ClickUpFieldResolver {
  return {
    resolveDropdown: () => null, resolveLabel: () => null, resolveLabels: () => [],
    // Preflight 1.11 (migrations 304-310): `null` = campo renomeado/apagado → o mapper recusa
    // a task inteira de propósito. O stub diz que os campos EXISTEM.
    getFieldType: () => 'drop_down', dropdownFieldNames: [], labelsFieldNames: [],
    getDropdownOptions: () => ({}), getLabelsOptions: () => ({}),
  } as unknown as ClickUpFieldResolver;
}

function buildTestApp(pool: Pool): express.Express {
  const app = express();
  app.use(express.json({ verify: (req, _res, buf) => { (req as Request & { rawBody?: string }).rawBody = buf.toString('utf8'); } }));
  const resolver = makeStubResolver();
  const controller = new ClickUpPatientWebhookController('mock-clickup-token', resolver, new ClickUpPatientMapper(resolver), new PatientService(), pool);
  app.post('/api/webhooks/clickup/patient', new ClickUpHmacMiddleware(WEBHOOK_SECRET).verify(), (req: Request, res: Response) => controller.handle(req, res));
  return app;
}

async function fireWebhook(app: express.Express): Promise<void> {
  mockFetch.mockResolvedValueOnce({ ok: true, json: async () => makeClickUpTask(TASK_ID) });
  const bodyJson = JSON.stringify({ event: 'taskUpdated', webhook_id: 'wh-a3', task_id: TASK_ID, list_id: PATIENT_LIST_ID });
  const signature = crypto.createHmac('sha256', WEBHOOK_SECRET).update(bodyJson).digest('hex');
  const res = await supertest(app).post('/api/webhooks/clickup/patient').set('Content-Type', 'application/json').set('X-Signature', signature).send(bodyJson);
  expect(res.status).toBe(200);
  expect(res.body.action).toBe('synced');
}

describe('A3 — a cobertura gravada pelo painel sobrevive ao webhook do ClickUp (Postgres real)', () => {
  let pool: Pool;
  let app: express.Express;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    app = buildTestApp(pool);
    await pool.query('DELETE FROM patients WHERE clickup_task_id = $1', [TASK_ID]);
  });

  afterAll(async () => {
    await pool.query('DELETE FROM patients WHERE clickup_task_id = $1', [TASK_ID]).catch(() => {});
    await pool.end();
  });

  it('webhook cria → painel grava cobertura → ficha mostra → webhook de novo → ficha AINDA mostra', async () => {
    // 1. O paciente nasce pelo webhook (é o caso dos ~382 importados).
    await fireWebhook(app);
    const { rows } = await pool.query<{ id: string }>('SELECT id FROM patients WHERE clickup_task_id = $1', [TASK_ID]);
    expect(rows).toHaveLength(1);
    const patientId = rows[0].id;

    // 2. O painel grava a cobertura — na coluna protegida (fill-only), como hoje.
    await new PatientService().updatePatientSection(patientId, 'general', { healthInsuranceName: COVERAGE });

    // 3. A ficha mostra a cobertura (era NULL antes do COALESCE — este é o passo RED).
    const repo = new PatientQueryRepository();
    const before = await repo.findDetailById(patientId);
    expect(before?.insuranceInformed).toBe(COVERAGE);

    // 4. O webhook roda de novo. `insurance_informed` cru fica NULL (o upsert sobrescreve
    //    com o que o mapper manda, e ele não manda) — e a ficha continua mostrando.
    await fireWebhook(app);
    const raw = await pool.query<{ ii: string | null; hin: string | null }>(
      'SELECT insurance_informed AS ii, health_insurance_name AS hin FROM patients WHERE id = $1', [patientId],
    );
    expect(raw.rows[0].ii).toBeNull();
    expect(raw.rows[0].hin).toBe(COVERAGE);

    const after = await repo.findDetailById(patientId);
    expect(after?.insuranceInformed).toBe(COVERAGE);
  });
});
