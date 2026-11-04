/**
 * Spec 027 Fase 3 (T034, lex T.4): nenhum VALOR de texto livre do serviço contratado em log, erro ou resposta de erro.
 * Corpo com `dailyObs: 'SEGREDO-123'` (e os outros 3 textos livres) forçando falha: o segredo não pode aparecer em
 * nenhuma chamada de `reportError`, `console.*` nem no corpo da resposta de erro. Repos mockados.
 */
jest.mock('@modules/identity', () => ({
  AuthMiddleware: { getAuthContext: jest.fn() },
}));
jest.mock('@shared/logging', () => ({ reportError: jest.fn(), loggingAls: { getStore: jest.fn().mockReturnValue(undefined) } }));

import { AdminPatientContractedServicesController } from '../AdminPatientContractedServicesController';
import { reportError } from '@shared/logging';
import { AuthMiddleware } from '@modules/identity';
import type { Response } from 'express';

const PATIENT_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const SERVICE_ID = 'bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee';
const SECRET = 'SEGREDO-123';
const FREE_TEXT = { dailyObs: SECRET, workerAttributes: SECRET, requiredExperience: SECRET, paymentDay: SECRET };

function mockRes(): Response & { status: jest.Mock; json: jest.Mock } {
  const res: { status: jest.Mock; json: jest.Mock } = { status: jest.fn(), json: jest.fn() };
  res.status.mockReturnValue(res);
  res.json.mockReturnValue(res);
  return res as unknown as Response & { status: jest.Mock; json: jest.Mock };
}
const req = (body: Record<string, unknown>) =>
  ({ params: { id: PATIENT_ID, sid: SERVICE_ID }, body, user: { roles: ['admin'] } }) as never;

describe('AdminPatientContractedServicesController — texto livre de recrutamento nunca vai a log/erro (T.4)', () => {
  const spies = (['log', 'info', 'warn', 'error'] as const).map((m) => jest.spyOn(console, m).mockImplementation(() => undefined));

  beforeEach(() => {
    jest.clearAllMocks();
    (AuthMiddleware.getAuthContext as jest.Mock).mockReturnValue({ principal: { id: 'uid-1' } });
  });
  afterAll(() => spies.forEach((s) => s.mockRestore()));

  const everythingEmitted = (res: { json: jest.Mock }) =>
    JSON.stringify([
      (reportError as jest.Mock).mock.calls.map(([e, ctx]) => [String((e as Error)?.message), ctx]),
      spies.map((s) => s.mock.calls),
      res.json.mock.calls,
    ]);

  it('create: falha do repositório (500) não deixa o segredo em reportError, console nem resposta', async () => {
    const repo = { create: jest.fn().mockRejectedValue(new Error('boom')) };
    const res = mockRes();
    await new AdminPatientContractedServicesController(repo as never, {} as never).create(
      req({ serviceCode: 'AT', ...FREE_TEXT }),
      res,
    );
    expect(res.status).toHaveBeenCalledWith(500);
    expect(repo.create).toHaveBeenCalledWith(expect.objectContaining({ dailyObs: SECRET }), expect.any(Date)); // controle: o corpo CHEGOU ao repo
    expect(reportError).toHaveBeenCalled(); // controle: o caminho de erro rodou
    expect(everythingEmitted(res)).not.toContain(SECRET);
  });

  it('update: falha do repositório (500) idem', async () => {
    const repo = {
      findById: jest.fn().mockResolvedValue({ id: SERVICE_ID, patientId: PATIENT_ID }),
      update: jest.fn().mockRejectedValue(new Error('boom')),
    };
    const res = mockRes();
    await new AdminPatientContractedServicesController(repo as never, {} as never).update(req(FREE_TEXT), res);
    expect(res.status).toHaveBeenCalledWith(500);
    expect(repo.update).toHaveBeenCalledWith(SERVICE_ID, expect.objectContaining({ dailyObs: SECRET }), expect.any(Date));
    expect(everythingEmitted(res)).not.toContain(SECRET);
  });

  it('400 de validação (texto acima do teto + campo desconhecido) devolve só NOMES de campo, nunca o valor', async () => {
    const repo = { create: jest.fn() };
    const res = mockRes();
    await new AdminPatientContractedServicesController(repo as never, {} as never).create(
      req({ serviceCode: 'AT', dailyObs: SECRET + 'x'.repeat(2001), requiredSex: SECRET }),
      res,
    );
    expect(res.status).toHaveBeenCalledWith(400);
    expect(repo.create).not.toHaveBeenCalled();
    const body = res.json.mock.calls[0][0];
    expect(body.details.fields).toEqual(expect.arrayContaining(['dailyObs', 'requiredSex']));
    expect(everythingEmitted(res)).not.toContain(SECRET);
  });
});
