jest.mock('@shared/logging', () => ({
  logger: { child: jest.fn().mockReturnValue({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }) },
  reportError: jest.fn(),
  loggingAls: { run: jest.fn() },
}));

import { InitWorkerUseCase, CONSENT_NOT_RECORDED } from '../InitWorkerUseCase';
import { Result } from '@shared/utils/Result';
import { Worker } from '../../domain/Worker';

/**
 * Aceite da política no init pelo app (spec 077, achado de conformidade): a ficha EXISTE, então o aceite entra
 * no dono do cadastro web (trio `lgpd_consent_at`/`terms_accepted_at`/`privacy_accepted_at` de `workers`, D514).
 */
const WORKER_ID = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';
const worker = { id: WORKER_ID, authUid: 'uid-1', email: 'a@exemplo.test', phone: null, country: 'AR' } as unknown as Worker;

const repo = (saved = true) => ({
  findByAuthUid: jest.fn().mockResolvedValue(Result.ok(worker)),
  recordConsentIfMissing: jest.fn().mockResolvedValue(saved),
});
const input = (lgpdOptIn: boolean) => ({ authUid: 'uid-1', email: 'a@exemplo.test', emailVerified: true, lgpdOptIn });

describe('InitWorkerUseCase — aceite da política em ficha existente', () => {
  it('com lgpdOptIn grava o aceite na ficha achada por auth_uid', async () => {
    const r = repo();
    const out = await new InitWorkerUseCase(r as never).execute(input(true));
    expect(r.recordConsentIfMissing).toHaveBeenCalledWith(WORKER_ID, expect.any(Date));
    expect(out.isSuccess).toBe(true);
  });

  it('sem lgpdOptIn (login) não grava nada', async () => {
    const r = repo();
    await new InitWorkerUseCase(r as never).execute(input(false));
    expect(r.recordConsentIfMissing).not.toHaveBeenCalled();
  });

  it('aceite não gravado falha com CONSENT_NOT_RECORDED (nunca ok)', async () => {
    const out = await new InitWorkerUseCase(repo(false) as never).execute(input(true));
    expect(out.isFailure).toBe(true);
    expect(out.error).toBe(CONSENT_NOT_RECORDED);
  });
});
