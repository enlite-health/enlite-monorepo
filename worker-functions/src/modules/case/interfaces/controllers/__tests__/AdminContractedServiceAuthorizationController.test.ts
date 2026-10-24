jest.mock('@shared/logging', () => ({ reportError: jest.fn(), logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));
jest.mock('@modules/identity', () => ({ AuthMiddleware: { getAuthContext: jest.fn() } }));

import { Request, Response } from 'express';
import { AuthMiddleware } from '@modules/identity';
import { reportError } from '@shared/logging';
import { AdminContractedServiceAuthorizationController } from '../AdminContractedServiceAuthorizationController';
import type { ContractedServiceAuthorizationRepository } from '../../../infrastructure/ContractedServiceAuthorizationRepository';
import { AuthorizationNotFoundError, AuthorizationOverlapsError } from '../../../domain/ContractedServiceAuthorization';

const PATIENT = '11111111-1111-1111-1111-111111111111';
const SERVICE = '22222222-2222-2222-2222-222222222222';
const AUTH = '33333333-3333-3333-3333-333333333333';
const BODY = { hours: 120, validFrom: '2026-01-01', validTo: '2026-12-31' };
const VIEW = { id: AUTH, hours: 120, validFrom: '2026-01-01', validTo: '2026-12-31', recordedAt: 'x', recordedBy: 'staff-1', supersededAt: null };

function mkRepo() {
  return {
    serviceBelongsToPatient: jest.fn().mockResolvedValue(true),
    list: jest.fn().mockResolvedValue([VIEW]),
    create: jest.fn().mockResolvedValue(VIEW),
    supersede: jest.fn().mockResolvedValue(VIEW),
  };
}
function call(params: Record<string, unknown>, body: unknown = BODY): [Request, Response, jest.Mock, jest.Mock] {
  const json = jest.fn();
  const status = jest.fn().mockReturnValue({ json });
  (AuthMiddleware.getAuthContext as jest.Mock).mockReturnValue({ principal: { id: 'staff-1' } });
  return [{ params, body } as unknown as Request, { status, json } as unknown as Response, status, json];
}
function ctl(repo = mkRepo()) {
  return { repo, c: new AdminContractedServiceAuthorizationController(repo as unknown as ContractedServiceAuthorizationRepository) };
}

describe('AdminContractedServiceAuthorizationController', () => {
  beforeEach(() => jest.clearAllMocks());

  it('validTo null → 422 AUTHORIZATION_NEEDS_END sem chamar o repo', async () => {
    const { repo, c } = ctl();
    const [req, res, status, json] = call({ id: PATIENT, sid: SERVICE }, { ...BODY, validTo: null });
    await c.create(req, res);
    expect(status).toHaveBeenCalledWith(422);
    expect(json.mock.calls[0][0].code).toBe('AUTHORIZATION_NEEDS_END');
    for (const fn of Object.values(repo)) expect(fn).not.toHaveBeenCalled();
  });

  it('AuthorizationOverlapsError → 409 AUTHORIZATION_OVERLAPS', async () => {
    const { repo, c } = ctl();
    repo.create.mockRejectedValue(new AuthorizationOverlapsError());
    const [req, res, status, json] = call({ id: PATIENT, sid: SERVICE });
    await c.create(req, res);
    expect(status).toHaveBeenCalledWith(409);
    expect(json.mock.calls[0][0].code).toBe('AUTHORIZATION_OVERLAPS');
  });

  it('serviço de outro paciente → 404, sem escrever (create, supersede e list)', async () => {
    const { repo, c } = ctl();
    repo.serviceBelongsToPatient.mockResolvedValue(false);
    for (const [fn, params] of [
      [c.create, { id: PATIENT, sid: SERVICE }],
      [c.supersede, { id: PATIENT, sid: SERVICE, aid: AUTH }],
      [c.list, { id: PATIENT, sid: SERVICE }],
    ] as const) {
      const [req, res, status] = call(params);
      await fn.call(c, req, res);
      expect(status).toHaveBeenCalledWith(404);
    }
    expect(repo.create).not.toHaveBeenCalled();
    expect(repo.supersede).not.toHaveBeenCalled();
    expect(repo.list).not.toHaveBeenCalled();
  });

  it('create feliz → 201 com a view e actorUid do ator', async () => {
    const { repo, c } = ctl();
    const [req, res, status, json] = call({ id: PATIENT, sid: SERVICE });
    await c.create(req, res);
    expect(status).toHaveBeenCalledWith(201);
    expect(json).toHaveBeenCalledWith({ success: true, data: VIEW });
    expect(repo.create).toHaveBeenCalledWith({ serviceId: SERVICE, hours: 120, validFrom: '2026-01-01', validTo: '2026-12-31', actorUid: 'staff-1' });
  });

  it('supersede: feliz → 201 na linha nova; aid inexistente/já substituída → 404 AUTHORIZATION_NOT_FOUND', async () => {
    const { repo, c } = ctl();
    let [req, res, status] = call({ id: PATIENT, sid: SERVICE, aid: AUTH });
    await c.supersede(req, res);
    expect(status).toHaveBeenCalledWith(201);
    expect(repo.supersede).toHaveBeenCalledWith(AUTH, expect.objectContaining({ serviceId: SERVICE }));
    repo.supersede.mockRejectedValue(new AuthorizationNotFoundError());
    let json: jest.Mock;
    [req, res, status, json] = call({ id: PATIENT, sid: SERVICE, aid: AUTH });
    await c.supersede(req, res);
    expect(status).toHaveBeenCalledWith(404);
    expect(json.mock.calls[0][0].code).toBe('AUTHORIZATION_NOT_FOUND');
  });

  it('corpo inválido → 400; params inválidos → 400; list feliz → 200 { authorizations }', async () => {
    const { c } = ctl();
    let [req, res, status] = call({ id: PATIENT, sid: SERVICE }, { ...BODY, hours: 0 });
    await c.create(req, res);
    expect(status).toHaveBeenCalledWith(400);
    [req, res, status] = call({ id: 'x', sid: SERVICE });
    await c.create(req, res);
    expect(status).toHaveBeenCalledWith(400);
    let json: jest.Mock;
    [req, res, status, json] = call({ id: PATIENT, sid: SERVICE });
    await c.list(req, res);
    expect(status).toHaveBeenCalledWith(200);
    expect(json).toHaveBeenCalledWith({ success: true, data: { authorizations: [VIEW] } });
  });

  it('erro inesperado → 500 + reportError sem corpo', async () => {
    const { repo, c } = ctl();
    repo.create.mockRejectedValue(new Error('boom'));
    const [req, res, status] = call({ id: PATIENT, sid: SERVICE });
    await c.create(req, res);
    expect(status).toHaveBeenCalledWith(500);
    expect((reportError as jest.Mock).mock.calls[0][1]).toEqual({
      source: 'AdminContractedServiceAuthorizationController:create', patientId: PATIENT, serviceId: SERVICE,
    });
  });
});
