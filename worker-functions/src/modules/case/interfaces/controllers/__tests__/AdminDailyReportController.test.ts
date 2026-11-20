jest.mock('@shared/logging', () => ({
  reportError: jest.fn(),
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  toSafeError: jest.requireActual('@shared/logging/safeError').toSafeError,
}));

import type { Request, Response } from 'express';
import { reportError } from '@shared/logging';
import { AdminDailyReportController } from '../AdminDailyReportController';

const ESPIA = 'NARRATIVA-ESPIA-092';
const PID = '11111111-1111-4111-8111-111111111111';

function mk(params: Record<string, string>, query: Record<string, string> = {}, cells?: string[]) {
  const json = jest.fn();
  const status = jest.fn().mockReturnValue({ json });
  return { req: { params, query, permissionCells: cells } as unknown as Request, res: { status } as unknown as Response, status, json };
}

describe('AdminDailyReportController.list', () => {
  const execute = jest.fn();
  const ctrl = new AdminDailyReportController({ execute } as never);
  beforeEach(() => jest.clearAllMocks());

  it('400 com patientId inválido, data inválida, janela invertida ou parâmetro desconhecido — só caminhos', async () => {
    for (const [params, query] of [
      [{ patientId: 'x' }, {}], [{ patientId: PID }, { from: 'ontem' }], [{ patientId: PID }, { from: '2026-11-20', to: '2026-11-10' }], [{ patientId: PID }, { limit: '1' }],
    ] as const) {
      const m = mk({ ...params }, { ...query });
      await ctrl.list(m.req, m.res);
      expect(m.status).toHaveBeenCalledWith(400);
      expect(m.json.mock.calls[0][0].code).toBe('invalid_query');
    }
    expect(execute).not.toHaveBeenCalled();
  });

  it('200 repassa patientId, janela e as CÉLULAS da request (null quando o engine não decidiu)', async () => {
    execute.mockResolvedValue({ items: [] });
    const a = mk({ patientId: PID }, { from: '2026-11-01', to: '2026-11-30' }, ['daily_report:read']);
    await ctrl.list(a.req, a.res);
    expect(a.status).toHaveBeenCalledWith(200);
    expect(execute).toHaveBeenLastCalledWith({ patientId: PID, from: '2026-11-01', to: '2026-11-30', cells: ['daily_report:read'] });
    const b = mk({ patientId: PID });
    await ctrl.list(b.req, b.res);
    expect(execute).toHaveBeenLastCalledWith({ patientId: PID, from: null, to: null, cells: null });
  });

  it('404 quando o paciente não existe / está fora do país', async () => {
    execute.mockResolvedValueOnce(null);
    const m = mk({ patientId: PID });
    await ctrl.list(m.req, m.res);
    expect(m.status).toHaveBeenCalledWith(404);
  });

  it('PRIVACIDADE: erro do driver com a linha no detail → 500 sem corpo útil e sem o texto no que vai ao reportError', async () => {
    execute.mockRejectedValueOnce(Object.assign(new Error(`DETAIL: Failing row contains (${ESPIA})`), { code: '22P02', detail: ESPIA }));
    const m = mk({ patientId: PID });
    await ctrl.list(m.req, m.res);
    expect(m.status).toHaveBeenCalledWith(500);
    expect(JSON.stringify(m.json.mock.calls[0][0])).not.toContain(ESPIA);
    const [reported] = (reportError as jest.Mock).mock.calls[0];
    expect(`${reported.message}${reported.stack}`).not.toContain(ESPIA);
  });
});
