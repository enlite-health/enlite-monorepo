import { describe, it, expect } from 'vitest';
import { ApiError } from '@infrastructure/http/ApiError';
import { runWorkerInit, handOffInitOutcome, readInitOutcome, clearInitOutcome } from '../workerInitOutcome';

const apiError = (error: string, status: number) => new ApiError({ success: false, error }, status);

describe('runWorkerInit — o resultado do init num lugar só (DP-20)', () => {
  it('ok → kind ok com a resposta', async () => {
    const response = { status: 'ok' as const, worker: { id: 'w-1' } as never };
    expect(await runWorkerInit(async () => response)).toEqual({ kind: 'ok', response });
  });

  it('claim_pending → os dados do modal do código', async () => {
    const out = await runWorkerInit(async () => ({ status: 'claim_pending', candidateWorkerId: 'w-2', phoneMasked: '•••1243', verificationSid: 'VE2' }));
    expect(out).toEqual({ kind: 'claim_pending', candidateWorkerId: 'w-2', phoneMasked: '•••1243', verificationSid: 'VE2' });
  });

  it('400 EMAIL_NOT_VERIFIED → email_not_verified', async () => {
    expect(await runWorkerInit(async () => { throw apiError('EMAIL_NOT_VERIFIED', 400); })).toEqual({ kind: 'email_not_verified' });
  });

  it('429 → rate_limited', async () => {
    expect(await runWorkerInit(async () => { throw apiError('Too many OTP requests. Try again in 15 minutes.', 429); })).toEqual({ kind: 'rate_limited' });
  });

  it('outro erro sobe como antes', async () => {
    await expect(runWorkerInit(async () => { throw apiError('Failed to create worker', 400); })).rejects.toThrow('Failed to create worker');
  });

  it('a passagem do 1º login sobrevive a duas leituras (StrictMode) e some ao limpar', () => {
    handOffInitOutcome({ kind: 'rate_limited' });
    expect(readInitOutcome()).toEqual({ kind: 'rate_limited' });
    expect(readInitOutcome()).toEqual({ kind: 'rate_limited' });
    clearInitOutcome();
    expect(readInitOutcome()).toBeNull();
  });
});
