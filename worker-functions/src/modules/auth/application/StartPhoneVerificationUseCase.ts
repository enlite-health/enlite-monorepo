import { IWorkerRepository } from '@modules/worker/ports/IWorkerRepository';
import { Result } from '@shared/utils/Result';
import { logger, safeErrorFields } from '@shared/logging';
import { resourceIdHash } from '@shared/audit/resourceAccessLog';
import { generatePhoneCandidates, normalizePhoneAR } from '@shared/utils/phoneNormalization';
import { maskPhone } from '@shared/utils/phoneMask';
import { isClaimableWorker } from '@modules/worker/application/isClaimableWorker';
import { OTP_CHANNEL_UNAVAILABLE, OTP_RATE_LIMITED, OtpChallengePort, OtpPurpose } from '../ports/OtpChallengePort';
import type { IPhoneVerificationRepository } from '../ports/IPhoneVerificationRepository';
import { OTP_TTL_MINUTES } from '../infrastructure/PgOtpChallengeService';

export interface StartPhoneVerificationInput {
  authUid: string;
  email: string;
  phone: string;
}

export type StartPhoneVerificationOutput =
  | { status: 'ALREADY_VERIFIED'; phoneMasked: string }
  | { status: 'SENT'; code?: 'CLAIM_PENDING'; challengeId: string; phoneMasked: string; resendAfterSec: number; expiresInSec: number };

/** Espera do app antes de oferecer o reenvio. O teto de verdade são os limites por telefone e por ficha, contados no banco. */
export const RESEND_AFTER_SEC = 60;

/** Quem tem o número decide a finalidade: o SERVIDOR decide, nunca o cliente (um `purpose` no corpo é ignorado). */
function decidePurpose(holder: 'none' | 'imported'): OtpPurpose {
  return holder === 'imported' ? 'claim' : 'phone_verify';
}

/**
 * `POST /api/workers/me/phone-verification/start` (emenda 077 §2.4). Identidade SÓ do token.
 *   ninguém tem o número            → desafio `phone_verify` (a ficha do token)
 *   ficha IMPORTADA tem o número    → desafio `claim`, enviado ao número DA FICHA importada; o mesmo código une (CLAIM_PENDING)
 *   conta REAL tem o número         → PHONE_IN_USE (o app abre o unir contas)
 *   o número já é o da ficha E verificado → ALREADY_VERIFIED
 * Log: só `workerIdHash` e `code` (AC-8): nem telefone, nem máscara, nem código.
 */
export class StartPhoneVerificationUseCase {
  constructor(
    private readonly workers: IWorkerRepository,
    private readonly verification: IPhoneVerificationRepository,
    private readonly otp: OtpChallengePort,
  ) {}

  async execute(input: StartPhoneVerificationInput): Promise<Result<StartPhoneVerificationOutput>> {
    const normalized = normalizePhoneAR(input.phone);
    if (normalized.length < 10 || normalized.length > 15) return Result.fail('INVALID_PHONE');

    const ownResult = await this.workers.findByAuthUid(input.authUid);
    if (ownResult.isFailure) return Result.fail(ownResult.error!);
    const own = ownResult.getValue();
    if (!own) return Result.fail('WORKER_NOT_FOUND');

    const log = logger.child({ source: 'StartPhoneVerificationUseCase:execute', workerIdHash: resourceIdHash(own.id) });
    const phoneE164 = `+${normalized}`;

    if (own.phone && normalizePhoneAR(own.phone) === normalized) {
      const current = await this.verification.readState(own.id);
      if (current?.state === 'verified') {
        log.info({ msg: 'phone_verification_start', code: 'ALREADY_VERIFIED' });
        return Result.ok({ status: 'ALREADY_VERIFIED', phoneMasked: maskPhone(phoneE164) });
      }
    }

    const holderResult = await this.workers.findByPhoneCandidates(generatePhoneCandidates(input.phone));
    if (holderResult.isFailure) return Result.fail(holderResult.error!);
    const holder = holderResult.getValue();
    const other = holder !== null && holder.id !== own.id ? holder : null;

    let target = { workerId: own.id, isTest: own.isTest === true, phoneE164, purpose: decidePurpose('none') };
    if (other) {
      const claimable = await isClaimableWorker(this.workers, other);
      if (claimable.isFailure) return Result.fail(claimable.error!);
      if (!claimable.getValue()) {
        log.info({ msg: 'phone_verification_start', code: 'PHONE_IN_USE' });
        return Result.fail('PHONE_IN_USE');
      }
      // Anti-hijack (padrão do claim): o código vai ao número GRAVADO na ficha importada, não ao digitado.
      const onRecord = other.phone ?? input.phone;
      target = {
        workerId: other.id,
        isTest: other.isTest === true,
        phoneE164: onRecord.startsWith('+') ? onRecord : `+${normalizePhoneAR(onRecord)}`,
        purpose: decidePurpose('imported'),
      };
    }

    try {
      const { challengeId } = await this.otp.start({
        workerId: target.workerId,
        purpose: target.purpose,
        phoneE164: target.phoneE164,
        ctx: { workerId: target.workerId, fichaIsTest: target.isTest, tokenEmail: input.email },
      });
      const code = target.purpose === 'claim' ? ('CLAIM_PENDING' as const) : undefined;
      log.info({ msg: 'phone_verification_start', code: code ?? 'SENT' });
      return Result.ok({
        status: 'SENT',
        ...(code ? { code } : {}),
        challengeId,
        phoneMasked: maskPhone(target.phoneE164),
        resendAfterSec: RESEND_AFTER_SEC,
        expiresInSec: OTP_TTL_MINUTES * 60,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      if (message === OTP_RATE_LIMITED || message === OTP_CHANNEL_UNAVAILABLE) {
        log.warn({ msg: 'phone_verification_start', code: message });
        return Result.fail(message);
      }
      log.error({ ...safeErrorFields(err), msg: 'phone_verification_start_failed', code: 'OTP_START_FAILED' });
      return Result.fail('OTP_START_FAILED');
    }
  }
}
