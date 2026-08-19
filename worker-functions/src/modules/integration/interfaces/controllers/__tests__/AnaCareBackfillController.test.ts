/**
 * AnaCareBackfillController.test.ts
 *
 * Cobre:
 *   1. Body inválido → 400 sem tocar no use case
 *   2. Body válido → 200 com o sumário do use case
 *   3. Erro do use case → 500 + reportError
 *   4. FIAÇÃO: o providerFactory passado ao use case constrói o provider COM
 *      o guard `isExternalIdClaimed` — é um guard fail-closed, "esqueci de
 *      injetar" precisa quebrar o teste, não passar silencioso.
 */

// ── Mocks (antes dos imports) ─────────────────────────────────────

const mockExecute = jest.fn();
const useCaseCtorArgs: unknown[][] = [];

jest.mock('../../../application/BackfillWorkerMirrorUseCase', () => ({
  BackfillWorkerMirrorUseCase: jest.fn().mockImplementation((...args: unknown[]) => {
    useCaseCtorArgs.push(args);
    return { execute: mockExecute };
  }),
}));

const mockIsAnaCareIdClaimed = jest.fn();
jest.mock('../../../application/MirrorWorkerService', () => ({
  isAnaCareIdClaimed: (externalId: string) => mockIsAnaCareIdClaimed(externalId),
}));

const providerCtorArgs: unknown[][] = [];
jest.mock('../../../infrastructure/anacare/AnaCareMirrorProvider', () => ({
  AnaCareMirrorProvider: jest.fn().mockImplementation((...args: unknown[]) => {
    providerCtorArgs.push(args);
    return { name: 'anacare' };
  }),
}));

const mockReportError = jest.fn();
jest.mock('@shared/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  reportError: (...args: unknown[]) => mockReportError(...args),
  loggingAls: { getStore: jest.fn().mockReturnValue(null) },
}));

// ── Imports ───────────────────────────────────────────────────────

import type { Request, Response } from 'express';
import { AnaCareBackfillController } from '../AnaCareBackfillController';

// ── Helpers ───────────────────────────────────────────────────────

interface FakeRes {
  res: Response;
  status: jest.Mock;
  json: jest.Mock;
}

function makeRes(): FakeRes {
  const json = jest.fn();
  const status = jest.fn().mockImplementation(() => ({ json }));
  return { res: { status, json } as unknown as Response, status, json };
}

function makeReq(body: unknown): Request {
  return { body } as Request;
}

const SUMMARY = { eligible: 3, created: 1, updated: 1, skipped: 1, deactivated: 0, errors: [] };

// ── Suite ─────────────────────────────────────────────────────────

describe('AnaCareBackfillController.handle', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    useCaseCtorArgs.length = 0;
    providerCtorArgs.length = 0;
  });

  it('responde 400 e não executa o backfill quando o body é inválido', async () => {
    const { res, status, json } = makeRes();

    await new AnaCareBackfillController().handle(makeReq({ limit: -1 }), res);

    expect(status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ success: false, error: 'Invalid request body' }));
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it('responde 200 com o sumário e repassa dryRun/limit ao use case', async () => {
    mockExecute.mockResolvedValue(SUMMARY);
    const { res, status, json } = makeRes();

    await new AnaCareBackfillController().handle(makeReq({ dryRun: false, limit: 10 }), res);

    expect(mockExecute).toHaveBeenCalledWith({ dryRun: false, limit: 10 });
    expect(status).toHaveBeenCalledWith(200);
    expect(json).toHaveBeenCalledWith({ success: true, data: SUMMARY });
  });

  it('body ausente é tratado como {} (dryRun default do use case)', async () => {
    mockExecute.mockResolvedValue(SUMMARY);
    const { res, status } = makeRes();

    await new AnaCareBackfillController().handle(makeReq(undefined), res);

    expect(mockExecute).toHaveBeenCalledWith({ dryRun: undefined, limit: undefined });
    expect(status).toHaveBeenCalledWith(200);
  });

  it('responde 500 e reporta o erro quando o use case falha', async () => {
    mockExecute.mockRejectedValue(new Error('AnaCare unavailable'));
    const { res, status, json } = makeRes();

    await new AnaCareBackfillController().handle(makeReq({}), res);

    expect(status).toHaveBeenCalledWith(500);
    expect(json).toHaveBeenCalledWith({ success: false, error: 'AnaCare unavailable' });
    expect(mockReportError).toHaveBeenCalled();
  });

  it('erro não-Error também vira 500 (sem quebrar o handler)', async () => {
    mockExecute.mockRejectedValue('boom');
    const { res, status, json } = makeRes();

    await new AnaCareBackfillController().handle(makeReq({}), res);

    expect(status).toHaveBeenCalledWith(500);
    expect(json).toHaveBeenCalledWith({ success: false, error: 'boom' });
  });

  it('FIAÇÃO: o providerFactory do backfill injeta o guard isExternalIdClaimed', async () => {
    process.env.ANACARE_API_KEY = 'ana_care.test.backfill'; // AnaCareClient.create() → fromEnv
    mockExecute.mockResolvedValue(SUMMARY);
    const { res } = makeRes();

    await new AnaCareBackfillController().handle(makeReq({ dryRun: false }), res);

    // o factory é lazy: o use case só o chama quando há upsert real
    expect(useCaseCtorArgs).toHaveLength(1);
    const [providerFactory] = useCaseCtorArgs[0] as [() => Promise<unknown>];
    await providerFactory();

    expect(providerCtorArgs).toHaveLength(1);
    const [, deps] = providerCtorArgs[0] as [unknown, { isExternalIdClaimed?: (id: string) => Promise<boolean> }];
    expect(typeof deps?.isExternalIdClaimed).toBe('function');

    mockIsAnaCareIdClaimed.mockResolvedValue(true);
    await expect(deps.isExternalIdClaimed!('7777')).resolves.toBe(true);
    expect(mockIsAnaCareIdClaimed).toHaveBeenCalledWith('7777');

    delete process.env.ANACARE_API_KEY;
  });
});
