/**
 * AnaCareMirrorEventHandler.test.ts
 *
 * Cobre:
 *   1. Payload válido → instancia provider e chama mirrorOne
 *   2. Payload inválido (workerId ausente) → throw
 *   3. Erro do service → propaga (DomainEventProcessor marca 'failed')
 */

// ── Mocks (antes dos imports) ─────────────────────────────────────

const mockMirrorOne = jest.fn();

// MirrorWorkerService é instanciado com o provider injetado pelo factory;
// mockamos o mirrorOne via prototype para interceptar qualquer instância.
jest.mock('../MirrorWorkerService', () => ({
  MirrorWorkerService: jest.fn().mockImplementation(() => ({
    mirrorOne: mockMirrorOne,
  })),
}));

jest.mock('@shared/logging', () => ({
  logger: {
    child: jest.fn().mockReturnValue({
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    }),
    info: jest.fn(),
    warn: jest.fn(),
  },
  loggingAls: { getStore: jest.fn().mockReturnValue(null) },
}));

// ── Imports ───────────────────────────────────────────────────────

import { createAnaCareMirrorHandler } from '../AnaCareMirrorEventHandler';
import type { AnaCareMirrorProvider } from '../../infrastructure/anacare/AnaCareMirrorProvider';

// ── Fake provider factory ─────────────────────────────────────────

function makeFakeProvider(): AnaCareMirrorProvider {
  return {
    name: 'anacare-fake',
    upsert: jest.fn(),
    deactivate: jest.fn(),
  } as unknown as AnaCareMirrorProvider;
}

// ── Suite ─────────────────────────────────────────────────────────

describe('createAnaCareMirrorHandler', () => {
  const WORKER_ID = 'worker-uuid-handler-test';
  let fakeProvider: AnaCareMirrorProvider;
  let providerFactory: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    fakeProvider = makeFakeProvider();
    providerFactory = jest.fn().mockResolvedValue(fakeProvider);
  });

  // ─────────────────────────────────────────────
  // 1. Payload válido → chama mirrorOne
  // ─────────────────────────────────────────────

  it('chama mirrorOne com workerId correto quando payload válido', async () => {
    mockMirrorOne.mockResolvedValue('created');
    const handler = createAnaCareMirrorHandler({ providerFactory });

    await handler({ workerId: WORKER_ID });

    expect(providerFactory).toHaveBeenCalledTimes(1);
    expect(mockMirrorOne).toHaveBeenCalledWith(WORKER_ID);
  });

  it('chama mirrorOne e não lança erro quando result=updated', async () => {
    mockMirrorOne.mockResolvedValue('updated');
    const handler = createAnaCareMirrorHandler({ providerFactory });

    await expect(handler({ workerId: WORKER_ID })).resolves.toBeUndefined();
    expect(mockMirrorOne).toHaveBeenCalledWith(WORKER_ID);
  });

  it('chama mirrorOne e não lança erro quando result=skipped', async () => {
    mockMirrorOne.mockResolvedValue('skipped');
    const handler = createAnaCareMirrorHandler({ providerFactory });

    await expect(handler({ workerId: WORKER_ID })).resolves.toBeUndefined();
  });

  it('chama mirrorOne e não lança erro quando result=deactivated', async () => {
    mockMirrorOne.mockResolvedValue('deactivated');
    const handler = createAnaCareMirrorHandler({ providerFactory });

    await expect(handler({ workerId: WORKER_ID })).resolves.toBeUndefined();
  });

  // ─────────────────────────────────────────────
  // 2. Payload inválido
  // ─────────────────────────────────────────────

  it('lança erro quando workerId está ausente no payload', async () => {
    const handler = createAnaCareMirrorHandler({ providerFactory });

    await expect(handler({})).rejects.toThrow(/workerId must be a non-empty string/);
    expect(mockMirrorOne).not.toHaveBeenCalled();
  });

  it('lança erro quando workerId é número (tipo incorreto)', async () => {
    const handler = createAnaCareMirrorHandler({ providerFactory });

    await expect(handler({ workerId: 123 })).rejects.toThrow(/workerId must be a non-empty string/);
  });

  it('lança erro quando workerId é string vazia', async () => {
    const handler = createAnaCareMirrorHandler({ providerFactory });

    await expect(handler({ workerId: '' })).rejects.toThrow(/workerId must be a non-empty string/);
  });

  // ─────────────────────────────────────────────
  // 3. Erro do service propaga (DomainEventProcessor marca 'failed')
  // ─────────────────────────────────────────────

  it('propaga erro do mirrorOne para o DomainEventProcessor marcar como failed', async () => {
    const apiError = new Error('HTTP 503: AnaCare unavailable');
    mockMirrorOne.mockRejectedValue(apiError);
    const handler = createAnaCareMirrorHandler({ providerFactory });

    await expect(handler({ workerId: WORKER_ID })).rejects.toThrow('HTTP 503: AnaCare unavailable');
  });
});
