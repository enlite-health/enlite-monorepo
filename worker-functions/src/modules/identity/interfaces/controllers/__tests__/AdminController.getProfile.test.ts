/**
 * AdminController.getProfile — cobertura da lógica NOVA (`canAccessAnaCareHours`, porte PRD
 * `feat/anacare-horas-prd-allowlist`). O resto do controller (delete/create/list/reset/update
 * admin) já era descoberto ANTES deste PR (achado fora do escopo, ver relatório do gate) — este
 * arquivo cobre só o endpoint que o diff tocou, não o controller inteiro.
 */
const mockExecute = jest.fn();
jest.mock('../../../application/GetAdminProfileUseCase', () => ({
  GetAdminProfileUseCase: jest.fn().mockImplementation(() => ({ execute: mockExecute })),
}));
// O construtor do AdminController instancia OUTROS use cases (create/list/delete/reset admin)
// que, por sua vez, abrem `DatabaseConnection.getInstance()` — sem env de banco, isso lança
// síncrono no `new AdminController()`. Mock na raiz (mesmo molde de outros testes de controller
// do repo) em vez de mocar cada use case individualmente.
jest.mock('@shared/database/DatabaseConnection', () => ({
  DatabaseConnection: {
    getInstance: jest.fn().mockReturnValue({ getPool: jest.fn().mockReturnValue({ query: jest.fn() }) }),
  },
}));
jest.mock('../../../infrastructure/GoogleIdentityService', () => ({ GoogleIdentityService: jest.fn() }));

import type { Request, Response } from 'express';
import { AdminController } from '../AdminController';
import { Result } from '@shared/utils/Result';

function mockRes(): Response {
  const res: Partial<Response> = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res as Response;
}

function mockReq(uid: string | undefined): Request {
  return { user: uid ? { uid } : undefined } as unknown as Request;
}

const ALLOWLIST_ENV = 'marcel@enlite.health;gabriel.g.stein@gmail.com;sonez.elizabeth@enlite.health';

describe('AdminController.getProfile — canAccessAnaCareHours', () => {
  const original = process.env.ANACARE_HOURS_ALLOWED_EMAILS;
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.ANACARE_HOURS_ALLOWED_EMAILS = ALLOWLIST_ENV;
  });
  afterAll(() => {
    if (original === undefined) delete process.env.ANACARE_HOURS_ALLOWED_EMAILS;
    else process.env.ANACARE_HOURS_ALLOWED_EMAILS = original;
  });

  it('e-mail NA allowlist → canAccessAnaCareHours: true, resto do perfil preservado', async () => {
    mockExecute.mockResolvedValue(Result.ok({ firebaseUid: 'u1', email: 'marcel@enlite.health', role: 'admin' }));
    const controller = new AdminController();
    const res = mockRes();
    await controller.getProfile(mockReq('u1'), res);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      success: true,
      data: { firebaseUid: 'u1', email: 'marcel@enlite.health', role: 'admin', canAccessAnaCareHours: true },
    });
  });

  it('e-mail FORA da allowlist → canAccessAnaCareHours: false', async () => {
    mockExecute.mockResolvedValue(Result.ok({ firebaseUid: 'u2', email: 'outro.staff@enlite.health', role: 'recruiter' }));
    const controller = new AdminController();
    const res = mockRes();
    await controller.getProfile(mockReq('u2'), res);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ canAccessAnaCareHours: false }) }),
    );
  });

  it('sem uid autenticado → 401, use case nem é chamado', async () => {
    const controller = new AdminController();
    const res = mockRes();
    await controller.getProfile(mockReq(undefined), res);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it('use case falha (perfil não encontrado) → 404, sem canAccessAnaCareHours inventado', async () => {
    mockExecute.mockResolvedValue(Result.fail('Admin user not found'));
    const controller = new AdminController();
    const res = mockRes();
    await controller.getProfile(mockReq('u-orfao'), res);
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({ success: false, error: 'Admin user not found' });
  });
});
