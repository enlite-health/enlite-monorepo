import { ClaimController } from '../ClaimController';
import { Result } from '@shared/utils/Result';
import { Worker } from '@modules/worker/domain/Worker';
import { Request, Response } from 'express';
import { logger } from '@shared/logging';

// Mock logger para não poluir output
jest.mock('@shared/logging', () => ({
  logger: {
    child: jest.fn().mockReturnValue({
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    }),
  },
  reportError: jest.fn(),
}));

const WORKER_ID = 'a1b2c3d4-1234-4abc-8def-9876543210ab';

const claimedWorker: Worker = {
  id: WORKER_ID,
  authUid: 'newFirebaseUid999',
  email: 'joana@gmail.com',
  phone: '+5491155261243',
  currentStep: 1,
  status: 'INCOMPLETE_REGISTER',
  country: 'AR',
  timezone: 'America/Argentina/Buenos_Aires',
  registrationCompleted: false,
  createdAt: new Date('2024-01-01'),
  updatedAt: new Date('2024-01-01'),
};

function makeMockRes(): [Response, jest.Mock, jest.Mock] {
  const jsonMock = jest.fn();
  const statusMock = jest.fn().mockReturnValue({ json: jsonMock });
  const res = { status: statusMock, json: jsonMock } as unknown as Response;
  return [res, statusMock, jsonMock];
}

describe('ClaimController', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('POST /api/auth/claim/start', () => {
    const validBody = {
      authUid: 'newUid123',
      email: 'joana@gmail.com',
      phone: '+5491155261243',
    };

    it('retorna 200 com candidateWorkerId, phoneMasked e verificationSid', async () => {
      const startClaim = {
        execute: jest.fn().mockResolvedValue(
          Result.ok({
            candidateWorkerId: WORKER_ID,
            phoneMasked: '+54 9 11 ****-1243',
            verificationSid: 'VE_SID',
          }),
        ),
      };
      const confirmClaim = { execute: jest.fn() };
      const controller = new ClaimController(startClaim as any, confirmClaim as any);

      const [actualRes, statusFn, jsonFn] = makeMockRes();
      await controller.start({ body: validBody, headers: {}, ip: '127.0.0.1' } as Request, actualRes);

      expect(statusFn).toHaveBeenCalledWith(200);
      expect(jsonFn).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          data: expect.objectContaining({
            candidateWorkerId: WORKER_ID,
            verificationSid: 'VE_SID',
          }),
        }),
      );
    });

    it('retorna 200 com noCandidate: true quando não encontra ficha', async () => {
      const startClaim = {
        execute: jest.fn().mockResolvedValue(Result.ok({ noCandidate: true })),
      };
      const confirmClaim = { execute: jest.fn() };
      const controller = new ClaimController(startClaim as any, confirmClaim as any);

      const [actualRes, statusFn, jsonFn] = makeMockRes();
      await controller.start({ body: validBody, headers: {}, ip: '127.0.0.1' } as Request, actualRes);

      expect(statusFn).toHaveBeenCalledWith(200);
      expect(jsonFn).toHaveBeenCalledWith(
        expect.objectContaining({ success: true, data: { noCandidate: true } }),
      );
    });

    it('retorna 400 quando authUid está ausente', async () => {
      const startClaim = { execute: jest.fn() };
      const confirmClaim = { execute: jest.fn() };
      const controller = new ClaimController(startClaim as any, confirmClaim as any);

      const [actualRes, statusFn, jsonFn] = makeMockRes();
      await controller.start({ body: { email: 'joana@gmail.com', phone: '+5491155261243' }, headers: {}, ip: '127.0.0.1' } as Request, actualRes);

      expect(statusFn).toHaveBeenCalledWith(400);
      expect(jsonFn).toHaveBeenCalledWith(expect.objectContaining({ success: false }));
      expect(startClaim.execute).not.toHaveBeenCalled();
    });

    it('retorna 400 quando phone está ausente', async () => {
      const startClaim = { execute: jest.fn() };
      const confirmClaim = { execute: jest.fn() };
      const controller = new ClaimController(startClaim as any, confirmClaim as any);

      const [actualRes, statusFn] = makeMockRes();
      await controller.start({ body: { authUid: 'uid', email: 'joana@gmail.com' }, headers: {}, ip: '127.0.0.1' } as Request, actualRes);

      expect(statusFn).toHaveBeenCalledWith(400);
    });

    it('retorna 400 quando use case retorna INVALID_PHONE', async () => {
      const startClaim = {
        execute: jest.fn().mockResolvedValue(Result.fail('INVALID_PHONE')),
      };
      const confirmClaim = { execute: jest.fn() };
      const controller = new ClaimController(startClaim as any, confirmClaim as any);

      const [actualRes, statusFn, jsonFn] = makeMockRes();
      await controller.start({ body: validBody, headers: {}, ip: '127.0.0.1' } as Request, actualRes);

      expect(statusFn).toHaveBeenCalledWith(400);
      expect(jsonFn).toHaveBeenCalledWith(
        expect.objectContaining({ success: false, error: 'INVALID_PHONE' }),
      );
    });

    it('retorna 500 quando use case retorna erro não-cliente', async () => {
      const startClaim = {
        execute: jest.fn().mockResolvedValue(Result.fail('DB connection lost')),
      };
      const confirmClaim = { execute: jest.fn() };
      const controller = new ClaimController(startClaim as any, confirmClaim as any);

      const [actualRes, statusFn] = makeMockRes();
      await controller.start({ body: validBody, headers: {}, ip: '127.0.0.1' } as Request, actualRes);

      expect(statusFn).toHaveBeenCalledWith(500);
    });

    it('retorna 500 quando use case lança exceção inesperada', async () => {
      const startClaim = {
        execute: jest.fn().mockRejectedValue(new Error('Unexpected crash')),
      };
      const confirmClaim = { execute: jest.fn() };
      const controller = new ClaimController(startClaim as any, confirmClaim as any);

      const [actualRes, statusFn] = makeMockRes();
      await controller.start({ body: validBody, headers: {}, ip: '127.0.0.1' } as Request, actualRes);

      expect(statusFn).toHaveBeenCalledWith(500);
    });

    it('loga claim_request_received e claim_request_completed no caminho feliz', async () => {
      const logChild = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
      (logger.child as jest.Mock).mockReturnValue(logChild);

      const startClaim = {
        execute: jest.fn().mockResolvedValue(Result.ok({ noCandidate: true })),
      };
      const confirmClaim = { execute: jest.fn() };
      const controller = new ClaimController(startClaim as any, confirmClaim as any);

      const [actualRes] = makeMockRes();
      await controller.start({ body: validBody, headers: {}, ip: '127.0.0.1' } as Request, actualRes);

      expect(logChild.info).toHaveBeenCalledWith(
        expect.objectContaining({ msg: 'claim_request_received' }),
      );
      expect(logChild.info).toHaveBeenCalledWith(
        expect.objectContaining({ msg: 'claim_request_completed', responseStatus: 200 }),
      );
    });
  });

  describe('POST /api/auth/claim/confirm', () => {
    const validBody = {
      verificationSid: 'VE_SID',
      otp: '123456',
      authUid: 'newUid123',
      email: 'joana@gmail.com',
      candidateWorkerId: WORKER_ID,
    };

    it('retorna 200 com worker após OTP válido', async () => {
      const startClaim = { execute: jest.fn() };
      const confirmClaim = {
        execute: jest.fn().mockResolvedValue(Result.ok(claimedWorker)),
      };
      const controller = new ClaimController(startClaim as any, confirmClaim as any);

      const [actualRes, statusFn, jsonFn] = makeMockRes();
      await controller.confirm({ body: validBody, headers: {}, ip: '127.0.0.1' } as Request, actualRes);

      expect(statusFn).toHaveBeenCalledWith(200);
      expect(jsonFn).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          data: expect.objectContaining({ worker: claimedWorker }),
        }),
      );
    });

    it.each(['INVALID_OTP', 'EXPIRED_OTP', 'CANDIDATE_NOT_FOUND', 'NOT_IMPORTABLE'])(
      'retorna 400 com erro %s quando use case retorna esse código',
      async (errorCode) => {
        const startClaim = { execute: jest.fn() };
        const confirmClaim = {
          execute: jest.fn().mockResolvedValue(Result.fail(errorCode)),
        };
        const controller = new ClaimController(startClaim as any, confirmClaim as any);

        const [actualRes, statusFn, jsonFn] = makeMockRes();
        await controller.confirm({ body: validBody, headers: {}, ip: '127.0.0.1' } as Request, actualRes);

        expect(statusFn).toHaveBeenCalledWith(400);
        expect(jsonFn).toHaveBeenCalledWith(
          expect.objectContaining({ success: false, error: errorCode }),
        );
      },
    );

    it('retorna 400 quando candidateWorkerId está ausente', async () => {
      const startClaim = { execute: jest.fn() };
      const confirmClaim = { execute: jest.fn() };
      const controller = new ClaimController(startClaim as any, confirmClaim as any);

      const { candidateWorkerId: _omit, ...bodyWithout } = validBody;
      const [actualRes, statusFn] = makeMockRes();
      await controller.confirm({ body: bodyWithout, headers: {}, ip: '127.0.0.1' } as Request, actualRes);

      expect(statusFn).toHaveBeenCalledWith(400);
      expect(confirmClaim.execute).not.toHaveBeenCalled();
    });

    it('retorna 500 quando use case lança exceção inesperada', async () => {
      const startClaim = { execute: jest.fn() };
      const confirmClaim = {
        execute: jest.fn().mockRejectedValue(new Error('Crash')),
      };
      const controller = new ClaimController(startClaim as any, confirmClaim as any);

      const [actualRes, statusFn] = makeMockRes();
      await controller.confirm({ body: validBody, headers: {}, ip: '127.0.0.1' } as Request, actualRes);

      expect(statusFn).toHaveBeenCalledWith(500);
    });

    it('loga claim_request_received e claim_request_completed no confirm', async () => {
      const logChild = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
      (logger.child as jest.Mock).mockReturnValue(logChild);

      const startClaim = { execute: jest.fn() };
      const confirmClaim = {
        execute: jest.fn().mockResolvedValue(Result.ok(claimedWorker)),
      };
      const controller = new ClaimController(startClaim as any, confirmClaim as any);

      const [actualRes] = makeMockRes();
      await controller.confirm({ body: validBody, headers: {}, ip: '127.0.0.1' } as Request, actualRes);

      expect(logChild.info).toHaveBeenCalledWith(
        expect.objectContaining({ msg: 'claim_request_received' }),
      );
      expect(logChild.info).toHaveBeenCalledWith(
        expect.objectContaining({ msg: 'claim_request_completed', responseStatus: 200 }),
      );
    });
  });
});
