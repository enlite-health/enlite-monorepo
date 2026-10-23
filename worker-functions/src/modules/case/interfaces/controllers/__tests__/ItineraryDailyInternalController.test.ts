jest.mock('@shared/database/DatabaseConnection', () => ({
  DatabaseConnection: { getInstance: jest.fn().mockReturnValue({ getPool: jest.fn().mockReturnValue({}) }) },
}));
const mockReportError = jest.fn();
jest.mock('@shared/logging', () => ({ logger: { info: jest.fn() }, reportError: (...a: unknown[]) => mockReportError(...a) }));

import { ItineraryDailyInternalController, summarizeItineraryDaily } from '../ItineraryDailyInternalController';
import { createItineraryDailyInternalRoutes } from '../../routes/itineraryDailyInternalRoutes';

const alert = { operationDate: '2026-11-02', alertRecipients: 2, notified: 2, alreadySent: 0, emailsSent: 0, emailsSkipped: 2, emailsFailed: 0, skippedNoCountry: 1, failures: 1 };
const result = {
  countries: {
    AR: { operationDate: '2026-11-02', patientsChecked: 5, moved: 2, unchanged: 2, notReady: 1, failures: 0 },
    BR: { operationDate: '2026-11-02', patientsChecked: 3, moved: 0, unchanged: 3, notReady: 0, failures: 2 },
  },
  alert,
};

function res() {
  const r: { status: jest.Mock; json: jest.Mock } = { status: jest.fn(), json: jest.fn() };
  r.status.mockReturnValue(r);
  return r;
}

describe('ItineraryDailyInternalController (spec 069 F4)', () => {
  beforeEach(() => jest.clearAllMocks());

  it('resposta = SÓ contagens somadas dos países (sem id de paciente, uid ou e-mail)', () => {
    expect(summarizeItineraryDaily(result)).toEqual({
      operationDate: '2026-11-02', patientsChecked: 8, statusMoved: 2, statusUnchanged: 5, statusNotReady: 1,
      alertRecipients: 2, notified: 2, alreadySent: 0, emailsSent: 0, emailsSkipped: 2, emailsFailed: 0, skippedNoCountry: 1, failures: 3,
    });
  });

  it('200 com o corpo resumido; o instante é capturado UMA vez (clock) e os países vêm do mapa de fusos', async () => {
    const now = new Date('2026-11-03T09:00:00Z');
    const execute = jest.fn().mockResolvedValue(result);
    const r = res();
    await new ItineraryDailyInternalController({ execute }, () => now).handle({} as never, r as never);
    expect(execute).toHaveBeenCalledWith({ now, countries: ['AR', 'BR'] });
    expect(r.status).toHaveBeenCalledWith(200);
    expect(r.json).toHaveBeenCalledWith(expect.objectContaining({ patientsChecked: 8, failures: 3 }));
  });

  it('erro fora do isolamento → 500 sem vazar a mensagem, e reporta (o Scheduler re-tenta); erro não-Error embrulhado', async () => {
    const execute = jest.fn().mockRejectedValueOnce(new Error('segredo interno')).mockRejectedValueOnce('texto');
    const c = new ItineraryDailyInternalController({ execute });
    const r1 = res();
    await c.handle({} as never, r1 as never);
    expect(r1.status).toHaveBeenCalledWith(500);
    expect(JSON.stringify(r1.json.mock.calls)).not.toContain('segredo');
    const r2 = res();
    await c.handle({} as never, r2 as never);
    expect(mockReportError).toHaveBeenLastCalledWith(expect.objectContaining({ message: 'texto' }), expect.anything());
  });

  it('construtor padrão e a rota POST /itinerary/daily (nenhum outro método/path)', () => {
    const controller = new ItineraryDailyInternalController();
    const router = createItineraryDailyInternalRoutes(controller) as unknown as { stack: Array<{ route: { path: string; methods: Record<string, boolean> } }> };
    expect(router.stack.map((l) => [l.route.path, Object.keys(l.route.methods)])).toEqual([['/itinerary/daily', ['post']]]);
  });
});
