/**
 * Conta apagada (DF-20, T132): DeleteUserUseCase e DeleteUserByEmailUseCase chamam a porta
 * `markDeleted` DEPOIS do sucesso no Firebase. DeleteUser: também fora do `if (userExists)`.
 */
import { Result } from '@shared/utils/Result';
import { DeleteUserUseCase } from '../DeleteUserUseCase';
import { DeleteUserByEmailUseCase } from '../DeleteUserByEmailUseCase';

const UID = 'uid-sintetico';
const markDeleted = jest.fn();
const repo = {
  existsByFirebaseUid: jest.fn(),
  deleteUserComplete: jest.fn(),
  findByEmail: jest.fn(),
};
const google = { deleteUser: jest.fn(), deleteUserByEmail: jest.fn() };
const mk = <T>(C: new (...a: any[]) => T): T => new C(repo, google, { markDeleted });

beforeEach(() => {
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
  markDeleted.mockReset().mockResolvedValue(undefined);
  repo.existsByFirebaseUid.mockReset().mockResolvedValue(Result.ok(true));
  repo.deleteUserComplete.mockReset().mockResolvedValue(Result.ok());
  repo.findByEmail.mockReset().mockResolvedValue(Result.ok({ firebase_uid: UID, email: 'x@example.test', role: 'worker' }));
  google.deleteUser.mockReset().mockResolvedValue(Result.ok());
  google.deleteUserByEmail.mockReset().mockResolvedValue(Result.ok());
});

describe('DeleteUserUseCase', () => {
  it('marca o login (ator = a própria conta)', async () => {
    const r = await mk(DeleteUserUseCase).execute({ authUid: UID });
    expect(r.isSuccess).toBe(true);
    expect(markDeleted).toHaveBeenCalledWith(UID, UID);
  });

  it('sem linha em users (userExists=false) → ainda marca, e não apaga do banco', async () => {
    repo.existsByFirebaseUid.mockResolvedValue(Result.ok(false));
    const r = await mk(DeleteUserUseCase).execute({ authUid: UID });
    expect(r.isSuccess).toBe(true);
    expect(markDeleted).toHaveBeenCalledWith(UID, UID);
    expect(repo.deleteUserComplete).not.toHaveBeenCalled();
  });

  it('Firebase falhou → NÃO marca', async () => {
    google.deleteUser.mockResolvedValue(Result.fail('x'));
    const r = await mk(DeleteUserUseCase).execute({ authUid: UID });
    expect(r.isFailure).toBe(true);
    expect(markDeleted).not.toHaveBeenCalled();
  });

  it('iam falhou → falha visível (retry é seguro: Firebase NOT_FOUND é sucesso)', async () => {
    markDeleted.mockRejectedValue(new Error('db'));
    const r = await mk(DeleteUserUseCase).execute({ authUid: UID });
    expect(r.isFailure).toBe(true);
    expect(repo.deleteUserComplete).not.toHaveBeenCalled();
  });
});

describe('DeleteUserByEmailUseCase', () => {
  it('marca o login com o ator informado', async () => {
    const r = await mk(DeleteUserByEmailUseCase).execute({ email: 'x@example.test', actorUid: 'uid-ator' });
    expect(r.isSuccess).toBe(true);
    expect(markDeleted).toHaveBeenCalledWith(UID, 'uid-ator');
  });

  it('sem ator → a própria conta', async () => {
    await mk(DeleteUserByEmailUseCase).execute({ email: 'x@example.test' });
    expect(markDeleted).toHaveBeenCalledWith(UID, UID);
  });

  it('Firebase falhou → NÃO marca (conta viva não perde o login)', async () => {
    google.deleteUserByEmail.mockResolvedValue(Result.fail('x'));
    await mk(DeleteUserByEmailUseCase).execute({ email: 'x@example.test' });
    expect(markDeleted).not.toHaveBeenCalled();
  });
});
