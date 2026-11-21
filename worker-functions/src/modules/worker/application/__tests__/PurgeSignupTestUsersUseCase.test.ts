jest.mock('@shared/logging', () => ({
  logger: { child: jest.fn().mockReturnValue({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }) },
  reportError: jest.fn(),
}));

import type { Pool } from 'pg';
import { PurgeSignupTestUsersUseCase } from '../PurgeSignupTestUsersUseCase';

type Row = { auth_uid: string | null; email: string | null; is_test: boolean };

/** O dublê do pool devolve TODAS as linhas que o teste monta: quem restringe o escopo é o use case. */
const poolWith = (rows: Row[]) => ({ query: jest.fn().mockResolvedValue({ rows }) }) as unknown as Pool;
const firebase = () => ({ deleteUser: jest.fn().mockResolvedValue(undefined) });

describe('PurgeSignupTestUsersUseCase (FR-95/DP-23)', () => {
  it('T-F3c-25 apaga só o escopo: is_test + qa.signup.*@enlite.test', async () => {
    const fb = firebase();
    const uc = new PurgeSignupTestUsersUseCase(poolWith([
      { auth_uid: 'uid-a', email: 'qa.signup.run1@enlite.test', is_test: true },
      { auth_uid: 'uid-b', email: 'QA.Signup.Run2@Enlite.Test', is_test: true },
      { auth_uid: 'uid-real', email: 'qa.signup.run3@enlite.test', is_test: false }, // ficha NÃO é de teste
      { auth_uid: 'uid-dom', email: 'qa.signup.run4@gmail.com', is_test: true },     // domínio fora do escopo
    ]), fb);
    const out = await uc.execute();
    expect(fb.deleteUser.mock.calls.map((c) => c[0]).sort()).toEqual(['uid-a', 'uid-b']);
    expect(out).toEqual({ inScope: 2, deleted: 2, failed: 0 });
  });

  it('T-F3c-25 conta real e conta qa.worker. (massa-base) ficam intactas', async () => {
    const fb = firebase();
    const uc = new PurgeSignupTestUsersUseCase(poolWith([
      { auth_uid: 'uid-real', email: 'joana.silva@gmail.com', is_test: false },
      { auth_uid: 'uid-base', email: 'qa.worker.inc@enlite.test', is_test: true },
      { auth_uid: 'uid-sig', email: 'qa.signup.run1@enlite.test', is_test: true },
    ]), fb);
    await uc.execute();
    expect(fb.deleteUser).toHaveBeenCalledTimes(1);
    expect(fb.deleteUser).toHaveBeenCalledWith('uid-sig');
  });

  it('T-F3c-25 erro numa conta não interrompe as outras', async () => {
    const fb = firebase();
    fb.deleteUser.mockRejectedValueOnce(new Error('auth/internal-error'));
    const uc = new PurgeSignupTestUsersUseCase(poolWith([
      { auth_uid: 'uid-1', email: 'qa.signup.a@enlite.test', is_test: true },
      { auth_uid: 'uid-2', email: 'qa.signup.b@enlite.test', is_test: true },
      { auth_uid: 'uid-3', email: 'qa.signup.c@enlite.test', is_test: true },
    ]), fb);
    const out = await uc.execute();
    expect(fb.deleteUser).toHaveBeenCalledTimes(3);
    expect(out).toEqual({ inScope: 3, deleted: 2, failed: 1 });
  });
});
