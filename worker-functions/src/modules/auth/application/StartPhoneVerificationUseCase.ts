import { IWorkerRepository } from '@modules/worker/ports/IWorkerRepository';
import { Result } from '@shared/utils/Result';
import { logger, safeErrorFields } from '@shared/logging';
import { resourceIdHash } from '@shared/audit/resourceAccessLog';
import { generatePhoneCandidates, normalizePhoneAR } from '@shared/utils/phoneNormalization';
import { maskPhone } from '@shared/utils/phoneMask';
import { isClaimableWorker } from '@modules/worker/application/isClaimableWorker';
import { OTP_CHANNEL_UNAVAILABLE, OTP_RATE_LIMITED, OTP_TTL_MINUTES, OtpChallengePort, OtpPurpose } from '../ports/OtpChallengePort';
import type { IPhoneVerificationRepository } from '../ports/IPhoneVerificationRepository';

/**
 * Com `phone`: o fluxo de sempre (um `challengeId` junto é ignorado). Sem `phone`, com `challengeId` (D797 adendo 3, caso T-13: o app
 * só conhece o celular MASCARADO): REENVIO do código de claim — ver `resendClaim`.
 */
export type StartPhoneVerificationInput =
  | { authUid: string; email: string; phone: string; challengeId?: string }
  | { authUid: string; email: string; phone?: undefined; challengeId: string };

export type StartPhoneVerificationOutput =
  | { status: 'ALREADY_VERIFIED'; phoneMasked: string }
  | { status: 'SENT'; code?: 'CLAIM_PENDING'; challengeId: string; phoneMasked: string; resendAfterSec: number; expiresInSec: number };

/** Espera do app antes de oferecer o reenvio. O teto de verdade são os limites por telefone e por ficha, contados no banco. */
export const RESEND_AFTER_SEC = 60;

/** Id do plano B (Twilio Verify, sem linha em `otp_challenges`): `VE` + 32 hex. Qualquer outro id sem desafio de claim é recusado. */
const VERIFY_SID = /^VE[0-9a-f]{32}$/i;

const toE164 = (phone: string): string => (phone.startsWith('+') ? phone : `+${normalizePhoneAR(phone)}`);

type Log = Pick<ReturnType<typeof logger.child>, 'info' | 'warn' | 'error'>;
type Target = { workerId: string; isTest: boolean; phoneE164: string; purpose: OtpPurpose };

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
 * Sem `phone`, com `challengeId` de claim → reenvio do código de claim (D797 adendo 3; ver `resendClaim`).
 * Log: só `workerIdHash` e `code` (AC-8): nem telefone, nem máscara, nem código.
 */
export class StartPhoneVerificationUseCase {
  constructor(
    private readonly workers: IWorkerRepository,
    private readonly verification: IPhoneVerificationRepository,
    private readonly otp: OtpChallengePort,
  ) {}

  async execute(input: StartPhoneVerificationInput): Promise<Result<StartPhoneVerificationOutput>> {
    if (input.phone === undefined) return this.resendClaim(input.authUid, input.email, input.challengeId);
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

    let target: Target = { workerId: own.id, isTest: own.isTest === true, phoneE164, purpose: decidePurpose('none') };
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
        phoneE164: toE164(onRecord),
        purpose: decidePurpose('imported'),
      };
    }

    return this.send(target, input.email, log);
  }

  /**
   * Reenvio do código de claim SEM o número (D797 adendo 3, simétrico ao `confirm` sem `phone` do adendo 1). O caso T-13 nasce no
   * `init` de e-mail não verificado de ficha importada: o desafio é da ficha com o E-MAIL DO TOKEN. Por isso o reenvio só vale para
   * ela, e a ficha é lida pelo e-mail do token (nunca pelo id que o cliente manda):
   *   - o id é desafio de claim (`claimChallengePhone`) cujo telefone é o da ficha do e-mail do token → código novo para esse número;
   *   - o id tem o formato do plano B (`VE…`, sem linha) → código novo para o telefone gravado na ficha do e-mail do token;
   *   - desafio que não é de claim, id inexistente, desafio de OUTRA ficha, ou e-mail sem ficha importada com telefone →
   *     CANDIDATE_NOT_FOUND (um código só: a resposta não diz se o id existe para outra pessoa); nada é emitido;
   *   - a ficha deixou de ser reclamável (já tem login, inclusive o do próprio token) → NOT_IMPORTABLE / CANDIDATE_NOT_FOUND.
   * Código vencido ou consumido NÃO bloqueia: reenviar é justamente para o código que venceu; o que encerra o reenvio é a ficha
   * deixar de ser reclamável. Limites de emissão: os MESMOS do `start` (por telefone e por ficha, no `otp.start`, sob advisory lock).
   */
  private async resendClaim(authUid: string, email: string, challengeId: string): Promise<Result<StartPhoneVerificationOutput>> {
    const ownResult = await this.workers.findByAuthUid(authUid);
    if (ownResult.isFailure) return Result.fail(ownResult.error!);
    const own = ownResult.getValue();
    const log = logger.child({ source: 'StartPhoneVerificationUseCase:resendClaim', workerIdHash: own ? resourceIdHash(own.id) : 'sem_ficha' });
    const refuse = (code: string): Result<StartPhoneVerificationOutput> => {
      log.info({ msg: 'phone_verification_start', code });
      return Result.fail(code);
    };

    const fromChallenge = await this.verification.claimChallengePhone(challengeId);
    if (!fromChallenge && !VERIFY_SID.test(challengeId)) return refuse('CANDIDATE_NOT_FOUND');
    const fichaResult = await this.workers.findByEmail(email);
    if (fichaResult.isFailure) return Result.fail(fichaResult.error!);
    const ficha = fichaResult.getValue();
    if (!ficha || ficha.id === own?.id || !ficha.phone) return refuse('CANDIDATE_NOT_FOUND');
    // O desafio tem de ser DESTA ficha: o telefone é único por ficha, então telefone do desafio ≠ telefone dela = desafio alheio.
    if (fromChallenge && normalizePhoneAR(fromChallenge) !== normalizePhoneAR(ficha.phone)) return refuse('CANDIDATE_NOT_FOUND');
    const claimable = await isClaimableWorker(this.workers, ficha);
    if (claimable.isFailure) return Result.fail(claimable.error!);
    if (!claimable.getValue()) return refuse('NOT_IMPORTABLE');

    const target: Target = { workerId: ficha.id, isTest: ficha.isTest === true, phoneE164: fromChallenge ?? toE164(ficha.phone), purpose: 'claim' };
    return this.send(target, email, log);
  }

  /** Emite pelo port (limites por telefone e por ficha moram lá) e monta a resposta. Erro de canal/limite sobe com o próprio código. */
  private async send(target: Target, email: string, log: Log): Promise<Result<StartPhoneVerificationOutput>> {
    try {
      const { challengeId } = await this.otp.start({
        workerId: target.workerId,
        purpose: target.purpose,
        phoneE164: target.phoneE164,
        ctx: { workerId: target.workerId, fichaIsTest: target.isTest, tokenEmail: email },
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
