/**
 * WorkerControllerV2.test.ts
 *
 * Testa o controller HTTP que expõe os endpoints de worker para o app mobile.
 *
 * Como o WorkerControllerV2 instancia todas as dependências via `new` no construtor,
 * o DatabaseConnection é mockado ANTES do import do controller para evitar
 * tentativas reais de conexão com o banco durante os testes.
 *
 * Estratégia de mock para use cases:
 * - Após instanciar o controller, usamos jest.spyOn nos campos privados
 *   `getProgressUseCase` e `initWorkerUseCase` para controlar o comportamento
 *   sem depender de uma injeção de dependência real.
 *
 * Cenários:
 * initWorker:
 *   1. authUid ausente → 400 com erro descritivo
 *   2. email ausente → 400 com erro descritivo
 *   3. Worker já existe por authUid (idempotência) → 200 sem chamar initWorkerUseCase
 *   4. Worker novo → initWorkerUseCase cria → 201
 *   5. initWorkerUseCase falha → 400 com erro
 *   6. Exceção lançada internamente → 500
 *
 * getProgress (me endpoint):
 *   1. Sem auth → 401
 *   2. Worker encontrado → 200 com dados
 *   3. Worker não encontrado → 404 "Worker not found"
 *
 * Contrato round-trip (init → me):
 *   4. authUid usado no init é o mesmo que getProgress busca no repositório
 */

const mockQuery = jest.fn();

jest.mock('@shared/database/DatabaseConnection', () => ({
  DatabaseConnection: {
    getInstance: jest.fn().mockReturnValue({
      getPool: jest.fn().mockReturnValue({
        query: mockQuery,
      }),
    }),
  },
}));

// KMSEncryptionService também faz IO — mockamos para não necessitar credenciais GCP
jest.mock('@shared/security/KMSEncryptionService', () => ({
  KMSEncryptionService: jest.fn().mockImplementation(() => ({
    encrypt: jest.fn().mockResolvedValue('encrypted-value'),
    decrypt: jest.fn().mockResolvedValue(''),
    encryptBatch: jest.fn().mockResolvedValue({}),
  })),
}));

import { WorkerControllerV2 } from '../WorkerControllerV2';
import { Request, Response } from 'express';
import { Result } from '@shared/utils/Result';
import { Worker } from '../../../domain/Worker';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function mockReqRes(
  body: Record<string, unknown> = {},
  headers: Record<string, string> = {},
  user?: { uid: string }
): [Request, Response] {
  const req = {
    body,
    params: {},
    query: {},
    headers,
    user,
  } as unknown as Request;

  const res = {
    json: jest.fn().mockReturnThis(),
    status: jest.fn().mockReturnThis(),
  } as unknown as Response;

  return [req, res];
}

// ─── Dados de teste ───────────────────────────────────────────────────────────

const AUTH_UID = 'firebase-uid-test-abc123';
const WORKER_EMAIL = 'worker@example.com';
const WORKER_ID = 'b2c3d4e5-0000-4bcd-9000-000000000002';

const mockWorker: Worker = {
  id: WORKER_ID,
  authUid: AUTH_UID,
  email: WORKER_EMAIL,
  phone: '+5511988887777',
  currentStep: 1,
  status: 'INCOMPLETE_REGISTER',
  country: 'BR',
  timezone: 'America/Sao_Paulo',
  registrationCompleted: false,
  createdAt: new Date('2024-03-01T12:00:00Z'),
  updatedAt: new Date('2024-03-01T12:00:00Z'),
};

// ─── Testes ───────────────────────────────────────────────────────────────────

describe('WorkerControllerV2', () => {
  let controller: WorkerControllerV2;

  beforeEach(() => {
    jest.clearAllMocks();
    controller = new WorkerControllerV2();
  });

  // ───────────────────────────────────────────────────────────────────────────
  // initWorker
  // ───────────────────────────────────────────────────────────────────────────

  describe('initWorker', () => {

    it('retorna 400 com erro descritivo quando authUid está ausente no body', async () => {
      const [req, res] = mockReqRes({ email: WORKER_EMAIL });

      await controller.initWorker(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          error: expect.stringContaining('authUid'),
        })
      );
    });

    it('retorna 400 com erro descritivo quando email está ausente no body', async () => {
      const [req, res] = mockReqRes({ authUid: AUTH_UID });

      await controller.initWorker(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          error: expect.stringContaining('email'),
        })
      );
    });

    it('retorna 200 com worker existente sem chamar initWorkerUseCase quando worker já existe para o authUid', async () => {
      jest.spyOn(controller['getProgressUseCase'], 'execute')
        .mockResolvedValue(Result.ok(mockWorker));

      const initSpy = jest.spyOn(controller['initWorkerUseCase'], 'execute');

      const [req, res] = mockReqRes({ authUid: AUTH_UID, email: WORKER_EMAIL });

      await controller.initWorker(req, res);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          data: expect.objectContaining({ status: 'ok', worker: mockWorker }),
        })
      );
      expect(initSpy).not.toHaveBeenCalled();
    });

    it('retorna 201 com novo worker quando worker não existe e initWorkerUseCase cria com sucesso', async () => {
      jest.spyOn(controller['getProgressUseCase'], 'execute')
        .mockResolvedValue(Result.fail('Worker not found'));

      jest.spyOn(controller['initWorkerUseCase'], 'execute')
        .mockResolvedValue(Result.ok({ status: 'ok' as const, worker: mockWorker }));

      const [req, res] = mockReqRes({ authUid: AUTH_UID, email: WORKER_EMAIL });

      await controller.initWorker(req, res);

      expect(res.status).toHaveBeenCalledWith(201);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          data: expect.objectContaining({ status: 'ok', worker: mockWorker }),
        })
      );
    });

    it('repassa lgpdOptIn e whatsappPhone ao initWorkerUseCase para persistir no banco', async () => {
      jest.spyOn(controller['getProgressUseCase'], 'execute')
        .mockResolvedValue(Result.fail('Worker not found'));

      const initSpy = jest.spyOn(controller['initWorkerUseCase'], 'execute')
        .mockResolvedValue(Result.ok({ status: 'ok' as const, worker: mockWorker }));

      const [req, res] = mockReqRes({
        authUid: AUTH_UID,
        email: WORKER_EMAIL,
        lgpdOptIn: true,
        whatsappPhone: '+5411234567890',
        country: 'AR',
      });

      await controller.initWorker(req, res);

      expect(res.status).toHaveBeenCalledWith(201);
      expect(initSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          lgpdOptIn: true,
          whatsappPhone: '+5411234567890',
        })
      );
    });

    it('retorna 400 com mensagem de erro quando initWorkerUseCase falha', async () => {
      jest.spyOn(controller['getProgressUseCase'], 'execute')
        .mockResolvedValue(Result.fail('Worker not found'));

      const mensagemDeErro = 'Duplicate email: worker already registered';
      jest.spyOn(controller['initWorkerUseCase'], 'execute')
        .mockResolvedValue(Result.fail(mensagemDeErro));

      const [req, res] = mockReqRes({ authUid: AUTH_UID, email: WORKER_EMAIL });

      await controller.initWorker(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          error: mensagemDeErro,
        })
      );
    });

    it('retorna 500 quando o use case lança uma exceção inesperada', async () => {
      jest.spyOn(controller['getProgressUseCase'], 'execute')
        .mockRejectedValue(new Error('Unhandled database crash'));

      const [req, res] = mockReqRes({ authUid: AUTH_UID, email: WORKER_EMAIL });

      await controller.initWorker(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          error: 'Internal server error',
        })
      );
    });

  });

  // ───────────────────────────────────────────────────────────────────────────
  // getProgress (me endpoint)
  // ───────────────────────────────────────────────────────────────────────────

  describe('getProgress', () => {

    it('retorna 401 quando não há user.uid nem header x-auth-uid', async () => {
      const [req, res] = mockReqRes({}, {});

      await controller.getProgress(req, res);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          error: expect.stringContaining('Unauthorized'),
        })
      );
    });

    it('retorna 200 com dados do worker quando getProgressUseCase encontra o worker via user.uid', async () => {
      jest.spyOn(controller['getProgressUseCase'], 'execute')
        .mockResolvedValue(Result.ok(mockWorker));
      mockQuery.mockResolvedValueOnce({ rows: [{ missing: [] }] });

      const [req, res] = mockReqRes({}, {}, { uid: AUTH_UID });

      await controller.getProgress(req, res);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          data: { ...mockWorker, missingFields: [] },
        })
      );
    });

    it('retorna 200 com dados do worker quando getProgressUseCase encontra o worker via header x-auth-uid', async () => {
      jest.spyOn(controller['getProgressUseCase'], 'execute')
        .mockResolvedValue(Result.ok(mockWorker));
      mockQuery.mockResolvedValueOnce({ rows: [{ missing: [] }] });

      const [req, res] = mockReqRes({}, { 'x-auth-uid': AUTH_UID });

      await controller.getProgress(req, res);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          data: { ...mockWorker, missingFields: [] },
        })
      );
    });

    // ── missingFields: a fonte única de completude que a tela consome ────────
    //
    // Incidente 08/09/2026: o frontend mantinha a PRÓPRIA lista de campos
    // obrigatórios, e ela omitia `phone` e `title_certificate`. A prestadora
    // via "cadastro completo" na home e levava "registro incompleto" ao se
    // postular — 23 pessoas nesse estado em produção. O GET agora devolve o
    // veredito de `fn_worker_missing_fields`, a MESMA função que barra a
    // postulação, para os dois nunca divergirem.

    it('devolve missingFields com o que o portão exige — inclusive phone e title_certificate', async () => {
      jest.spyOn(controller['getProgressUseCase'], 'execute')
        .mockResolvedValue(Result.ok(mockWorker));
      mockQuery.mockResolvedValueOnce({
        rows: [{ missing: ['phone', 'title_certificate'] }],
      });

      const [req, res] = mockReqRes({}, {}, { uid: AUTH_UID });

      await controller.getProgress(req, res);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            missingFields: ['phone', 'title_certificate'],
          }),
        })
      );
    });

    it('quando não consegue apurar, devolve missingFields NULL — "não sei" nunca vira "completo"', async () => {
      jest.spyOn(controller['getProgressUseCase'], 'execute')
        .mockResolvedValue(Result.ok(mockWorker));
      mockQuery.mockRejectedValueOnce(new Error('db down'));

      const [req, res] = mockReqRes({}, {}, { uid: AUTH_UID });

      await controller.getProgress(req, res);

      // 200 com null (e não omissão da chave, nem `[]`): o cliente precisa
      // conseguir distinguir "nada falta" de "não foi possível apurar". Fundir
      // ausência de informação com informação de ausência é a causa raiz que
      // este conserto ataca.
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ missingFields: null }),
        })
      );
    });

    it('retorna 404 com "Worker not found" quando getProgressUseCase falha por auth_uid sem vínculo no banco', async () => {
      jest.spyOn(controller['getProgressUseCase'], 'execute')
        .mockResolvedValue(Result.fail('Worker not found'));

      const [req, res] = mockReqRes({}, { 'x-auth-uid': 'uid-sem-vinculo' });

      await controller.getProgress(req, res);

      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          error: 'Worker not found',
        })
      );
    });

  });

  // ───────────────────────────────────────────────────────────────────────────
  // Contrato round-trip: init → me
  // Garante que o authUid usado no init é exatamente o mesmo que o me vai buscar.
  // Este é o teste crítico que detecta o bug "Worker not found" após login.
  // ───────────────────────────────────────────────────────────────────────────

  describe('Contrato round-trip: init → me', () => {

    it('após initWorker criar worker com authUid, getProgress busca com o mesmo authUid exato', async () => {
      const AUTH_UID_ROUND_TRIP = 'round-trip-uid-XYZ789';

      // initWorker: worker não existe ainda, vai criar
      const getProgressSpy = jest.spyOn(controller['getProgressUseCase'], 'execute')
        .mockResolvedValueOnce(Result.fail('Worker not found')) // chamada dentro de initWorker
        .mockResolvedValueOnce(Result.ok({ ...mockWorker, authUid: AUTH_UID_ROUND_TRIP })); // chamada direta de getProgress

      jest.spyOn(controller['initWorkerUseCase'], 'execute')
        .mockResolvedValue(Result.ok({ status: 'ok' as const, worker: { ...mockWorker, authUid: AUTH_UID_ROUND_TRIP } }));

      // 1. Chama initWorker
      const [initReq, initRes] = mockReqRes({ authUid: AUTH_UID_ROUND_TRIP, email: WORKER_EMAIL });
      await controller.initWorker(initReq, initRes);
      expect(initRes.status).toHaveBeenCalledWith(201);

      // 2. Chama getProgress com o mesmo authUid
      const [meReq, meRes] = mockReqRes({}, { 'x-auth-uid': AUTH_UID_ROUND_TRIP });
      await controller.getProgress(meReq, meRes);

      // O getProgressUseCase deve ter sido chamado com o authUid exato nas duas ocasiões
      expect(getProgressSpy).toHaveBeenCalledWith(AUTH_UID_ROUND_TRIP);
      expect(getProgressSpy).toHaveBeenCalledTimes(2);

      // A segunda chamada (getProgress direto) retorna 200
      expect(meRes.status).toHaveBeenCalledWith(200);
    });

  });

});
