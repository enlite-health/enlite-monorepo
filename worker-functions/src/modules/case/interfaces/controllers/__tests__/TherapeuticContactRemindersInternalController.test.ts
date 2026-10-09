const mockReportError = jest.fn();
jest.mock('@shared/logging', () => ({ logger: { info: jest.fn() }, reportError: (...a: unknown[]) => mockReportError(...a) }));

import { TherapeuticContactRemindersInternalController } from '../TherapeuticContactRemindersInternalController';

const res = () => { const r = { status: jest.fn(), json: jest.fn() }; r.status.mockReturnValue(r); return r; };
const RESULT = { cycles: 1, sent: 1, cancelled: 0, superseded: 0, skippedNoRecipient: 0, failed: 0, remainingDue: 0 };

describe('TherapeuticContactRemindersInternalController (spec 048)', () => {
  beforeEach(() => jest.clearAllMocks());

  it('200 com só contagens; limit default 50', async () => {
    const sweep = { execute: jest.fn().mockResolvedValue(RESULT) };
    const r = res();
    await new TherapeuticContactRemindersInternalController(sweep as never).handle({ query: {} } as never, r as never);
    expect(sweep.execute).toHaveBeenCalledWith({ limit: 50 });
    expect(r.status).toHaveBeenCalledWith(200);
    expect(r.json).toHaveBeenCalledWith(RESULT);
  });

  it('limit inválido: 400 e o use case nem roda', async () => {
    const sweep = { execute: jest.fn() };
    for (const limit of ['0', '501', 'abc']) {
      const r = res();
      await new TherapeuticContactRemindersInternalController(sweep as never).handle({ query: { limit } } as never, r as never);
      expect(r.status).toHaveBeenCalledWith(400);
    }
    expect(sweep.execute).not.toHaveBeenCalled();
  });

  it('erro geral: 500 genérico + reportError só com a origem (sem PII, sem corpo)', async () => {
    const sweep = { execute: jest.fn().mockRejectedValue(new Error('db fora')) };
    const r = res();
    await new TherapeuticContactRemindersInternalController(sweep as never).handle({ query: {}, body: { x: 'segredo' } } as never, r as never);
    expect(r.status).toHaveBeenCalledWith(500);
    expect(r.json).toHaveBeenCalledWith({ error: 'Internal server error' });
    expect(mockReportError).toHaveBeenCalledWith(expect.any(Error), { source: 'TherapeuticContactRemindersInternalController:handle' });
  });
});
