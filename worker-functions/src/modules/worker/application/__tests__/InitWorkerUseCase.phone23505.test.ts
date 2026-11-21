jest.mock('@shared/logging', () => ({
  logger:      { child: jest.fn().mockReturnValue({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }) },
  reportError: jest.fn(),
  loggingAls:  { run: jest.fn() },
}));

import { InitWorkerUseCase } from '../InitWorkerUseCase';
import { Result } from '@shared/utils/Result';
import { Worker } from '../../domain/Worker';

// DT-51/C-43: duas contas gravando o mesmo celular ao mesmo tempo estouram 23505 no índice do telefone.
const WORKER_ID = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';
const PG_TEXT = 'duplicate key value violates unique constraint "idx_workers_phone_unique" Key (phone)=(5491151265663) already exists.';

const found: Worker = {
  id: WORKER_ID, authUid: 'abc123XYZ789def', email: 'joana.silva@gmail.com',
  currentStep: 1, status: 'INCOMPLETE_REGISTER', country: 'AR', timezone: 'America/Argentina/Buenos_Aires',
  registrationCompleted: false, createdAt: new Date('2024-06-01T10:00:00Z'), updatedAt: new Date('2024-06-01T10:00:00Z'),
};

const pgError = (constraint: string) => Object.assign(new Error(PG_TEXT), { code: '23505', constraint });

const run = (error: Error) => {
  const repo = {
    findByAuthUid: jest.fn().mockResolvedValue(Result.ok(found)),
    findByPhoneCandidates: jest.fn().mockResolvedValue(Result.ok(null)),
    setPhoneIfNull: jest.fn().mockRejectedValue(error),
  };
  return new InitWorkerUseCase(repo as any).execute({
    authUid: found.authUid, email: found.email, emailVerified: true, phone: '+5491151265663', country: 'AR',
  });
};

describe('InitWorkerUseCase — 23505 do telefone', () => {
  it('T-F3c-09 23505 de idx_workers_phone_unique vira PHONE_IN_USE sem o texto do Postgres', async () => {
    const result = await run(pgError('idx_workers_phone_unique'));

    expect(result.isSuccess).toBe(true);
    expect(result.getValue()).toEqual({ status: 'phone_rejected', code: 'PHONE_IN_USE' });
    expect(JSON.stringify(result.getValue())).not.toContain('duplicate key');
    expect(JSON.stringify(result.getValue())).not.toContain('5491151265663');
  });

  it('T-F3c-09 23505 de outra constraint NÃO vira PHONE_IN_USE (erro interno sem o texto do banco)', async () => {
    const result = await run(pgError('workers_email_key'));

    expect(result.isFailure).toBe(true);
    expect(result.error).not.toContain('duplicate key');
    expect(result.error).not.toContain('5491151265663');
  });
});
