jest.mock('@shared/logging', () => ({ reportError: jest.fn() }));

import type { Request, Response } from 'express';
import { reportError } from '@shared/logging';
import { requireAnaCareHoursAllowlist } from '../requireAnaCareHoursAllowlist';
import type { AdminRepository } from '@modules/identity/infrastructure/AdminRepository';

function mockRes(): Response {
  const res: Partial<Response> = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res as Response;
}

function mockReq(uid: string | undefined): Request {
  return {
    authContext: uid ? { principal: { id: uid } } : undefined,
  } as unknown as Request;
}

function mockAdminRepo(email: string | null): Pick<AdminRepository, 'findByFirebaseUid'> {
  return {
    findByFirebaseUid: jest.fn().mockResolvedValue(email ? { email } : null),
  };
}

const ALLOWLIST_ENV = { ANACARE_HOURS_ALLOWED_EMAILS: 'marcel@enlite.health;gabriel.g.stein@gmail.com;sonez.elizabeth@enlite.health' };

describe('requireAnaCareHoursAllowlist', () => {
  const original = process.env.ANACARE_HOURS_ALLOWED_EMAILS;
  beforeEach(() => {
    process.env.ANACARE_HOURS_ALLOWED_EMAILS = ALLOWLIST_ENV.ANACARE_HOURS_ALLOWED_EMAILS;
  });
  afterAll(() => {
    if (original === undefined) delete process.env.ANACARE_HOURS_ALLOWED_EMAILS;
    else process.env.ANACARE_HOURS_ALLOWED_EMAILS = original;
  });

  it('staff SEM uid (sem authContext) → 403 not_allowlisted, next NÃO é chamado', async () => {
    const next = jest.fn();
    const res = mockRes();
    await requireAnaCareHoursAllowlist(mockAdminRepo(null))(mockReq(undefined), res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ success: false, error: 'not_allowlisted', code: 'ANACARE_HOURS_NOT_ALLOWLISTED' });
    expect(next).not.toHaveBeenCalled();
  });

  it('staff autenticado mas FORA da allowlist → 403, next NÃO é chamado', async () => {
    const next = jest.fn();
    const res = mockRes();
    await requireAnaCareHoursAllowlist(mockAdminRepo('outro.staff@enlite.health'))(mockReq('uid-fora'), res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'ANACARE_HOURS_NOT_ALLOWLISTED' }));
    expect(next).not.toHaveBeenCalled();
  });

  it('uid não encontrado em `users` (admin null) → 403, next NÃO é chamado', async () => {
    const next = jest.fn();
    const res = mockRes();
    await requireAnaCareHoursAllowlist(mockAdminRepo(null))(mockReq('uid-orfao'), res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it('staff NA allowlist (um dos 3 e-mails da decisão) → next() chamado, sem resposta de erro', async () => {
    const next = jest.fn();
    const res = mockRes();
    await requireAnaCareHoursAllowlist(mockAdminRepo('gabriel.g.stein@gmail.com'))(mockReq('uid-gabriel'), res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  it('e-mail com maiúscula/espaço no banco ainda casa (normalização)', async () => {
    const next = jest.fn();
    const res = mockRes();
    await requireAnaCareHoursAllowlist(mockAdminRepo('  Marcel@Enlite.Health  '))(mockReq('uid-marcel'), res, next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('lê o uid do authContext (token verificado) — nunca de um header do cliente', async () => {
    const adminRepo = mockAdminRepo('gabriel.g.stein@gmail.com');
    const next = jest.fn();
    const res = mockRes();
    const req = {
      authContext: { principal: { id: 'uid-do-token' } },
      headers: { 'x-user-email': 'atacante@fora.com' }, // client-controlled — deve ser ignorado
    } as unknown as Request;
    await requireAnaCareHoursAllowlist(adminRepo)(req, res, next);
    expect(adminRepo.findByFirebaseUid).toHaveBeenCalledWith('uid-do-token');
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('erro ao consultar o banco → 403 explícito (NUNCA pendura a requisição), reporta o erro sem PII', async () => {
    const next = jest.fn();
    const res = mockRes();
    const adminRepo: Pick<AdminRepository, 'findByFirebaseUid'> = {
      findByFirebaseUid: jest.fn().mockRejectedValue(new Error('conexão perdida')),
    };
    await requireAnaCareHoursAllowlist(adminRepo)(mockReq('uid-qualquer'), res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ success: false, error: 'not_allowlisted', code: 'ANACARE_HOURS_NOT_ALLOWLISTED' });
    expect(next).not.toHaveBeenCalled();
    expect(reportError).toHaveBeenCalledWith(expect.any(Error), { source: 'requireAnaCareHoursAllowlist' });
  });
});
