/**
 * PromoteBlockedApplicationsEventHandler.test.ts
 *
 * Handler para `worker.registration_completed`. Mesmo padrão de
 * AnaCareMirrorEventHandler: valida payload, delega ao use case, nunca
 * lança exceção vinda do use case (ele já é tolerante por linha).
 */

const mockExecute = jest.fn();

jest.mock('../PromoteBlockedApplicationsUseCase', () => ({
  PromoteBlockedApplicationsUseCase: jest.fn().mockImplementation(() => ({
    execute: mockExecute,
  })),
}));

import { createPromoteBlockedApplicationsHandler } from '../PromoteBlockedApplicationsEventHandler';

/** Meta que o DomainEventProcessor entrega junto do payload (A1 do gate 30/08); este handler a ignora. */
const META = { eventId: 'evt-test' };

describe('createPromoteBlockedApplicationsHandler', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('lança erro quando workerId ausente no payload', async () => {
    const handler = createPromoteBlockedApplicationsHandler({} as never);
    await expect(handler({}, META)).rejects.toThrow(/workerId must be a non-empty string/);
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it('lança erro quando workerId é string vazia', async () => {
    const handler = createPromoteBlockedApplicationsHandler({} as never);
    await expect(handler({ workerId: '' }, META)).rejects.toThrow(/workerId must be a non-empty string/);
  });

  it('delega ao PromoteBlockedApplicationsUseCase.execute com o workerId do payload', async () => {
    mockExecute.mockResolvedValue({ promoted: 1, skipped: 0, reasons: {} });
    const handler = createPromoteBlockedApplicationsHandler({} as never);

    await expect(handler({ workerId: 'w-1' }, META)).resolves.toBeUndefined();
    expect(mockExecute).toHaveBeenCalledWith('w-1');
  });
});
