/**
 * AdminServiceTeamContactController — trilha de acesso a contato (C6): só sai quando o nome REAL
 * do prestador foi projetado. Sem `worker_contact:read` o caso de uso devolve `NOME_REDIGIDO`
 * (não-nulo) e a trilha NÃO pode registrar um acesso que não aconteceu.
 */
jest.mock('@shared/logging', () => ({ reportError: jest.fn(), logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));
jest.mock('@shared/audit/contactAccessFromRequest', () => ({ emitirTrilhaDeContato: jest.fn() }));
jest.mock('@modules/identity', () => ({ AuthMiddleware: { getAuthContext: jest.fn() } }));

import { Request, Response } from 'express';
import { emitirTrilhaDeContato } from '@shared/audit/contactAccessFromRequest';
import { AuthMiddleware } from '@modules/identity';
import { NOME_REDIGIDO } from '@modules/identity/permissions';
import { AdminServiceTeamContactController } from '../AdminServiceTeamContactController';
import type {
  GetServiceTeamContactUseCase,
  RegisterServiceTeamContactUseCase,
  ServiceTeamContactResult,
} from '../../../application/ServiceTeamContactUseCase';

const PARAMS = {
  id: '11111111-1111-1111-1111-111111111111',
  sid: '22222222-2222-2222-2222-222222222222',
  workerId: '33333333-3333-3333-3333-333333333333',
};

function reqRes(body: Record<string, unknown> = {}): [Request, Response] {
  const json = jest.fn().mockReturnThis();
  const status = jest.fn().mockReturnValue({ json });
  (AuthMiddleware.getAuthContext as jest.Mock).mockReturnValue({ principal: { id: 'staff-1' } });
  return [{ params: PARAMS, body, query: {} } as unknown as Request, { json, status } as unknown as Response];
}

function result(displayName: string | null): ServiceTeamContactResult {
  return { workerId: PARAMS.workerId, displayName, history: [] };
}

describe('AdminServiceTeamContactController — trilha de contato', () => {
  const getUseCase = { execute: jest.fn() };
  const registerUseCase = { execute: jest.fn() };
  const ctrl = new AdminServiceTeamContactController(
    getUseCase as unknown as GetServiceTeamContactUseCase,
    registerUseCase as unknown as RegisterServiceTeamContactUseCase,
  );
  const body = { contacted: true, eventDate: '2026-09-28', note: null };
  beforeEach(() => jest.clearAllMocks());

  it('GET com a célula (nome real) → emite a trilha com o workerId', async () => {
    getUseCase.execute.mockResolvedValueOnce(result('Maria Perez'));
    const [req, res] = reqRes();
    await ctrl.get(req, res);
    expect(emitirTrilhaDeContato).toHaveBeenCalledWith(req, [PARAMS.workerId]);
  });

  it('GET sem a célula (NOME_REDIGIDO) → NÃO emite a trilha, e a resposta segue 200', async () => {
    getUseCase.execute.mockResolvedValueOnce(result(NOME_REDIGIDO));
    const [req, res] = reqRes();
    await ctrl.get(req, res);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(emitirTrilhaDeContato).not.toHaveBeenCalled();
  });

  it('GET com displayName nulo → NÃO emite', async () => {
    getUseCase.execute.mockResolvedValueOnce(result(null));
    const [req, res] = reqRes();
    await ctrl.get(req, res);
    expect(emitirTrilhaDeContato).not.toHaveBeenCalled();
  });

  it('POST com a célula → emite; sem a célula (NOME_REDIGIDO) → não emite', async () => {
    registerUseCase.execute.mockResolvedValueOnce(result('Maria Perez'));
    const [req1, res1] = reqRes(body);
    await ctrl.register(req1, res1);
    expect(emitirTrilhaDeContato).toHaveBeenCalledTimes(1);
    expect(emitirTrilhaDeContato).toHaveBeenCalledWith(req1, [PARAMS.workerId]);

    jest.clearAllMocks();
    registerUseCase.execute.mockResolvedValueOnce(result(NOME_REDIGIDO));
    const [req2, res2] = reqRes(body);
    await ctrl.register(req2, res2);
    expect(res2.status).toHaveBeenCalledWith(200);
    expect(emitirTrilhaDeContato).not.toHaveBeenCalled();
  });
});
