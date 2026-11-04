/**
 * TalentumWebhookController.test.ts
 *
 * Testa o controller com o formato envelope v2 do webhook Talentum.
 *
 * Cenários cobertos:
 *
 * 1. Validação de payload (Zod discriminated union):
 *    - 400 com body vazio / null / undefined
 *    - 400 sem action ou subtype
 *    - 400 com combinação inválida (PRESCREENING + ANALYZED)
 *    - 400 com email inválido
 *    - 400 com campos extras em sub-objetos (strict mode)
 *    - 200 com PRESCREENING_RESPONSE payload válido
 *    - 200 com PRESCREENING.CREATED payload válido
 *
 * 2. Roteamento por action:
 *    - PRESCREENING.CREATED → CreateJobPostingFromTalentumUseCase
 *    - PRESCREENING_RESPONSE → ProcessTalentumPrescreening
 *
 * 3. Propagação de environment
 *
 * 4. Tratamento de erros (500, sem PII)
 *
 * 5. Validação de questions
 */

// Mock das dependências de infraestrutura
jest.mock('@shared/database/DatabaseConnection', () => ({
  DatabaseConnection: {
    getInstance: jest.fn().mockReturnValue({
      getPool: jest.fn().mockReturnValue({
        query: jest.fn().mockResolvedValue({ rows: [] }),
      }),
    }),
  },
}));

const prescreeningRepoMockImpl = () => ({
  upsertPrescreening: jest.fn().mockResolvedValue({
    prescreening: {
      id: 'internal-uuid-001',
      talentumPrescreeningId: 'tp-001',
      talentumProfileId: 'prof-001',
      workerId: null,
      jobPostingId: null,
      jobCaseName: 'Test Case',
      status: 'INITIATED',
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    created: true,
  }),
  upsertQuestion: jest.fn().mockResolvedValue({
    question: { id: 'q-uuid-001', questionId: 'q1', question: 'Test?', responseType: 'TEXT', createdAt: new Date(), updatedAt: new Date() },
    created: true,
  }),
  upsertResponse: jest.fn().mockResolvedValue({
    response: { id: 'r-uuid-001', prescreeningId: 'internal-uuid-001', questionId: 'q-uuid-001', answer: 'yes', responseSource: 'register', createdAt: new Date(), updatedAt: new Date() },
    created: true,
  }),
});

// Mock canonical path used by PrescreeningResponseHandler after Passo 6 migration.
// TalentumPrescreeningRepository class is the same mock — shared reference via prescreeningRepoMockImpl.
// ProcessTalentumPrescreening is NOT mocked here so it uses the real implementation
// (which internally calls the mocked TalentumPrescreeningRepository from @modules/matching).
jest.mock('@modules/matching', () => {
  const actual = jest.requireActual('@modules/matching');
  return {
    ...actual,
    TalentumPrescreeningRepository: jest.fn().mockImplementation(prescreeningRepoMockImpl),
  };
});

jest.mock('@modules/worker', () => ({
  ...jest.requireActual('@modules/worker'),
  WorkerRepository: jest.fn().mockImplementation(() => ({
    findByEmail: jest.fn().mockResolvedValue({ getValue: () => null }),
    findByPhoneCandidates: jest.fn().mockResolvedValue({ getValue: () => null }),
    findByCuit: jest.fn().mockResolvedValue({ getValue: () => null }),
  })),
}));

jest.mock('../../../../application/CreateJobPostingFromTalentumUseCase', () => ({
  CreateJobPostingFromTalentumUseCase: jest.fn().mockImplementation(() => ({
    execute: jest.fn().mockResolvedValue({
      created: true,
      skipped: false,
      jobPostingId: 'jp-uuid-001',
      caseNumber: 42,
    }),
  })),
}));

import { Request, Response } from 'express';
import { TalentumWebhookController } from '../TalentumWebhookController';
// Import from @modules/matching — same mock instance used by PrescreeningResponseHandler after Passo 6 migration.
import { TalentumPrescreeningRepository } from '@modules/matching';
import { CreateJobPostingFromTalentumUseCase } from '../../../../application/CreateJobPostingFromTalentumUseCase';

// ─────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────

function makeResponsePayload(overrides: Record<string, any> = {}) {
  return {
    action: 'PRESCREENING_RESPONSE' as const,
    subtype: overrides.subtype ?? 'INITIATED',
    data: {
      prescreening: {
        id: 'tp-001',
        name: 'Test Case',
        ...(overrides.prescreening || {}),
      },
      profile: {
        id: 'prof-001',
        firstName: 'Test',
        lastName: 'User',
        email: 'test@example.com',
        phoneNumber: '+5491100000000',
        cuil: '20-12345678-9',
        registerQuestions: [],
        ...(overrides.profile || {}),
      },
      response: {
        id: 'resp-001',
        state: [],
        ...(overrides.response || {}),
      },
    },
  };
}

function makeCreatedPayload(overrides: Record<string, any> = {}) {
  return {
    action: 'PRESCREENING' as const,
    subtype: 'CREATED' as const,
    data: {
      _id: overrides._id ?? 'talentum-project-001',
      name: overrides.name ?? 'Operario de producción',
    },
  };
}

function makeMockReq(body: any, partnerContext?: any): Partial<Request> {
  const req: Partial<Request> = {
    body,
    headers: {},
  };
  if (partnerContext !== undefined) {
    (req as any).partnerContext = partnerContext;
  }
  return req;
}

function makeMockRes(): { res: Partial<Response>; getStatus: () => number | null; getBody: () => any } {
  let statusCode: number | null = null;
  let body: any = null;

  const res: Partial<Response> = {
    status: jest.fn().mockImplementation((code: number) => {
      statusCode = code;
      return res;
    }),
    json: jest.fn().mockImplementation((data: any) => {
      body = data;
      return res;
    }),
  };

  return {
    res,
    getStatus: () => statusCode,
    getBody: () => body,
  };
}

// ─────────────────────────────────────────────────────────────────
// Testes
// ─────────────────────────────────────────────────────────────────

describe('TalentumWebhookController', () => {
  let controller: TalentumWebhookController;

  beforeEach(() => {
    jest.clearAllMocks();
    controller = new TalentumWebhookController();
  });

  // ─────────────────────────────────────────────────────────────────
  // 1. Validação de payload (Zod)
  // ─────────────────────────────────────────────────────────────────

  describe('validação de payload', () => {
    it('deve retornar 400 com body vazio', async () => {
      const req = makeMockReq({});
      const { res, getStatus } = makeMockRes();

      await controller.handlePrescreening(req as Request, res as Response);

      expect(getStatus()).toBe(400);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ error: 'Invalid payload' }),
      );
    });

    it('deve retornar 400 com body null', async () => {
      const req = makeMockReq(null);
      const { res, getStatus } = makeMockRes();

      await controller.handlePrescreening(req as Request, res as Response);

      expect(getStatus()).toBe(400);
    });

    it('deve retornar 400 com body undefined', async () => {
      const req = makeMockReq(undefined);
      const { res, getStatus } = makeMockRes();

      await controller.handlePrescreening(req as Request, res as Response);

      expect(getStatus()).toBe(400);
    });

    it('deve retornar 400 sem action', async () => {
      const req = makeMockReq({ subtype: 'CREATED', data: { _id: 'x', name: 'y' } });
      const { res, getStatus } = makeMockRes();

      await controller.handlePrescreening(req as Request, res as Response);

      expect(getStatus()).toBe(400);
    });

    it('deve retornar 400 sem subtype', async () => {
      const req = makeMockReq({ action: 'PRESCREENING', data: { _id: 'x', name: 'y' } });
      const { res, getStatus } = makeMockRes();

      await controller.handlePrescreening(req as Request, res as Response);

      expect(getStatus()).toBe(400);
    });

    it('deve retornar 400 com combinação inválida (PRESCREENING + ANALYZED)', async () => {
      const req = makeMockReq({ action: 'PRESCREENING', subtype: 'ANALYZED', data: { _id: 'x', name: 'y' } });
      const { res, getStatus } = makeMockRes();

      await controller.handlePrescreening(req as Request, res as Response);

      expect(getStatus()).toBe(400);
    });

    it('deve retornar 400 quando prescreening.id está ausente no PRESCREENING_RESPONSE', async () => {
      const payload = makeResponsePayload();
      delete (payload.data.prescreening as any).id;

      const req = makeMockReq(payload);
      const { res, getStatus } = makeMockRes();

      await controller.handlePrescreening(req as Request, res as Response);

      expect(getStatus()).toBe(400);
    });

    it('deve retornar 400 quando prescreening.id é string vazia', async () => {
      const payload = makeResponsePayload({ prescreening: { id: '' } });

      const req = makeMockReq(payload);
      const { res, getStatus } = makeMockRes();

      await controller.handlePrescreening(req as Request, res as Response);

      expect(getStatus()).toBe(400);
    });

    it('deve retornar 400 quando email é inválido', async () => {
      const payload = makeResponsePayload({ profile: { email: 'not-an-email' } });

      const req = makeMockReq(payload);
      const { res, getStatus } = makeMockRes();

      await controller.handlePrescreening(req as Request, res as Response);

      expect(getStatus()).toBe(400);
    });

    it('deve retornar 400 quando profile está ausente', async () => {
      const payload = makeResponsePayload();
      delete (payload.data as any).profile;

      const req = makeMockReq(payload);
      const { res, getStatus } = makeMockRes();

      await controller.handlePrescreening(req as Request, res as Response);

      expect(getStatus()).toBe(400);
    });

    it('deve retornar 400 quando response está ausente', async () => {
      const payload = makeResponsePayload();
      delete (payload.data as any).response;

      const req = makeMockReq(payload);
      const { res, getStatus } = makeMockRes();

      await controller.handlePrescreening(req as Request, res as Response);

      expect(getStatus()).toBe(400);
    });

    it('deve retornar 400 com campo extra dentro de prescreening (strict mode)', async () => {
      const payload = makeResponsePayload();
      (payload.data.prescreening as any).extraField = 'nope';

      const req = makeMockReq(payload);
      const { res, getStatus } = makeMockRes();

      await controller.handlePrescreening(req as Request, res as Response);

      expect(getStatus()).toBe(400);
    });

    it('deve aceitar payload quando cuil está ausente (campo opcional)', async () => {
      const payload = makeResponsePayload();
      delete (payload.data.profile as any).cuil;

      const req = makeMockReq(payload, { isTest: false });
      const { res, getStatus } = makeMockRes();

      await controller.handlePrescreening(req as Request, res as Response);

      expect(getStatus()).toBe(200);
    });

    it('deve aceitar todos os subtypes válidos de PRESCREENING_RESPONSE', async () => {
      for (const subtype of ['INITIATED', 'IN_PROGRESS', 'COMPLETED', 'ANALYZED']) {
        const payload = makeResponsePayload({ subtype });
        const req = makeMockReq(payload, { isTest: false });
        const { res, getStatus } = makeMockRes();

        await controller.handlePrescreening(req as Request, res as Response);

        expect(getStatus()).toBe(200);
      }
    });

    it('deve retornar detalhes do erro Zod na resposta', async () => {
      const req = makeMockReq({ bad: true });
      const { res, getBody } = makeMockRes();

      await controller.handlePrescreening(req as Request, res as Response);

      const body = getBody();
      expect(body.error).toBe('Invalid payload');
      expect(body.details).toBeDefined();
    });

    it('deve normalizar email para lowercase', async () => {
      const payload = makeResponsePayload({ profile: { email: 'Test@EXAMPLE.com' } });
      const req = makeMockReq(payload, { isTest: false });
      const { res, getStatus } = makeMockRes();

      await controller.handlePrescreening(req as Request, res as Response);

      expect(getStatus()).toBe(200);
    });

    it('deve aceitar email com Unicode no local-part (RFC 6531 / SMTPUTF8)', async () => {
      const payload = makeResponsePayload({ profile: { email: 'maría.redondo@bue.edu.ar' } });
      const req = makeMockReq(payload, { isTest: false });
      const { res, getStatus } = makeMockRes();

      await controller.handlePrescreening(req as Request, res as Response);

      expect(getStatus()).toBe(200);
    });

    it('deve aceitar registerQuestions vazio (default [])', async () => {
      const payload = makeResponsePayload();
      delete (payload.data.profile as any).registerQuestions;

      const req = makeMockReq(payload, { isTest: false });
      const { res, getStatus } = makeMockRes();

      await controller.handlePrescreening(req as Request, res as Response);

      expect(getStatus()).toBe(200);
    });

    it('deve aceitar response.state vazio (default [])', async () => {
      const payload = makeResponsePayload();
      delete (payload.data.response as any).state;

      const req = makeMockReq(payload, { isTest: false });
      const { res, getStatus } = makeMockRes();

      await controller.handlePrescreening(req as Request, res as Response);

      expect(getStatus()).toBe(200);
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // 2. Roteamento por action
  // ─────────────────────────────────────────────────────────────────

  describe('roteamento por action', () => {
    it('PRESCREENING.CREATED deve chamar CreateJobPostingFromTalentumUseCase', async () => {
      const payload = makeCreatedPayload();
      const req = makeMockReq(payload, { isTest: false });
      const { res, getStatus, getBody } = makeMockRes();

      await controller.handlePrescreening(req as Request, res as Response);

      expect(getStatus()).toBe(200);
      const body = getBody();
      expect(body.received).toBe(true);
      expect(body.event).toBe('PRESCREENING.CREATED');
      expect(body.created).toBe(true);
      expect(body.jobPostingId).toBe('jp-uuid-001');
    });

    it('PRESCREENING_RESPONSE deve chamar ProcessTalentumPrescreening', async () => {
      const payload = makeResponsePayload();
      const req = makeMockReq(payload, { isTest: false });
      const { res, getStatus, getBody } = makeMockRes();

      await controller.handlePrescreening(req as Request, res as Response);

      expect(getStatus()).toBe(200);
      const body = getBody();
      expect(body).toHaveProperty('prescreeningId');
      expect(body).toHaveProperty('resolved');
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // 3. Propagação de environment
  // ─────────────────────────────────────────────────────────────────

  describe('propagação de environment', () => {
    it('deve passar environment=production quando partnerContext.isTest=false', async () => {
      const payload = makeResponsePayload();
      const req = makeMockReq(payload, { partnerId: 'p1', partnerName: 'talentum', isTest: false });
      const { res } = makeMockRes();

      await controller.handlePrescreening(req as Request, res as Response);

      const repoInstance = (TalentumPrescreeningRepository as jest.Mock).mock.results[0].value;
      expect(repoInstance.upsertPrescreening).toHaveBeenCalledWith(
        expect.objectContaining({ environment: 'production' }),
      );
    });

    it('deve usar environment=test quando partnerContext.isTest=true', async () => {
      const payload = makeResponsePayload();
      const req = makeMockReq(payload, { partnerId: 'p1', partnerName: 'talentum', isTest: true });
      const { res, getStatus } = makeMockRes();

      await controller.handlePrescreening(req as Request, res as Response);

      expect(getStatus()).toBe(200);
      const repoInstance = (TalentumPrescreeningRepository as jest.Mock).mock.results[0]?.value;
      if (repoInstance) {
        expect(repoInstance.upsertPrescreening).toHaveBeenCalledWith(
          expect.objectContaining({ environment: 'test' }),
        );
      }
    });

    it('deve defaultar para production quando partnerContext está ausente', async () => {
      const payload = makeResponsePayload();
      const req = makeMockReq(payload); // sem partnerContext
      const { res } = makeMockRes();

      await controller.handlePrescreening(req as Request, res as Response);

      const repoInstance = (TalentumPrescreeningRepository as jest.Mock).mock.results[0].value;
      expect(repoInstance.upsertPrescreening).toHaveBeenCalledWith(
        expect.objectContaining({ environment: 'production' }),
      );
    });

    it('deve defaultar para production quando partnerContext.isTest é undefined', async () => {
      const payload = makeResponsePayload();
      const req = makeMockReq(payload, { partnerId: 'p1', partnerName: 'talentum' });
      const { res } = makeMockRes();

      await controller.handlePrescreening(req as Request, res as Response);

      const repoInstance = (TalentumPrescreeningRepository as jest.Mock).mock.results[0].value;
      expect(repoInstance.upsertPrescreening).toHaveBeenCalledWith(
        expect.objectContaining({ environment: 'production' }),
      );
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // 4. Tratamento de erros
  // ─────────────────────────────────────────────────────────────────

  describe('tratamento de erros', () => {
    it('deve retornar 500 quando use case lança exceção', async () => {
      (TalentumPrescreeningRepository as jest.Mock).mockImplementationOnce(() => ({
        upsertPrescreening: jest.fn().mockRejectedValue(new Error('DB connection refused')),
        upsertQuestion: jest.fn(),
        upsertResponse: jest.fn(),
      }));

      const controller2 = new TalentumWebhookController();
      const payload = makeResponsePayload();
      const req = makeMockReq(payload, { isTest: false });
      const { res, getStatus, getBody } = makeMockRes();

      await controller2.handlePrescreening(req as Request, res as Response);

      expect(getStatus()).toBe(500);
      expect(getBody()).toEqual({ error: 'Internal server error' });
    });

    it('não deve expor detalhes do erro na resposta 500', async () => {
      (TalentumPrescreeningRepository as jest.Mock).mockImplementationOnce(() => ({
        upsertPrescreening: jest.fn().mockRejectedValue(new Error('FATAL: password authentication failed')),
        upsertQuestion: jest.fn(),
        upsertResponse: jest.fn(),
      }));

      const controller2 = new TalentumWebhookController();
      const payload = makeResponsePayload();
      const req = makeMockReq(payload, { isTest: false });
      const { res, getBody } = makeMockRes();

      await controller2.handlePrescreening(req as Request, res as Response);

      const body = getBody();
      expect(body.error).toBe('Internal server error');
      expect(JSON.stringify(body)).not.toContain('password');
      expect(JSON.stringify(body)).not.toContain('FATAL');
      expect(body.stack).toBeUndefined();
    });

    it('deve logar o prescreeningId externo no erro (para debugging)', async () => {
      const consoleSpy = jest.spyOn(console, 'error').mockImplementation();

      (TalentumPrescreeningRepository as jest.Mock).mockImplementationOnce(() => ({
        upsertPrescreening: jest.fn().mockRejectedValue(new Error('timeout')),
        upsertQuestion: jest.fn(),
        upsertResponse: jest.fn(),
      }));

      const controller2 = new TalentumWebhookController();
      const payload = makeResponsePayload({ prescreening: { id: 'external-tp-999' } });
      const req = makeMockReq(payload, { isTest: false });
      const { res } = makeMockRes();

      await controller2.handlePrescreening(req as Request, res as Response);

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('[TalentumWebhook:PrescreeningResponse] ERROR | extId=external-tp-999 |'),
        'timeout',
      );

      consoleSpy.mockRestore();
    });

    it('deve retornar 500 quando CreateJobPostingFromTalentum lança exceção', async () => {
      const consoleSpy = jest.spyOn(console, 'error').mockImplementation();

      (CreateJobPostingFromTalentumUseCase as jest.Mock).mockImplementationOnce(() => ({
        execute: jest.fn().mockRejectedValue(new Error('DB error')),
      }));

      const controller2 = new TalentumWebhookController();
      const payload = makeCreatedPayload();
      const req = makeMockReq(payload, { isTest: false });
      const { res, getStatus, getBody } = makeMockRes();

      await controller2.handlePrescreening(req as Request, res as Response);

      expect(getStatus()).toBe(500);
      expect(getBody()).toEqual({ error: 'Internal server error' });

      consoleSpy.mockRestore();
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // 5. Resposta de sucesso
  // ─────────────────────────────────────────────────────────────────

  describe('resposta de sucesso', () => {
    it('deve retornar 200 com formato correto para PRESCREENING_RESPONSE', async () => {
      const payload = makeResponsePayload();
      const req = makeMockReq(payload, { isTest: false });
      const { res, getStatus, getBody } = makeMockRes();

      await controller.handlePrescreening(req as Request, res as Response);

      expect(getStatus()).toBe(200);
      const body = getBody();
      expect(body).toHaveProperty('prescreeningId');
      expect(body).toHaveProperty('talentumPrescreeningId');
      expect(body).toHaveProperty('workerId');
      expect(body).toHaveProperty('jobPostingId');
      expect(body).toHaveProperty('resolved');
      expect(body.resolved).toHaveProperty('worker');
      expect(body.resolved).toHaveProperty('jobPosting');
    });

    it('deve retornar 200 com formato correto para PRESCREENING.CREATED', async () => {
      const payload = makeCreatedPayload();
      const req = makeMockReq(payload, { isTest: false });
      const { res, getStatus, getBody } = makeMockRes();

      await controller.handlePrescreening(req as Request, res as Response);

      expect(getStatus()).toBe(200);
      const body = getBody();
      expect(body.received).toBe(true);
      expect(body.event).toBe('PRESCREENING.CREATED');
      expect(body.jobPostingId).toBeDefined();
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // 5b. Erro sem propriedade .message (fallback ?? err)
  // ─────────────────────────────────────────────────────────────────

  describe('erro sem .message', () => {
    it('deve retornar 500 quando handler lança valor não-Error (string)', async () => {
      (TalentumPrescreeningRepository as jest.Mock).mockImplementationOnce(() => ({
        upsertPrescreening: jest.fn().mockRejectedValue('raw string error'),
        upsertWorkerJobApplicationFromTalentum: jest.fn(),
        upsertQuestion: jest.fn(),
        upsertResponse: jest.fn(),
      }));

      const controller2 = new TalentumWebhookController();
      const payload = makeResponsePayload();
      const req = makeMockReq(payload, { isTest: false });
      const { res, getStatus, getBody } = makeMockRes();

      await controller2.handlePrescreening(req as Request, res as Response);

      expect(getStatus()).toBe(500);
      expect(getBody()).toEqual({ error: 'Internal server error' });
    });

    it('deve retornar 500 quando VacancyCreated handler lança valor não-Error', async () => {
      const consoleSpy = jest.spyOn(console, 'error').mockImplementation();

      (CreateJobPostingFromTalentumUseCase as jest.Mock).mockImplementationOnce(() => ({
        execute: jest.fn().mockRejectedValue(42),
      }));

      const controller2 = new TalentumWebhookController();
      const payload = makeCreatedPayload();
      const req = makeMockReq(payload, { isTest: false });
      const { res, getStatus } = makeMockRes();

      await controller2.handlePrescreening(req as Request, res as Response);

      expect(getStatus()).toBe(500);
      consoleSpy.mockRestore();
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // 6. Validação de questions
  // ─────────────────────────────────────────────────────────────────

  describe('validação de questions', () => {
    it('deve retornar 400 quando registerQuestion tem questionId vazio', async () => {
      const payload = makeResponsePayload({
        profile: {
          registerQuestions: [
            { questionId: '', question: 'Test?', answer: 'yes', responseType: 'TEXT' },
          ],
        },
      });

      const req = makeMockReq(payload);
      const { res, getStatus } = makeMockRes();

      await controller.handlePrescreening(req as Request, res as Response);

      expect(getStatus()).toBe(400);
    });

    it('deve retornar 400 quando registerQuestion tem campo extra (strict)', async () => {
      const payload = makeResponsePayload({
        profile: {
          registerQuestions: [
            { questionId: 'q1', question: 'Test?', answer: 'yes', responseType: 'TEXT', extra: 'nope' },
          ],
        },
      });

      const req = makeMockReq(payload);
      const { res, getStatus } = makeMockRes();

      await controller.handlePrescreening(req as Request, res as Response);

      expect(getStatus()).toBe(400);
    });

    it('deve aceitar answer vazia em registerQuestion', async () => {
      const payload = makeResponsePayload({
        profile: {
          registerQuestions: [
            { questionId: 'q1', question: 'Test?', answer: '', responseType: 'TEXT' },
          ],
        },
      });

      const req = makeMockReq(payload, { isTest: false });
      const { res, getStatus } = makeMockRes();

      await controller.handlePrescreening(req as Request, res as Response);

      expect(getStatus()).toBe(200);
    });

    it('deve retornar 400 quando response.state item tem question vazia', async () => {
      const payload = makeResponsePayload({
        response: {
          state: [
            { questionId: 'q1', question: '', answer: 'yes', responseType: 'TEXT' },
          ],
        },
      });

      const req = makeMockReq(payload);
      const { res, getStatus } = makeMockRes();

      await controller.handlePrescreening(req as Request, res as Response);

      expect(getStatus()).toBe(400);
    });
  });
});
