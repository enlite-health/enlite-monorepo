/** Caminho de exceção do webhook (controller do módulo matching): reportError sem PII e o 500 inalterado. */
jest.mock('@shared/database/DatabaseConnection', () => ({
  DatabaseConnection: {
    getInstance: () => ({
      getPool: () => { throw Object.assign(new Error('boom: Key (email)=(maria@x.com)'), { code: '08006', detail: 'maria@x.com' }); },
    }),
  },
}));
jest.mock('@shared/logging', () => ({ ...jest.requireActual('@shared/logging'), reportError: jest.fn() }));

import type { Request, Response } from 'express';
import '@modules/matching'; // ordem de carga do ciclo matching ↔ integration (como na app)
import { TalentumWebhookController } from '../TalentumWebhookController';
import { reportError } from '@shared/logging';

describe('matching/TalentumWebhookController — alarme no caminho de exceção', () => {
  it('erro ao processar → reportError(source, talentumPrescreeningId) sem PII; resposta 500 inalterada', async () => {
    process.env.USE_MOCK_AUTH = 'true';
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() } as unknown as Response;
    const req = { headers: {}, body: {
      action: 'PRESCREENING_RESPONSE', subtype: 'INITIATED',
      data: {
        prescreening: { id: 'tp-alarme', name: 'Caso' },
        profile: { id: 'prof-alarme', firstName: 'A', lastName: 'B', email: 'a@test.local', phoneNumber: '+5491100000001', registerQuestions: [] },
        response: { id: 'resp-alarme', state: [] },
      },
    } } as unknown as Request;

    await new TalentumWebhookController().handlePrescreening(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(reportError).toHaveBeenCalledTimes(1);
    const [err, ctx] = (reportError as jest.Mock).mock.calls[0];
    expect(ctx).toEqual({ source: 'TalentumWebhookController:process', talentumPrescreeningId: 'tp-alarme' });
    expect(JSON.stringify([err.message, err.stack])).not.toContain('maria@x.com');
  });
});
