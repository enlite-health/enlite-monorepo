jest.mock('@shared/database/DatabaseConnection', () => ({
  DatabaseConnection: { getInstance: jest.fn().mockReturnValue({ getPool: jest.fn().mockReturnValue({}) }) },
}));
const mockReportError = jest.fn();
jest.mock('@shared/logging', () => ({ logger: { info: jest.fn() }, reportError: (...a: unknown[]) => mockReportError(...a) }));

import { PresenceAlertsInternalController } from '../PresenceAlertsInternalController';
import { createPresenceAlertsInternalRoutes } from '../../routes/presenceAlertsInternalRoutes';

const result = { alerted: 2, alertedPresenceOpen: 1, alertedRefusedNoEntry: 1, alreadyAlerted: 3, unresolved: 0, skippedTest: 1, inAppDelivered: 2, emailsSent: 0, emailsSkipped: 2, emailsFailed: 0, failures: 1 };
function res() {
  const r: { status: jest.Mock; json: jest.Mock } = { status: jest.fn(), json: jest.fn() };
  r.status.mockReturnValue(r);
  return r;
}

describe('PresenceAlertsInternalController', () => {
  beforeEach(() => jest.clearAllMocks());

  it('200 com SÓ contagens; o instante é capturado UMA vez (clock)', async () => {
    const now = new Date('2026-11-26T15:00:00Z');
    const execute = jest.fn().mockResolvedValue(result);
    const r = res();
    await new PresenceAlertsInternalController({ execute }, () => now).handle({} as never, r as never);
    expect(execute).toHaveBeenCalledWith({ now });
    expect(r.status).toHaveBeenCalledWith(200);
    expect(r.json).toHaveBeenCalledWith(result);
    expect(Object.values(r.json.mock.calls[0][0]).every((v) => typeof v === 'number')).toBe(true);
  });

  it('erro fora do isolamento (attendance fora do ar) → 500 sem corpo do erro e reportError (o Scheduler re-tenta)', async () => {
    const r = res();
    await new PresenceAlertsInternalController({ execute: jest.fn().mockRejectedValue(new Error('presence_unavailable:http_503')) }).handle({} as never, r as never);
    expect(r.status).toHaveBeenCalledWith(500);
    expect(r.json).toHaveBeenCalledWith({ error: 'Internal server error' });
    expect(mockReportError).toHaveBeenCalledTimes(1);
  });

  it('a rota é POST /presence/alerts classe service', () => {
    const layer = (createPresenceAlertsInternalRoutes(new PresenceAlertsInternalController({ execute: jest.fn() })) as unknown as { stack: Array<{ route: { path: string; methods: Record<string, boolean> } }> }).stack[0].route;
    expect([layer.path, layer.methods.post]).toEqual(['/presence/alerts', true]);
  });
});
