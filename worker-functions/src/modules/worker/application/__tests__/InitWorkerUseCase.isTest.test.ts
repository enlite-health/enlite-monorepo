jest.mock('@shared/logging', () => ({
  logger: { child: jest.fn().mockReturnValue({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }) },
  reportError: jest.fn(),
  loggingAls: { run: jest.fn() },
}));

import { InitWorkerUseCase } from '../InitWorkerUseCase';
import { Result } from '@shared/utils/Result';
import { Worker } from '../../domain/Worker';

const created = { id: 'f47ac10b-58cc-4372-a567-0e02b2c3d479', authUid: 'uid-1' } as unknown as Worker;

const makeRepo = () => ({
  findByAuthUid: jest.fn().mockResolvedValue(Result.ok(null)),
  findByEmail: jest.fn().mockResolvedValue(Result.ok(null)),
  findByPhoneCandidates: jest.fn().mockResolvedValue(Result.ok(null)),
  create: jest.fn().mockResolvedValue(Result.ok(created)),
});

async function initWith(email: string) {
  const repo = makeRepo();
  const uc = new InitWorkerUseCase(repo as never);
  const res = await uc.execute({ authUid: 'uid-1', email, emailVerified: false, lgpdOptIn: true });
  expect(res.isSuccess).toBe(true);
  expect(repo.create).toHaveBeenCalledTimes(1);
  return repo.create.mock.calls[0][0] as { isTest?: boolean };
}

describe('InitWorkerUseCase — is_test no INSERT (C-50/DP-23)', () => {
  it('T-F3c-22 token @enlite.test grava is_test = true no create', async () => {
    expect((await initWith('qa.signup.run1@enlite.test')).isTest).toBe(true);
  });

  it('T-F3c-22 token comum grava is_test = false no create', async () => {
    expect((await initWith('joana.silva@gmail.com')).isTest).toBe(false);
  });

  it('T-F3c-22 e-mail em caixa mista (QA.Signup.X@Enlite.Test) grava is_test = true', async () => {
    expect((await initWith('QA.Signup.X@Enlite.Test')).isTest).toBe(true);
  });
});
