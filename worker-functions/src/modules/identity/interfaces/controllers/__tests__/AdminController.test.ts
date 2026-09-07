/**
 * AdminController — o contrato HTTP dos handlers que não têm suíte própria.
 *
 * O caso que motivou (07/09): `POST /api/admin/users` deixou de aceitar `role`
 * no corpo — a conta nasce sem grupo e o painel concede. O resto do arquivo
 * entra porque a régua é 100% no arquivo TOCADO (D200) e ele estava em 29%:
 * `deleteAdminUser` tem suíte própria (anti-lockout); aqui vão os outros.
 */

const mocks = {
  create: jest.fn(),
  list: jest.fn(),
  reset: jest.fn(),
  profile: jest.fn(),
  deleteByEmail: jest.fn(),
  countAdmins: jest.fn(),
};
jest.mock('../../../application/DeleteAdminUserUseCase', () => ({
  DeleteAdminUserUseCase: jest.fn().mockImplementation(() => ({ execute: jest.fn() })),
  LAST_MANAGER: 'last_manager',
}));
jest.mock('../../../application/DeleteUserByEmailUseCase', () => ({
  DeleteUserByEmailUseCase: jest.fn().mockImplementation(() => ({ execute: mocks.deleteByEmail })),
}));
jest.mock('../../../application/CreateAdminUserUseCase', () => ({
  CreateAdminUserUseCase: jest.fn().mockImplementation(() => ({ execute: mocks.create })),
}));
jest.mock('../../../application/ListAdminUsersUseCase', () => ({
  ListAdminUsersUseCase: jest.fn().mockImplementation(() => ({ execute: mocks.list })),
}));
jest.mock('../../../application/ResetAdminPasswordUseCase', () => ({
  ResetAdminPasswordUseCase: jest.fn().mockImplementation(() => ({ execute: mocks.reset })),
}));
jest.mock('../../../application/GetAdminProfileUseCase', () => ({
  GetAdminProfileUseCase: jest.fn().mockImplementation(() => ({ execute: mocks.profile })),
}));
jest.mock('../../../infrastructure/AdminRepository', () => ({
  AdminRepository: jest.fn().mockImplementation(() => ({ countAdmins: mocks.countAdmins })),
}));
jest.mock('../../../infrastructure/UserRepository', () => ({ UserRepository: jest.fn() }));
jest.mock('../../../infrastructure/GoogleIdentityService', () => ({ GoogleIdentityService: jest.fn() }));

import type { Request, Response } from 'express';
import { AdminController } from '../AdminController';
import { Result } from '@shared/utils/Result';

function res(): Response & { status: jest.Mock; json: jest.Mock } {
  const r = { status: jest.fn(), json: jest.fn() } as unknown as Response & { status: jest.Mock; json: jest.Mock };
  r.status.mockReturnValue(r);
  return r;
}
const req = (over: Partial<{ body: unknown; params: unknown; query: unknown; user: unknown }> = {}): Request =>
  ({ body: {}, params: {}, query: {}, ...over }) as unknown as Request;

let silencio: jest.SpyInstance[] = [];
beforeEach(() => {
  Object.values(mocks).forEach((m) => m.mockReset());
  silencio = [jest.spyOn(console, 'error').mockImplementation(() => undefined), jest.spyOn(console, 'warn').mockImplementation(() => undefined)];
});
afterEach(() => silencio.forEach((s) => s.mockRestore()));

describe('POST /api/admin/users — createAdminUser', () => {
  it('sem email/displayName → 400', async () => {
    const r = res();
    await new AdminController().createAdminUser(req({ body: { email: 'a@enlite.health' } }), r);
    expect(r.status).toHaveBeenCalledWith(400);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('cria e devolve 201 — e `role` no corpo NÃO chega ao use case (07/09)', async () => {
    mocks.create.mockResolvedValue(Result.ok({ firebaseUid: 'u1' }));
    const r = res();
    await new AdminController().createAdminUser(
      req({ body: { email: 'a@enlite.health', displayName: 'A', department: 'RH', role: 'admin' } }),
      r,
    );
    expect(mocks.create).toHaveBeenCalledWith({ email: 'a@enlite.health', displayName: 'A', department: 'RH' });
    expect(r.status).toHaveBeenCalledWith(201);
    expect(r.json).toHaveBeenCalledWith({ success: true, data: { firebaseUid: 'u1' } });
  });

  it('falha do use case → 400 com a mensagem; exceção → 500', async () => {
    mocks.create.mockResolvedValueOnce(Result.fail('e-mail já existe'));
    const r1 = res();
    await new AdminController().createAdminUser(req({ body: { email: 'a@enlite.health', displayName: 'A' } }), r1);
    expect(r1.status).toHaveBeenCalledWith(400);
    expect(r1.json).toHaveBeenCalledWith({ success: false, error: 'e-mail já existe' });

    mocks.create.mockRejectedValueOnce(new Error('boom'));
    const r2 = res();
    await new AdminController().createAdminUser(req({ body: { email: 'a@enlite.health', displayName: 'A' } }), r2);
    expect(r2.status).toHaveBeenCalledWith(500);
  });
});

describe('POST /api/admin/setup — bootstrap', () => {
  it('já existe admin → 403', async () => {
    mocks.countAdmins.mockResolvedValue(1);
    const r = res();
    await new AdminController().setup(req({ body: { email: 'a@enlite.health', displayName: 'A' } }), r);
    expect(r.status).toHaveBeenCalledWith(403);
  });

  it('sem admin: valida corpo (400), cria (201), repassa falha (400), exceção (500)', async () => {
    mocks.countAdmins.mockResolvedValue(0);
    const r0 = res();
    await new AdminController().setup(req({ body: {} }), r0);
    expect(r0.status).toHaveBeenCalledWith(400);

    mocks.create.mockResolvedValueOnce(Result.ok({ firebaseUid: 'u1' }));
    const r1 = res();
    await new AdminController().setup(req({ body: { email: 'a@enlite.health', displayName: 'A' } }), r1);
    expect(r1.status).toHaveBeenCalledWith(201);

    mocks.create.mockResolvedValueOnce(Result.fail('x'));
    const r2 = res();
    await new AdminController().setup(req({ body: { email: 'a@enlite.health', displayName: 'A' } }), r2);
    expect(r2.status).toHaveBeenCalledWith(400);

    mocks.countAdmins.mockRejectedValueOnce(new Error('db'));
    const r3 = res();
    await new AdminController().setup(req({ body: {} }), r3);
    expect(r3.status).toHaveBeenCalledWith(500);
  });
});

describe('GET /api/admin/users — listAdminUsers', () => {
  it('pagina (limit teto 200) e devolve a lista projetada', async () => {
    mocks.list.mockResolvedValue(Result.ok({ admins: [{ firebaseUid: 'u1' }], total: 1 }));
    const r = res();
    await new AdminController().listAdminUsers(req({ query: { limit: '500', offset: '10' } }), r);
    expect(mocks.list).toHaveBeenCalledWith(200, 10);
    expect(r.json).toHaveBeenCalledWith({ success: true, data: [{ firebaseUid: 'u1' }], pagination: { limit: 200, offset: 10, total: 1 } });
  });

  it('defaults (50, 0); falha → 400; exceção → 500', async () => {
    mocks.list.mockResolvedValueOnce(Result.fail('x'));
    const r1 = res();
    await new AdminController().listAdminUsers(req(), r1);
    expect(mocks.list).toHaveBeenCalledWith(50, 0);
    expect(r1.status).toHaveBeenCalledWith(400);

    mocks.list.mockRejectedValueOnce(new Error('boom'));
    const r2 = res();
    await new AdminController().listAdminUsers(req(), r2);
    expect(r2.status).toHaveBeenCalledWith(500);
  });
});

describe('POST /api/admin/users/:id/reset-password — resetAdminPassword', () => {
  it('200 com o link; falha → 400; exceção → 500', async () => {
    mocks.reset.mockResolvedValueOnce(Result.ok({ resetLink: 'https://l' }));
    const r1 = res();
    await new AdminController().resetAdminPassword(req({ params: { id: 'u1' } }), r1);
    expect(mocks.reset).toHaveBeenCalledWith('u1');
    expect(r1.json).toHaveBeenCalledWith({ success: true, data: { resetLink: 'https://l', message: 'Password reset link generated' } });

    mocks.reset.mockResolvedValueOnce(Result.fail('User not found'));
    const r2 = res();
    await new AdminController().resetAdminPassword(req({ params: { id: 'u1' } }), r2);
    expect(r2.status).toHaveBeenCalledWith(400);

    mocks.reset.mockRejectedValueOnce(new Error('boom'));
    const r3 = res();
    await new AdminController().resetAdminPassword(req({ params: { id: 'u1' } }), r3);
    expect(r3.status).toHaveBeenCalledWith(500);
  });
});

describe('GET /api/admin/auth/profile — getProfile', () => {
  it('sem uid → 401; negado → 404; ok → 200; exceção (Error e não-Error) → 500', async () => {
    const r0 = res();
    await new AdminController().getProfile(req(), r0);
    expect(r0.status).toHaveBeenCalledWith(401);

    mocks.profile.mockResolvedValueOnce(Result.fail('Admin user not found'));
    const r1 = res();
    await new AdminController().getProfile(req({ user: { uid: 'u1' } }), r1);
    expect(r1.status).toHaveBeenCalledWith(404);

    mocks.profile.mockResolvedValueOnce(Result.ok({ firebaseUid: 'u1', email: 'a@enlite.health' }));
    const r2 = res();
    await new AdminController().getProfile(req({ user: { uid: 'u1' } }), r2);
    expect(r2.json).toHaveBeenCalledWith({ success: true, data: { firebaseUid: 'u1', email: 'a@enlite.health' } });

    mocks.profile.mockRejectedValueOnce(new Error('boom'));
    const r3 = res();
    await new AdminController().getProfile(req({ user: { uid: 'u1' } }), r3);
    expect(r3.status).toHaveBeenCalledWith(500);

    mocks.profile.mockRejectedValueOnce('string');
    const r4 = res();
    await new AdminController().getProfile(req({ user: { uid: 'u1' } }), r4);
    expect(r4.status).toHaveBeenCalledWith(500);
  });
});

describe('DELETE /api/admin/users/by-email — deleteUserByEmail', () => {
  it('sem e-mail → 400; formato inválido → 400; ok → 200; falha → 400; exceção → 500', async () => {
    const c = new AdminController();
    const r0 = res();
    await c.deleteUserByEmail(req({ body: {} }), r0);
    expect(r0.json).toHaveBeenCalledWith({ success: false, error: 'Email is required' });

    const r1 = res();
    await c.deleteUserByEmail(req({ body: { email: 'nao-e-email' } }), r1);
    expect(r1.json).toHaveBeenCalledWith({ success: false, error: 'Invalid email format' });

    mocks.deleteByEmail.mockResolvedValueOnce(Result.ok());
    const r2 = res();
    await c.deleteUserByEmail(req({ body: { email: 'a@enlite.health' } }), r2);
    expect(r2.status).toHaveBeenCalledWith(200);

    mocks.deleteByEmail.mockResolvedValueOnce(Result.fail('not found'));
    const r3 = res();
    await c.deleteUserByEmail(req({ body: { email: 'a@enlite.health' } }), r3);
    expect(r3.status).toHaveBeenCalledWith(400);

    mocks.deleteByEmail.mockRejectedValueOnce(new Error('boom'));
    const r4 = res();
    await c.deleteUserByEmail(req({ body: { email: 'a@enlite.health' } }), r4);
    expect(r4.status).toHaveBeenCalledWith(500);
  });
});
