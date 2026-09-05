/**
 * ClickUpPatientWebhookController — Unit Tests
 *
 * Cenários cobertos:
 *
 *  1. Body schema inválido → 400
 *  2. list_id no body diferente do PATIENT_LIST_ID → 200 skipped_other_list
 *  3. taskDeleted → UPDATE no DB + 200 soft_deleted (affectedRows=1)
 *  4. taskDeleted com clickup_task_id que não existe → 200 affectedRows=0
 *  5. taskCreated com fetch OK + list correta → chama UseCase + 200 synced
 *  6. task.list.id diferente → 200 skipped_task_other_list
 *  7. fetch task falha (5xx) → 200 fetch_failed (sem retry storm)
 *  8. UseCase retorna CASE_NUMBER_CONFLICT → 200 com kind correto
 *  9. UseCase retorna SKIPPED_SUBTASK → 200 synced com kind=SKIPPED_SUBTASK
 * 10. list_id ausente no payload → não filtra por lista (não faz skip precoce)
 */

// ── Mocks (before imports) ────────────────────────────────────────────────────

const mockLoggerInfo  = jest.fn();
const mockLoggerWarn  = jest.fn();
const mockLoggerError = jest.fn();

jest.mock('firebase-functions', () => ({
  logger: {
    info:  (...args: unknown[]) => mockLoggerInfo(...args),
    warn:  (...args: unknown[]) => mockLoggerWarn(...args),
    error: (...args: unknown[]) => mockLoggerError(...args),
  },
}));

const mockDbQuery = jest.fn();
jest.mock('@shared/database/DatabaseConnection', () => ({
  DatabaseConnection: {
    getInstance: jest.fn().mockReturnValue({
      getPool: jest.fn().mockReturnValue({ query: mockDbQuery }),
    }),
  },
}));

const mockUseCaseExecute = jest.fn();
jest.mock('../../../../application/SyncPatientFromClickUpTaskUseCase', () => ({
  SyncPatientFromClickUpTaskUseCase: jest.fn().mockImplementation(() => ({
    execute: mockUseCaseExecute,
  })),
}));

const mockMapperMap = jest.fn();
jest.mock('../../../../infrastructure/clickup/ClickUpPatientMapper', () => ({
  ClickUpPatientMapper: jest.fn().mockImplementation(() => ({
    map: mockMapperMap,
  })),
}));

const mockPatientServiceUpsert = jest.fn();
jest.mock('../../../../../case/application/PatientService', () => ({
  PatientService: jest.fn().mockImplementation(() => ({
    upsertFromClickUp: mockPatientServiceUpsert,
  })),
}));

const mockFieldResolverFromList = jest.fn();
jest.mock('../../../../infrastructure/clickup/ClickUpFieldResolver', () => ({
  ClickUpFieldResolver: {
    fromList: mockFieldResolverFromList,
  },
}));

const mockFetch = jest.fn();
global.fetch = mockFetch as unknown as typeof fetch;

// ── Imports ───────────────────────────────────────────────────────────────────

import { Request, Response } from 'express';
import { ClickUpPatientWebhookController } from '../ClickUpPatientWebhookController';
import { ClickUpFieldResolver } from '../../../../infrastructure/clickup/ClickUpFieldResolver';
import { ClickUpPatientMapper } from '../../../../infrastructure/clickup/ClickUpPatientMapper';
import { PatientService } from '../../../../../case/application/PatientService';
import { Pool } from 'pg';

// ─────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────

const PATIENT_LIST_ID = '901304883903';
const OTHER_LIST_ID   = '999999999999';

// ─────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────

function makeMockRes(): { res: Partial<Response>; statusCode: () => number | null; body: () => unknown } {
  let code: number | null  = null;
  let responseBody: unknown = null;
  const res: Partial<Response> = {
    status: jest.fn().mockImplementation((c: number) => { code = c; return res; }),
    json:   jest.fn().mockImplementation((b: unknown) => { responseBody = b; return res; }),
  };
  return { res, statusCode: () => code, body: () => responseBody };
}

function makeMockReq(body: unknown): Partial<Request> {
  return { body } as Partial<Request>;
}

function makeValidBody(overrides: Record<string, unknown> = {}) {
  return {
    event:      'taskCreated',
    webhook_id: 'wh-001',
    task_id:    'task-abc',
    ...overrides,
  };
}

function makeClickUpTask(listId = PATIENT_LIST_ID) {
  return {
    id:            'task-abc',
    name:          'García, Ana',
    status:        { status: 'activo' },
    parent:        null,
    custom_fields: [],
    list:          { id: listId, name: 'Estado de Pacientes' },
    url:           'https://app.clickup.com/t/task-abc',
    date_created:  '1700000000000',
    date_updated:  '1700000001000',
  };
}

function buildController(): ClickUpPatientWebhookController {
  const resolver   = {} as unknown as ClickUpFieldResolver;
  const mapper     = new ClickUpPatientMapper(resolver);
  const patientSvc = new PatientService();
  const mockPool   = { query: mockDbQuery } as unknown as Pool;
  return new ClickUpPatientWebhookController('tok-test', resolver, mapper, patientSvc, mockPool);
}

// ─────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────

describe('ClickUpPatientWebhookController', () => {
  let controller: ClickUpPatientWebhookController;

  beforeEach(() => {
    jest.clearAllMocks();
    controller = buildController();
  });

  // ─────────────────────────────────────────────────────────────────
  // 1. Schema inválido
  // ─────────────────────────────────────────────────────────────────

  it('1. deve retornar 400 quando body schema é inválido', async () => {
    const req = makeMockReq({ bad: true });
    const { res, statusCode, body } = makeMockRes();

    await controller.handle(req as Request, res as Response);

    expect(statusCode()).toBe(400);
    expect((body() as Record<string, unknown>).error).toBe('invalid body schema');
    expect(mockLoggerWarn).toHaveBeenCalledWith('clickup_webhook.invalid_body', expect.any(Object));
  });

  it('1b. deve retornar 400 quando body está vazio', async () => {
    const req = makeMockReq({});
    const { res, statusCode } = makeMockRes();

    await controller.handle(req as Request, res as Response);

    expect(statusCode()).toBe(400);
  });

  // ─────────────────────────────────────────────────────────────────
  // 2. list_id no payload diferente → skip precoce
  // ─────────────────────────────────────────────────────────────────

  it('2. deve retornar 200 skipped_other_list quando list_id do payload é diferente', async () => {
    const req = makeMockReq(makeValidBody({ list_id: OTHER_LIST_ID }));
    const { res, statusCode, body } = makeMockRes();

    await controller.handle(req as Request, res as Response);

    expect(statusCode()).toBe(200);
    expect((body() as Record<string, unknown>).action).toBe('skipped_other_list');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  // ─────────────────────────────────────────────────────────────────
  // 3. taskDeleted com task existente
  // ─────────────────────────────────────────────────────────────────

  it('3. taskDeleted deve chamar UPDATE e retornar soft_deleted affectedRows=1', async () => {
    mockDbQuery.mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 'patient-uuid-1' }] });

    const req = makeMockReq(makeValidBody({ event: 'taskDeleted' }));
    const { res, statusCode, body } = makeMockRes();

    await controller.handle(req as Request, res as Response);

    expect(mockDbQuery).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE patients SET deleted_at'),
      ['task-abc'],
    );
    expect(statusCode()).toBe(200);
    const b = body() as Record<string, unknown>;
    expect(b.action).toBe('soft_deleted');
    expect(b.affectedRows).toBe(1);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  // ─────────────────────────────────────────────────────────────────
  // 4. taskDeleted com task inexistente no banco
  // ─────────────────────────────────────────────────────────────────

  it('4. taskDeleted deve retornar affectedRows=0 quando task não existe', async () => {
    mockDbQuery.mockResolvedValueOnce({ rowCount: 0, rows: [] });

    const req = makeMockReq(makeValidBody({ event: 'taskDeleted' }));
    const { res, statusCode, body } = makeMockRes();

    await controller.handle(req as Request, res as Response);

    expect(statusCode()).toBe(200);
    expect((body() as Record<string, unknown>).affectedRows).toBe(0);
  });

  // ─────────────────────────────────────────────────────────────────
  // 5. taskCreated com fetch OK + UseCase executado
  // ─────────────────────────────────────────────────────────────────

  it('5. taskCreated deve buscar task, chamar UseCase e retornar 200 synced', async () => {
    const task = makeClickUpTask();
    mockFetch.mockResolvedValueOnce({
      ok:   true,
      json: async () => task,
    });
    mockUseCaseExecute.mockResolvedValueOnce({ kind: 'CREATED', taskId: 'task-abc' });

    const req = makeMockReq(makeValidBody({ list_id: PATIENT_LIST_ID }));
    const { res, statusCode, body } = makeMockRes();

    await controller.handle(req as Request, res as Response);

    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('/task/task-abc'),
      expect.objectContaining({ headers: { Authorization: 'tok-test' } }),
    );
    expect(mockUseCaseExecute).toHaveBeenCalledWith(task, { onMissingContact: 'flag' }, expect.any(String));
    expect(statusCode()).toBe(200);
    const b = body() as Record<string, unknown>;
    expect(b.success).toBe(true);
    expect(b.action).toBe('synced');
    expect((b.result as Record<string, unknown>).kind).toBe('CREATED');
  });

  // Sync que ERROU não pode sair com `success: true`. O caso real: um campo renomeado no ClickUp
  // faz a guarda fail-closed da 1.11 recusar a task inteira — nada é gravado, e o webhook
  // respondia `{"success":true,"action":"synced"}`. Para o ClickUp e para qualquer monitor que
  // olhe o corpo, a task tinha sido sincronizada; só uma linha de log denunciava.
  // O 200 é preservado de propósito (o padrão da casa em `fetch_failed` e `catalog_stale`):
  // devolver 5xx faria o ClickUp reentregar em tempestade um erro que o retry não conserta.
  it('sync com kind=ERROR responde success:false e action=sync_failed, mantendo HTTP 200', async () => {
    const task = makeClickUpTask();
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => task });
    mockUseCaseExecute.mockResolvedValueOnce({
      kind: 'ERROR', taskId: 'task-err', error: new Error('catálogo ilegível'),
    });

    const req = makeMockReq(makeValidBody({ list_id: PATIENT_LIST_ID }));
    const { res, statusCode, body } = makeMockRes();

    await controller.handle(req as Request, res as Response);

    expect(statusCode()).toBe(200);
    const b = body() as Record<string, unknown>;
    expect(b.success).toBe(false);
    expect(b.action).toBe('sync_failed');
    expect((b.result as Record<string, unknown>).kind).toBe('ERROR');
    // A mensagem do erro NÃO sai no corpo: ela pode carregar rótulo clínico.
    expect(JSON.stringify(b)).not.toContain('catálogo ilegível');
  });

  // ─────────────────────────────────────────────────────────────────
  // 6. task.list.id diferente → skip após fetch
  // ─────────────────────────────────────────────────────────────────

  it('6. deve retornar 200 skipped_task_other_list quando task.list.id é diferente', async () => {
    const task = makeClickUpTask(OTHER_LIST_ID);
    mockFetch.mockResolvedValueOnce({
      ok:   true,
      json: async () => task,
    });

    const req = makeMockReq(makeValidBody());
    const { res, statusCode, body } = makeMockRes();

    await controller.handle(req as Request, res as Response);

    expect(statusCode()).toBe(200);
    expect((body() as Record<string, unknown>).action).toBe('skipped_task_other_list');
    expect(mockUseCaseExecute).not.toHaveBeenCalled();
  });

  // ─────────────────────────────────────────────────────────────────
  // 7. fetch task falha (5xx)
  // ─────────────────────────────────────────────────────────────────

  it('7. deve retornar 200 fetch_failed quando ClickUp API retorna 5xx', async () => {
    mockFetch.mockResolvedValueOnce({
      ok:         false,
      status:     503,
      statusText: 'Service Unavailable',
    });

    const req = makeMockReq(makeValidBody());
    const { res, statusCode, body } = makeMockRes();

    await controller.handle(req as Request, res as Response);

    expect(statusCode()).toBe(200);
    expect((body() as Record<string, unknown>).action).toBe('fetch_failed');
    expect(mockLoggerError).toHaveBeenCalledWith('clickup_webhook.fetch_task_failed', expect.any(Object));
    expect(mockUseCaseExecute).not.toHaveBeenCalled();
  });

  it('7b. deve retornar 200 fetch_failed quando fetch lança exceção de rede', async () => {
    mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    const req = makeMockReq(makeValidBody());
    const { res, statusCode, body } = makeMockRes();

    await controller.handle(req as Request, res as Response);

    expect(statusCode()).toBe(200);
    expect((body() as Record<string, unknown>).action).toBe('fetch_failed');
  });

  // ─────────────────────────────────────────────────────────────────
  // 8. UseCase retorna CASE_NUMBER_CONFLICT
  // ─────────────────────────────────────────────────────────────────

  it('8. deve retornar 200 synced com kind=CASE_NUMBER_CONFLICT', async () => {
    const task = makeClickUpTask();
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => task });
    mockUseCaseExecute.mockResolvedValueOnce({
      kind:       'CASE_NUMBER_CONFLICT',
      taskId:     'task-abc',
      patientId:  'patient-xyz',
      caseNumber: 42,
      patientName: 'García, Ana',
    });

    const req = makeMockReq(makeValidBody());
    const { res, statusCode, body } = makeMockRes();

    await controller.handle(req as Request, res as Response);

    expect(statusCode()).toBe(200);
    expect((body() as Record<string, unknown>).action).toBe('synced');
    expect(((body() as Record<string, unknown>).result as Record<string, unknown>).kind).toBe('CASE_NUMBER_CONFLICT');
  });

  // ─────────────────────────────────────────────────────────────────
  // 9. UseCase retorna SKIPPED_SUBTASK
  // ─────────────────────────────────────────────────────────────────

  it('9. deve retornar 200 synced com kind=SKIPPED_SUBTASK', async () => {
    const task = makeClickUpTask();
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => task });
    mockUseCaseExecute.mockResolvedValueOnce({ kind: 'SKIPPED_SUBTASK', taskId: 'task-abc' });

    const req = makeMockReq(makeValidBody());
    const { res, statusCode, body } = makeMockRes();

    await controller.handle(req as Request, res as Response);

    expect(statusCode()).toBe(200);
    expect(((body() as Record<string, unknown>).result as Record<string, unknown>).kind).toBe('SKIPPED_SUBTASK');
  });

  // ─────────────────────────────────────────────────────────────────
  // 10. list_id ausente no payload → não aplica skip precoce
  // ─────────────────────────────────────────────────────────────────

  it('10. deve buscar task quando list_id está ausente no payload', async () => {
    const task = makeClickUpTask();
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => task });
    mockUseCaseExecute.mockResolvedValueOnce({ kind: 'UPDATED', taskId: 'task-abc' });

    // No list_id in body
    const req = makeMockReq({ event: 'taskUpdated', webhook_id: 'wh-001', task_id: 'task-abc' });
    const { res, statusCode } = makeMockRes();

    await controller.handle(req as Request, res as Response);

    expect(mockFetch).toHaveBeenCalled();
    expect(statusCode()).toBe(200);
  });

  // ─────────────────────────────────────────────────────────────────
  // health() — liveness probe
  // ─────────────────────────────────────────────────────────────────

  describe('health()', () => {
    it('retorna 200 com status ok + estrutural info (sem PII)', () => {
      const ctrl = new ClickUpPatientWebhookController(
        'tok',
        {} as ClickUpFieldResolver,
        new ClickUpPatientMapper({} as ClickUpFieldResolver),
        new PatientService(),
        { query: mockDbQuery } as unknown as Pool,
      );
      const { res, statusCode, body } = makeMockRes();

      ctrl.health({} as Request, res as Response);

      expect(statusCode()).toBe(200);
      const payload = body() as Record<string, unknown>;
      expect(payload.status).toBe('ok');
      expect(payload.service).toBe('clickup-patient-webhook');
      expect(payload.patientListId).toBe(PATIENT_LIST_ID);
      expect(typeof payload.uptimeSeconds).toBe('number');
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // ClickUpPatientWebhookController.create() (factory)
  // ─────────────────────────────────────────────────────────────────

  describe('static create()', () => {
    it('deve lançar erro quando CLICKUP_API_TOKEN está ausente', async () => {
      const original = process.env.CLICKUP_API_TOKEN;
      delete process.env.CLICKUP_API_TOKEN;

      await expect(ClickUpPatientWebhookController.create()).rejects.toThrow('CLICKUP_API_TOKEN missing');

      process.env.CLICKUP_API_TOKEN = original;
    });

    it('deve criar controller quando token e FieldResolver estão disponíveis', async () => {
      process.env.CLICKUP_API_TOKEN = 'tok-ok';
      mockFieldResolverFromList.mockResolvedValueOnce({} as unknown as ClickUpFieldResolver);

      const ctrl = await ClickUpPatientWebhookController.create();

      expect(ctrl).toBeInstanceOf(ClickUpPatientWebhookController);
      expect(mockFieldResolverFromList).toHaveBeenCalledWith(PATIENT_LIST_ID, { token: 'tok-ok' });

      delete process.env.CLICKUP_API_TOKEN;
    });

    // ── a FIAÇÃO da 1.13, e por que ela precisa de asserção própria ───────────
    // Medido em 24/08: arrancar UM hunk — o argumento `catalog` desta chamada —
    // mata a recarga de catálogo em produção, e TUDO continua verde. O parâmetro é
    // opcional no construtor, então compila; `create()` já era chamado por este
    // teste, mas ninguém verificava o que ele MONTA; e o guardian da fase mede por
    // PEÇA, não por hunk, então o sobrevivente não vira exit != 0.
    //
    // `create()` é o ÚNICO caminho que produção roda. Sem esta asserção, a task
    // 1.13 inteira pode ser desfeita por uma linha, em silêncio.
    it('create() FIA o refresher de catálogo no controller (task 1.13, hunk que sobrevivia)', async () => {
      process.env.CLICKUP_API_TOKEN = 'tok-ok';
      mockFieldResolverFromList.mockResolvedValueOnce({} as unknown as ClickUpFieldResolver);

      const ctrl = await ClickUpPatientWebhookController.create();
      const fiado = (ctrl as unknown as { catalog?: unknown }).catalog;

      // não basta existir: tem de ser o refresher, e tem de saber recarregar
      expect(fiado).toBeDefined();
      expect(typeof (fiado as { ensureFreshFor?: unknown })?.ensureFreshFor).toBe('function');

      delete process.env.CLICKUP_API_TOKEN;
    });
  });
});
