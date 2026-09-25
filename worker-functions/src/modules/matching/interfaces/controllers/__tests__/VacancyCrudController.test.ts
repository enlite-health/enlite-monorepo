/**
 * VacancyCrudController.test.ts
 *
 * Suíte nova (arquivo não tinha teste unit — achado da revisão da 028, F3 do
 * plano de execução) — cobertura 100% do arquivo. `formatCaseTitle` (linha
 * tocada pela 028) é REAL (não mockado) — é o próprio motivo desta suíte
 * existir. Os demais colaboradores (helpers de query/audit, use cases de
 * short link, logging, RLS de sistema) são mockados para isolar o controller
 * — molde padrão de unit test de controller (mock de pool/client, sem banco
 * real; ver JobPostingARRepository.test.ts pro mesmo padrão em repositório).
 *
 * Cenários:
 *   1. createVacancy() — validação (is_test/is_draft/patient_id/patient
 *      inexistente/patient_address_id órfão), sucesso com e sem updatePatient,
 *      audit best-effort (falha não derruba o 201), erro genérico → 500,
 *      pós-commit (domain event + tryEnsureShortLink) via flush do setImmediate
 *   2. updateVacancy() — auth error, sem campos válidos, draft vs operacional,
 *      vacante não encontrada (antes/depois do UPDATE), sucesso, rollback em erro,
 *      pós-commit (purge vs ensure short link conforme status)
 *   3. deleteVacancy() — não encontrada (antes/depois), sucesso, rollback em erro,
 *      pós-commit (purge short link)
 *   4. tryEnsureShortLink() (exportada) — is_test, status ausente/não-público,
 *      ShortLinkService indisponível, sucesso, falha (reportError, não lança)
 */

import type { Request, Response } from 'express';

// ── Mocks (antes dos imports) ────────────────────────────────────

const mockQuery = jest.fn();
const mockClientQuery = jest.fn();
const mockClientRelease = jest.fn();
const mockConnect = jest.fn();

jest.mock('@shared/database/DatabaseConnection', () => ({
  DatabaseConnection: {
    getInstance: jest.fn().mockReturnValue({
      getPool: jest.fn().mockReturnValue({
        query: mockQuery,
        connect: mockConnect,
      }),
    }),
  },
}));

const mockAuthorizeVacancyUpdate = jest.fn();
const mockBuildInsertQuery = jest.fn(() => 'INSERT INTO job_postings (...) VALUES (...) RETURNING *');
const mockBuildInsertParams = jest.fn(() => ['param1', 'param2']);
const mockRetryOnCaseOrdinalConflict = jest.fn((attempt: () => Promise<unknown>) => attempt());

jest.mock('../vacancyCrudHelpers', () => {
  const actual = jest.requireActual('../vacancyCrudHelpers');
  return {
    ...actual,
    authorizeVacancyUpdate: (...args: any[]) => (mockAuthorizeVacancyUpdate as any)(...args),
    buildInsertQuery: (...args: any[]) => (mockBuildInsertQuery as any)(...args),
    buildInsertParams: (...args: any[]) => (mockBuildInsertParams as any)(...args),
    retryOnCaseOrdinalConflict: (...args: any[]) => (mockRetryOnCaseOrdinalConflict as any)(...args),
  };
});

const mockAuditVacancyCreated = jest.fn().mockResolvedValue(undefined);
const mockAuditVacancyUpdated = jest.fn().mockResolvedValue(undefined);
const mockAuditVacancyDeleted = jest.fn().mockResolvedValue(undefined);
const mockCreateWithPatientUpdate = jest.fn();

jest.mock('../vacancyCrudAuditHelpers', () => ({
  auditVacancyCreated: (...args: any[]) => (mockAuditVacancyCreated as any)(...args),
  auditVacancyUpdated: (...args: any[]) => (mockAuditVacancyUpdated as any)(...args),
  auditVacancyDeleted: (...args: any[]) => (mockAuditVacancyDeleted as any)(...args),
  createWithPatientUpdate: (...args: any[]) => (mockCreateWithPatientUpdate as any)(...args),
}));

const mockEnsureExecute = jest.fn().mockResolvedValue(undefined);
jest.mock('../../../application/EnsureVacancyShortLinkUseCase', () => ({
  EnsureVacancyShortLinkUseCase: jest.fn().mockImplementation(() => ({ execute: mockEnsureExecute })),
}));

const mockPurgeExecute = jest.fn().mockResolvedValue(undefined);
jest.mock('../../../application/PurgeVacancyShortLinksUseCase', () => ({
  PurgeVacancyShortLinksUseCase: jest.fn().mockImplementation(() => ({ execute: mockPurgeExecute })),
}));

const mockShortLinkFromEnv = jest.fn();
jest.mock('../../../infrastructure/shortlinks/ShortLinkService', () => ({
  ShortLinkService: { fromEnv: (...args: any[]) => (mockShortLinkFromEnv as any)(...args) },
}));

const mockReportError = jest.fn();
jest.mock('@shared/logging', () => ({
  reportError: (...args: any[]) => (mockReportError as any)(...args),
  loggingAls: { getStore: jest.fn().mockReturnValue(undefined) },
}));

jest.mock('@shared/database/requestDbSession', () => ({
  withSystemDbContext: (_label: string, fn: () => Promise<unknown>) => fn(),
}));

import { VacancyCrudController, tryEnsureShortLink } from '../VacancyCrudController';

// ── Helpers ──────────────────────────────────────────────────────

function makeRes(): Response {
  const res: Partial<Response> = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res as Response;
}

function makeReq(overrides: Partial<Request> & { body?: unknown; params?: unknown } = {}): Request {
  return {
    body: {},
    params: {},
    user: { uid: 'admin-1' },
    ...overrides,
  } as unknown as Request;
}

/** Deixa a fila de `setImmediate` do controller (pós-commit) rodar. */
function flushImmediates(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

const mockClient = { query: mockClientQuery, release: mockClientRelease };

describe('VacancyCrudController', () => {
  let controller: VacancyCrudController;

  beforeEach(() => {
    jest.clearAllMocks();
    // mockQuery/mockClientQuery usam `.mockResolvedValueOnce()` em sequência em
    // cada teste — `mockReset()` (não só `clearAllMocks`) é necessário pra
    // esvaziar a fila de "once" entre testes; sobra de fila de um teste que
    // falhou/lançou vazava pro índice de chamada do próximo (achado ao rodar
    // esta própria suíte pela 1ª vez — contaminação cross-test).
    mockQuery.mockReset();
    mockClientQuery.mockReset();
    mockConnect.mockResolvedValue(mockClient);
    mockClientQuery.mockResolvedValue({ rows: [] });
    mockQuery.mockResolvedValue({ rows: [] }); // default — testes sobrescrevem com mockResolvedValueOnce quando precisam
    mockShortLinkFromEnv.mockReturnValue(null); // default: sem Short.io configurado
    controller = new VacancyCrudController();
  });

  // Drena qualquer `setImmediate` (pós-commit) que o teste tenha registrado
  // mas não esperado explicitamente — sem isso, o callback fica pendente na
  // fila global do Node e roda durante o `flushImmediates()` de um teste
  // SEGUINTE, consumindo o `mockResolvedValueOnce`/mock daquele outro teste
  // (contaminação cross-test, achado ao rodar esta suíte pela 1ª vez).
  afterEach(() => flushImmediates());

  // ── createVacancy ────────────────────────────────────────────

  describe('createVacancy', () => {
    it('is_test não-booleano → 400', async () => {
      const req = makeReq({ body: { is_test: 'sim', patient_id: 'p-1' } });
      const res = makeRes();

      await controller.createVacancy(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect((res.json as jest.Mock).mock.calls[0][0].error).toContain('is_test must be a boolean');
    });

    it('is_draft não-booleano → 400', async () => {
      const req = makeReq({ body: { is_draft: 'sim', patient_id: 'p-1' } });
      const res = makeRes();

      await controller.createVacancy(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect((res.json as jest.Mock).mock.calls[0][0].error).toContain('is_draft must be a boolean');
    });

    it('sem patient_id → 400', async () => {
      const req = makeReq({ body: {} });
      const res = makeRes();

      await controller.createVacancy(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect((res.json as jest.Mock).mock.calls[0][0].error).toContain('patient_id é obrigatório');
    });

    it('patient_id não-string (ex: número) → 400', async () => {
      const req = makeReq({ body: { patient_id: 123 } });
      const res = makeRes();

      await controller.createVacancy(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('patient_id não encontrado (patients vazio) → 400', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] }); // patientCheck
      const req = makeReq({ body: { patient_id: 'p-inexistente' } });
      const res = makeRes();

      await controller.createVacancy(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect((res.json as jest.Mock).mock.calls[0][0].error).toContain('paciente não encontrado');
    });

    it('patient_address_id não pertence ao patient_id (ou arquivado) → 400', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [{ id: 'p-1' }] })  // patientCheck ok
        .mockResolvedValueOnce({ rows: [] });               // ownerCheck vazio

      const req = makeReq({ body: { patient_id: 'p-1', patient_address_id: 'addr-outro' } });
      const res = makeRes();

      await controller.createVacancy(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect((res.json as jest.Mock).mock.calls[0][0].error).toContain('patient_address_id não pertence');
    });

    it('sucesso sem updatePatient → INSERT via buildInsertQuery/Params, audit best-effort, 201, pós-commit dispara domain event + tryEnsureShortLink', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [{ id: 'p-1' }] })      // patientCheck
        .mockResolvedValueOnce({ rows: [{ vn: '10' }] })       // nextval
        .mockResolvedValueOnce({ rows: [{ id: 'jp-new', status: 'SEARCHING', is_test: false }] }); // INSERT (via retryOnCaseOrdinalConflict)
      mockClientQuery.mockResolvedValue({ rows: [] }); // audit client: BEGIN/COMMIT

      const req = makeReq({ body: { patient_id: 'p-1', case_number: 230 } });
      const res = makeRes();

      await controller.createVacancy(req, res);

      expect(res.status).toHaveBeenCalledWith(201);
      expect((res.json as jest.Mock).mock.calls[0][0].data.id).toBe('jp-new');
      expect(mockRetryOnCaseOrdinalConflict).toHaveBeenCalled();
      expect(mockCreateWithPatientUpdate).not.toHaveBeenCalled();
      expect(mockAuditVacancyCreated).toHaveBeenCalledWith(mockClient, 'jp-new', expect.any(Object), expect.objectContaining({ actorUserId: 'admin-1' }));
      expect(mockClientQuery).toHaveBeenCalledWith('BEGIN');
      expect(mockClientQuery).toHaveBeenCalledWith('COMMIT');
      expect(mockClientRelease).toHaveBeenCalled();

      // Pós-commit: domain event + tryEnsureShortLink (status SEARCHING é público,
      // mas ShortLinkService.fromEnv()=null por padrão do beforeEach → execute não roda).
      await flushImmediates();
      const domainEventCall = mockQuery.mock.calls.find(
        (c) => typeof c[0] === 'string' && c[0].includes('vacancy.created'),
      );
      expect(domainEventCall).toBeDefined();
      expect(JSON.parse(domainEventCall![1][0]).jobPostingId).toBe('jp-new');
    });

    it('sucesso com updatePatient (objeto não-vazio) → usa createWithPatientUpdate, não o INSERT direto', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [{ id: 'p-1' }] })   // patientCheck
        .mockResolvedValueOnce({ rows: [{ vn: '20' }] });   // nextval — roda incondicionalmente antes do hasUpdate branch
      mockCreateWithPatientUpdate.mockResolvedValueOnce({ id: 'jp-with-update', status: 'SEARCHING', is_test: false });

      const req = makeReq({ body: { patient_id: 'p-1', case_number: 230, updatePatient: { zone_neighborhood: 'x' } } });
      const res = makeRes();

      await controller.createVacancy(req, res);

      expect(res.status).toHaveBeenCalledWith(201);
      expect(mockCreateWithPatientUpdate).toHaveBeenCalledWith(expect.anything(), 230, { zone_neighborhood: 'x' }, expect.any(Object), expect.any(Object));
      expect(mockRetryOnCaseOrdinalConflict).not.toHaveBeenCalled();
    });

    it('updatePatient objeto VAZIO → tratado como sem update (hasUpdate=false)', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [{ id: 'p-1' }] })
        .mockResolvedValueOnce({ rows: [{ vn: '11' }] })
        .mockResolvedValueOnce({ rows: [{ id: 'jp-empty-update', status: 'SEARCHING', is_test: false }] });

      const req = makeReq({ body: { patient_id: 'p-1', case_number: 230, updatePatient: {} } });
      const res = makeRes();

      await controller.createVacancy(req, res);

      expect(mockCreateWithPatientUpdate).not.toHaveBeenCalled();
      expect(mockRetryOnCaseOrdinalConflict).toHaveBeenCalled();
    });

    it('audit best-effort falha (client.query rejeita no BEGIN/audit) → ROLLBACK engolido, resposta 201 intocada', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [{ id: 'p-1' }] })
        .mockResolvedValueOnce({ rows: [{ vn: '12' }] })
        .mockResolvedValueOnce({ rows: [{ id: 'jp-audit-fail', status: 'SEARCHING', is_test: false }] });
      mockAuditVacancyCreated.mockRejectedValueOnce(new Error('audit FK violation'));
      mockClientQuery.mockResolvedValue({ rows: [] }); // BEGIN ok, ROLLBACK ok

      const req = makeReq({ body: { patient_id: 'p-1', case_number: 230 } });
      const res = makeRes();

      await controller.createVacancy(req, res);

      expect(res.status).toHaveBeenCalledWith(201); // falha de audit NÃO derruba a resposta
      expect(mockClientQuery).toHaveBeenCalledWith('ROLLBACK');
    });

    it('erro genérico (ex: patientCheck lança) → reportError + 500', async () => {
      mockQuery.mockRejectedValueOnce(new Error('connection lost'));

      const req = makeReq({ body: { patient_id: 'p-1' } });
      const res = makeRes();

      await controller.createVacancy(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect((res.json as jest.Mock).mock.calls[0][0].details).toBe('connection lost');
      expect(mockReportError).toHaveBeenCalledWith(expect.any(Error), { source: 'VacancyCrudController:createVacancy' });
    });

    it('domain event pós-commit falha (INSERT domain_events rejeita) → reportError, não derruba o processo', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [{ id: 'p-1' }] })
        .mockResolvedValueOnce({ rows: [{ vn: '13' }] })
        .mockResolvedValueOnce({ rows: [{ id: 'jp-domain-fail', status: 'SEARCHING', is_test: false }] })
        .mockRejectedValueOnce(new Error('domain_events insert failed')); // dentro do setImmediate

      const req = makeReq({ body: { patient_id: 'p-1', case_number: 230 } });
      const res = makeRes();

      await controller.createVacancy(req, res);
      await flushImmediates();

      expect(mockReportError).toHaveBeenCalledWith(
        expect.any(Error),
        expect.objectContaining({ source: 'VacancyCrudController:domainEvent', jobPostingId: 'jp-domain-fail' }),
      );
    });
  });

  // ── updateVacancy ────────────────────────────────────────────

  describe('updateVacancy', () => {
    it('authorizeVacancyUpdate → erro (ex: status inválido) → status/error do auth', async () => {
      mockAuthorizeVacancyUpdate.mockResolvedValueOnce({ kind: 'error', status: 400, error: 'status inválido' });

      const req = makeReq({ params: { id: 'jp-1' }, body: { status: 'FOO' } });
      const res = makeRes();

      await controller.updateVacancy(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect((res.json as jest.Mock).mock.calls[0][0].error).toBe('status inválido');
    });

    it('authorizeVacancyUpdate → 422 de campo travado (lockedFields) → controller repassa locked_fields no corpo (F3/fase-1)', async () => {
      mockAuthorizeVacancyUpdate.mockResolvedValueOnce({
        kind: 'error',
        status: 422,
        error: 'Campos travados pela origem (paciente/serviço contratado) não podem ser editados: schedule.',
        lockedFields: ['schedule'],
      });

      const req = makeReq({ params: { id: 'jp-1' }, body: { schedule: [] } });
      const res = makeRes();

      await controller.updateVacancy(req, res);

      expect(res.status).toHaveBeenCalledWith(422);
      const body = (res.json as jest.Mock).mock.calls[0][0];
      expect(body.success).toBe(false);
      expect(body.locked_fields).toEqual(['schedule']);
    });

    it('authorizeVacancyUpdate → erro SEM lockedFields (ex: 400 de status inválido) → corpo não ganha locked_fields', async () => {
      mockAuthorizeVacancyUpdate.mockResolvedValueOnce({ kind: 'error', status: 400, error: 'status inválido' });

      const req = makeReq({ params: { id: 'jp-1' }, body: { status: 'FOO' } });
      const res = makeRes();

      await controller.updateVacancy(req, res);

      const body = (res.json as jest.Mock).mock.calls[0][0];
      expect(body.locked_fields).toBeUndefined();
    });

    it('nenhum campo permitido no body → 400 "No valid fields to update"', async () => {
      mockAuthorizeVacancyUpdate.mockResolvedValueOnce({ kind: 'ok', isDraft: false, currentStatus: 'SEARCHING' });

      const req = makeReq({ params: { id: 'jp-1' }, body: { campo_nao_permitido: 'x' } });
      const res = makeRes();

      await controller.updateVacancy(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect((res.json as jest.Mock).mock.calls[0][0].error).toBe('No valid fields to update');
    });

    it('is_draft=false → só campos OPERATIONAL_EDITABLE_FIELDS (schedule/status) são aceitos, resto ignorado', async () => {
      mockAuthorizeVacancyUpdate.mockResolvedValueOnce({ kind: 'ok', isDraft: false, currentStatus: 'SEARCHING' });
      mockClientQuery
        .mockResolvedValueOnce({})                                              // BEGIN
        .mockResolvedValueOnce({ rows: [{ id: 'jp-1', status: 'SEARCHING' }] })  // SELECT before
        .mockResolvedValueOnce({ rows: [{ id: 'jp-1', status: 'ACTIVE', is_test: false }] }) // UPDATE
        .mockResolvedValue({ rows: [] });                                       // COMMIT

      const req = makeReq({ params: { id: 'jp-1' }, body: { status: 'ACTIVE', title: 'Tentativa de burlar' } });
      const res = makeRes();

      await controller.updateVacancy(req, res);

      expect(res.status).toHaveBeenCalledWith(200);
      const updateCall = mockClientQuery.mock.calls[2];
      expect(updateCall[0]).toContain('status = $1');
      expect(updateCall[0]).not.toContain('title');
    });

    it('is_draft=true → campos de FULL_ALLOWED_UPDATE_FIELDS (ex: title) são aceitos', async () => {
      mockAuthorizeVacancyUpdate.mockResolvedValueOnce({ kind: 'ok', isDraft: true, currentStatus: 'PENDING_ACTIVATION' });
      mockClientQuery
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({ rows: [{ id: 'jp-1' }] })
        .mockResolvedValueOnce({ rows: [{ id: 'jp-1', title: 'Novo título', status: 'PENDING_ACTIVATION', is_test: false }] })
        .mockResolvedValue({ rows: [] });

      const req = makeReq({ params: { id: 'jp-1' }, body: { title: 'Novo título' } });
      const res = makeRes();

      await controller.updateVacancy(req, res);

      expect(res.status).toHaveBeenCalledWith(200);
      const updateCall = mockClientQuery.mock.calls[2];
      expect(updateCall[0]).toContain('title = $1');
    });

    it('campo jsonb (schedule) como objeto → JSON.stringify antes do UPDATE', async () => {
      mockAuthorizeVacancyUpdate.mockResolvedValueOnce({ kind: 'ok', isDraft: false, currentStatus: 'SEARCHING' });
      mockClientQuery
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({ rows: [{ id: 'jp-1' }] })
        .mockResolvedValueOnce({ rows: [{ id: 'jp-1', status: 'SEARCHING', is_test: false }] })
        .mockResolvedValue({ rows: [] });

      const scheduleObj = [{ dayOfWeek: 1, startTime: '08:00', endTime: '16:00' }];
      const req = makeReq({ params: { id: 'jp-1' }, body: { schedule: scheduleObj } });
      const res = makeRes();

      await controller.updateVacancy(req, res);

      const updateCall = mockClientQuery.mock.calls[2];
      expect(updateCall[1][0]).toBe(JSON.stringify(scheduleObj));
    });

    it('vacante não encontrada ANTES do UPDATE (SELECT before vazio) → 404, ROLLBACK', async () => {
      mockAuthorizeVacancyUpdate.mockResolvedValueOnce({ kind: 'ok', isDraft: false, currentStatus: 'SEARCHING' });
      mockClientQuery
        .mockResolvedValueOnce({})          // BEGIN
        .mockResolvedValueOnce({ rows: [] }) // SELECT before — vazio
        .mockResolvedValue({});              // ROLLBACK

      const req = makeReq({ params: { id: 'jp-sumiu' }, body: { status: 'ACTIVE' } });
      const res = makeRes();

      await controller.updateVacancy(req, res);

      expect(res.status).toHaveBeenCalledWith(404);
      expect(mockClientQuery).toHaveBeenCalledWith('ROLLBACK');
    });

    it('vacante não encontrada NO UPDATE (rows vazio após SELECT ok) → 404, ROLLBACK', async () => {
      mockAuthorizeVacancyUpdate.mockResolvedValueOnce({ kind: 'ok', isDraft: false, currentStatus: 'SEARCHING' });
      mockClientQuery
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({ rows: [{ id: 'jp-1' }] }) // before ok
        .mockResolvedValueOnce({ rows: [] })                // UPDATE — race, sumiu
        .mockResolvedValue({});

      const req = makeReq({ params: { id: 'jp-1' }, body: { status: 'ACTIVE' } });
      const res = makeRes();

      await controller.updateVacancy(req, res);

      expect(res.status).toHaveBeenCalledWith(404);
    });

    it('status final em INACTIVE_STATUSES (CLOSED/SUSPENDED) → pós-commit chama purge, não ensure', async () => {
      mockAuthorizeVacancyUpdate.mockResolvedValueOnce({ kind: 'ok', isDraft: false, currentStatus: 'SEARCHING' });
      mockShortLinkFromEnv.mockReturnValue({}); // Short.io "configurado" pra provar que purge É chamado
      mockClientQuery
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({ rows: [{ id: 'jp-1' }] })
        .mockResolvedValueOnce({ rows: [{ id: 'jp-1', status: 'CLOSED', is_test: false }] })
        .mockResolvedValue({ rows: [] });

      const req = makeReq({ params: { id: 'jp-1' }, body: { status: 'CLOSED' } });
      const res = makeRes();

      await controller.updateVacancy(req, res);
      await flushImmediates();

      expect(mockPurgeExecute).toHaveBeenCalledWith('jp-1');
      expect(mockEnsureExecute).not.toHaveBeenCalled();
    });

    it('status final ATIVO/público → pós-commit chama tryEnsureShortLink, não purge', async () => {
      mockAuthorizeVacancyUpdate.mockResolvedValueOnce({ kind: 'ok', isDraft: false, currentStatus: 'PENDING_ACTIVATION' });
      mockShortLinkFromEnv.mockReturnValue({});
      mockClientQuery
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({ rows: [{ id: 'jp-1' }] })
        .mockResolvedValueOnce({ rows: [{ id: 'jp-1', status: 'ACTIVE', is_test: false }] })
        .mockResolvedValue({ rows: [] });

      const req = makeReq({ params: { id: 'jp-1' }, body: { status: 'ACTIVE' } });
      const res = makeRes();

      await controller.updateVacancy(req, res);
      await flushImmediates();

      expect(mockEnsureExecute).toHaveBeenCalled();
      expect(mockPurgeExecute).not.toHaveBeenCalled();
    });

    it('erro dentro da transação (ex: auditVacancyUpdated lança) → ROLLBACK + rethrow → 500', async () => {
      mockAuthorizeVacancyUpdate.mockResolvedValueOnce({ kind: 'ok', isDraft: false, currentStatus: 'SEARCHING' });
      mockClientQuery
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({ rows: [{ id: 'jp-1' }] })
        .mockResolvedValueOnce({ rows: [{ id: 'jp-1', status: 'SEARCHING' }] })
        .mockResolvedValue({});
      mockAuditVacancyUpdated.mockRejectedValueOnce(new Error('audit trail broke'));

      const req = makeReq({ params: { id: 'jp-1' }, body: { status: 'SEARCHING' } });
      const res = makeRes();

      await controller.updateVacancy(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect((res.json as jest.Mock).mock.calls[0][0].details).toBe('audit trail broke');
      expect(mockClientQuery).toHaveBeenCalledWith('ROLLBACK');
      expect(mockReportError).toHaveBeenCalledWith(
        expect.any(Error),
        expect.objectContaining({ source: 'VacancyCrudController:updateVacancy', vacancyId: 'jp-1' }),
      );
    });
  });

  // ── deleteVacancy ────────────────────────────────────────────

  describe('deleteVacancy', () => {
    it('vacante não encontrada ANTES do soft-delete → 404, ROLLBACK', async () => {
      mockClientQuery
        .mockResolvedValueOnce({})          // BEGIN
        .mockResolvedValueOnce({ rows: [] }) // SELECT before — vazio
        .mockResolvedValue({});

      const req = makeReq({ params: { id: 'jp-sumiu' } });
      const res = makeRes();

      await controller.deleteVacancy(req, res);

      expect(res.status).toHaveBeenCalledWith(404);
      expect(mockClientQuery).toHaveBeenCalledWith('ROLLBACK');
    });

    it('vacante não encontrada NO UPDATE de soft-delete (race) → 404, ROLLBACK', async () => {
      mockClientQuery
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({ rows: [{ id: 'jp-1' }] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValue({});

      const req = makeReq({ params: { id: 'jp-1' } });
      const res = makeRes();

      await controller.deleteVacancy(req, res);

      expect(res.status).toHaveBeenCalledWith(404);
    });

    it('sucesso → COMMIT, audit chamado, 200, pós-commit dispara purge de short links', async () => {
      mockClientQuery
        .mockResolvedValueOnce({})                              // BEGIN
        .mockResolvedValueOnce({ rows: [{ id: 'jp-1' }] })       // SELECT before
        .mockResolvedValueOnce({ rows: [{ id: 'jp-1' }] })       // UPDATE soft-delete
        .mockResolvedValue({ rows: [] });                        // COMMIT
      mockShortLinkFromEnv.mockReturnValue({});

      const req = makeReq({ params: { id: 'jp-1' } });
      const res = makeRes();

      await controller.deleteVacancy(req, res);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(mockAuditVacancyDeleted).toHaveBeenCalledWith(mockClient, 'jp-1', { id: 'jp-1' }, expect.any(Object));
      expect(mockClientQuery).toHaveBeenCalledWith('COMMIT');

      await flushImmediates();
      expect(mockPurgeExecute).toHaveBeenCalledWith('jp-1');
    });

    it('erro dentro da transação (ex: auditVacancyDeleted lança) → ROLLBACK + rethrow → 500', async () => {
      mockClientQuery
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({ rows: [{ id: 'jp-1' }] })
        .mockResolvedValueOnce({ rows: [{ id: 'jp-1' }] })
        .mockResolvedValue({});
      mockAuditVacancyDeleted.mockRejectedValueOnce(new Error('delete audit broke'));

      const req = makeReq({ params: { id: 'jp-1' } });
      const res = makeRes();

      await controller.deleteVacancy(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(mockClientQuery).toHaveBeenCalledWith('ROLLBACK');
    });
  });

  // ── tryEnsureShortLink (exportada) ──────────────────────────

  describe('tryEnsureShortLink', () => {
    it('is_test=true → nunca cria short link (mesmo com status público)', async () => {
      await tryEnsureShortLink({} as never, 'jp-1', 'SEARCHING', true);

      expect(mockShortLinkFromEnv).not.toHaveBeenCalled();
    });

    it('status ausente (null) → não cria', async () => {
      await tryEnsureShortLink({} as never, 'jp-1', null, false);
      expect(mockShortLinkFromEnv).not.toHaveBeenCalled();
    });

    it('status não-público (ex: PENDING_ACTIVATION) → não cria', async () => {
      await tryEnsureShortLink({} as never, 'jp-1', 'PENDING_ACTIVATION', false);
      expect(mockShortLinkFromEnv).not.toHaveBeenCalled();
    });

    it('ShortLinkService indisponível (fromEnv=null) → não cria', async () => {
      mockShortLinkFromEnv.mockReturnValue(null);
      await tryEnsureShortLink({} as never, 'jp-1', 'SEARCHING', false);
      expect(mockEnsureExecute).not.toHaveBeenCalled();
    });

    it('status público + service disponível → cria o short link', async () => {
      mockShortLinkFromEnv.mockReturnValue({});
      await tryEnsureShortLink({} as never, 'jp-1', 'SEARCHING', false);
      expect(mockEnsureExecute).toHaveBeenCalledWith('jp-1', 'site');
    });

    it('execute() lança → reportError, não propaga', async () => {
      mockShortLinkFromEnv.mockReturnValue({});
      mockEnsureExecute.mockRejectedValueOnce(new Error('Short.io indisponível'));

      await expect(tryEnsureShortLink({} as never, 'jp-1', 'SEARCHING', false)).resolves.toBeUndefined();

      expect(mockReportError).toHaveBeenCalledWith(
        expect.any(Error),
        expect.objectContaining({ source: 'tryEnsureShortLink', vacancyId: 'jp-1' }),
      );
    });

    it('execute() lança valor NÃO-Error (ex: string crua) → normalizado em Error antes do reportError', async () => {
      mockShortLinkFromEnv.mockReturnValue({});
      mockEnsureExecute.mockRejectedValueOnce('short.io 503 raw');

      await tryEnsureShortLink({} as never, 'jp-1', 'SEARCHING', false);

      const [err] = mockReportError.mock.calls[0];
      expect(err).toBeInstanceOf(Error);
      expect(err.message).toBe('short.io 503 raw');
    });
  });

  // ── tryPurgeShortLinks (privada, só alcançável via updateVacancy/deleteVacancy) ──

  describe('tryPurgeShortLinks (via deleteVacancy)', () => {
    it('ShortLinkService indisponível (fromEnv=null, default) → não tenta purgar', async () => {
      mockClientQuery
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({ rows: [{ id: 'jp-1' }] })
        .mockResolvedValueOnce({ rows: [{ id: 'jp-1' }] })
        .mockResolvedValue({ rows: [] });
      // mockShortLinkFromEnv já é null por padrão do beforeEach — não sobrescreve.

      const req = makeReq({ params: { id: 'jp-1' } });
      const res = makeRes();

      await controller.deleteVacancy(req, res);
      await flushImmediates();

      expect(mockPurgeExecute).not.toHaveBeenCalled();
    });

    it('execute() de purge lança → reportError (source=tryPurgeShortLinks), não derruba o processo', async () => {
      mockClientQuery
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({ rows: [{ id: 'jp-1' }] })
        .mockResolvedValueOnce({ rows: [{ id: 'jp-1' }] })
        .mockResolvedValue({ rows: [] });
      mockShortLinkFromEnv.mockReturnValue({});
      mockPurgeExecute.mockRejectedValueOnce(new Error('purge falhou'));

      const req = makeReq({ params: { id: 'jp-1' } });
      const res = makeRes();

      await controller.deleteVacancy(req, res);
      await flushImmediates();

      expect(mockReportError).toHaveBeenCalledWith(
        expect.any(Error),
        expect.objectContaining({ source: 'tryPurgeShortLinks', vacancyId: 'jp-1' }),
      );
    });

    it('execute() de purge lança valor NÃO-Error (string crua) → normalizado em Error', async () => {
      mockClientQuery
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({ rows: [{ id: 'jp-1' }] })
        .mockResolvedValueOnce({ rows: [{ id: 'jp-1' }] })
        .mockResolvedValue({ rows: [] });
      mockShortLinkFromEnv.mockReturnValue({});
      mockPurgeExecute.mockRejectedValueOnce('purge raw failure');

      const req = makeReq({ params: { id: 'jp-1' } });
      const res = makeRes();

      await controller.deleteVacancy(req, res);
      await flushImmediates();

      const call = mockReportError.mock.calls.find((c) => c[1]?.source === 'tryPurgeShortLinks');
      expect(call![0]).toBeInstanceOf(Error);
      expect(call![0].message).toBe('purge raw failure');
    });
  });

  // ── extractHumanActor (privada, exercitada via qualquer endpoint) ────

  describe('extractHumanActor', () => {
    it('req sem `user` (não-autenticado / middleware ausente) → actorUserId=null, sem lançar', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [{ id: 'p-1' }] })
        .mockResolvedValueOnce({ rows: [{ vn: '30' }] })
        .mockResolvedValueOnce({ rows: [{ id: 'jp-no-user', status: 'SEARCHING', is_test: false }] });
      mockClientQuery.mockResolvedValue({ rows: [] });

      const req = makeReq({ body: { patient_id: 'p-1', case_number: 230 }, user: undefined });
      const res = makeRes();

      await controller.createVacancy(req, res);

      expect(mockAuditVacancyCreated).toHaveBeenCalledWith(
        mockClient, 'jp-no-user', expect.any(Object),
        expect.objectContaining({ actorUserId: null }),
      );
    });
  });

  // ── audit best-effort: ROLLBACK também falha (createVacancy) ────────

  describe('createVacancy — audit best-effort com ROLLBACK também falhando', () => {
    it('audit lança E o ROLLBACK subsequente também rejeita → engolido pelo .catch interno, 201 intocado', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [{ id: 'p-1' }] })
        .mockResolvedValueOnce({ rows: [{ vn: '31' }] })
        .mockResolvedValueOnce({ rows: [{ id: 'jp-double-fail', status: 'SEARCHING', is_test: false }] });
      mockAuditVacancyCreated.mockRejectedValueOnce(new Error('audit FK violation'));
      mockClientQuery
        .mockResolvedValueOnce({})                                 // BEGIN
        .mockRejectedValueOnce(new Error('ROLLBACK também falhou')); // ROLLBACK — falha também

      const req = makeReq({ body: { patient_id: 'p-1', case_number: 230 } });
      const res = makeRes();

      await controller.createVacancy(req, res);

      expect(res.status).toHaveBeenCalledWith(201); // dupla falha de best-effort não derruba a resposta
    });
  });

  // ── outer catch: valor NÃO-Error lançado (createVacancy/updateVacancy/deleteVacancy) ──

  describe('outer catch — valor não-Error propagado', () => {
    it('createVacancy: patientCheck rejeita com string crua → 500 com details=string, reportError normaliza em Error', async () => {
      mockQuery.mockRejectedValueOnce('raw db string');

      const req = makeReq({ body: { patient_id: 'p-1' } });
      const res = makeRes();

      await controller.createVacancy(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect((res.json as jest.Mock).mock.calls[0][0].details).toBe('raw db string');
      const [err] = mockReportError.mock.calls[0];
      expect(err).toBeInstanceOf(Error);
    });

    it('updateVacancy: authorizeVacancyUpdate rejeita com string crua → 500 com details=string', async () => {
      mockAuthorizeVacancyUpdate.mockRejectedValueOnce('raw auth string');

      const req = makeReq({ params: { id: 'jp-1' }, body: { status: 'ACTIVE' } });
      const res = makeRes();

      await controller.updateVacancy(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect((res.json as jest.Mock).mock.calls[0][0].details).toBe('raw auth string');
    });

    it('deleteVacancy: SELECT before rejeita com string crua → ROLLBACK, 500 com details=string', async () => {
      mockClientQuery
        .mockResolvedValueOnce({})               // BEGIN
        .mockRejectedValueOnce('raw select string') // SELECT before — falha com valor cru
        .mockResolvedValue({});                   // ROLLBACK

      const req = makeReq({ params: { id: 'jp-1' } });
      const res = makeRes();

      await controller.deleteVacancy(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect((res.json as jest.Mock).mock.calls[0][0].details).toBe('raw select string');
    });
  });

  // ── domain event pós-commit: valor NÃO-Error rejeitado ──────────────

  describe('createVacancy — domain event pós-commit com valor não-Error', () => {
    it('INSERT domain_events rejeita com string crua → reportError normaliza em Error', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [{ id: 'p-1' }] })
        .mockResolvedValueOnce({ rows: [{ vn: '32' }] })
        .mockResolvedValueOnce({ rows: [{ id: 'jp-domain-raw', status: 'SEARCHING', is_test: false }] })
        .mockRejectedValueOnce('domain event raw failure');
      mockClientQuery.mockResolvedValue({ rows: [] });

      const req = makeReq({ body: { patient_id: 'p-1', case_number: 230 } });
      const res = makeRes();

      await controller.createVacancy(req, res);
      await flushImmediates();

      const call = mockReportError.mock.calls.find(
        (c) => c[1]?.source === 'VacancyCrudController:domainEvent' && c[1]?.jobPostingId === 'jp-domain-raw',
      );
      expect(call).toBeDefined();
      expect(call![0]).toBeInstanceOf(Error);
      expect(call![0].message).toBe('domain event raw failure');
    });
  });
});
